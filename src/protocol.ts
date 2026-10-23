import data from './reference.json';
import {object, numeric} from './json';
import {callTool, definitions} from './tools';
import type {Store} from './store';
export const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const rpcError = (id: any, code: number, message: string, data?: any) => ({jsonrpc: '2.0', id, error: {code, message, ...(data === undefined ? {} : {data})}});
export function validId(m: any) { return !Object.hasOwn(m, 'id') || typeof m.id === 'string' || (numeric(m.id) && Number.isFinite(Number(m.id))); }
export async function rpc(m: any, store?: Store, requestId = crypto.randomUUID()): Promise<any> {
  if (!object(m)) return rpcError(null, -32600, 'JSON-RPC body must be an object');
  if (!validId(m)) return rpcError(null, -32600, 'Invalid id');
  const id = m.id ?? null;
  if (m.jsonrpc !== '2.0') return rpcError(id, -32600, "jsonrpc must be '2.0'");
  if (!Object.hasOwn(m, 'method')) return null;
  if (typeof m.method !== 'string' || !m.method) return rpcError(id, -32600, 'method must be a string');
  if (id === null) return null;
  const p = Object.hasOwn(m, 'params') ? m.params : {};
  if (!object(p)) return rpcError(id, -32602, 'params must be an object');
  let result: any;
  try {
    switch (m.method) {
      case 'initialize': result = {...data.INITIALIZE, protocolVersion: versions.includes(p.protocolVersion) ? p.protocolVersion : versions[0]}; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = {tools: definitions}; break;
      case 'tools/call':
        if (typeof p.name !== 'string') return rpcError(id, -32602, 'name must be a string');
        result = await callTool(p.name, Object.hasOwn(p, 'arguments') ? p.arguments : {}, store); break;
      case 'resources/list': result = {resources: data.RESOURCE_DEFS}; break;
      case 'resources/read': {
        if (typeof p.uri !== 'string') return rpcError(id, -32602, 'uri must be a string');
        const def = data.RESOURCE_DEFS.find(r => r.uri === p.uri);
        if (!def) return rpcError(id, -32002, 'Resource not found', {uri: p.uri});
        result = {contents: [{uri: p.uri, mimeType: def.mimeType, text: (data.RESOURCE_TEXT as Record<string, string>)[p.uri]}]}; break;
      }
      case 'resources/templates/list': result = {resourceTemplates: []}; break;
      case 'prompts/list': result = {prompts: []}; break;
      default: return rpcError(id, -32601, `Method not found: ${m.method}`);
    }
    return {jsonrpc: '2.0', id, result};
  } catch { return rpcError(id, -32603, 'Internal error', {requestId}); }
}
