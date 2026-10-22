// Unauthenticated endpoints, each with its own trust check: document verification, careers portal,
// candidate offer signing, biometric device pushes (HMAC), WhatsApp (Meta signature), Slack (signing secret)
// and SSO (OIDC). Mounted BEFORE the global JSON parser so signatures are checked against the raw body.
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { Tenant, Employee, Applicant, User, Notification, AuditLog } from '../../models/index.js';
import { runAsSystem, runWithTenant } from '../../lib/tenantContext.js';
import { decryptField } from '../../lib/fieldcrypt.js';
import { putFile } from '../../lib/storage.js';
import { sendWhatsApp } from '../../lib/notify.js';
import { signToken } from '../../middleware/auth.js';
import { config } from '../../config.js';
import { SealedDocument, JobRequisition, CandidateProfile, Offer, AttendanceDevice, Connector } from '../models.js';
import { Establishment } from '../../models/index.js';
import { verifyMeta, verifySlack, deviceSignature, scanUpload } from '../lib/platform.js';
import { parseCv, matchScore, transcribe } from '../lib/agents.js';
import { offerPdf } from '../lib/pdfDocs.js';
import { pkcePair, authorizeUrl, exchangeCode, verifyIdToken } from '../lib/oidc.js';
import { applyDevicePunch } from './time.js';
import { handleCopilot } from './ai.js';
import { z, fail, decodeUpload, sendPdf, publicBase, emitEvent } from './_util.js';

const r = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Raw body for signature checks; JSON/form parsed by hand afterwards.
r.use(express.raw({ type: () => true, limit: '12mb' }), (req, res, next) => {
  req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const ct = req.headers['content-type'] || ''; const txt = req.rawBody.toString('utf8');
  try { req.body = ct.includes('application/json') && txt ? JSON.parse(txt) : ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(txt)) : txt; } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  req._body = true; next();
});
r.use(rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again in a minute.' } }));
const asTenant = (tenantId, fn) => runWithTenant({ tenantId: String(tenantId) }, fn);
const tenantOr404 = async (id) => { if (!/^[0-9a-f]{24}$/i.test(id)) throw fail(404, 'Not found'); const t = await runAsSystem(() => Tenant.findById(id).select('name').lean()); if (!t) throw fail(404, 'Not found'); return t; };
const sysAudit = (tenantId, action, entity, entityId, after) => asTenant(tenantId, () => AuditLog.create({ actorType: 'system', action, entity, entityId: String(entityId ?? ''), after }).catch(() => {}));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// =============================================================== Document verification
r.get('/verify/:code', ah(async (req, res) => {
  const d = await runAsSystem(() => SealedDocument.findOne({ code: String(req.params.code).toUpperCase() }).lean());
  const t = d ? await runAsSystem(() => Tenant.findById(d.tenantId).select('name').lean()) : null;
  const out = d ? { valid: !d.revokedAt, issuer: t?.name, kind: d.kind, title: d.title, issuedAt: d.createdAt, sha256: d.sha256, revokedAt: d.revokedAt } : { valid: false };
  if (!(req.headers.accept || '').includes('text/html')) return res.json(out);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Document verification</title><body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#14211d"><h1 style="font-size:22px">${out.valid ? '✔ Genuine document' : '✖ Not verified'}</h1>${d ? `<p><b>${esc(out.title)}</b> (${esc(out.kind)})<br>Issued by ${esc(out.issuer)} on ${new Date(out.issuedAt).toISOString().slice(0, 10)}${out.revokedAt ? '<br><b>Revoked</b>' : ''}</p><p style="font-size:12px;color:#5b6b66">File fingerprint (SHA-256): ${esc(out.sha256 || '')}<br>Compare with the PDF you received: <code>shasum -a 256 file.pdf</code></p>` : '<p>No document with this code was issued through Wasl HRMS.</p>'}</body>`);
}));

// =============================================================== Careers portal
r.get('/careers/:tenantId', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const jobs = await asTenant(t._id, () => JobRequisition.find({ status: 'open' }).select('title department location employmentType description requirements publicSlug publishedAt').sort({ publishedAt: -1 }).lean());
  res.json({ company: t.name, jobs });
}));
r.post('/careers/:tenantId/:reqId/apply', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many applications from this connection. Try later.' } }), ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const b = z.object({ name: z.string().min(2).max(100), email: z.string().email(), phone: z.string().max(30).optional(), visaStatus: z.enum(['visit_visa', 'residence_on_notice', 'golden_visa', 'uae_national', 'outside_uae', 'other']).default('other'), cvText: z.string().max(60000).optional(), file: z.string().optional(), contentType: z.string().optional(), fileName: z.string().max(120).optional(), consent: z.literal(true, { errorMap: () => ({ message: 'Please accept the privacy notice.' }) }), website: z.string().max(0).optional() }).parse(req.body);
  const out = await asTenant(t._id, async () => {
    const rq = await JobRequisition.findOne({ _id: req.params.reqId, status: 'open' }).lean(); if (!rq) throw fail(404, 'This job is no longer open.');
    if (await Applicant.exists({ email: b.email.toLowerCase(), role: rq.title })) throw fail(409, 'You have already applied for this job.');
    let cv, buffer, type;
    if (b.file) { buffer = decodeUpload(b.file, 5 * 1024 * 1024); const s = await scanUpload(buffer, b.contentType); if (!s.ok) throw fail(400, s.error); type = s.type; cv = { ...(await putFile({ tenantId: String(t._id), buffer, declaredType: s.type })), fileName: b.fileName }; }
    const ap = await Applicant.create({ name: b.name, email: b.email.toLowerCase(), phone: b.phone, role: rq.title, department: rq.department, establishmentId: rq.establishmentId, visaStatus: b.visaStatus, source: 'careers_portal', stage: 'applied' });
    const parsed = await parseCv({ buffer, contentType: type, text: b.cvText });
    await CandidateProfile.create({ applicantId: ap._id, requisitionId: rq._id, cv, parsed, match: matchScore({ ...parsed, inUae: ['residence_on_notice', 'golden_visa', 'uae_national', 'visit_visa'].includes(b.visaStatus) }, rq) });
    await Notification.create({ audience: 'hr', title: `New applicant: ${b.name}`, body: rq.title, link: '#talent' }).catch(() => {});
    await AuditLog.create({ actorType: 'system', action: 'applicant.apply', entity: 'Applicant', entityId: String(ap._id), after: { requisition: rq.title, source: 'careers_portal' } });
    return { ok: true };
  });
  res.status(201).json({ ...out, message: 'Thank you. Your application was received.' });
}));

// =============================================================== Offers (candidate side)
const offerByToken = async (tenantId, token) => {
  const o = await Offer.findOne({ signTokenHash: createHash('sha256').update(String(token)).digest('hex') });
  if (!o) throw fail(404, 'This offer link is not valid.');
  if (o.expiresAt && o.expiresAt < new Date() && o.status !== 'signed') { o.status = 'expired'; await o.save(); throw fail(410, 'This offer has expired. Please contact the company.'); }
  return o;
};
r.get('/offers/:tenantId/:token', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const out = await asTenant(t._id, async () => {
    const o = await offerByToken(t._id, req.params.token); const est = await Establishment.findById(o.establishmentId).select('name nameAr jurisdiction').lean();
    if (o.status === 'sent') { o.status = 'viewed'; await o.save(); }
    return { company: est?.name, companyAr: est?.nameAr, candidateName: o.candidateName, jobTitle: o.jobTitle, startDate: o.startDate, basicFils: o.basicFils, housingFils: o.housingFils, transportFils: o.transportFils, otherFils: o.otherFils, probationMonths: o.probationMonths, noticeDays: o.noticeDays, visaType: o.visaType, status: o.status, expiresAt: o.expiresAt, signedAt: o.signature?.at, documents: (o.documents || []).map((d) => ({ kind: d.kind, fileName: d.fileName, at: d.at })) };
  });
  res.json(out);
}));
r.get('/offers/:tenantId/:token/pdf', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const buf = await asTenant(t._id, async () => { const o = await offerByToken(t._id, req.params.token); const est = await Establishment.findById(o.establishmentId).lean(); return offerPdf({ offer: o.toObject(), establishment: est, seal: {}, signature: o.signature }); });
  sendPdf(res, buf, 'offer.pdf');
}));
r.post('/offers/:tenantId/:token/sign', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const b = z.object({ name: z.string().min(2).max(100), accept: z.literal(true), signature: z.string().regex(/^data:image\/png;base64,/).max(400000) }).parse(req.body);
  await asTenant(t._id, async () => {
    const o = await offerByToken(t._id, req.params.token); if (!['sent', 'viewed'].includes(o.status)) throw fail(409, `This offer is ${o.status}.`);
    if (b.name.trim().toLowerCase() !== o.candidateName.trim().toLowerCase()) throw fail(400, 'Type your full name exactly as it appears on the offer.');
    const est = await Establishment.findById(o.establishmentId).lean();
    const docHash = createHash('sha256').update(offerPdf({ offer: o.toObject(), establishment: est, seal: {} })).digest('hex');
    o.signature = { name: b.name, imageDataUrl: b.signature, at: new Date(), ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200), docHash };
    o.status = 'signed'; await o.save();
    await Notification.create({ audience: 'hr', title: `Offer signed: ${o.candidateName}`, body: `${o.jobTitle}. Convert to employee to start onboarding.`, link: '#talent' }).catch(() => {});
    await AuditLog.create({ actorType: 'system', action: 'offer.signed', entity: 'Offer', entityId: String(o._id), after: { ip: req.ip, docHash } });
    await emitEvent('offer.signed', { offerId: String(o._id) });
  });
  res.json({ ok: true, message: 'Thank you. Your signed offer has been sent to HR.' });
}));
r.post('/offers/:tenantId/:token/decline', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId); const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {});
  await asTenant(t._id, async () => { const o = await offerByToken(t._id, req.params.token); if (o.status === 'signed') throw fail(409, 'This offer is already signed.'); o.status = 'declined'; await o.save(); await Notification.create({ audience: 'hr', title: `Offer declined: ${o.candidateName}`, body: reason || '', link: '#talent', severity: 'warn' }).catch(() => {}); });
  res.json({ ok: true });
}));
r.post('/offers/:tenantId/:token/documents', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const b = z.object({ kind: z.enum(['passport', 'photo', 'education_certificate', 'experience_letter', 'emirates_id', 'visa', 'other']), file: z.string(), contentType: z.string(), fileName: z.string().max(120).optional() }).parse(req.body);
  const out = await asTenant(t._id, async () => {
    const o = await offerByToken(t._id, req.params.token); if (['declined', 'withdrawn'].includes(o.status)) throw fail(409, 'This offer is closed.');
    if ((o.documents || []).length >= 15) throw fail(400, 'Upload limit reached.');
    const buf = decodeUpload(b.file); const s = await scanUpload(buf, b.contentType); if (!s.ok) throw fail(400, s.error);
    const f = await putFile({ tenantId: String(t._id), buffer: buf, declaredType: s.type });
    o.documents.push({ kind: b.kind, fileName: b.fileName, ...f, at: new Date() }); await o.save(); return { uploaded: o.documents.length };
  });
  res.status(201).json(out);
}));

// =============================================================== Biometric devices
function parseDevicePayload(req, vendor) {
  const body = req.body;
  if (typeof body === 'string' && /\t/.test(body)) // ZKTeco ADMS ATTLOG: PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify
    return body.trim().split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 2).map((p) => ({ employeeNo: p[0].trim(), time: `${p[1].trim().replace(' ', 'T')}+04:00`, direction: p[2] === '0' ? 'in' : p[2] === '1' ? 'out' : 'auto', verifyMode: p[3], eventId: `${p[0]}:${p[1]}` }));
  if (vendor === 'hikvision' && body?.AccessControllerEvent) { const e = body.AccessControllerEvent; return [{ employeeNo: String(e.employeeNoString || e.employeeNo || ''), time: body.dateTime, direction: 'auto', verifyMode: e.currentVerifyMode, eventId: `${e.serialNo || ''}:${body.dateTime}` }]; }
  return (body?.events || []).map((e) => ({ employeeNo: String(e.employeeNo), time: e.time, direction: e.direction || 'auto', verifyMode: e.verifyMode, eventId: e.eventId }));
}
r.post('/devices/punch', ah(async (req, res) => {
  const keyId = String(req.headers['x-wasl-key'] || req.query.key || '');
  const device = await runAsSystem(() => AttendanceDevice.findOne({ keyId, active: true }).select('+secretEnc').lean());
  if (!device) throw fail(401, 'Unknown device');
  const sig = String(req.headers['x-wasl-signature'] || '');
  const expected = deviceSignature(decryptField(device.secretEnc), req.rawBody);
  if (!sig || sig.length !== expected.length || !createHash('sha256').update(sig).digest().equals(createHash('sha256').update(expected).digest())) throw fail(401, 'Invalid signature');
  const events = parseDevicePayload(req, device.vendor).slice(0, 500);
  const results = await asTenant(device.tenantId, async () => {
    const out = [];
    for (const e of events) { const at = new Date(e.time); if (Number.isNaN(+at) || Math.abs(Date.now() - at) > 7 * 864e5) { out.push({ eventId: e.eventId, result: 'bad_time' }); continue; } out.push({ eventId: e.eventId, result: await applyDevicePunch({ device, employeeNo: e.employeeNo, at, direction: e.direction, eventId: e.eventId, verifyMode: e.verifyMode, raw: e }) }); }
    await AttendanceDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date(), lastError: null } });
    return out;
  });
  res.json({ received: events.length, results });
}));

// =============================================================== WhatsApp (Meta Cloud API) inbound
r.get('/whatsapp/webhook', (req, res) => (req.query['hub.verify_token'] && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN ? res.end(String(req.query['hub.challenge'] || '')) : res.status(403).end()));
const digits = (p) => String(p || '').replace(/\D/g, '');
async function employeeByPhone(phone) {
  const tail = digits(phone).slice(-9); if (tail.length < 9) return null;
  const list = await runAsSystem(() => Employee.find({ phone: { $regex: tail.split('').join('\\D*') + '$' }, status: { $in: ['active', 'notice', 'onboarding'] } }).lean());
  return list.length === 1 ? list[0] : null; // ambiguous numbers are ignored for safety
}
async function whatsappMedia(id) {
  const meta = await fetch(`https://graph.facebook.com/v20.0/${id}`, { headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }).then((x) => x.json());
  const bin = await fetch(meta.url, { headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  return { buffer: Buffer.from(await bin.arrayBuffer()), mime: meta.mime_type || 'audio/ogg' };
}
r.post('/whatsapp/webhook', ah(async (req, res) => {
  if (!verifyMeta(process.env.WHATSAPP_APP_SECRET, req.rawBody, req.headers['x-hub-signature-256'])) return res.status(401).end();
  res.status(200).json({ ok: true }); // acknowledge fast; Meta retries slow webhooks
  const msgs = (req.body?.entry || []).flatMap((e) => e.changes || []).flatMap((c) => c.value?.messages || []);
  for (const m of msgs.slice(0, 10)) {
    try {
      const emp = await employeeByPhone(m.from);
      if (!emp) { await sendWhatsApp(m.from, 'Sorry, this number is not registered with your HR system. Ask HR to update your mobile number.'); continue; }
      let text = m.text?.body; let transcript;
      if (!text && m.type === 'audio' && m.audio?.id) { const media = await whatsappMedia(m.audio.id); transcript = (await transcribe(media.buffer, media.mime)).text; text = transcript; }
      if (!text) continue;
      const out = await asTenant(emp.tenantId, () => handleCopilot({ employee: emp, text, channel: 'whatsapp', transcript }));
      await sendWhatsApp(m.from, out.reply + (out.pdfUrl ? `\n${process.env.PUBLIC_URL || ''}/employee` : ''));
    } catch (e) { console.warn('WhatsApp message failed:', e.message); }
  }
}));

// =============================================================== Slack slash command (/wasl …)
r.post('/slack/command', ah(async (req, res) => {
  if (!verifySlack(process.env.SLACK_SIGNING_SECRET, req.rawBody.toString('utf8'), req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'])) return res.status(401).end();
  const { user_id: slackUser, text = '' } = req.body;
  let email = null;
  if (process.env.SLACK_BOT_TOKEN) { const u = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUser)}`, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }).then((x) => x.json()).catch(() => null); email = u?.user?.profile?.email?.toLowerCase(); }
  if (!email) return res.json({ response_type: 'ephemeral', text: 'I could not match your Slack account to a Wasl user (needs SLACK_BOT_TOKEN with users:read.email).' });
  const users = await runAsSystem(() => User.find({ email, active: true }).lean());
  if (users.length !== 1) return res.json({ response_type: 'ephemeral', text: 'Your Slack email is not linked to exactly one Wasl account.' });
  const u = users[0];
  const out = await asTenant(u.tenantId, async () => {
    const emp = u.employeeId ? await Employee.findById(u.employeeId).lean() : null;
    if (/^\s*hire\b/i.test(text) && u.roles.some((x) => ['hr_admin', 'owner'].includes(x))) return { reply: `Open Wasl → AI agent and paste: "${text.trim()}". Hiring actions always need approval in the app.` };
    if (!emp) return { reply: 'Your account has no employee record, so I cannot file requests for you.' };
    return handleCopilot({ employee: emp, userId: u._id, text, channel: 'slack' });
  });
  res.json({ response_type: 'ephemeral', text: out.reply });
}));

// =============================================================== SSO (OIDC)
r.get('/sso/:tenantId/start', ah(async (req, res) => {
  const t = await tenantOr404(req.params.tenantId);
  const c = await asTenant(t._id, () => Connector.findOne({ kind: 'sso', enabled: true, killSwitch: false }).lean());
  if (!c) throw fail(404, 'Single sign-on is not enabled for this organisation.');
  const { verifier, challenge } = pkcePair(); const nonce = createHash('sha256').update(verifier + Date.now()).digest('hex').slice(0, 32);
  const state = jwt.sign({ tid: String(t._id), v: verifier, n: nonce }, config.jwtSecret, { expiresIn: '10m' });
  res.redirect(await authorizeUrl({ issuer: c.config.issuer, clientId: c.config.clientId, redirectUri: `${publicBase(req)}/api/public/sso/callback`, state, nonce, challenge }));
}));
r.get('/sso/callback', ah(async (req, res) => {
  let st; try { st = jwt.verify(String(req.query.state || ''), config.jwtSecret); } catch { throw fail(400, 'Sign-in session expired. Start again.'); }
  if (req.query.error) throw fail(401, `Sign-in was cancelled: ${req.query.error_description || req.query.error}`);
  const { user, token } = await asTenant(st.tid, async () => {
    const c = await Connector.findOne({ kind: 'sso', enabled: true, killSwitch: false }).select('+secretEnc').lean(); if (!c) throw fail(404, 'SSO disabled');
    const idt = await exchangeCode({ issuer: c.config.issuer, clientId: c.config.clientId, clientSecret: c.secretEnc ? decryptField(c.secretEnc) : undefined, redirectUri: `${publicBase(req)}/api/public/sso/callback`, code: String(req.query.code), verifier: st.v });
    const claims = await verifyIdToken(idt, { issuer: c.config.issuer, clientId: c.config.clientId, nonce: st.n });
    const email = String(claims.email || claims.preferred_username || '').toLowerCase();
    if (!email || (claims.email_verified === false)) throw fail(403, 'Your identity provider did not return a verified email.');
    if (c.config.emailDomain && !email.endsWith(`@${c.config.emailDomain.toLowerCase()}`)) throw fail(403, 'This email domain is not allowed.');
    const u = await User.findOne({ email, active: true }).lean(); if (!u) throw fail(403, 'No active Wasl account for this email. Ask HR to create one.');
    await AuditLog.create({ actorId: u._id, actorType: 'user', action: 'auth.sso.login', entity: 'User', entityId: String(u._id), after: { issuer: claims.iss } });
    return { user: u, token: signToken(u) };
  });
  const payload = Buffer.from(JSON.stringify({ token, user: { name: user.name, email: user.email, roles: user.roles, employeeId: user.employeeId, mfaEnabled: user.mfaEnabled, sso: true } })).toString('base64url');
  res.redirect(`/sso.html#${payload}`);
}));

r.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'Some fields are missing or invalid.', fields: err.flatten().fieldErrors });
  if (err?.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Something went wrong.' });
});
export default r;
export const _test = { parseDevicePayload, sysAudit };
