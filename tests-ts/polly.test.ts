import {afterEach, expect, it, vi} from 'vitest';
import worker from '../src/index';
import {sha256} from '../src/json';
import {speechText, synthesize} from '../src/polly';
const config = {AWS_ACCESS_KEY_ID: 'example', AWS_SECRET_ACCESS_KEY: 'example-secret'};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([
  [{}, {'x-amzn-ErrorType': 'EngineNotSupportedException:http://example.test'}],
  [{__type: 'com.amazonaws.polly#EngineNotSupportedException'}, {}],
  [{message: 'This voice does not support the selected engine'}, {'x-amzn-ErrorType': 'ValidationException'}],
])('retries unsupported generative engines from REST-JSON errors %s', async (body, headers) => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), {status: 400, headers}))
    .mockResolvedValueOnce(new Response('mp3'));
  expect(new TextDecoder().decode(await synthesize('Hello', config, fetcher))).toBe('mp3');
  expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).Engine)).toEqual(['generative', 'neural']);
});
it('uses the error header even if the upstream body is not JSON', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', {status: 400, headers: {'x-amzn-ErrorType': 'EngineNotSupportedException'}}))
    .mockResolvedValueOnce(new Response('mp3'));
  await synthesize('Hello', config, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  [403, {message: 'denied engine'}, 'generative', 1],
  [400, {__type: 'ValidationException', message: 'invalid text'}, 'generative', 1],
  [400, {__type: 'EngineNotSupportedException'}, 'neural', 1],
  [400, {__type: 'EngineNotSupportedException'}, 'generative', 2],
])('bounds retries for status %s and engine errors %s', async (status, body, engine, count) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), {status}));
  await expect(synthesize('Hello', {...config, POLLY_ENGINE: engine}, fetcher)).rejects.toThrow(/^voice unavailable$/);
  expect(fetcher).toHaveBeenCalledTimes(count);
});
it('hides upstream exceptions', async () => {
  await expect(synthesize('Hello', config, vi.fn(async () => { throw new Error('private detail'); }))).rejects.toThrow(/^voice unavailable$/);
});
it('limits raw input before sanitizing and counts the sanitized Unicode text', () => {
  expect(() => speechText({text: '<b>' + 'x'.repeat(1200) + '</b>'})).toThrow(RangeError);
  expect(speechText({text: '<b>' + '😀'.repeat(300) + '</b>'})).toBe('😀'.repeat(300));
  expect(() => speechText({text: '😀'.repeat(301)})).toThrow(RangeError);
});
it('enforces TTS HTTP auth, limits, validation, CORS and binary response', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const env: any = {...config, MCP_JUDGE_TOKEN_HASHES: await sha256('demo'),
    IP_LIMITER: {limit: async () => ({success: true})}, SUBJECT_LIMITER: {limit: async () => ({success: true})}};
  const fetcher = vi.fn(async () => new Response(new Uint8Array([0, 255, 1, 128])));
  vi.stubGlobal('fetch', fetcher);
  const send = (value: any, headers = {}, method = 'POST') => worker.fetch(new Request('https://example.com/tts', {
    method, headers: {Authorization: 'Bearer demo', Origin: 'https://example.com', ...headers},
    ...(method === 'POST' ? {body: JSON.stringify(value)} : {}),
  }), env);
  expect((await send({text: 'hello'}, {Authorization: ''})).status).toBe(401);
  for (const value of [{text: ''}, {text: 'x'.repeat(301)}, {text: '<b></b>'}, {text: 3}, [], {text: 'ok', extra: 1}, {text: 'a'.repeat(64000)}]) {
    expect((await send(value)).status).toBe(400);
  }
  expect((await send({text: 'a'.repeat(65536)})).status).toBe(413);
  expect(fetcher).not.toHaveBeenCalled();
  const res = await send({text: '<b>' + 'x'.repeat(300) + '</b>'});
  expect(res.status).toBe(200); expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  expect(res.headers.get('Cache-Control')).toBe('no-store'); expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 128]));
  expect(JSON.parse(fetcher.mock.calls[0][1].body).Text).toBe('x'.repeat(300));
  // Decode entities exactly once. A second pass would erase this literal text.
  expect((await send({text: '&amp;lt;b&amp;gt;&amp;lt;/b&amp;gt;'})).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).Text).toBe('&lt;b&gt;&lt;/b&gt;');
  expect((await send({}, {}, 'OPTIONS')).status).toBe(204);
  expect((await send({text: 'hello'}, {Origin: 'https://evil.example'})).status).toBe(403);
  for (const name of ['IP_LIMITER', 'SUBJECT_LIMITER']) {
    env[name].limit = async () => ({success: false});
    expect((await send({text: 'hello'})).status).toBe(429);
    env[name].limit = async () => ({success: true});
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});
