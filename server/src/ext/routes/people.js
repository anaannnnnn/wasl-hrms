// People operations: OCR expense claims (→ payroll), health insurance & perks hub, dependents, company assets,
// and immigration / government-process case management with dependencies, costs, rejections and grace periods.
import { Router } from 'express';
import { Employee, Establishment, Notification } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { putFile, getFile } from '../../lib/storage.js';
import { aiEnabled, ocrReceipt } from '../../lib/ai.js';
import { toFils } from '../../lib/money.js';
import { ExpenseClaim, InsurancePolicy, InsuranceMember, BenefitRequest, Perk, Dependent, CompanyAsset, AssetRequest, ImmigrationCase } from '../models.js';
import { scanUpload } from '../lib/platform.js';
import { onboardingSteps } from '../lib/agents.js';
import { z, fail, money, ymd, oid, decodeUpload, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const HR = requireRole('hr_admin');
const MGR = requireRole('hr_admin', 'manager');
const FIN = requireRole('hr_admin', 'payroll_maker', 'payroll_checker');

// =============================================================== Expenses
const CATEGORIES = ['travel', 'meals', 'fuel', 'client', 'office', 'training', 'telecom', 'medical', 'other'];
/** Step 1 (optional): scan a receipt and get suggested fields. Nothing is saved. */
r.post('/me/expenses/scan', ah(async (req, res) => {
  const { file, contentType } = z.object({ file: z.string(), contentType: z.string() }).parse(req.body);
  const buf = decodeUpload(file); const s = await scanUpload(buf, contentType); if (!s.ok) throw fail(400, s.error);
  if (!aiEnabled()) return res.json({ suggested: null, note: 'Receipt reading is not configured; please type the amounts.' });
  const x = await ocrReceipt(buf, s.type).catch((e) => ({ error: e.message }));
  res.json({ suggested: x, note: 'Check these values before submitting; you are responsible for the claim.' });
}));
r.post('/me/expenses', ah(async (req, res) => {
  const b = z.object({ category: z.enum(CATEGORIES), merchant: z.string().min(2).max(120), trn: z.string().regex(/^\d{15}$/, 'TRN has 15 digits').optional().or(z.literal('')), receiptDate: ymd, description: z.string().max(300).optional(), total: money, vat: money.default(0), file: z.string().optional(), contentType: z.string().optional(), ocr: z.any().optional() }).parse(req.body);
  if (b.total <= 0) throw fail(400, 'Total must be more than zero.');
  if (b.vat > Math.round(b.total * 0.05 / 1.05) + 2) throw fail(400, 'VAT is more than 5% of the total; please check the receipt.');
  if (b.receiptDate > new Date().toISOString().slice(0, 10)) throw fail(400, 'Receipt date is in the future.');
  let receipt;
  if (b.file) { const buf = decodeUpload(b.file); const s = await scanUpload(buf, b.contentType); if (!s.ok) throw fail(400, s.error); receipt = { ...(await putFile({ tenantId: req.user.tenantId, buffer: buf, declaredType: s.type })), scan: s.scan }; }
  const flags = []; let duplicateOf;
  const dup = await ExpenseClaim.findOne({ employeeId: req.user.employeeId, totalFils: b.total, receiptDate: new Date(b.receiptDate), merchant: new RegExp(`^${b.merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: { $ne: 'rejected' } }).lean();
  if (dup) { flags.push('POSSIBLE_DUPLICATE'); duplicateOf = dup._id; }
  if (receipt?.sha256 && (await ExpenseClaim.exists({ 'receipt.sha256': receipt.sha256, status: { $ne: 'rejected' } }))) flags.push('SAME_RECEIPT_FILE');
  if (Date.now() - Date.parse(b.receiptDate) > 90 * 864e5) flags.push('OLDER_THAN_90_DAYS');
  if (!receipt) flags.push('NO_RECEIPT');
  const c = await ExpenseClaim.create({ employeeId: req.user.employeeId, category: b.category, merchant: b.merchant, trn: b.trn || undefined, receiptDate: b.receiptDate, description: b.description, totalFils: b.total, vatFils: b.vat, receipt, ocr: b.ocr, flags, duplicateOf });
  await Notification.create({ audience: 'manager', title: 'Expense claim to approve', body: `${b.merchant} · AED ${(b.total / 100).toFixed(2)}`, link: '#people' }).catch(() => {});
  await audit(req, 'expense.submit', 'ExpenseClaim', c._id, null, { totalFils: b.total, flags }); res.status(201).json(c);
}));
r.get('/me/expenses', ah(async (req, res) => res.json(await ExpenseClaim.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean())));
r.get('/expenses', requireRole('hr_admin', 'manager', 'payroll_maker', 'payroll_checker'), ah(async (req, res) => res.json(await ExpenseClaim.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).limit(500).populate('employeeId', 'fullName employeeNo department').lean())));
r.get('/expenses/:id/receipt', requireRole('hr_admin', 'manager', 'payroll_maker', 'payroll_checker'), ah(async (req, res) => {
  const c = await ExpenseClaim.findById(req.params.id).lean(); if (!c?.receipt?.storageKey) throw fail(404, 'No receipt');
  const f = await getFile({ tenantId: req.user.tenantId, storageKey: c.receipt.storageKey }); await audit(req, 'expense.receipt.view', 'ExpenseClaim', c._id);
  if (f.url) return res.json({ url: f.url }); res.setHeader('Content-Type', c.receipt.contentType); res.end(f.buffer);
}));
/** Two-level approval: line manager, then HR/finance (a different person). Approved claims flow into the next payroll sync. */
r.post('/expenses/:id/decision', requireRole('hr_admin', 'manager', 'payroll_maker', 'payroll_checker'), ah(async (req, res) => {
  const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(300).optional() }).parse(req.body);
  const c = await ExpenseClaim.findById(req.params.id); if (!c) throw fail(404, 'Claim not found');
  if (String(c.employeeId) === String(req.user.employeeId)) throw fail(403, 'You cannot approve your own claim.');
  const finance = req.user.roles.some((x) => ['hr_admin', 'payroll_maker', 'payroll_checker', 'owner'].includes(x));
  if (c.status === 'submitted') {
    c.approvals.push({ level: 1, role: finance ? 'finance' : 'manager', by: req.user.id, decision: b.decision, note: b.note, at: new Date() });
    c.status = b.decision === 'reject' ? 'rejected' : 'manager_approved';
  } else if (c.status === 'manager_approved') {
    if (!finance) throw fail(403, 'HR/finance gives the second approval.');
    if (c.approvals.some((a) => String(a.by) === req.user.id)) throw fail(403, 'A different person must give the second approval.');
    c.approvals.push({ level: 2, role: 'finance', by: req.user.id, decision: b.decision, note: b.note, at: new Date() });
    c.status = b.decision === 'reject' ? 'rejected' : 'approved';
  } else throw fail(409, `Claim is already ${c.status.replace(/_/g, ' ')}.`);
  await c.save();
  await Notification.create({ audience: 'employee', employeeId: c.employeeId, title: `Expense claim ${c.status.replace(/_/g, ' ')}`, body: `${c.merchant} · AED ${(c.totalFils / 100).toFixed(2)}${b.note ? ` · ${b.note}` : ''}`, link: '#epeople' }).catch(() => {});
  await audit(req, `expense.${b.decision}`, 'ExpenseClaim', c._id, null, { status: c.status, note: b.note });
  if (c.status === 'approved') await emitEvent('expense.approved', { expenseId: String(c._id), employeeId: String(c.employeeId), totalFils: c.totalFils });
  res.json(c);
}));

// =============================================================== Insurance & perks
r.get('/insurance/policies', FIN, ah(async (req, res) => res.json(await InsurancePolicy.find().lean())));
const netIn = z.object({ name: z.string(), type: z.enum(['hospital', 'clinic', 'pharmacy', 'lab']), emirate: z.string(), area: z.string().optional(), phone: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), directBilling: z.boolean().default(true) });
r.post('/insurance/policies', HR, ah(async (req, res) => {
  const b = z.object({ insurer: z.string().min(2), tpa: z.string().optional(), policyNo: z.string().optional(), plan: z.string().optional(), emirate: z.string().optional(), startDate: ymd.optional(), endDate: ymd.optional(), premiumPerMember: money.optional(), network: z.array(netIn).max(2000).default([]), brokerContact: z.string().optional() }).parse(req.body);
  const p = await InsurancePolicy.create({ ...b, premiumPerMemberFils: b.premiumPerMember }); await audit(req, 'insurance.policy.create', 'InsurancePolicy', p._id, null, { insurer: b.insurer, plan: b.plan }); res.status(201).json(p);
}));
r.post('/insurance/policies/:id/network', HR, ah(async (req, res) => { const { network } = z.object({ network: z.array(netIn).max(2000) }).parse(req.body); const p = await InsurancePolicy.findByIdAndUpdate(req.params.id, { $set: { network } }, { new: true }); if (!p) throw fail(404, 'Policy not found'); await audit(req, 'insurance.network.update', 'InsurancePolicy', p._id, null, { count: network.length }); res.json(p); }));
r.post('/insurance/members', HR, ah(async (req, res) => {
  const b = z.object({ policyId: oid, employeeId: oid, memberName: z.string().optional(), relation: z.enum(['self', 'spouse', 'child', 'parent']).default('self'), cardNo: z.string().max(40).optional(), validFrom: ymd.optional(), validTo: ymd.optional() }).parse(req.body);
  const e = await Employee.findById(b.employeeId).select('fullName').lean(); if (!e) throw fail(404, 'Employee not found');
  const m = await InsuranceMember.create({ ...b, memberName: b.memberName || e.fullName }); await audit(req, 'insurance.member.add', 'InsuranceMember', m._id, null, { relation: b.relation }); res.status(201).json(m);
}));
r.get('/insurance/members', FIN, ah(async (req, res) => res.json(await InsuranceMember.find(req.query.policyId ? { policyId: req.query.policyId } : {}).populate('employeeId', 'fullName employeeNo').lean())));
r.get('/me/insurance', ah(async (req, res) => {
  const members = await InsuranceMember.find({ employeeId: req.user.employeeId, status: { $ne: 'removed' } }).lean();
  const policies = await InsurancePolicy.find({ _id: { $in: [...new Set(members.map((m) => String(m.policyId)))] } }).select('-network').lean();
  res.json({ cards: members.map((m) => ({ ...m, policy: policies.find((p) => String(p._id) === String(m.policyId)) })), requests: await BenefitRequest.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean() });
}));
r.get('/me/insurance/network', ah(async (req, res) => {
  const { q = '', emirate = '', type = '', lat, lng } = req.query;
  const m = await InsuranceMember.findOne({ employeeId: req.user.employeeId, status: 'active' }).lean(); if (!m) return res.json([]);
  const p = await InsurancePolicy.findById(m.policyId).select('network').lean();
  const rad = (d) => (d * Math.PI) / 180; const dist = (x) => (lat && x.lat != null ? Math.round(6371 * 2 * Math.asin(Math.sqrt(Math.sin(rad(x.lat - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(x.lat)) * Math.sin(rad(x.lng - lng) / 2) ** 2)) * 10) / 10 : null);
  const rows = (p?.network || []).filter((x) => (!q || `${x.name} ${x.area}`.toLowerCase().includes(String(q).toLowerCase())) && (!emirate || x.emirate === emirate) && (!type || x.type === type)).map((x) => ({ ...x, km: dist(x) }));
  res.json(rows.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || a.name.localeCompare(b.name)).slice(0, 100));
}));
r.post('/me/benefits/requests', ah(async (req, res) => {
  const b = z.object({ kind: z.enum(['dependent_add', 'dependent_remove', 'card_replacement', 'plan_query']), dependent: z.object({ name: z.string().min(2), relation: z.string(), dateOfBirth: ymd.optional(), emiratesIdLast4: z.string().regex(/^\d{4}$/).optional() }).optional(), memberId: oid.optional(), notes: z.string().max(500).optional() }).parse(req.body);
  if (b.kind === 'dependent_add' && !b.dependent) throw fail(400, 'Add the dependent details.');
  const x = await BenefitRequest.create({ ...b, employeeId: req.user.employeeId });
  await Notification.create({ audience: 'hr', title: `Insurance request: ${b.kind.replace(/_/g, ' ')}`, body: b.dependent?.name || b.notes || '', link: '#people' }).catch(() => {});
  await audit(req, 'benefit.request', 'BenefitRequest', x._id, null, { kind: b.kind }); res.status(201).json(x);
}));
r.get('/benefits/requests', HR, ah(async (req, res) => res.json(await BenefitRequest.find(req.query.status ? { status: req.query.status } : { status: { $in: ['open', 'sent_to_broker'] } }).populate('employeeId', 'fullName employeeNo').sort({ createdAt: -1 }).lean())));
r.post('/benefits/requests/:id/status', HR, ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['sent_to_broker', 'done', 'rejected']) }).parse(req.body);
  const x = await BenefitRequest.findById(req.params.id); if (!x) throw fail(404, 'Request not found');
  x.status = status; x.handledBy = req.user.id; if (status !== 'sent_to_broker') x.closedAt = new Date(); await x.save();
  if (status === 'done' && x.kind === 'dependent_remove' && x.memberId) await InsuranceMember.updateOne({ _id: x.memberId }, { $set: { status: 'removed' } });
  await Notification.create({ audience: 'employee', employeeId: x.employeeId, title: `Insurance request ${status.replace(/_/g, ' ')}`, body: x.kind.replace(/_/g, ' '), link: '#epeople' }).catch(() => {});
  await audit(req, 'benefit.request.status', 'BenefitRequest', x._id, null, { status }); res.json(x);
}));
r.get('/perks', ah(async (req, res) => res.json(await Perk.find({ active: true, $or: [{ validTo: null }, { validTo: { $gte: new Date() } }] }).sort({ category: 1, title: 1 }).lean())));
r.post('/perks', HR, ah(async (req, res) => { const b = z.object({ title: z.string().min(2), provider: z.string().optional(), category: z.string().optional(), description: z.string().max(500).optional(), code: z.string().max(40).optional(), url: z.string().url().optional(), validTo: ymd.optional() }).parse(req.body); const p = await Perk.create(b); await audit(req, 'perk.create', 'Perk', p._id, null, { title: b.title }); res.status(201).json(p); }));
r.get('/me/perks', ah(async (req, res) => res.json(await Perk.find({ active: true, $or: [{ validTo: null }, { validTo: { $gte: new Date() } }] }).sort({ category: 1 }).lean())));

// =============================================================== Dependents
const depIn = z.object({ name: z.string().min(2).max(100), nameAr: z.string().max(100).optional(), relation: z.enum(['spouse', 'son', 'daughter', 'father', 'mother', 'other']), dateOfBirth: ymd.optional(), nationality: z.string().max(60).optional(), sponsor: z.enum(['employee', 'company', 'other']).default('employee'), residenceExpiry: ymd.optional(), emiratesIdExpiry: ymd.optional(), passportExpiry: ymd.optional(), airfareEligible: z.boolean().optional() });
r.get('/employees/:id/dependents', MGR, ah(async (req, res) => res.json(await Dependent.find({ employeeId: req.params.id }).lean())));
r.post('/employees/:id/dependents', HR, ah(async (req, res) => { const b = depIn.parse(req.body); if (!(await Employee.exists({ _id: req.params.id }))) throw fail(404, 'Employee not found'); const d = await Dependent.create({ ...b, employeeId: req.params.id }); await audit(req, 'dependent.create', 'Dependent', d._id, null, { relation: b.relation }); res.status(201).json(d); }));
r.patch('/dependents/:id', HR, ah(async (req, res) => { const b = depIn.partial().parse(req.body); const before = await Dependent.findById(req.params.id).lean(); if (!before) throw fail(404, 'Dependent not found'); const d = await Dependent.findByIdAndUpdate(req.params.id, { $set: b }, { new: true }); await audit(req, 'dependent.update', 'Dependent', d._id, before, b); res.json(d); }));
r.get('/me/dependents', ah(async (req, res) => res.json(await Dependent.find({ employeeId: req.user.employeeId }).lean())));
r.get('/dependents/expiring', HR, ah(async (req, res) => {
  const until = new Date(Date.now() + (Number(req.query.days) || 90) * 864e5);
  res.json(await Dependent.find({ $or: [{ residenceExpiry: { $lte: until } }, { emiratesIdExpiry: { $lte: until } }, { passportExpiry: { $lte: until } }] }).populate('employeeId', 'fullName employeeNo').lean());
}));

// =============================================================== Company assets
const assetIn = z.object({ tag: z.string().min(1).max(40), kind: z.enum(['laptop', 'phone', 'sim', 'vehicle', 'access_card', 'tools', 'uniform', 'other']), model: z.string().max(80).optional(), serial: z.string().max(80).optional(), value: money.optional(), purchasedAt: ymd.optional() });
r.get('/assets', MGR, ah(async (req, res) => res.json(await CompanyAsset.find(req.query.employeeId ? { assignedTo: req.query.employeeId } : {}).populate('assignedTo', 'fullName employeeNo').sort({ tag: 1 }).lean())));
r.post('/assets', HR, ah(async (req, res) => { const b = assetIn.parse(req.body); const a = await CompanyAsset.create({ ...b, valueFils: b.value, history: [{ at: new Date(), action: 'created', by: req.user.id }] }); await audit(req, 'asset.create', 'CompanyAsset', a._id, null, { tag: b.tag }); res.status(201).json(a); }));
r.post('/assets/:id/assign', HR, ah(async (req, res) => {
  const { employeeId, note } = z.object({ employeeId: oid, note: z.string().max(200).optional() }).parse(req.body);
  const a = await CompanyAsset.findById(req.params.id); if (!a) throw fail(404, 'Asset not found'); if (a.status === 'assigned') throw fail(409, 'Asset is already assigned. Return it first.');
  if (!(await Employee.exists({ _id: employeeId }))) throw fail(404, 'Employee not found');
  a.assignedTo = employeeId; a.assignedAt = new Date(); a.status = 'assigned'; a.history.push({ at: new Date(), action: 'assigned', employeeId, by: req.user.id, note }); await a.save();
  await AssetRequest.updateMany({ employeeId, kind: a.kind, status: 'open' }, { $set: { status: 'fulfilled', assetId: a._id } });
  await audit(req, 'asset.assign', 'CompanyAsset', a._id, null, { employeeId }); res.json(a);
}));
r.post('/assets/:id/return', HR, ah(async (req, res) => {
  const { condition, note } = z.object({ condition: z.enum(['in_stock', 'repair', 'lost', 'retired']).default('in_stock'), note: z.string().max(200).optional() }).parse(req.body);
  const a = await CompanyAsset.findById(req.params.id); if (!a) throw fail(404, 'Asset not found');
  a.history.push({ at: new Date(), action: `returned:${condition}`, employeeId: a.assignedTo, by: req.user.id, note }); a.assignedTo = null; a.assignedAt = null; a.status = condition; await a.save();
  await audit(req, 'asset.return', 'CompanyAsset', a._id, null, { condition }); res.json(a);
}));
r.get('/asset-requests', HR, ah(async (req, res) => res.json(await AssetRequest.find({ status: 'open' }).populate('employeeId', 'fullName employeeNo').lean())));
r.get('/me/assets', ah(async (req, res) => res.json({ assets: await CompanyAsset.find({ assignedTo: req.user.employeeId }).select('tag kind model serial assignedAt').lean(), requests: await AssetRequest.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean() })));
r.post('/me/asset-requests', ah(async (req, res) => { const b = z.object({ kind: z.string().max(40), reason: z.string().min(3).max(300), neededBy: ymd.optional() }).parse(req.body); const x = await AssetRequest.create({ ...b, employeeId: req.user.employeeId, source: 'self' }); await audit(req, 'asset.request', 'AssetRequest', x._id, null, b); res.status(201).json(x); }));

// =============================================================== Immigration / government cases
const recompute = (c) => {
  const done = new Set(c.steps.filter((s) => ['done', 'skipped'].includes(s.status)).map((s) => s.key));
  if (c.steps.every((s) => ['done', 'skipped'].includes(s.status))) c.status = 'done';
  else if (c.steps.some((s) => s.status === 'rejected')) c.status = 'blocked';
  else if (c.status !== 'cancelled') c.status = 'open';
  return c.steps.map((s) => ({ key: s.key, ready: (s.dependsOn || []).every((d) => done.has(d)) }));
};
const RENEWAL_STEPS = (kind) => ({
  renewal: [{ key: 'medical', name: 'Medical fitness test', owner: 'employee' }, { key: 'eid', name: 'Emirates ID renewal', owner: 'pro', dependsOn: ['medical'] }, { key: 'insurance', name: 'Health insurance valid for visa term', owner: 'insurer' }, { key: 'contract', name: 'Contract renewal / labour card', owner: 'typing_centre' }, { key: 'visa', name: 'Residence visa renewal', owner: 'pro', dependsOn: ['medical', 'eid', 'insurance', 'contract'] }],
  cancellation: [{ key: 'settlement', name: 'Final settlement paid via WPS', owner: 'hr' }, { key: 'labour_cancel', name: 'Work permit cancellation', owner: 'typing_centre', dependsOn: ['settlement'] }, { key: 'visa_cancel', name: 'Residence visa cancellation', owner: 'pro', dependsOn: ['labour_cancel'] }, { key: 'insurance_cancel', name: 'Insurance cancellation', owner: 'insurer', dependsOn: ['visa_cancel'] }, { key: 'exit_or_status', name: 'Exit or status change within grace period', owner: 'employee', dependsOn: ['visa_cancel'] }],
  transfer: [{ key: 'noc', name: 'Transfer approval / offer from new employer', owner: 'hr' }, { key: 'labour_cancel', name: 'Current work permit cancellation', owner: 'typing_centre', dependsOn: ['noc'] }, { key: 'new_permit', name: 'New work permit (new employer)', owner: 'pro', dependsOn: ['labour_cancel'] }],
  dependent_new: [{ key: 'entry', name: 'Dependent entry permit', owner: 'pro' }, { key: 'medical', name: 'Medical test (18+)', owner: 'employee', dependsOn: ['entry'] }, { key: 'eid', name: 'Emirates ID biometrics', owner: 'employee', dependsOn: ['entry'] }, { key: 'insurance', name: 'Health insurance', owner: 'insurer' }, { key: 'visa', name: 'Dependent residence visa', owner: 'pro', dependsOn: ['medical', 'eid', 'insurance'] }],
  dependent_renewal: [{ key: 'insurance', name: 'Health insurance', owner: 'insurer' }, { key: 'medical', name: 'Medical test (18+)', owner: 'employee' }, { key: 'visa', name: 'Dependent visa renewal', owner: 'pro', dependsOn: ['insurance', 'medical'] }],
  golden_visa: [{ key: 'eligibility', name: 'Eligibility check (salary/skills category)', owner: 'hr' }, { key: 'nomination', name: 'Nomination / application', owner: 'pro', dependsOn: ['eligibility'] }, { key: 'medical', name: 'Medical test', owner: 'employee', dependsOn: ['nomination'] }, { key: 'eid', name: 'Emirates ID', owner: 'pro', dependsOn: ['medical'] }],
}[kind]);
r.get('/immigration/cases', MGR, ah(async (req, res) => {
  const cases = await ImmigrationCase.find(req.query.status ? { status: req.query.status } : { status: { $in: ['open', 'blocked'] } }).sort({ updatedAt: -1 }).populate('employeeId', 'fullName employeeNo').lean();
  const now = Date.now();
  res.json(cases.map((c) => ({ ...c, readiness: recompute({ ...c }), overdue: c.steps.filter((s) => !['done', 'skipped'].includes(s.status) && s.dueDate && new Date(s.dueDate) < now).length, costFils: c.steps.reduce((a, s) => a + (s.costFils || 0), 0) })));
}));
r.post('/immigration/cases', HR, ah(async (req, res) => {
  const b = z.object({ kind: z.enum(['new_hire', 'renewal', 'cancellation', 'transfer', 'dependent_new', 'dependent_renewal', 'golden_visa']), employeeId: oid.optional(), dependentId: oid.optional(), subjectName: z.string().optional(), startDate: ymd.optional(), graceUntil: ymd.optional() }).parse(req.body);
  const e = b.employeeId ? await Employee.findById(b.employeeId).lean() : null; const est = e ? await Establishment.findById(e.establishmentId).lean() : null;
  const base = b.kind === 'new_hire' ? onboardingSteps({ startDate: b.startDate || new Date().toISOString().slice(0, 10), jurisdiction: est?.jurisdiction }) : RENEWAL_STEPS(b.kind).map((s, i) => ({ ...s, dueDate: new Date(Date.now() + (i + 1) * 5 * 864e5), dependsOn: s.dependsOn || [] }));
  const c = await ImmigrationCase.create({ ...b, subjectName: b.subjectName || e?.fullName, establishmentId: est?._id, jurisdiction: est?.jurisdiction || 'MAINLAND', steps: base, createdBy: req.user.id, source: 'manual' });
  await audit(req, 'immigration.case.create', 'ImmigrationCase', c._id, null, { kind: b.kind }); res.status(201).json(c);
}));
r.patch('/immigration/cases/:id/steps/:key', HR, ah(async (req, res) => {
  const b = z.object({ status: z.enum(['todo', 'in_progress', 'submitted', 'rejected', 'done', 'skipped']).optional(), dueDate: ymd.optional(), cost: money.optional(), reference: z.string().max(80).optional(), rejectionReason: z.string().max(300).optional(), owner: z.enum(['hr', 'pro', 'typing_centre', 'employee', 'insurer']).optional() }).parse(req.body);
  const c = await ImmigrationCase.findById(req.params.id); if (!c) throw fail(404, 'Case not found');
  const s = c.steps.find((x) => x.key === req.params.key); if (!s) throw fail(404, 'Step not found');
  const ready = recompute(c).find((x) => x.key === s.key)?.ready;
  if (['submitted', 'done'].includes(b.status) && !ready) throw fail(409, `Finish ${s.dependsOn.join(', ')} first.`);
  const before = s.toObject();
  if (b.status === 'rejected') { s.attempts = (s.attempts || 0) + 1; s.rejectionReason = b.rejectionReason || 'Rejected'; }
  if (b.status === 'in_progress' && before.status === 'rejected') s.rejectionReason = s.rejectionReason ? `${s.rejectionReason} (resubmitting)` : undefined;
  Object.assign(s, { ...(b.status ? { status: b.status } : {}), ...(b.dueDate ? { dueDate: new Date(b.dueDate) } : {}), ...(b.cost != null ? { costFils: b.cost } : {}), ...(b.reference ? { reference: b.reference } : {}), ...(b.owner ? { owner: b.owner } : {}) });
  if (b.status === 'done') s.doneAt = new Date();
  recompute(c); await c.save();
  await audit(req, 'immigration.step.update', 'ImmigrationCase', c._id, before, s.toObject());
  if (c.status === 'done') await emitEvent('immigration.case.completed', { caseId: String(c._id), kind: c.kind, employeeId: c.employeeId && String(c.employeeId) });
  res.json(c);
}));
r.post('/immigration/cases/:id/cancel', HR, ah(async (req, res) => { const c = await ImmigrationCase.findByIdAndUpdate(req.params.id, { $set: { status: 'cancelled' } }, { new: true }); if (!c) throw fail(404, 'Case not found'); await audit(req, 'immigration.case.cancel', 'ImmigrationCase', c._id); res.json(c); }));
r.get('/me/immigration', ah(async (req, res) => res.json(await ImmigrationCase.find({ employeeId: req.user.employeeId, status: { $ne: 'cancelled' } }).select('kind status steps.name steps.status steps.owner steps.dueDate').lean())));

export default r;
export { RENEWAL_STEPS, recompute };
