import {canonical, digest, parseJSON, sha256, float} from './json';
export const TTL_SECONDS = 72 * 3600, MAX_RECORDS = 25;
export interface Store {
  load(key: string): Promise<string | null>;
  compareSwap(key: string, old: string | null, value: string): Promise<boolean>;
}
export class ChainBroken extends Error {
  constructor(public index: number, public action: string) { super(`Chain broken at record #${index}`); }
}
export async function checkChain(records: any[], household: string, anchor: string | null = null) {
  let previous = anchor;
  for (const [i, record] of records.entries()) {
    const {trace_id, ...body} = record;
    if (body.household_id !== household || body.previous !== previous || trace_id !== await digest(body))
      throw new ChainBroken(i + 1, body.action ?? 'Unknown action');
    previous = trace_id;
  }
}
export class D1Store implements Store {
  constructor(private db: D1Database) {}
  load(key: string) { return this.db.prepare('SELECT payload FROM decision_chains WHERE household = ?').bind(key).first<string>('payload'); }
  async compareSwap(key: string, old: string | null, value: string) {
    const stmt = old === null
      ? this.db.prepare('INSERT OR IGNORE INTO decision_chains (household, payload) VALUES (?, ?) RETURNING household').bind(key, value)
      : this.db.prepare('UPDATE decision_chains SET payload = ? WHERE household = ? AND payload = ? RETURNING household').bind(value, key, old);
    return await stmt.first('household') !== null;
  }
}
export class SubjectStore implements Store {
  private key: Promise<string>;
  constructor(private store: Store, subject: string, private session: string) { this.key = sha256(subject); }
  async load(household: string) {
    return parseJSON(await this.store.load(await this.key) ?? '{}')[this.session + ':' + household] ?? null;
  }
  async compareSwap(household: string, old: string | null, value: string) {
    const key = this.session + ':' + household;
    for (let i = 0; i < 4; i++) {
      const raw = await this.store.load(await this.key);
      let doc = parseJSON(raw ?? '{}');
      if ((doc[key] ?? null) !== old) return false;
      doc = Object.fromEntries(Object.entries(doc).filter(([k, v]) => k === key || Number(parseJSON(v as string).expires_at) > Date.now() / 1000));
      if (!(key in doc) && Object.keys(doc).length >= 8) throw new RangeError('Subject storage capacity reached');
      doc[key] = value;
      if (await this.store.compareSwap(await this.key, raw, canonical(doc))) return true;
    }
    return false;
  }
}
export async function readSnapshot(store: Store, household: string, now = Date.now() / 1000) {
  const raw = await store.load(household), chain = raw ? parseJSON(raw) : null;
  if (!chain || Number(chain.expires_at) <= now) return {records: [], anchor: null};
  await checkChain(chain.records, household, chain.anchor ?? null);
  return chain;
}
export async function append(store: Store, fields: any, now: any = float(Date.now() / 1000)) {
  const household = fields.household_id;
  for (let i = 0; i < 4; i++) {
    const old = await store.load(household);
    let chain = old ? parseJSON(old) : null;
    if (!chain || Number(chain.expires_at) <= Number(now)) chain = {expires_at: typeof now === 'number' ? now + TTL_SECONDS : float(Number(now) + TTL_SECONDS), records: [], anchor: null};
    const records = chain.records;
    await checkChain(records, household, chain.anchor ?? null);
    const body = {...fields, created_at: now, expires_at: chain.expires_at,
      previous: records.length ? records.at(-1).trace_id : null,
      atoms: [{kind: 'Action', id: 'Action_0001', content: fields.action},
        {kind: 'Finding', id: 'Finding_0001', content: fields.reason, references: ['Action_0001']}]};
    const record = {...body, trace_id: await digest(body)};
    records.push(record);
    if (records.length > MAX_RECORDS) chain.anchor = records.shift().trace_id;
    if (await store.compareSwap(household, old, canonical(chain))) return record;
  }
  throw new RangeError('Concurrent write conflict; retry the request');
}
