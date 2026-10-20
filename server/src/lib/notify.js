// Notifications: always stored in-app; optionally delivered by email (Resend HTTP API) and WhatsApp (Meta Cloud API).
// Channels switch on only when their environment variables exist, so nothing is sent from a dev machine by accident.
import { Notification } from '../models/index.js';

export const channels = () => ({
  email: !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
  whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
});

async function sendEmail(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`email ${res.status}`);
}

export async function sendWhatsApp(toE164, text) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toE164.replace(/[^\d]/g, ''), type: 'text', text: { body: text.slice(0, 4000) } }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`whatsapp ${res.status}`);
}

/**
 * @param {object} n { audience: 'hr'|'employee'|'manager', userId?, employeeId?, title, body, link?, severity?, dedupeKey? }
 * @param {object} contact { email?, phone? } optional external delivery
 */
export async function notify(n, contact = {}) {
  if (n.dedupeKey && await Notification.exists({ dedupeKey: n.dedupeKey })) return null; // idempotent
  const doc = await Notification.create({ ...n, deliveries: [] });
  const ch = channels();
  const tasks = [];
  if (contact.email && ch.email) tasks.push(sendEmail(contact.email, n.title, `${n.body}\n\n${n.link || ''}`).then(() => 'email:sent', (e) => `email:failed ${e.message}`));
  if (contact.phone && ch.whatsapp) tasks.push(sendWhatsApp(contact.phone, `${n.title}\n${n.body}`).then(() => 'whatsapp:sent', (e) => `whatsapp:failed ${e.message}`));
  if (tasks.length) { doc.deliveries = await Promise.all(tasks); await doc.save(); }
  return doc;
}
