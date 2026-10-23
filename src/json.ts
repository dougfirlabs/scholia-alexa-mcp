import {parse, LosslessNumber, isLosslessNumber} from 'lossless-json';
export const bytes = (text: string) => new TextEncoder().encode(text);
export const parseJSON = (text: string): any => parse(text);
export const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) && !isLosslessNumber(v);
export const numeric = (v: any) => typeof v === 'number' || isLosslessNumber(v);
// Python JSON uses code-point key order, ASCII escaping, and distinguishes floats
// from integers. Preserve numeric tokens when loading existing signed records.
const quote = (v: string) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const keyOrder = (a: string, b: string) => {
  const x = Array.from(a, c => c.codePointAt(0)!), y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
export function pythonNumber(raw: string): string {
  if (!/[.eE]/.test(raw)) return BigInt(raw).toString();
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('Non-finite number');
  if (Object.is(n, -0)) return '-0.0';
  const abs = Math.abs(n);
  if (abs && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, exponent] = n.toExponential().split('e');
    const e = Number(exponent);
    return `${mantissa}e${e < 0 ? '-' : '+'}${Math.abs(e).toString().padStart(2, '0')}`;
  }
  const s = n.toString();
  return s.includes('.') ? s : s + '.0';
}
export function canonical(v: any): string {
  if (v === null) return 'null';
  if (isLosslessNumber(v)) return pythonNumber(v.value);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number');
    return Number.isInteger(v) ? String(v) : pythonNumber(String(v));
  }
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort(keyOrder).map(k => quote(k) + ':' + canonical(v[k])).join(',') + '}';
  throw new Error('Invalid JSON');
}
export function float(v: number) { return new LosslessNumber(Number.isInteger(v) ? `${v}.0` : String(v)); }
export const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (value: string) => hex(await crypto.subtle.digest('SHA-256', bytes(value)));
export const digest = async (value: any) => 'sha256:' + await sha256(canonical(value));
