import {hmac} from './auth';
import {sha256, hex, object} from './json';
import {sanitize} from './tools';
export function speechText(message: any): string {
  if (!object(message) || Object.keys(message).join() !== 'text' || typeof message.text !== 'string') throw new RangeError('Expected text');
  const text = sanitize(message.text).trim();
  if (!text || Array.from(text).length > 300) throw new RangeError('Expected text');
  return text;
}
export async function signedHeaders(body: string, access: string, secret: string, region: string, timestamp: string, session = '') {
  const headers: Record<string, string> = {'content-type': 'application/json', host: `polly.${region}.amazonaws.com`, 'x-amz-date': timestamp};
  if (session) headers['x-amz-security-token'] = session;
  const keys = Object.keys(headers).sort(), names = keys.join(';');
  const canonical = ['POST', '/v1/speech', '', keys.map(k => `${k}:${headers[k].trim().replace(/\s+/g, ' ')}\n`).join(''), names, await sha256(body)].join('\n');
  const day = timestamp.slice(0, 8), scope = `${day}/${region}/polly/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', timestamp, scope, await sha256(canonical)].join('\n');
  let key: string | ArrayBuffer = 'AWS4' + secret;
  for (const v of [day, region, 'polly', 'aws4_request']) key = await hmac(key, v);
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names}, Signature=${hex(await hmac(key, toSign))}`;
  return headers;
}
export async function synthesize(text: string, env: Record<string, any>, fetcher: typeof fetch = fetch) {
  text = speechText({text});
  const region = env.AWS_REGION || 'us-west-2';
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('voice unavailable');
  let engine = env.POLLY_ENGINE || 'generative';
  try {
    for (let i = 0; i < 2; i++) {
      const body = JSON.stringify({Text: text, TextType: 'text', OutputFormat: 'mp3', Engine: engine, VoiceId: env.POLLY_VOICE || 'Ruth'});
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const headers = await signedHeaders(body, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, region, timestamp, env.AWS_SESSION_TOKEN);
      const response = await fetcher(`https://polly.${region}.amazonaws.com/v1/speech`, {method: 'POST', headers, body, redirect: 'error'});
      if (response.status === 200) return response.arrayBuffer();
      const error: any = await response.json(), code = (error.__type ?? error.code ?? '').split('#').at(-1).split(':')[0];
      if (i === 0 && engine === 'generative' && code === 'EngineNotSupportedException') { engine = 'neural'; continue; }
      break;
    }
  } catch { /* Never disclose upstream credentials or error details. */ }
  throw new Error('voice unavailable');
}
