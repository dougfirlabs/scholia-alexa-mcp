#!/usr/bin/env node
// Usage: MCP_TOKEN=... node scripts/latency.mjs http://localhost:8787
// The first initialize request is a cold-request proxy; restart wrangler first.
import {performance} from 'node:perf_hooks';
const url = new URL('/mcp', process.argv[2] || 'http://localhost:8787');
const token = process.env.MCP_TOKEN;
if (!token) throw new Error('Set MCP_TOKEN to a local or authorized test credential');
const count = Number(process.env.LATENCY_SAMPLES || 20);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Invalid LATENCY_SAMPLES');
let id = 0;
async function call(method, params = {}) {
  const start = performance.now();
  const response = await fetch(url, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25'}, body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  const payload = await response.json();
  if (!response.ok || payload.error || payload.result?.isError) throw new Error(`Probe failed: HTTP ${response.status}; ${JSON.stringify(payload.error || payload.result)}`);
  return {ms: performance.now() - start, result: payload.result};
}
const first = await call('initialize');
const record = await call('tools/call', {name: 'record_decision', arguments: {household_id: 'latency', session_id: first.result.session_id, action: 'dim lights', reason: 'Local latency probe', inputs: {}, approver: 'test'}});
const samples = {};
for (const [label, method, params] of [
  ['tools/list', 'tools/list', {}],
  ['explain_why', 'tools/call', {name: 'explain_why', arguments: {household_id: 'latency', trace_id: record.result.structuredContent.trace_id}}],
]) {
  const times = [];
  for (let i = 0; i < count; i++) times.push((await call(method, params)).ms);
  times.sort((a, b) => a - b);
  samples[label] = {n: count, p50_ms: times[Math.ceil(count * .5) - 1], p95_ms: times[Math.ceil(count * .95) - 1]};
}
console.log(JSON.stringify({url: String(url), first_initialize_ms: first.ms, cold_probe: 'First request after local runtime start; not a remote isolate cold-start measurement', samples}, null, 2));
if (process.env.LATENCY_MAX_P95_MS && Object.values(samples).some(s => s.p95_ms >= Number(process.env.LATENCY_MAX_P95_MS))) process.exitCode = 1;
