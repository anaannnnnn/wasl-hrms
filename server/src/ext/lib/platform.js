// Platform helpers: API keys, idempotency, signed webhooks (with replay protection), document seals,
// third-party signature checks (Slack, Meta/WhatsApp, devices) and upload scanning. No external deps.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { sniffType } from '../../lib/storage.js';

export const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const safeEq = (a, b) => { const A = Buffer.from(String(a)); const B = Buffer.from(String(b)); return A.length === B.length && timingSafeEqual(A, B); };

// ---------------- API keys: "wsl_<prefix>_<secret>"; only a hash is stored ----------------
export function newApiKey() {
  const prefix = randomBytes(5).toString('hex'); const secret = randomBytes(24).toString('base64url');
  return { key: `wsl_${prefix}_${secret}`, prefix, hash: sha256(secret) };
}
export function parseApiKey(k) {
  const m = /^wsl_([0-9a-f]{10})_([A-Za-z0-9_-]{20,})$/.exec(String(k || ''));
  return m ? { prefix: m[1], secretHash: sha256(m[2]) } : null;
}
export const apiKeyMatches = (stored, parsed) => !!stored && !!parsed && safeEq(stored.hash, parsed.secretHash);

// ---------------- Idempotency ----------------
export const requestHash = (body) => sha256(JSON.stringify(body ?? {}));

// ---------------- Outgoing webhooks: Stripe-style signature header ----------------
// Wasl-Signature: t=<unix>,v1=<hex hmac of "<t>.<body>">  — receivers reject if |now - t| > 5 min (replay protection)
export function signWebhook(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
export function verifyWebhook(secret, body, header, { toleranceSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(now - Number(parts.t)) > toleranceSec) return false;
  return safeEq(createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex'), parts.v1);
}
export const backoffMs = (attempt, base = 30000, cap = 6 * 3600 * 1000) => Math.min(cap, base * 2 ** Math.max(0, attempt - 1));

// ---------------- Inbound signatures ----------------
export function verifySlack(signingSecret, rawBody, ts, sig, now = Math.floor(Date.now() / 1000)) {
  if (!signingSecret || !ts || !sig || Math.abs(now - Number(ts)) > 300) return false;
  return safeEq(`v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`, sig);
}
export function verifyMeta(appSecret, rawBody, sig) {
  if (!appSecret || !sig) return false;
  return safeEq(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`, sig);
}
export const deviceSignature = (secret, rawBody) => createHmac('sha256', secret).update(rawBody).digest('hex');

// ---------------- Document seals (tamper-evident letters / payslips / offers) ----------------
export const newSealCode = () => randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12);

// ---------------- Anonymous survey respondent key (not reversible without the server secret) ----------------
export const respondentHash = (secret, surveyId, employeeId) => createHmac('sha256', secret).update(`${surveyId}:${employeeId}`).digest('hex');

// ---------------- Upload scanning: magic-byte type check + optional ClamAV (clamd INSTREAM) ----------------
export function validateUpload(buffer, declaredType, allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) {
  const sniffed = sniffType(buffer);
  if (!sniffed || !allowed.includes(sniffed)) return { ok: false, error: 'Only PDF, JPG, PNG or WEBP files are accepted.' };
  if (declaredType && declaredType !== sniffed) return { ok: false, error: `The file content is ${sniffed}, not ${declaredType}.` };
  return { ok: true, type: sniffed };
}

export function clamScan(buffer, { host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT || 3310), timeoutMs = 20000 } = {}) {
  if (!host) return Promise.resolve({ scanned: false, clean: true, detail: 'ClamAV not configured' });
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }); let out = '';
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs, () => done({ scanned: false, clean: false, detail: 'Scanner timed out' }));
    sock.on('error', (e) => done({ scanned: false, clean: false, detail: `Scanner unavailable: ${e.message}` }));
    sock.on('data', (d) => (out += d.toString()));
    sock.on('end', () => done({ scanned: true, clean: /OK\0?\s*$/.test(out), detail: out.replace(/\0/g, '').trim() }));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += 64 * 1024) { const chunk = buffer.subarray(i, i + 64 * 1024); const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length); sock.write(len); sock.write(chunk); }
      sock.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

/** Policy: when a scanner is configured but unreachable, uploads fail closed unless SCAN_FAIL_OPEN=true. */
export async function scanUpload(buffer, declaredType) {
  const v = validateUpload(buffer, declaredType);
  if (!v.ok) return { ok: false, error: v.error };
  const s = await clamScan(buffer);
  if (s.scanned && !s.clean) return { ok: false, error: 'The file was blocked by the virus scanner.', scan: s.detail };
  if (!s.scanned && process.env.CLAMAV_HOST && process.env.SCAN_FAIL_OPEN !== 'true') return { ok: false, error: 'The virus scanner is unavailable; try again shortly.', scan: s.detail };
  return { ok: true, type: v.type, scan: s.scanned ? 'clean' : 'not_scanned' };
}

// ---------------- Masking for reports ----------------
export const mask = (v, keep = 4) => (v == null || v === '' ? '' : `•••• ${String(v).slice(-keep)}`);
