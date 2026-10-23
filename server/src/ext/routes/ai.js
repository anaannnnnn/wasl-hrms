// AI v2 routes: the multi-step Nexus agent (propose → validate → preview → approve → execute → verify) and the
// multilingual employee copilot over text and voice. Also real PDF letters for the request centre.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Employee, Establishment, LeaveRequest, ServiceRequest, PayrollRun, AgentRun, Notification } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { evaluateRequest, leaveBalances } from '../../lib/leave.js';
import { filsToDisplay } from '../../lib/money.js';
import { GradeBand, ImmigrationCase, FeatureSettings, CopilotMessage, Offer } from '../models.js';
import { extractHire, validateHire, buildHirePlan, onboardingSteps, routeCopilot, reply, transcribe, detectLang } from '../lib/agents.js';
import { letterPdf, PDF_LETTER_TYPES } from '../lib/pdfDocs.js';
import { createOffer, sendOffer } from './talent.js';
import { z, fail, decodeUpload, sendPdf, sealedPdf, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const ref = (p) => `${p}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomUUID().slice(0, 4).toUpperCase()}`;
const killed = async () => !!(await FeatureSettings.findOne().select('agentKillSwitch').lean())?.agentKillSwitch;

// =============================================================== Nexus agent v2 (HR)
async function resolveEstablishment(refText) {
  const ests = await Establishment.find().lean();
  if (!refText) return ests.length === 1 ? ests[0] : null;
  const num = (refText.match(/\d+/) || [])[0];
  return ests.find((e) => refText.toLowerCase().includes(e.name.toLowerCase())) || (num && ests.find((e) => e.tradeLicenceNo?.endsWith(num) || e.mohreId?.endsWith(num))) || (num && ests.sort((a, b) => a.createdAt - b.createdAt)[Number(num) - 1]) || null;
}
r.post('/agent2/propose', requireRole('hr_admin'), ah(async (req, res) => {
  if (await killed()) throw fail(423, 'The AI agent is switched off by an administrator.');
  const { command, establishmentId } = z.object({ command: z.string().min(5).max(2000), establishmentId: z.string().optional() }).parse(req.body);
  if (!/\bhire\b|تعيين|onboard/i.test(command)) throw fail(400, 'The multi-step agent currently runs hiring workflows. For leave, letters and other commands use the AI bar.');
  const { params, engine, aiError } = await extractHire(command);
  const est = establishmentId ? await Establishment.findById(establishmentId).lean() : await resolveEstablishment(params.establishmentRef);
  const v = validateHire(params, { gradeBands: await GradeBand.find().lean(), establishment: est });
  const plan = buildHirePlan(params, v, { establishment: est });
  const run = await AgentRun.create({ userId: req.user.id, command, intent: 'hire_workflow', proposal: { params, validation: v, plan, establishmentId: est?._id, engine, aiError } });
  await audit(req, 'agent2.propose', 'AgentRun', run._id, null, { intent: 'hire_workflow', engine, ok: v.ok }, 'agent');
  res.json({ id: run._id, engine, params, validation: v, plan, establishment: est && { _id: est._id, name: est.name, jurisdiction: est.jurisdiction } });
}));
r.post('/agent2/:id/execute', requireRole('hr_admin'), ah(async (req, res) => {
  if (await killed()) throw fail(423, 'The AI agent is switched off by an administrator.');
  const overrides = z.object({ candidateEmail: z.string().email().optional(), sendNow: z.boolean().default(true) }).parse(req.body || {});
  const run = await AgentRun.findById(req.params.id); if (!run || run.status !== 'proposed' || run.intent !== 'hire_workflow') throw fail(404, 'Proposal not found or already handled');
  if (String(run.userId) !== req.user.id && !req.user.roles.includes('owner')) throw fail(403, 'Only the person who created the proposal can approve it.');
  const { params: p, validation: v, establishmentId } = run.proposal;
  if (!v.ok) throw fail(409, `Resolve first: ${v.issues.join(' ')}`);
  const done = []; const steps = run.proposal.plan.steps.map((s) => ({ ...s }));
  const mark = (id, status, detail) => { const s = steps.find((x) => x.id === id); s.status = status; if (detail) s.detail = detail; done.push(id); };
  try {
    mark('validate', 'ok');
    const offer = await createOffer(req, { candidateName: p.candidateName, candidateEmail: overrides.candidateEmail || p.candidateEmail || undefined, jobTitle: p.jobTitle, grade: v.comp.grade, establishmentId: String(establishmentId), startDate: p.startDate, basic: v.comp.basicFils, housing: v.comp.housingFils, transport: v.comp.transportFils, other: 0, probationMonths: 6, noticeDays: 30, visaType: p.visa === 'uae_national' ? 'UAE National (no visa)' : p.visa === 'freezone' ? 'Free-zone employment visa' : p.visa === 'golden' ? 'Golden visa holder' : 'Mainland employment visa', lang: 'dual' }, 'agent');
    mark('offer', 'done', `Offer ${offer._id} created (PDF available)`);
    if (overrides.sendNow) { const s = await sendOffer(req, offer); mark('esign', 'done', s.emailed ? `Emailed to ${offer.candidateEmail}` : `Link ready: ${s.link}`); run.result = { ...(run.result || {}), signLink: s.emailed ? undefined : s.link }; } else mark('esign', 'skipped', 'Not sent yet');
    const est = await Establishment.findById(establishmentId).lean();
    const vc = await ImmigrationCase.create({ offerId: offer._id, subjectName: p.candidateName, establishmentId, kind: 'new_hire', jurisdiction: est.jurisdiction, steps: onboardingSteps({ startDate: p.startDate, jurisdiction: est.jurisdiction, visa: p.visa }), createdBy: req.user.id, source: 'agent' });
    mark('visa', 'done', `Visa & onboarding tracker ${vc._id} opened`);
    mark('assets', 'scheduled', 'Created automatically when the signed offer is converted to an employee');
    mark('probation', 'scheduled', '30/60/90-day check-ins created on conversion');
    run.status = 'executed'; run.result = { ...(run.result || {}), offerId: offer._id, visaCaseId: vc._id, steps };
    await run.save();
    await audit(req, 'agent2.execute', 'AgentRun', run._id, null, { offerId: offer._id, visaCaseId: vc._id }, 'agent');
    // verify: re-read what was written
    const verify = { offer: !!(await Offer.exists({ _id: offer._id })), visaCase: !!(await ImmigrationCase.exists({ _id: vc._id })) };
    res.json({ message: `${p.candidateName}: offer created${overrides.sendNow ? ' and sent' : ''}, visa tracker opened.`, steps, verify, result: run.result });
  } catch (e) {
    run.status = 'failed'; run.result = { error: e.message, completed: done, steps }; await run.save();
    await audit(req, 'agent2.failed', 'AgentRun', run._id, null, { error: e.message, completed: done }, 'agent');
    throw fail(e.status || 500, `Stopped after ${done.join(', ') || 'no steps'}: ${e.message}. Nothing else was changed.`);
  }
}));
r.post('/agent2/:id/discard', requireRole('hr_admin'), ah(async (req, res) => { const run = await AgentRun.findOneAndUpdate({ _id: req.params.id, status: 'proposed' }, { $set: { status: 'discarded' } }, { new: true }); if (!run) throw fail(404, 'Proposal not found'); await audit(req, 'agent2.discard', 'AgentRun', run._id, null, null, 'agent'); res.json({ ok: true }); }));
r.get('/agent2/runs', requireRole('hr_admin'), ah(async (req, res) => res.json(await AgentRun.find({ intent: 'hire_workflow' }).sort({ createdAt: -1 }).limit(50).lean())));

// =============================================================== Copilot (employees, any channel)
/** Execute an employee copilot request. Used by the app, voice, WhatsApp and Slack. Runs inside the tenant context. */
export async function handleCopilot({ employee, userId, text, channel = 'app', transcript }) {
  if (await killed()) return { intent: 'blocked', reply: 'The assistant is temporarily switched off. Please use the app menus.' };
  const routed = await routeCopilot(text);
  const lang = routed.lang || detectLang(text); let out = { intent: routed.intent, engine: routed.engine };
  const est = await Establishment.findById(employee.establishmentId).lean();
  if (routed.intent === 'leave') {
    const p = routed.params;
    if (!p.startDate) out.reply = reply(lang, 'leave_need');
    else {
      const end = new Date(Date.parse(`${p.startDate}T00:00:00Z`) + (Math.max(1, p.days || 1) - 1) * 864e5).toISOString().slice(0, 10);
      const existing = await LeaveRequest.find({ employeeId: employee._id }).lean();
      const ev = evaluateRequest({ employee, request: { type: p.type || 'annual', startDate: p.startDate, endDate: end }, existing, rulePackId: est?.rulePackId });
      if (!ev.ok) out.reply = reply(lang, 'blocked', ev.errors.join(' '));
      else {
        const lr = await LeaveRequest.create({ employeeId: employee._id, type: p.type || 'annual', startDate: p.startDate, endDate: end, days: ev.days, ...ev.split, warnings: ev.warnings, source: channel === 'whatsapp' ? 'whatsapp' : 'agent', reason: `Via assistant (${channel})` });
        await Notification.create({ audience: 'manager', title: `Leave request: ${employee.fullName}`, body: `${ev.days} day(s) from ${p.startDate} (via ${channel})`, link: '#leave' }).catch(() => {});
        await emitEvent('leave.created', { leaveRequestId: String(lr._id), employeeId: String(employee._id), days: ev.days });
        out = { ...out, leaveRequestId: lr._id, reply: reply(lang, 'leave_ok', ev.days, p.startDate) };
      }
    }
  } else if (routed.intent === 'leave_balance') {
    const b = leaveBalances({ employee, requests: await LeaveRequest.find({ employeeId: employee._id }).lean(), rulePackId: est?.rulePackId });
    out.reply = reply(lang, 'balance', Math.max(0, Math.floor(b.annual.remaining)), b.sick.fullPayLeft);
  } else if (routed.intent === 'payslip') {
    const run = await PayrollRun.findOne({ status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': employee._id }).sort({ period: -1 }).lean();
    const line = run?.lines.find((l) => String(l.employeeId) === String(employee._id));
    out = { ...out, runId: run?._id, reply: run ? reply(lang, 'payslip', run.period, filsToDisplay(line.netFils)) : reply(lang, 'unknown') };
  } else if (routed.intent === 'letter') {
    const auto = ['salary_certificate', 'experience'].includes(routed.params.letterType);
    const sr = await ServiceRequest.create({ employeeId: employee._id, kind: 'letter', letterType: routed.params.letterType, addressee: routed.params.addressee, lang: 'dual', status: auto ? 'done' : 'open', reference: ref('LTR'), closedAt: auto ? new Date() : undefined, details: `Requested via assistant (${channel})`, slaDueAt: new Date(Date.now() + 2 * 864e5) });
    out = { ...out, requestId: sr._id, pdfUrl: auto ? `/api/me/letters/${sr._id}/pdf` : undefined, reply: auto ? reply(lang, 'letter_ok', 'certificate') : reply(lang, 'blocked', 'HR will review this letter and notify you.') };
    if (!auto) await Notification.create({ audience: 'hr', title: `Letter request: ${employee.fullName}`, body: `${routed.params.letterType} to ${routed.params.addressee}`, link: '#requests' }).catch(() => {});
  } else out.reply = reply(lang, 'unknown');
  await CopilotMessage.create({ employeeId: employee._id, userId, channel, lang, text, transcript, intent: out.intent, result: { ...out, reply: undefined }, reply: out.reply });
  return { ...out, lang };
}
r.post('/me/copilot', ah(async (req, res) => {
  const { text } = z.object({ text: z.string().min(2).max(1000) }).parse(req.body);
  const employee = await Employee.findById(req.user.employeeId).lean(); if (!employee) throw fail(404, 'Your employee record was not found.');
  const out = await handleCopilot({ employee, userId: req.user.id, text, channel: 'app' });
  await audit(req, 'copilot.ask', 'CopilotMessage', '', null, { intent: out.intent, lang: out.lang });
  res.json(out);
}));
r.post('/me/copilot/voice', ah(async (req, res) => {
  const { audio, mime, lang } = z.object({ audio: z.string().max(14_000_000), mime: z.string().regex(/^audio\//).default('audio/webm'), lang: z.string().max(5).optional() }).parse(req.body);
  const buf = decodeUpload(audio, 10 * 1024 * 1024);
  const t = await transcribe(buf, mime, lang);
  if (!t.text.trim()) throw fail(422, 'I could not hear anything. Try again closer to the microphone.');
  const employee = await Employee.findById(req.user.employeeId).lean();
  const out = await handleCopilot({ employee, userId: req.user.id, text: t.text, channel: 'voice', transcript: t.text });
  await audit(req, 'copilot.voice', 'CopilotMessage', '', null, { intent: out.intent, lang: out.lang });
  res.json({ transcript: t.text, ...out });
}));
r.get('/me/copilot/history', ah(async (req, res) => res.json(await CopilotMessage.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).limit(30).lean())));
r.get('/copilot/log', requireRole('hr_admin'), ah(async (req, res) => res.json(await CopilotMessage.find().sort({ createdAt: -1 }).limit(200).populate('employeeId', 'fullName').lean())));

// =============================================================== Real PDF letters
async function letterBuffer(req, sr) {
  if (!PDF_LETTER_TYPES.includes(sr.letterType)) throw fail(400, 'Unknown letter type');
  const e = await Employee.findById(sr.employeeId).lean(); const est = await Establishment.findById(e.establishmentId).lean();
  return sealedPdf(req, { kind: `letter:${sr.letterType}`, title: sr.reference, employeeId: e._id }, (seal) => letterPdf({ type: sr.letterType, employee: e, establishment: est, addressee: sr.addressee || 'To whom it may concern', purpose: sr.purpose, lang: sr.lang || 'dual', reference: sr.reference, issuedAt: sr.closedAt || new Date(), seal }));
}
r.get('/me/letters/:requestId/pdf', ah(async (req, res) => {
  const sr = await ServiceRequest.findOne({ _id: req.params.requestId, employeeId: req.user.employeeId, kind: 'letter', status: 'done' }).lean();
  if (!sr) throw fail(404, 'Letter not issued yet.');
  sendPdf(res, await letterBuffer(req, sr), `${sr.letterType}-${sr.reference}.pdf`, false);
}));
r.get('/letters/:requestId/pdf', requireRole('hr_admin'), ah(async (req, res) => {
  const sr = await ServiceRequest.findOne({ _id: req.params.requestId, kind: 'letter' }).lean(); if (!sr) throw fail(404, 'Letter request not found');
  await audit(req, 'letter.pdf', 'ServiceRequest', sr._id); sendPdf(res, await letterBuffer(req, sr), `${sr.letterType}-${sr.reference}.pdf`);
}));
r.post('/letters/pdf', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ employeeId: z.string(), type: z.enum(PDF_LETTER_TYPES), addressee: z.string().max(120).optional(), purpose: z.string().max(200).optional(), lang: z.enum(['en', 'ar', 'dual']).default('dual') }).parse(req.body);
  const e = await Employee.findById(b.employeeId).lean(); if (!e) throw fail(404, 'Employee not found');
  const sr = await ServiceRequest.create({ employeeId: e._id, kind: 'letter', letterType: b.type, addressee: b.addressee, purpose: b.purpose, lang: b.lang, status: 'done', reference: ref('LTR'), handledBy: req.user.id, closedAt: new Date() });
  await audit(req, 'letter.issue', 'ServiceRequest', sr._id, null, { type: b.type, employee: e.fullName, format: 'pdf' });
  sendPdf(res, await letterBuffer(req, sr.toObject()), `${b.type}-${sr.reference}.pdf`);
}));

export default r;
