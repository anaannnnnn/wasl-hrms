// Time-based one-time passwords (RFC 6238 / RFC 4226) for two-factor sign-in. Works with any authenticator app.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function base32Decode(s) {
  const bits = s.replace(/=+$/, '').toUpperCase().split('').map((c) => { const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32'); return i.toString(2).padStart(5, '0'); }).join('');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secretB32, counter, digits = 6) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
export const totp = (secret, time = Date.now(), step = 30) => hotp(secret, Math.floor(time / 1000 / step));

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const c = Buffer.from(String(code));
  return [-1, 0, 1].some((w) => timingSafeEqual(Buffer.from(totp(secret, time + w * 30000)), c));
}
export const otpauthUrl = (secret, account, issuer = 'Wasl HRMS') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
