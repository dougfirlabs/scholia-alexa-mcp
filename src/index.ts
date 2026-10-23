import {clientSubject, issueToken, judgeSubject, scopes, sessionId, verifyToken} from './auth';
import {bytes, canonical, object, parseJSON, sha256} from './json';
import {rpc, rpcError, validId, versions} from './protocol';
import {D1Store, SubjectStore} from './store';
import {definitions} from './tools';
import {speechText, synthesize} from './polly';
export interface Env {
  [key: string]: any;
  DECISIONS_DB?: D1Database;
  ASSETS?: Fetcher;
  IP_LIMITER?: RateLimit;
  SUBJECT_LIMITER?: RateLimit;
}
const base = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
const response = (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) => new Response(body, {status, headers: {...base, ...headers}});
const json = (value: any, status = 200, headers: Record<string, string> = {}) => response(canonical(value), status, {'Content-Type': 'application/json; charset=utf-8', ...headers});
export function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { const url = new URL(origin); if (!url.host) return false; } catch { return false; }
  return origin === new URL(request.url).origin || (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s: string) => s.trim()).includes(origin);
}
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  return !origin || !originAllowed(request, env) ? {} : {'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Expose-Headers': 'mcp-protocol-version', 'Access-Control-Max-Age': '600', Vary: 'Origin'};
}
async function limit(env: Env, name: 'IP_LIMITER' | 'SUBJECT_LIMITER', key: string) {
  if (!env[name]) throw new Error('Rate limiter unavailable');
  return (await env[name]!.limit({key})).success;
}
class TooLarge extends Error {}
async function body(request: Request) {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) throw new TooLarge();
  // Bound streamed bodies too, including clients that omit Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > 65536) { await reader.cancel(); throw new TooLarge(); }
    chunks.push(value);
  }
  const merged = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}
const bearer = (request: Request) => {
  const header = request.headers.get('Authorization') ?? '', i = header.indexOf(' ');
  return header.slice(0, i).toLowerCase() === 'bearer' ? header.slice(i + 1) : '';
};
async function route(request: Request, env: Env, audit: Record<string, any>) {
  const url = new URL(request.url), path = url.pathname, audience = env.MCP_RESOURCE_URL ?? '', issuer = audience.replace(/\/mcp$/, ''), headers = cors(request, env);
  const unauthorized = () => json({error: 'unauthorized'}, 401, {...headers, 'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`});
  const deniedMethod = (allow = 'POST, OPTIONS') => response('Method Not Allowed', 405, {...headers, Allow: allow});
  if (env.MCP_DISABLED === '1') return json({error: 'unavailable'}, 503);
  if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'].includes(path)) {
    if (request.method !== 'GET') return deniedMethod('GET');
    if (!audience) return json({error: 'unavailable'}, 503);
    return json(path.includes('protected-resource') ? {resource: audience, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: scopes} :
      {issuer, token_endpoint: issuer + '/oauth/token', grant_types_supported: ['client_credentials'], response_types_supported: [], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'], scopes_supported: scopes});
  }
  if (['/demo', '/demo/', '/demo/app.js', '/demo/style.css'].includes(path)) return ['GET', 'HEAD'].includes(request.method) ? env.ASSETS!.fetch(request) : deniedMethod('GET, HEAD');
  const tokenRoute = ['/oauth/token', '/oauth/judge'].includes(path);
  if (!tokenRoute && !['/mcp', '/healthz', '/tts'].includes(path)) return response('Not Found', 404);
  if (!originAllowed(request, env)) return json({error: 'forbidden_origin'}, 403);
  if (request.method === 'OPTIONS' && path !== '/healthz') return response(null, 204, headers);
  if (tokenRoute && request.method !== 'POST') return deniedMethod();
  if (!await limit(env, 'IP_LIMITER', await sha256(request.headers.get('CF-Connecting-IP') || 'local'))) return json({error: 'rate_limited'}, 429, headers);
  let credential: {subject: string; scope: string} | null = null;
  if (path === '/oauth/token') {
    const subject = await clientSubject(request.headers.get('Authorization') ?? '', env.MCP_CLIENT_ID, env.MCP_CLIENT_SECRET);
    if (subject) credential = {subject, scope: 'mcp:service'};
  } else {
    const token = bearer(request), subject = await judgeSubject(token, env.MCP_JUDGE_TOKEN_HASHES);
    if (subject) credential = {subject, scope: 'mcp:service'};
    else if (path !== '/oauth/judge') credential = await verifyToken(token, env.MCP_JWT_SECRET ?? '', audience, env.MCP_JUDGE_TOKEN_HASHES, env.MCP_CLIENT_ID);
  }
  if (!credential) return unauthorized();
  const {subject} = credential;
  audit.subject = await sha256(subject);
  if (!await limit(env, 'SUBJECT_LIMITER', audit.subject)) return json({error: 'rate_limited'}, 429, headers);
  const session = await sessionId(subject);
  if (tokenRoute) {
    const raw = await body(request);
    let scope = 'mcp:service';
    if (path === '/oauth/token') {
      const form = new URLSearchParams(raw);
      if ([...form].length > 10) return json({error: 'invalid_request'}, 400, headers);
      if (form.getAll('grant_type').length !== 1 || form.get('grant_type') !== 'client_credentials') return json({error: 'unsupported_grant_type'}, 400, headers);
      if (form.has('resource') && (form.getAll('resource').length !== 1 || form.get('resource') !== audience)) return json({error: 'invalid_target'}, 400, headers);
      if (form.has('scope')) {
        scope = form.get('scope')!;
        if (form.getAll('scope').length !== 1 || !scope || scope.split(' ').some(s => !scopes.includes(s))) return json({error: 'invalid_scope'}, 400, headers);
        scope = [...new Set(scope.split(' '))].join(' ');
      }
    }
    return json({access_token: await issueToken(subject, env.MCP_JWT_SECRET ?? '', audience, scope), token_type: 'Bearer', expires_in: 3600, scope, session_id: session}, 200, headers);
  }
  if (path === '/healthz') return ['GET', 'HEAD'].includes(request.method) ? response(request.method === 'HEAD' ? null : canonical({ok: true, service: 'scholialang-mcp'}), 200, {'Content-Type': 'application/json; charset=utf-8', ...headers}) : deniedMethod('GET, HEAD');
  if (request.method === 'GET') return json({error: 'SSE stream is not supported by this stateless MCP worker'}, 405, {Allow: 'POST, OPTIONS', ...headers});
  if (request.method !== 'POST') return deniedMethod();
  const grants = credential.scope.split(' ');
  const allowed = (scope: string) => grants.includes('mcp:service') || grants.includes(scope);
  const insufficient = () => json({error: 'insufficient_scope'}, 403, {...headers, 'WWW-Authenticate': 'Bearer error="insufficient_scope"'});
  if (path === '/tts') {
    if (!allowed('mcp:tools')) return insufficient();
    let message: any;
    try { message = parseJSON(await body(request)); speechText(message); }
    catch (e) { if (e instanceof TooLarge) throw e; return json({error: 'Expected 1 to 300 sanitized text characters'}, 400, headers); }
    // Pass the original text so entity decoding is not applied to its own output.
    try { return response(await synthesize(message.text, env), 200, {...headers, 'Content-Type': 'audio/mpeg'}); }
    catch { return json({error: 'voice unavailable'}, 503, headers); }
  }
  const version = request.headers.get('MCP-Protocol-Version');
  if (version && !versions.includes(version)) return json(rpcError(null, -32602, 'Unsupported MCP-Protocol-Version', {supported: versions}), 400, headers);
  let message: any;
  try { message = parseJSON(await body(request)); }
  catch (e) { if (e instanceof TooLarge) throw e; return json(rpcError(null, -32700, 'Parse error'), 400, headers); }
  if (object(message)) {
    const method = message.method;
    if (typeof method === 'string' && ((method.startsWith('tools/') && !allowed('mcp:tools')) || (method.startsWith('resources/') && !allowed('mcp:resources')))) return insufficient();
    audit.method = ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/read', 'resources/list', 'notifications/initialized'].includes(method) ? method : 'other';
    const p = message.params;
    if (method === 'tools/call' && object(p)) {
      audit.tool = definitions.some(t => t.name === p.name) ? p.name : 'unknown';
      if (p.name === 'record_decision' && message.jsonrpc === '2.0' && validId(message) && Object.hasOwn(message, 'id') && object(p.arguments) && p.arguments.session_id !== session) return json(rpcError(message.id, -32602, 'Use the server-issued session_id'), 200, headers);
    }
  }
  const store = env.DECISIONS_DB ? new SubjectStore(new D1Store(env.DECISIONS_DB), subject, session) : undefined;
  const result = await rpc(message, store, audit.requestId);
  if (result?.result && message.method === 'initialize') result.result.session_id = session;
  return result === null ? response(null, 202, headers) : json(result, 200, headers);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const audit: Record<string, any> = {method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE'].includes(request.method) ? request.method : 'other', tool: null, subject: null, requestId: crypto.randomUUID().replace(/-/g, '')};
    const start = performance.now(); let result: Response;
    try { result = await route(request, env, audit); }
    catch (e) { result = e instanceof TooLarge ? json({error: 'payload_too_large'}, 413, cors(request, env)) : json({error: 'Internal error', requestId: audit.requestId}, 500); }
    console.info(JSON.stringify({...audit, status: result.status, latency_ms: Math.round((performance.now() - start) * 100) / 100}));
    return result;
  }
};
