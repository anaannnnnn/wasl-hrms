// Document storage. Two drivers, chosen by STORAGE_DRIVER:
//   local  (default) — files under STORAGE_DIR (development / single server)
//   s3     — Linode Object Storage or any S3-compatible bucket, AWS Signature V4 implemented with node:crypto
// Files are never served publicly: downloads go through an authenticated route or a short-lived presigned URL.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cfg = () => ({
  driver: process.env.STORAGE_DRIVER || 'local',
  dir: process.env.STORAGE_DIR || path.resolve('storage'),
  endpoint: process.env.S3_ENDPOINT, // e.g. https://ae-dxb-1.linodeobjects.com (choose your region)
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET,
  key: process.env.S3_ACCESS_KEY,
  secret: process.env.S3_SECRET_KEY,
});

export const ALLOWED_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_BYTES = 8 * 1024 * 1024;

/** Validate by magic bytes, not just the declared type. */
export function sniffType(buf) {
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const amzDate = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}

function s3Url(c, key) {
  const u = new URL(c.endpoint);
  return { host: `${c.bucket}.${u.host}`, path: `/${key.split('/').map(enc).join('/')}`, origin: `${u.protocol}//${c.bucket}.${u.host}` };
}

async function s3Put(c, key, body, contentType) {
  const { host, path: p, origin } = s3Url(c, key);
  const t = amzDate(), date = t.slice(0, 8), hash = sha256(body);
  const headers = { host, 'content-type': contentType, 'x-amz-content-sha256': hash, 'x-amz-date': t, 'x-amz-server-side-encryption': 'AES256' };
  const names = Object.keys(headers).sort();
  const canonical = ['PUT', p, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', t, scope, sha256(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(c.secret, date, c.region)).update(sts).digest('hex');
  const res = await fetch(origin + p, { method: 'PUT', body, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` } });
  if (!res.ok) throw new Error(`Object storage upload failed (${res.status})`);
}

export function presignGet(key, expiresSec = 300, c = cfg(), now = new Date()) {
  const { host, path: p, origin } = s3Url(c, key);
  const t = amzDate(now), date = t.slice(0, 8), scope = `${date}/${c.region}/s3/aws4_request`;
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.key}/${scope}`, 'X-Amz-Date': t, 'X-Amz-Expires': String(expiresSec), 'X-Amz-SignedHeaders': 'host' };
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = ['GET', p, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', t, scope, sha256(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(c.secret, date, c.region)).update(sts).digest('hex');
  return `${origin}${p}?${qs}&X-Amz-Signature=${sig}`;
}

/** Store a file; returns { storageKey, contentType, size, sha256 }. */
export async function putFile({ tenantId, buffer, declaredType }) {
  if (buffer.length > MAX_BYTES) throw new Error('File is larger than 8 MB.');
  const type = sniffType(buffer);
  if (!type || (declaredType && declaredType !== type && !(declaredType === 'image/jpg' && type === 'image/jpeg'))) throw new Error('Only PDF, JPG, PNG or WEBP files are accepted.');
  const c = cfg();
  const key = `tenants/${tenantId}/documents/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ALLOWED_TYPES[type]}`;
  if (c.driver === 's3') {
    if (!c.endpoint || !c.bucket || !c.key || !c.secret) throw new Error('Object storage is not configured (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY).');
    await s3Put(c, key, buffer, type);
  } else {
    const full = path.join(c.dir, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer);
  }
  return { storageKey: key, contentType: type, size: buffer.length, sha256: sha256(buffer) };
}

/** Returns either { url } (s3 presigned) or { buffer } (local). Key must belong to the tenant. */
export async function getFile({ tenantId, storageKey }) {
  if (!storageKey.startsWith(`tenants/${tenantId}/`) || storageKey.includes('..')) throw new Error('File not found');
  const c = cfg();
  if (c.driver === 's3') return { url: presignGet(storageKey, 300, c) };
  return { buffer: await readFile(path.join(c.dir, storageKey)) };
}
