// MVP completion routes: employee self-service, notifications, payslips, letters, off-cycle & final settlement,
// document uploads + OCR, CSV import, go-live checklist, rule registry and tenant settings.
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  Tenant, User, Establishment, Employee, ComplianceDocument, LeaveRequest, PayrollRun, WpsSifBatch, Notification, ServiceRequest,
} from '../models/index.js';
import { authenticate, requireRole, restrictEmployees, isStaff, audit, ah } from '../middleware/auth.js';
import { runAsSystem } from '../lib/tenantContext.js';
import { renderPayslip, renderLetter, LETTER_TYPES } from '../lib/documents.js';
import { leaveBalances } from '../lib/leave.js';
import { finalSettlement } from '../lib/settlement.js';
import { putFile, getFile } from '../lib/storage.js';
import { aiEnabled, ocrDocument, DOC_TYPES } from '../lib/ai.js';
import { notify, channels } from '../lib/notify.js';
import { validateImport, templateCsv } from '../lib/importer.js';
import { isValidUaeIban } from '../lib/iban.js';
import { listRulePacks } from '../lib/rules.js';
import { toFils } from '../lib/money.js';

const r = Router();
r.use(authenticate, restrictEmployees);

const sendHtml = (res, html) => res.type('html').send(html);
const ref = (p) => `${p}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomUUID().slice(0, 4).toUpperCase()}`;
const myEmployee = async (req) => {
  if (!req.user.employeeId) { const e = new Error('Your login is not linked to an employee record.'); e.status = 400; throw e; }
  return Employee.findById(req.user.employeeId).lean();
};

// ---------------- Employee self-service ----------------
r.get('/me/profile', ah(async (req, res) => {
  const e = await myEmployee(req);
  const est = await Establishment.findById(e.establishmentId).select('name nameAr jurisdiction freeZone').lean();
  res.json({ ...e, establishment: est, bank: { bankName: e.bank?.bankName, ibanMasked: e.bank?.ibanLast4 ? `AE•• •••• ${e.bank.ibanLast4}` : null } });
}));

r.get('/me/balances', ah(async (req, res) => {
  const e = await myEmployee(req);
  const est = await Establishment.findById(e.establishmentId).lean();
  res.json(leaveBalances({ employee: e, requests: await LeaveRequest.find({ employeeId: e._id }).lean(), rulePackId: est?.rulePackId }));
}));

r.get('/me/leave', ah(async (req, res) => res.json(await LeaveRequest.find({ employeeId: req.user.employeeId }).sort({ startDate: -1 }).lean())));

r.get('/me/payslips', ah(async (req, res) => {
  const runs = await PayrollRun.find({ status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': req.user.employeeId }).sort({ period: -1 }).lean();
  res.json(runs.map((run) => { const l = run.lines.find((x) => String(x.employeeId) === String(req.user.employeeId)); return { runId: run._id, period: run.period, type: run.type, netFils: l.netFils, grossFils: l.grossFils }; }));
}));

r.get('/me/payslips/:runId', ah(async (req, res) => sendHtml(res, await payslipHtml(req.params.runId, req.user.employeeId, true))));

r.get('/me/documents', ah(async (req, res) => {
  const docs = await ComplianceDocument.find({ employeeId: req.user.employeeId }).sort({ expiryDate: 1 }).lean();
  res.json(docs.map((d) => ({ ...d, daysLeft: Math.ceil((new Date(d.expiryDate) - Date.now()) / 864e5), hasFile: !!d.storageKey })));
}));

r.get('/me/requests', ah(async (req, res) => res.json(await ServiceRequest.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean())));

r.post('/me/requests', ah(async (req, res) => {
  const b = z.object({
    kind: z.enum(['letter', 'bank_change', 'personal_data', 'salary_query', 'document_renewal', 'it_facilities', 'other']),
    letterType: z.enum(LETTER_TYPES).optional(), addressee: z.string().max(120).optional(), purpose: z.string().max(200).optional(),
    lang: z.enum(['en', 'ar', 'dual']).optional(), details: z.string().max(2000).optional(), iban: z.string().optional(),
  }).parse(req.body);
  if (b.kind === 'letter' && !b.letterType) return res.status(400).json({ error: 'Choose a letter type.' });
  if (b.kind === 'bank_change' && (!b.iban || !isValidUaeIban(b.iban.replace(/\s/g, '')))) return res.status(400).json({ error: 'Enter a valid UAE IBAN (23 characters starting with AE).' });
  const sla = new Date(Date.now() + (b.kind === 'letter' ? 2 : 5) * 864e5);
  const doc = await ServiceRequest.create({ employeeId: req.user.employeeId, ...b, payload: b.iban ? { iban: b.iban.replace(/\s/g, '') } : undefined, reference: ref('REQ'), slaDueAt: sla });
  await notify({ audience: 'hr', title: `New ${b.kind.replace(/_/g, ' ')} request`, body: `${req.user.name} · ${doc.reference}`, link: '#requests', severity: 'info' });
  await audit(req, 'request.create', 'ServiceRequest', doc._id, null, { kind: b.kind });
  res.status(201).json(doc);
}));

r.get('/me/letters/:requestId', ah(async (req, res) => {
  const sr = await ServiceRequest.findOne({ _id: req.params.requestId, employeeId: req.user.employeeId, kind: 'letter', status: 'done' }).lean();
  if (!sr) return res.status(404).json({ error: 'Letter not issued yet.' });
  const e = await Employee.findById(sr.employeeId).lean(); const est = await Establishment.findById(e.establishmentId).lean();
  sendHtml(res, renderLetter({ type: sr.letterType, employee: e, establishment: est, addressee: sr.addressee, purpose: sr.purpose, lang: sr.lang, reference: sr.reference, issuedAt: sr.closedAt }));
}));

// ---------------- Notifications ----------------
const notifQuery = (req) => (isStaff(req.user) ? { audience: { $in: ['hr', 'manager'] } } : { audience: 'employee', employeeId: req.user.employeeId });
r.get('/notifications', ah(async (req, res) => {
  const q = notifQuery(req);
  const list = await Notification.find(q).sort({ createdAt: -1 }).limit(30).lean();
  res.json(list.map((n) => ({ ...n, read: (n.readBy || []).some((u) => String(u) === req.user.id) })));
}));
r.post('/notifications/read-all', ah(async (req, res) => {
  await Notification.updateMany(notifQuery(req), { $addToSet: { readBy: req.user.id } });
  res.json({ ok: true });
}));

// ---------------- Request centre (HR side) ----------------
r.get('/requests', requireRole('hr_admin'), ah(async (req, res) => {
  res.json(await ServiceRequest.find(req.query.status ? { status: req.query.status } : {}).populate('employeeId', 'fullName employeeNo').sort({ createdAt: -1 }).lean());
}));

r.post('/requests/:id/decision', requireRole('hr_admin'), ah(async (req, res) => {
  const { decision, comment } = z.object({ decision: z.enum(['done', 'rejected', 'in_progress']), comment: z.string().max(500).optional() }).parse(req.body);
  const sr = await ServiceRequest.findById(req.params.id);
  if (!sr) return res.status(404).json({ error: 'Request not found' });
  if (decision === 'done' && sr.kind === 'bank_change' && sr.payload?.iban) {
    const e = await Employee.findById(sr.employeeId).select('+bank.iban');
    e.bank.iban = sr.payload.iban; await e.save();
  }
  sr.status = decision; sr.handledBy = req.user.id;
  if (comment) sr.comments.push({ by: req.user.id, text: comment, at: new Date() });
  if (decision !== 'in_progress') sr.closedAt = new Date();
  await sr.save();
  await notify({ audience: 'employee', employeeId: sr.employeeId, title: `Your request ${sr.reference} is ${decision.replace('_', ' ')}`, body: comment || (sr.kind === 'letter' && decision === 'done' ? 'Your letter is ready in My Workspace.' : ''), severity: decision === 'rejected' ? 'warn' : 'info' });
  await audit(req, `request.${decision}`, 'ServiceRequest', sr._id, null, { kind: sr.kind });
  res.json(sr);
}));

// ---------------- Letters (HR) ----------------
r.get('/letters/types', ah(async (req, res) => res.json(LETTER_TYPES)));
r.post('/letters', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ employeeId: z.string(), type: z.enum(LETTER_TYPES), addressee: z.string().max(120).optional(), purpose: z.string().max(200).optional(), lang: z.enum(['en', 'ar', 'dual']).default('dual') }).parse(req.body);
  const e = await Employee.findById(b.employeeId).lean();
  if (!e) return res.status(404).json({ error: 'Employee not found' });
  const est = await Establishment.findById(e.establishmentId).lean();
  const sr = await ServiceRequest.create({ employeeId: e._id, kind: 'letter', letterType: b.type, addressee: b.addressee, purpose: b.purpose, lang: b.lang, status: 'done', reference: ref('LTR'), handledBy: req.user.id, closedAt: new Date() });
  await audit(req, 'letter.issue', 'ServiceRequest', sr._id, null, { type: b.type, employee: e.fullName });
  sendHtml(res, renderLetter({ ...b, employee: e, establishment: est, reference: sr.reference, issuedBy: req.user.name }));
}));

// ---------------- Payslips ----------------
async function payslipHtml(runId, employeeId, selfService) {
  const run = await PayrollRun.findById(runId).lean();
  if (!run) { const e = new Error('Payroll run not found'); e.status = 404; throw e; }
  if (selfService && !['approved', 'exported', 'paid'].includes(run.status)) { const e = new Error('Payslip not released yet.'); e.status = 404; throw e; }
  const line = run.lines.find((l) => String(l.employeeId) === String(employeeId));
  if (!line) { const e = new Error('No payslip for this employee in this run.'); e.status = 404; throw e; }
  const employee = await Employee.findById(employeeId).lean();
  const establishment = await Establishment.findById(run.establishmentId).lean();
  const year = run.period.slice(0, 4);
  const ytdRuns = await PayrollRun.find({ period: { $gte: `${year}-01`, $lte: run.period }, status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': employeeId }).select('lines.$').lean();
  const ytd = ytdRuns.reduce((a, x) => ({ grossFils: a.grossFils + (x.lines[0]?.grossFils || 0), netFils: a.netFils + (x.lines[0]?.netFils || 0) }), { grossFils: 0, netFils: 0 });
  return renderPayslip({ employee, establishment, run, line, ytd });
}

r.get('/payroll/runs/:id/payslips/:employeeId', requireRole('hr_admin', 'payroll_maker', 'payroll_checker'), ah(async (req, res) => sendHtml(res, await payslipHtml(req.params.id, req.params.employeeId, false))));

r.post('/payroll/runs/:id/payslips/send', requireRole('hr_admin', 'payroll_maker'), ah(async (req, res) => {
  const run = await PayrollRun.findById(req.params.id).lean();
  if (!['approved', 'exported', 'paid'].includes(run?.status)) return res.status(400).json({ error: 'Payslips are released after the payroll is approved.' });
  const emps = await Employee.find({ _id: { $in: run.lines.map((l) => l.employeeId) } }).select('fullName email phone').lean();
  let sent = 0;
  for (const e of emps) {
    await notify({ audience: 'employee', employeeId: e._id, title: `Your payslip for ${run.period} is ready`, body: 'Open My Workspace → Payslips to view or save it as PDF.', dedupeKey: `payslip:${run._id}:${e._id}` }, { email: e.email, phone: e.phone });
    sent++;
  }
  await audit(req, 'payslips.release', 'PayrollRun', run._id, null, { count: sent, channels: channels() });
  res.json({ released: sent, channels: channels() });
}));

// ---------------- Off-cycle payroll ----------------
r.post('/payroll/offcycle', requireRole('payroll_maker', 'hr_admin'), ah(async (req, res) => {
  const b = z.object({ establishmentId: z.string(), period: z.string().regex(/^\d{4}-\d{2}$/), title: z.string().min(3).max(80), items: z.array(z.object({ employeeId: z.string(), amount: z.union([z.string(), z.number()]), label: z.string().max(60).optional() })).min(1) }).parse(req.body);
  const emps = await Employee.find({ _id: { $in: b.items.map((i) => i.employeeId) }, establishmentId: b.establishmentId }).lean();
  if (emps.length !== new Set(b.items.map((i) => i.employeeId)).size) return res.status(400).json({ error: 'Every employee must belong to the selected establishment.' });
  const last = await PayrollRun.findOne({ establishmentId: b.establishmentId, period: b.period, type: 'offcycle' }).sort({ runNo: -1 }).lean();
  const lines = b.items.map((i) => {
    const e = emps.find((x) => String(x._id) === i.employeeId); const amt = toFils(i.amount);
    if (amt <= 0) throw Object.assign(new Error('Amounts must be positive.'), { status: 400 });
    return { employeeId: e._id, employeeName: e.fullName, fixedFils: 0, variableFils: amt, grossFils: amt, deductionsFils: 0, netFils: amt, unpaidLeaveDays: 0, flags: [{ code: 'OFFCYCLE', severity: 'info', msg: i.label || b.title }], held: false };
  });
  const total = lines.reduce((a, l) => a + l.netFils, 0);
  const run = await PayrollRun.create({ establishmentId: b.establishmentId, period: b.period, type: 'offcycle', runNo: (last?.runNo || 0) + 1, title: b.title, lines, totals: { grossFils: total, netFils: total, heldFils: 0 }, rulePack: 'n/a', makerId: req.user.id, status: 'draft' });
  await audit(req, 'payroll.offcycle.create', 'PayrollRun', run._id, null, { title: b.title, totalFils: total });
  res.status(201).json(run);
}));

// ---------------- Final settlement ----------------
const settlementInput = z.object({ employeeId: z.string(), lastWorkingDate: z.string(), noticePayDays: z.number().min(0).max(90).default(0), outstandingLoan: z.union([z.string(), z.number()]).default(0), otherDeductions: z.union([z.string(), z.number()]).default(0), otherEarnings: z.union([z.string(), z.number()]).default(0), reason: z.string().max(200).optional() });
async function settle(b, req) {
  const e = await Employee.findById(b.employeeId).lean();
  if (!e) throw Object.assign(new Error('Employee not found'), { status: 404 });
  const est = await Establishment.findById(e.establishmentId).lean();
  const tenant = await runAsSystem(() => Tenant.findById(req.user.tenantId).lean());
  const leaves = await LeaveRequest.find({ employeeId: e._id }).lean();
  const bal = leaveBalances({ employee: e, requests: leaves, onDate: b.lastWorkingDate, rulePackId: est.rulePackId });
  const unpaid = leaves.filter((l) => l.status === 'approved').reduce((a, l) => a + (l.unpaidDays || 0), 0);
  const s = finalSettlement({ employee: e, lastWorkingDate: b.lastWorkingDate, unusedLeaveDays: Math.max(0, bal.annual.remaining), unpaidLeaveDays: unpaid, noticePayDays: b.noticePayDays, outstandingLoanFils: toFils(b.outstandingLoan), otherDeductionsFils: toFils(b.otherDeductions), otherEarningsFils: toFils(b.otherEarnings), jurisdiction: est.rulePackId, capBasis: tenant?.settings?.gratuityCapBasis });
  return { e, est, s, unusedLeaveDays: Math.max(0, bal.annual.remaining) };
}
r.post('/payroll/settlements/preview', requireRole('hr_admin', 'payroll_maker'), ah(async (req, res) => {
  const { s, unusedLeaveDays } = await settle(settlementInput.parse(req.body), req);
  res.json({ ...s, unusedLeaveDays });
}));
r.post('/payroll/settlements', requireRole('hr_admin', 'payroll_maker'), ah(async (req, res) => {
  const b = settlementInput.parse(req.body);
  const { e, est, s, unusedLeaveDays } = await settle(b, req);
  const period = b.lastWorkingDate.slice(0, 7);
  const last = await PayrollRun.findOne({ establishmentId: est._id, period, type: 'final' }).sort({ runNo: -1 }).lean();
  const fixed = Math.max(0, Math.min(s.wps.fixedFils, s.netFils)), variable = Math.max(0, s.netFils - fixed);
  const run = await PayrollRun.create({
    establishmentId: est._id, period, type: 'final', runNo: (last?.runNo || 0) + 1, title: `Final settlement · ${e.fullName}`,
    lines: [{ employeeId: e._id, employeeName: e.fullName, fixedFils: fixed, variableFils: variable, grossFils: s.grossFils, deductionsFils: s.deductionsFils, netFils: s.netFils, unpaidLeaveDays: 0, flags: [{ code: 'FINAL', severity: 'info', msg: b.reason || 'Final settlement' }], held: false }],
    totals: { grossFils: s.grossFils, netFils: s.netFils, heldFils: 0 }, rulePack: s.rulePack, makerId: req.user.id, status: 'draft',
    settlement: { employeeId: e._id, lastWorkingDate: b.lastWorkingDate, reason: b.reason, unusedLeaveDays, ...s },
  });
  await Employee.updateOne({ _id: e._id }, { status: 'notice' });
  await audit(req, 'payroll.settlement.create', 'PayrollRun', run._id, null, { employee: e.fullName, netFils: s.netFils });
  res.status(201).json(run);
}));

// ---------------- Document vault ----------------
const fileBody = z.object({ fileBase64: z.string().min(10), contentType: z.string(), fileName: z.string().max(200).optional() });
r.post('/documents/ocr', requireRole('hr_admin'), ah(async (req, res) => {
  const b = fileBody.parse(req.body);
  if (!aiEnabled()) return res.json({ available: false, message: 'Automatic reading is off. Enter the details manually, or set ANTHROPIC_API_KEY to switch it on.' });
  const buf = Buffer.from(b.fileBase64, 'base64');
  const fields = await ocrDocument(buf, b.contentType === 'image/jpg' ? 'image/jpeg' : b.contentType);
  res.json({ available: true, fields });
}));

r.post('/documents', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ ownerType: z.enum(['employee', 'establishment']), employeeId: z.string().optional(), establishmentId: z.string().optional(), docType: z.enum(DOC_TYPES), number: z.string().max(60).optional(), issueDate: z.string().optional(), expiryDate: z.string(), fileBase64: z.string().optional(), contentType: z.string().optional(), fileName: z.string().max(200).optional() }).parse(req.body);
  if (b.ownerType === 'employee' && !(await Employee.exists({ _id: b.employeeId }))) return res.status(400).json({ error: 'Choose an employee.' });
  if (b.ownerType === 'establishment' && !(await Establishment.exists({ _id: b.establishmentId }))) return res.status(400).json({ error: 'Choose an establishment.' });
  let file = {};
  if (b.fileBase64) {
    const stored = await putFile({ tenantId: req.user.tenantId, buffer: Buffer.from(b.fileBase64, 'base64'), declaredType: b.contentType });
    file = { ...stored, fileName: b.fileName, uploadedBy: req.user.id };
  }
  // Replacing a document of the same type for the same holder keeps history in the audit log
  const doc = await ComplianceDocument.create({ ownerType: b.ownerType, employeeId: b.employeeId, establishmentId: b.establishmentId, docType: b.docType, number: b.number, issueDate: b.issueDate, expiryDate: b.expiryDate, ...file });
  await audit(req, 'document.upload', 'ComplianceDocument', doc._id, null, { docType: b.docType, hasFile: !!b.fileBase64 });
  res.status(201).json({ _id: doc._id, docType: doc.docType, expiryDate: doc.expiryDate, hasFile: !!doc.storageKey });
}));

const fileHandler = ah(async (req, res) => {
  const doc = await ComplianceDocument.findById(req.params.id).lean();
  if (!doc?.storageKey) return res.status(404).json({ error: 'No file attached.' });
  if (!isStaff(req.user) && String(doc.employeeId) !== String(req.user.employeeId)) return res.status(403).json({ error: 'Not your document.' });
  const f = await getFile({ tenantId: req.user.tenantId, storageKey: doc.storageKey });
  await audit(req, 'document.download', 'ComplianceDocument', doc._id, null, { docType: doc.docType });
  if (f.url) return res.json({ url: f.url, expiresIn: 300 });
  res.setHeader('Content-Type', doc.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(doc.fileName || 'document').replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(f.buffer);
});
r.get('/documents/:id/file', fileHandler);
r.get('/me/documents/:id/file', fileHandler); // self-service path (employees may only reach /me/*)

// ---------------- CSV import ----------------
r.get('/import/template', requireRole('hr_admin'), (req, res) => res.type('text/csv').attachment('wasl-employee-template.csv').send(templateCsv()));
r.post('/import/employees', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ csv: z.string().max(2_000_000), establishmentId: z.string(), dryRun: z.boolean().default(true) }).parse(req.body);
  if (!(await Establishment.exists({ _id: b.establishmentId }))) return res.status(400).json({ error: 'Choose an establishment.' });
  const existing = await Employee.find().select('employeeNo +labourCardNo').lean();
  const result = validateImport(b.csv, { existingEmployeeNos: existing.map((e) => e.employeeNo), existingLabourCards: existing.map((e) => e.labourCardNo) });
  if (b.dryRun || result.errors.length) return res.json({ dryRun: true, toCreate: result.valid.length, errors: result.errors, preview: result.valid.slice(0, 5).map((v) => ({ row: v.row, employeeNo: v.data.employeeNo, fullName: v.data.fullName, joinDate: v.data.joinDate, basicFils: v.data.compensation.basicFils })) });
  const created = await Employee.insertMany(result.valid.map((v) => ({ ...v.data, establishmentId: b.establishmentId, bank: { ...v.data.bank, ibanLast4: v.data.bank.iban?.slice(-4) } })));
  await audit(req, 'employee.import', 'Employee', b.establishmentId, null, { count: created.length });
  res.json({ dryRun: false, created: created.length, errors: [] });
}));

// ---------------- Go-live checklist ----------------
r.get('/setup/checklist', requireRole('hr_admin'), ah(async (req, res) => {
  const tenant = await runAsSystem(() => Tenant.findById(req.user.tenantId).lean());
  const ests = await Establishment.find().lean();
  const emps = await Employee.find({ status: 'active' }).select('fullName +bank.iban +labourCardNo').lean();
  const users = await User.find({ active: true }).lean();
  const runs = await PayrollRun.countDocuments({ type: 'regular' });
  const docs = await ComplianceDocument.countDocuments();
  const badIban = emps.filter((e) => !isValidUaeIban(e.bank?.iban)).length;
  const badCard = emps.filter((e) => !/^\d{14}$/.test(e.labourCardNo || '')).length;
  const c = tenant?.settings?.checklist || {};
  const items = [
    { id: 'entities', label: 'Every establishment has a 13-digit MOHRE ID and 9-digit WPS routing code', ok: ests.length > 0 && ests.every((e) => /^\d{13}$/.test(e.mohreId || '') && /^\d{9}$/.test(e.wps?.agentRoutingCode || '')), detail: `${ests.length} establishment(s)` },
    { id: 'employees', label: 'Employees imported', ok: emps.length > 0, detail: `${emps.length} active` },
    { id: 'ibans', label: 'Every employee has a valid IBAN', ok: badIban === 0, detail: badIban ? `${badIban} invalid or missing` : 'All valid' },
    { id: 'cards', label: 'Every employee has a 14-digit labour card number', ok: badCard === 0, detail: badCard ? `${badCard} missing` : 'All present' },
    { id: 'roles', label: 'A payroll maker and a different payroll checker exist', ok: users.some((u) => u.roles.includes('payroll_maker') || u.roles.includes('hr_admin')) && users.some((u) => u.roles.includes('payroll_checker')), detail: `${users.length} user(s)` },
    { id: 'documents', label: 'Compliance documents recorded', ok: docs > 0, detail: `${docs} document(s)` },
    { id: 'preview', label: 'At least one payroll preview run', ok: runs > 0, detail: `${runs} run(s)` },
    { id: 'alerts', label: 'Email or WhatsApp alerts configured', ok: channels().email || channels().whatsapp, detail: 'Set RESEND_API_KEY + MAIL_FROM or WHATSAPP_TOKEN + WHATSAPP_PHONE_ID' },
    { id: 'storage', label: 'Object storage configured for document files', ok: process.env.STORAGE_DRIVER === 's3', detail: process.env.STORAGE_DRIVER === 's3' ? 'Linode Object Storage' : 'Using local disk (not for production)' },
    { id: 'bankFormatVerified', label: 'SIF format verified with your agent bank', ok: !!c.bankFormatVerified, manual: true },
    { id: 'legalReviewDone', label: 'Rule pack figures signed off by UAE employment counsel', ok: !!c.legalReviewDone, manual: true },
    { id: 'backupsConfigured', label: 'Daily database backups and a tested restore', ok: !!c.backupsConfigured, manual: true },
    { id: 'staffTrained', label: 'HR and managers trained', ok: !!c.staffTrained, manual: true },
  ];
  res.json({ items, done: items.filter((i) => i.ok).length, total: items.length });
}));
r.patch('/setup/checklist', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ id: z.enum(['bankFormatVerified', 'legalReviewDone', 'backupsConfigured', 'staffTrained']), ok: z.boolean() }).parse(req.body);
  await runAsSystem(() => Tenant.updateOne({ _id: req.user.tenantId }, { [`settings.checklist.${b.id}`]: b.ok }));
  await audit(req, 'setup.checklist', 'Tenant', req.user.tenantId, null, b);
  res.json({ ok: true });
}));

// ---------------- Rule registry & settings ----------------
r.get('/rules', ah(async (req, res) => res.json(listRulePacks())));
r.get('/settings', requireRole('hr_admin'), ah(async (req, res) => res.json((await runAsSystem(() => Tenant.findById(req.user.tenantId).lean()))?.settings || {})));
r.patch('/settings', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ gratuityCapBasis: z.enum(['total', 'basic']).optional(), payrollCutoffDay: z.number().int().min(1).max(28).optional() }).parse(req.body);
  const set = Object.fromEntries(Object.entries(b).map(([k, v]) => [`settings.${k}`, v]));
  await runAsSystem(() => Tenant.updateOne({ _id: req.user.tenantId }, set));
  await audit(req, 'settings.update', 'Tenant', req.user.tenantId, null, b);
  res.json({ ok: true });
}));

export default r;
