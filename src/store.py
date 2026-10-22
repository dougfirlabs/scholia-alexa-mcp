"""Bounded, tamper-evident household chains with a fixed retention window."""
import hashlib
import json
import time

TTL_SECONDS = 30 * 86400
MAX_RECORDS = 100


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def verify(records, household):
    previous = None
    for record in records:
        body = {key: value for key, value in record.items() if key != "trace_id"}
        if (body.get("household_id") != household or body.get("previous") != previous
                or record.get("trace_id") != digest(body)):
            return False
        previous = record["trace_id"]
    return True


class MemoryStore:
    """Explicit test double; never selected silently by the Worker."""
    def __init__(self):
        self.rows = {}

    async def load(self, household):
        return self.rows.get(household)

    async def compare_swap(self, household, old, new):
        if self.rows.get(household) != old:
            return False
        self.rows[household] = new
        return True


class D1Store:
    def __init__(self, binding):
        self.binding = binding

    async def load(self, household):
        return await self.binding.prepare(
            "SELECT payload FROM decision_chains WHERE household = ?"
        ).bind(household).first("payload")

    async def compare_swap(self, household, old, new):
        if old is None:
            statement = self.binding.prepare(
                "INSERT OR IGNORE INTO decision_chains (household, payload) VALUES (?, ?) RETURNING household"
            ).bind(household, new)
        else:
            statement = self.binding.prepare(
                "UPDATE decision_chains SET payload = ? WHERE household = ? AND payload = ? RETURNING household"
            ).bind(new, household, old)
        return await statement.first("household") is not None


async def read_chain(store, household, now=None):
    now = time.time() if now is None else now
    raw = await store.load(household)
    chain = json.loads(raw) if raw else None
    if chain is None or chain["expires_at"] <= now:
        return []
    records = chain["records"]
    if not verify(records, household):
        raise ValueError("Stored chain failed integrity verification")
    return records


async def append(store, fields, now=None):
    now = time.time() if now is None else now
    household = fields["household_id"]
    for _ in range(4):
        old = await store.load(household)
        chain = json.loads(old) if old else None
        if chain is None or chain["expires_at"] <= now:
            chain = {"expires_at": now + TTL_SECONDS, "records": []}
        records = chain["records"]
        if not verify(records, household):
            raise ValueError("Stored chain failed integrity verification")
        if len(records) >= MAX_RECORDS:
            raise ValueError("Household retention window is full (100 decisions)")
        body = {**fields, "created_at": now, "expires_at": chain["expires_at"],
                "previous": records[-1]["trace_id"] if records else None,
                "atoms": [{"kind": "Action", "id": "Action_0001", "content": fields["action"]},
                          {"kind": "Finding", "id": "Finding_0001", "content": fields["reason"],
                           "references": ["Action_0001"]}]}
        record = {**body, "trace_id": digest(body)}
        records.append(record)
        if await store.compare_swap(household, old, canonical(chain)):
            return record
    raise ValueError("Concurrent write conflict; retry the request")
