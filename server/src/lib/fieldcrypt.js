// Field-level encryption for sensitive identifiers (IBAN, labour card, MFA secrets): AES-256-GCM.
// Key: FIELD_ENCRYPTION_KEY = 32 random bytes, base64 or hex. Values are stored as "enc:v1:<iv>:<tag>:<ciphertext>".
// Reads are backward compatible: plaintext values written before encryption was enabled are returned as-is
// and re-encrypted on their next save. Rotate by setting FIELD_ENCRYPTION_KEY_OLD while re-saving records.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const parseKey = (v) => {
  if (!v) return null;
  const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (b.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).');
  return b;
};
const keys = () => ({ cur: parseKey(process.env.FIELD_ENCRYPTION_KEY), old: parseKey(process.env.FIELD_ENCRYPTION_KEY_OLD) });

export const encryptionEnabled = () => !!process.env.FIELD_ENCRYPTION_KEY;
export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function encryptField(plain) {
  if (plain == null || plain === '' || isEncrypted(plain)) return plain;
  const { cur } = keys();
  if (!cur) return plain; // encryption not configured (development)
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cur, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptField(v) {
  if (!isEncrypted(v)) return v;
  const [iv, tag, ct] = v.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
  for (const k of [keys().cur, keys().old].filter(Boolean)) {
    try {
      const d = createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch { /* try the next key */ }
  }
  throw new Error('Cannot decrypt a protected field: check FIELD_ENCRYPTION_KEY.');
}
