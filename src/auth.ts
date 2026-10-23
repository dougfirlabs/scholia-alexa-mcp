import {bytes, sha256} from './json';
export const scopes = ['mcp:service', 'mcp:tools', 'mcp:resources'];
export const sessionId = (subject: string) => sha256('session:' + subject);
export async function hmac(key: string | ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? bytes(key) : key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, bytes(text));
}
const encode = (v: Uint8Array) => btoa(String.fromCharCode(...v)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export async function equal(a: string, b: string) {
  const x = await sha256(a), y = await sha256(b);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export async function judgeSubject(token: string, hashes = '') {
  if (!token || token.length > 8192) return null;
  const digest = await sha256(token);
  for (const hash of hashes.split(',').map(h => h.trim()).filter(Boolean)) if (await equal(digest, hash)) return 'judge:' + digest;
  return null;
}
export async function clientSubject(header: string, client = '', secret = '') {
  try {
    if (header.length > 8192 || !client || client.startsWith('judge:') || !secret) return null;
    const parts = header.split(' ');
    if (parts.length !== 2) return null;
    const [scheme, value] = parts;
    if (scheme.toLowerCase() !== 'basic') return null;
    const decoded = new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
    const colon = decoded.indexOf(':'); if (colon < 0) return null;
    const unquote = (s: string) => new URLSearchParams('value=' + s.replace(/&/g, '%26').replace(/#/g, '%23')).get('value')!;
    return await equal(unquote(decoded.slice(0, colon)), client) && await equal(unquote(decoded.slice(colon + 1)), secret) ? client : null;
  } catch { return null; }
}
export async function issueToken(subject: string, key: string, audience: string, scope = 'mcp:service', now = Math.floor(Date.now() / 1000)) {
  if (bytes(key).length < 32 || !audience) throw new Error('Token service unavailable');
  const claims = {sub: subject, aud: audience, iss: audience.replace(/\/mcp$/, ''), iat: now, exp: now + 3600, sid: await sessionId(subject), scope};
  const content = [{alg: 'HS256', typ: 'JWT'}, claims].map(v => encode(bytes(JSON.stringify(v)))).join('.');
  return content + '.' + encode(new Uint8Array(await hmac(key, content)));
}
export async function verifyToken(token: string, key: string, audience: string, hashes = '', client = '', now = Date.now() / 1000) {
  try {
    if (bytes(key).length < 32 || token.length > 8192 || !audience) return null;
    const parts = token.split('.'); if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    const imported = await crypto.subtle.importKey('raw', bytes(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', imported, decode(sig), bytes(head + '.' + body))) return null;
    const header = JSON.parse(new TextDecoder().decode(decode(head))), c = JSON.parse(new TextDecoder().decode(decode(body)));
    if (Object.keys(header).length !== 2 || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || !(c.iat <= now && now < c.exp && c.exp <= c.iat + 3600) || c.aud !== audience || c.iss !== audience.replace(/\/mcp$/, '')) return null;
    if (typeof c.sub !== 'string' || c.sid !== await sessionId(c.sub)) return null;
    if (c.sub.startsWith('judge:')) {
      let found = false;
      for (const hash of hashes.split(',').map(x => x.trim()).filter(Boolean)) if (await equal(c.sub.slice(6), hash)) found = true;
      if (!found) return null;
    } else if (!client || c.sub !== client) return null;
    // Pre-port tokens had no scope and granted the full service.
    const scope = c.scope ?? 'mcp:service';
    if (typeof scope !== 'string' || !scope || scope.split(' ').some((s: string) => !scopes.includes(s))) return null;
    return {subject: c.sub as string, scope: scope as string};
  } catch { return null; }
}
