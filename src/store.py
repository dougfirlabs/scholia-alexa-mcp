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


class ChainBroken(ValueError):
    pass


def check_chain(records, household, anchor=None):
    previous = anchor
    for index, record in enumerate(records, 1):
        body = {key: value for key, value in record.items() if key != "trace_id"}
        if (body.get("household_id") != household or body.get("previous") != previous
                or record.get("trace_id") != digest(body)):
            raise ChainBroken(f"Chain broken at record #{index}")
        previous = record["trace_id"]


def verify(records, household, anchor=None):
    try:
        check_chain(records, household, anchor)
    except ChainBroken:
        return False
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


async def read_snapshot(store, household, now=None):
    now = time.time() if now is None else now
    raw = await store.load(household)
    chain = json.loads(raw) if raw else None
    if chain is None or chain["expires_at"] <= now:
        return {"records": [], "anchor": None}
    check_chain(chain["records"], household, chain.get("anchor"))
    return chain


async def read_chain(store, household, now=None):
    return (await read_snapshot(store, household, now))["records"]


async def append(store, fields, now=None):
    now = time.time() if now is None else now
    household = fields["household_id"]
    for _ in range(4):
        old = await store.load(household)
        chain = json.loads(old) if old else None
        if chain is None or chain["expires_at"] <= now:
            chain = {"expires_at": now + TTL_SECONDS, "records": [], "anchor": None}
        records = chain["records"]
        check_chain(records, household, chain.get("anchor"))
        body = {**fields, "created_at": now, "expires_at": chain["expires_at"],
                "previous": records[-1]["trace_id"] if records else None,
                "atoms": [{"kind": "Action", "id": "Action_0001", "content": fields["action"]},
                          {"kind": "Finding", "id": "Finding_0001", "content": fields["reason"],
                           "references": ["Action_0001"]}]}
        record = {**body, "trace_id": digest(body)}
        records.append(record)
        if len(records) > MAX_RECORDS:
            chain["anchor"] = records.pop(0)["trace_id"]
        if await store.compare_swap(household, old, canonical(chain)):
            return record
    raise ValueError("Concurrent write conflict; retry the request")
