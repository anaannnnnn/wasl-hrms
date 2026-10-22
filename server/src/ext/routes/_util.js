// Shared helpers for the extension routes.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toFils } from '../../lib/money.js';
import { SealedDocument, Webhook, WebhookDelivery } from '../models.js';
import { newSealCode } from '../lib/platform.js';
import { enqueue } from '../lib/queue.js';

export { z };
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const money = z.union([z.string(), z.number()]).transform((v, ctx) => { try { return toFils(v); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message }); return z.NEVER; } });
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ym = z.string().regex(/^\d{4}-\d{2}$/);
export const oid = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid ID');

/** Decode a base64 / data-URL upload with a size cap. */
export function decodeUpload(data, maxBytes = 8 * 1024 * 1024) {
  if (!data) return null;
  const b64 = String(data).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw fail(400, 'The file is empty.');
  if (buf.length > maxBytes) throw fail(413, `The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  return buf;
}

export const publicBase = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

/** Register a tamper-evident document and return its verification code + URL. */
export async function seal(req, { kind, title, employeeId, buffer }) {
  const code = newSealCode();
  await SealedDocument.create({ code, kind, title, employeeId, sha256: buffer ? createHash('sha256').update(buffer).digest('hex') : undefined, issuedBy: req.user?.id });
  return { code, verifyUrl: `${publicBase(req)}/api/public/verify/${code}` };
}
/** Seal first (code goes on the page), then store the final file hash. */
export async function sealedPdf(req, meta, render) {
  const s = await seal(req, meta);
  const buf = render(s);
  await SealedDocument.updateOne({ code: s.code }, { $set: { sha256: createHash('sha256').update(buf).digest('hex') } });
  return buf;
}

export function sendPdf(res, buf, filename, inline = true) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}
export function sendCsv(res, body, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.end('﻿' + body);
}

/** Emit a domain event to the tenant's webhooks (delivered asynchronously by the job queue). */
export async function emitEvent(event, data, eventId = `${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`) {
  const hooks = await Webhook.find({ active: true, $or: [{ events: event }, { events: '*' }] }).lean();
  for (const h of hooks) {
    try {
      const d = await WebhookDelivery.create({ webhookId: h._id, event, eventId, payload: { id: eventId, type: event, createdAt: new Date().toISOString(), data } });
      await enqueue('webhook.deliver', { deliveryId: String(d._id) }, { idempotencyKey: `wh:${d._id}`, maxAttempts: 8 });
    } catch (e) { if (e?.code !== 11000) throw e; }
  }
}
