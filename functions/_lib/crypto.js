/* ============================================================
   基础密码学工具（Web Crypto）
   ============================================================ */

const enc = new TextEncoder();

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomHex(n) {
  return bytesToHex(randomBytes(n));
}

/** 生成定长数字验证码（默认 6 位，首位允许为 0） */
export function randomDigits(len = 6) {
  const max = 10 ** len;
  const limit = Math.floor(4294967296 / max) * max; // 去掉取模偏斜的尾部
  const buf = new Uint32Array(1);
  let v = 0;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return String(v % max).padStart(len, '0');
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function sha256Hex(message) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(message));
  return bytesToHex(new Uint8Array(d));
}

/** 常量时间字符串比较，避免时序侧信道 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
