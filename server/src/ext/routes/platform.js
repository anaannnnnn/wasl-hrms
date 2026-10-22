// Platform: report builder (access-aware, masked, audited exports, schedules), API keys, signed webhooks,
// connectors with kill switches & health, background jobs console, rules registry (effective-dated, tested,
// approved, tenant-scoped), feature/AI governance settings, and the insights (forecast, attrition, NAFIS ROI).
import { Router } from 'express';
import { Employee, Establishment, LeaveRequest, Attendance, PayrollRun, ComplianceDocument, Pulse } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { encryptField } from '../../lib/fieldcrypt.js';
import { listRulePacks } from '../../lib/rules.js';
import { assessEmiratisation, nafisScenario } from '../../lib/emiratisation.js';
import { SavedReport, ApiKey, Webhook, WebhookDelivery, Connector, Job, RuleVersion, FeatureSettings, ExportLog, ExpenseClaim, Dependent } from '../models.js';
import { newApiKey, mask } from '../lib/platform.js';
import { toCsv } from '../lib/payrollPlus.js';
import { replay, enqueue } from '../lib/queue.js';
import { composePack, runTestCases, recalcPreview, registerApproved, tenantPackId, registeredVersions } from '../lib/rulesRegistry.js';
import { forecastRenewals, DEFAULT_FEES, scoreEmployee, aggregateByDepartment, SIGNALS, hiringVsFine } from '../lib/insights.js';
import { z, fail, ymd, oid, sendCsv, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const HR = requireRole('hr_admin');
const ANY_STAFF = requireRole('hr_admin', 'manager', 'payroll_maker', 'payroll_checker');
const settings = async () => (await FeatureSettings.findOne().lean()) || (await FeatureSettings.create({})).toObject();
const AED = (f) => (f == null ? '' : (f / 100).toFixed(2));
const d10 = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// =============================================================== Report builder
const SENSITIVE_ROLES = ['hr_admin', 'payroll_maker', 'payroll_checker', 'owner'];
export const ENTITIES = {
  employees: {
    label: 'Employees', columns: {
      employeeNo: { label: 'Employee no.', get: (e) => e.employeeNo }, fullName: { label: 'Name', get: (e) => e.fullName }, department: { label: 'Department', get: (e) => e.department },
      jobTitle: { label: 'Job title', get: (e) => e.jobTitle }, nationality: { label: 'Nationality', get: (e) => e.nationality }, uaeNational: { label: 'UAE national', get: (e) => (e.isUaeNational ? 'yes' : 'no') },
      joinDate: { label: 'Joined', get: (e) => d10(e.joinDate) }, status: { label: 'Status', get: (e) => e.status }, contractType: { label: 'Contract', get: (e) => e.contractType }, establishment: { label: 'Establishment', get: (e, x) => x.est[String(e.establishmentId)] },
      basic: { label: 'Basic (AED)', sensitive: true, get: (e) => AED(e.compensation?.basicFils) },
      totalPay: { label: 'Total monthly (AED)', sensitive: true, get: (e) => AED((e.compensation?.basicFils || 0) + (e.compensation?.housingFils || 0) + (e.compensation?.transportFils || 0) + (e.compensation?.allowances || []).reduce((a, y) => a + y.amountFils, 0)) },
      ibanLast4: { label: 'IBAN (last 4)', sensitive: true, get: (e) => e.bank?.ibanLast4 && `•••• ${e.bank.ibanLast4}` },
    },
    load: async (q, scope) => Employee.find({ ...scope.employee, ...(q.status ? { status: q.status } : {}), ...(q.department ? { department: q.department } : {}) }).limit(10000).lean(),
  },
  leave: {
    label: 'Leave', columns: { employee: { label: 'Employee', get: (l, x) => x.emp[String(l.employeeId)] }, type: { label: 'Type', get: (l) => l.type }, startDate: { label: 'From', get: (l) => d10(l.startDate) }, endDate: { label: 'To', get: (l) => d10(l.endDate) }, days: { label: 'Days', get: (l) => l.days }, status: { label: 'Status', get: (l) => l.status } },
    load: async (q, scope) => LeaveRequest.find({ employeeId: { $in: scope.ids }, ...(q.status ? { status: q.status } : {}), ...(q.from ? { endDate: { $gte: new Date(q.from) } } : {}), ...(q.to ? { startDate: { $lte: new Date(`${q.to}T23:59:59Z`) } } : {}) }).limit(20000).lean(),
  },
  attendance: {
    label: 'Attendance', columns: { employee: { label: 'Employee', get: (a, x) => x.emp[String(a.employeeId)] }, date: { label: 'Date', get: (a) => a.date }, clockIn: { label: 'In', get: (a) => a.clockIn?.at?.toISOString?.() }, clockOut: { label: 'Out', get: (a) => a.clockOut?.at?.toISOString?.() }, minutesWorked: { label: 'Minutes', get: (a) => a.minutesWorked }, lateMinutes: { label: 'Late min', get: (a) => a.lateMinutes }, overtimeMinutes: { label: 'OT min', get: (a) => a.overtimeMinutes }, status: { label: 'Status', get: (a) => a.status } },
    load: async (q, scope) => Attendance.find({ employeeId: { $in: scope.ids }, ...(q.from || q.to ? { date: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } } : {}) }).limit(50000).lean(),
  },
  payroll: {
    label: 'Payroll lines', sensitiveEntity: true, columns: { period: { label: 'Period', get: (l) => l.period }, type: { label: 'Run type', get: (l) => l.type }, employee: { label: 'Employee', get: (l) => l.employeeName }, gross: { label: 'Gross', sensitive: true, get: (l) => AED(l.grossFils) }, deductions: { label: 'Deductions', sensitive: true, get: (l) => AED(l.deductionsFils) }, net: { label: 'Net', sensitive: true, get: (l) => AED(l.netFils) }, status: { label: 'Run status', get: (l) => l.status } },
    load: async (q, scope) => (await PayrollRun.find({ ...(q.from ? { period: { $gte: q.from.slice(0, 7), ...(q.to ? { $lte: q.to.slice(0, 7) } : {}) } } : {}) }).limit(500).lean()).flatMap((run) => run.lines.filter((l) => scope.idSet.has(String(l.employeeId))).map((l) => ({ ...l, period: run.period, type: run.type, status: run.status }))),
  },
  expenses: {
    label: 'Expenses', columns: { employee: { label: 'Employee', get: (c, x) => x.emp[String(c.employeeId)] }, receiptDate: { label: 'Date', get: (c) => d10(c.receiptDate) }, merchant: { label: 'Merchant', get: (c) => c.merchant }, category: { label: 'Category', get: (c) => c.category }, total: { label: 'Total (AED)', get: (c) => AED(c.totalFils) }, vat: { label: 'VAT (AED)', get: (c) => AED(c.vatFils) }, status: { label: 'Status', get: (c) => c.status } },
    load: async (q, scope) => ExpenseClaim.find({ employeeId: { $in: scope.ids }, ...(q.status ? { status: q.status } : {}) }).limit(20000).lean(),
  },
  documents: {
    label: 'Documents', columns: { holder: { label: 'Holder', get: (d, x) => x.emp[String(d.employeeId)] || 'Company' }, docType: { label: 'Document', get: (d) => d.docType }, expiryDate: { label: 'Expiry', get: (d) => d10(d.expiryDate) }, daysLeft: { label: 'Days left', get: (d) => Math.ceil((new Date(d.expiryDate) - Date.now()) / 864e5) }, renewal: { label: 'Renewal', get: (d) => d.renewalCase?.status } },
    load: async (q, scope) => ComplianceDocument.find({ $or: [{ employeeId: { $in: scope.ids } }, ...(scope.all ? [{ ownerType: 'establishment' }] : [])], ...(q.to ? { expiryDate: { $lte: new Date(q.to) } } : {}) }).limit(20000).lean(),
  },
};
/** Row-level scope: managers only see their own department; HR/payroll see everyone. */
async function scopeFor(user) {
  const all = user.roles.some((x) => ['hr_admin', 'payroll_maker', 'payroll_checker', 'owner'].includes(x));
  let employee = {};
  if (!all) { const me = user.employeeId ? await Employee.findById(user.employeeId).select('department').lean() : null; employee = me?.department ? { department: me.department } : { _id: user.employeeId || null }; }
  const emps = await Employee.find(employee).select('fullName establishmentId').lean();
  return { all, employee, ids: emps.map((e) => e._id), idSet: new Set(emps.map((e) => String(e._id))), emp: Object.fromEntries(emps.map((e) => [String(e._id), e.fullName])) };
}
export async function runReport(user, { entity, columns, filters = {} }) {
  const E = ENTITIES[entity]; if (!E) throw fail(400, 'Unknown report type');
  const canSensitive = user.roles.some((x) => SENSITIVE_ROLES.includes(x));
  if (E.sensitiveEntity && !canSensitive) throw fail(403, 'Payroll reports need a payroll or HR role.');
  const cols = (columns?.length ? columns : Object.keys(E.columns)).filter((c) => E.columns[c]);
  const scope = await scopeFor(user);
  const est = Object.fromEntries((await Establishment.find().select('name').lean()).map((x) => [String(x._id), x.name]));
  const rows = await E.load(filters, scope);
  const ctx = { emp: scope.emp, est };
  const masked = cols.filter((c) => E.columns[c].sensitive && !canSensitive);
  const data = rows.map((row) => cols.map((c) => { const v = E.columns[c].get(row, ctx); return masked.includes(c) ? mask(v, 0) : v ?? ''; }));
  return { columns: cols.map((c) => ({ key: c, label: E.columns[c].label, masked: masked.includes(c) })), rows: data, sensitive: cols.some((c) => E.columns[c].sensitive) && !masked.length };
}
r.get('/reports/entities', ANY_STAFF, ah(async (req, res) => res.json(Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, { label: v.label, columns: Object.fromEntries(Object.entries(v.columns).map(([c, d]) => [c, { label: d.label, sensitive: !!d.sensitive }])) }])))));
const reportIn = z.object({ entity: z.enum(Object.keys(ENTITIES)), columns: z.array(z.string()).max(30).optional(), filters: z.object({ status: z.string().optional(), department: z.string().optional(), from: ymd.optional(), to: ymd.optional() }).default({}) });
r.post('/reports/run', ANY_STAFF, ah(async (req, res) => { const b = reportIn.parse(req.body); const out = await runReport(req.user, b); res.json({ ...out, rows: out.rows.slice(0, 500), total: out.rows.length }); }));
r.post('/reports/export', ANY_STAFF, ah(async (req, res) => {
  const b = reportIn.parse(req.body); const out = await runReport(req.user, b);
  await ExportLog.create({ userId: req.user.id, entity: b.entity, columns: out.columns.map((c) => c.key), rows: out.rows.length, sensitive: out.sensitive, format: 'csv' });
  await audit(req, 'report.export', 'Report', b.entity, null, { rows: out.rows.length, sensitive: out.sensitive, columns: out.columns.map((c) => c.key) });
  sendCsv(res, toCsv(out.columns.map((c) => c.label), out.rows), `${b.entity}-${new Date().toISOString().slice(0, 10)}.csv`);
}));
r.get('/reports/saved', ANY_STAFF, ah(async (req, res) => res.json(await SavedReport.find({ $or: [{ ownerUserId: req.user.id }, { shared: true }] }).sort({ name: 1 }).lean())));
r.post('/reports/saved', ANY_STAFF, ah(async (req, res) => {
  const b = reportIn.extend({ name: z.string().min(2).max(80), schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'), recipients: z.array(z.string().email()).max(10).default([]), shared: z.boolean().default(false) }).parse(req.body);
  const s = await SavedReport.create({ ...b, ownerUserId: req.user.id }); await audit(req, 'report.save', 'SavedReport', s._id, null, { name: b.name, schedule: b.schedule }); res.status(201).json(s);
}));
r.delete('/reports/saved/:id', ANY_STAFF, ah(async (req, res) => { await SavedReport.deleteOne({ _id: req.params.id, ownerUserId: req.user.id }); res.json({ ok: true }); }));
r.get('/reports/exports', HR, ah(async (req, res) => res.json(await ExportLog.find().sort({ createdAt: -1 }).limit(200).lean())));

// =============================================================== API keys
r.get('/api-keys', HR, ah(async (req, res) => res.json(await ApiKey.find().select('-hash').sort({ createdAt: -1 }).lean())));
r.post('/api-keys', HR, ah(async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(60), scopes: z.array(z.enum(['employees:read', 'leave:read', 'leave:write', 'attendance:read', 'attendance:write', 'payroll:read'])).min(1) }).parse(req.body);
  const k = newApiKey(); const doc = await ApiKey.create({ name: b.name, scopes: b.scopes, prefix: k.prefix, hash: k.hash, createdBy: req.user.id });
  await audit(req, 'apikey.create', 'ApiKey', doc._id, null, { name: b.name, scopes: b.scopes });
  res.status(201).json({ id: doc._id, key: k.key, note: 'Copy this key now. Only a hash is stored, so it cannot be shown again.' });
}));
r.post('/api-keys/:id/revoke', HR, ah(async (req, res) => { const k = await ApiKey.findByIdAndUpdate(req.params.id, { $set: { revokedAt: new Date() } }, { new: true }).select('-hash'); if (!k) throw fail(404, 'Key not found'); await audit(req, 'apikey.revoke', 'ApiKey', k._id); res.json(k); }));

// =============================================================== Webhooks
export const WEBHOOK_EVENTS = ['employee.created', 'employee.updated', 'employee.onboarding', 'leave.created', 'leave.approved', 'leave.rejected', 'payroll.computed', 'payroll.approved', 'payroll.sif_exported', 'payroll.rejections.imported', 'loan.approved', 'loan.rejected', 'expense.approved', 'document.uploaded', 'roster.published', 'immigration.case.completed', 'offer.signed', 'attendance.clock_in', 'attendance.clock_out'];
r.get('/webhooks', HR, ah(async (req, res) => res.json({ events: WEBHOOK_EVENTS, webhooks: await Webhook.find().lean() })));
r.post('/webhooks', HR, ah(async (req, res) => {
  const b = z.object({ url: z.string().url().refine((u) => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'Webhook URLs must use HTTPS.'), events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1), description: z.string().max(120).optional() }).parse(req.body);
  const host = new URL(b.url).hostname;
  if (process.env.NODE_ENV === 'production' && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw fail(400, 'Webhook URLs cannot point to private networks.');
  const { randomBytes } = await import('node:crypto'); const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const w = await Webhook.create({ ...b, secretEnc: encryptField(secret) }); await audit(req, 'webhook.create', 'Webhook', w._id, null, { url: b.url, events: b.events });
  res.status(201).json({ webhook: w, secret, note: 'Verify the Wasl-Signature header (t=…,v1=HMAC-SHA256 of "t.body") and reject timestamps older than 5 minutes.' });
}));
r.patch('/webhooks/:id', HR, ah(async (req, res) => { const b = z.object({ active: z.boolean().optional(), events: z.array(z.string()).optional() }).parse(req.body); const w = await Webhook.findByIdAndUpdate(req.params.id, { $set: { ...b, ...(b.active ? { failures: 0 } : {}) } }, { new: true }); if (!w) throw fail(404, 'Webhook not found'); await audit(req, 'webhook.update', 'Webhook', w._id, null, b); res.json(w); }));
r.delete('/webhooks/:id', HR, ah(async (req, res) => { await Webhook.deleteOne({ _id: req.params.id }); await audit(req, 'webhook.delete', 'Webhook', req.params.id); res.json({ ok: true }); }));
r.post('/webhooks/:id/test', HR, ah(async (req, res) => { const w = await Webhook.findById(req.params.id).lean(); if (!w) throw fail(404, 'Webhook not found'); await emitEvent(w.events.includes('*') ? 'employee.updated' : w.events[0], { test: true }, `test:${Date.now()}`); res.json({ queued: true }); }));
r.get('/webhooks/:id/deliveries', HR, ah(async (req, res) => res.json(await WebhookDelivery.find({ webhookId: req.params.id }).sort({ createdAt: -1 }).limit(100).lean())));
r.post('/webhooks/deliveries/:id/replay', HR, ah(async (req, res) => {
  const d = await WebhookDelivery.findByIdAndUpdate(req.params.id, { $set: { state: 'pending' } }, { new: true }); if (!d) throw fail(404, 'Delivery not found');
  await enqueue('webhook.deliver', { deliveryId: String(d._id) }, { idempotencyKey: `wh:${d._id}:replay:${Date.now()}`, maxAttempts: 8 });
  await audit(req, 'webhook.replay', 'WebhookDelivery', d._id); res.json({ queued: true });
}));

// =============================================================== Connectors (with kill switch & health)
const CONNECTOR_CATALOG = {
  accounting: ['xero', 'zoho_books', 'quickbooks', 'generic_erp'], sso: ['oidc'], esign: ['builtin', 'docusign', 'uae_pass_sign'], sms: ['twilio', 'etisalat_bulk', 'generic_http'],
  whatsapp: ['meta_cloud'], email: ['resend', 'smtp_relay'], attendance_device: ['zkteco', 'hikvision', 'generic'], insurance_broker: ['generic_sftp', 'generic_http'],
  recruitment: ['linkedin_jobs', 'bayt', 'naukrigulf', 'generic_xml_feed'], slack: ['slack'], speech: ['openai_whisper', 'generic_http'],
};
r.get('/connectors', HR, ah(async (req, res) => res.json({ catalog: CONNECTOR_CATALOG, connectors: await Connector.find().lean() })));
r.put('/connectors', HR, ah(async (req, res) => {
  const b = z.object({ kind: z.enum(Object.keys(CONNECTOR_CATALOG)), provider: z.string(), config: z.record(z.any()).default({}), secret: z.string().max(4000).optional(), enabled: z.boolean().default(false) }).parse(req.body);
  if (!CONNECTOR_CATALOG[b.kind].includes(b.provider)) throw fail(400, `Unknown ${b.kind} provider.`);
  if (b.kind === 'sso') { z.object({ issuer: z.string().url(), clientId: z.string().min(3), emailDomain: z.string().optional(), autoProvision: z.boolean().optional() }).parse(b.config); }
  const set = { config: b.config, enabled: b.enabled, ...(b.secret ? { secretEnc: encryptField(b.secret) } : {}) };
  const c = await Connector.findOneAndUpdate({ kind: b.kind, provider: b.provider }, { $set: set }, { upsert: true, new: true });
  await audit(req, 'connector.upsert', 'Connector', c._id, null, { kind: b.kind, provider: b.provider, enabled: b.enabled, secretChanged: !!b.secret }); res.json(c);
}));
r.post('/connectors/:id/kill', HR, ah(async (req, res) => { const { on } = z.object({ on: z.boolean() }).parse(req.body); const c = await Connector.findByIdAndUpdate(req.params.id, { $set: { killSwitch: on } }, { new: true }); if (!c) throw fail(404, 'Connector not found'); await audit(req, on ? 'connector.kill' : 'connector.unkill', 'Connector', c._id); res.json(c); }));
r.post('/connectors/:id/health', HR, ah(async (req, res) => {
  const c = await Connector.findById(req.params.id); if (!c) throw fail(404, 'Connector not found');
  let status = 'ok', detail = 'Configuration present';
  try { if (c.kind === 'sso') { const { discover } = await import('../lib/oidc.js'); await discover(c.config.issuer); detail = 'Discovery document reachable'; } } catch (e) { status = 'error'; detail = e.message; }
  c.health = { status, detail, checkedAt: new Date() }; await c.save(); res.json(c.health);
}));

// =============================================================== Jobs console
r.get('/jobs', HR, ah(async (req, res) => {
  const [rows, counts] = await Promise.all([Job.find(req.query.state ? { state: req.query.state } : {}).sort({ updatedAt: -1 }).limit(200).lean(), Job.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }])]);
  res.json({ counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), jobs: rows });
}));
r.post('/jobs/:id/replay', HR, ah(async (req, res) => { const j = await replay(req.params.id); if (!j) throw fail(404, 'Job not found or still running'); await audit(req, 'job.replay', 'Job', j._id); res.json(j); }));

// =============================================================== Rules registry
r.get('/rules/registry', ANY_STAFF, ah(async (req, res) => res.json({ codePacks: listRulePacks().filter((p) => !p.id.includes('::')), versions: await RuleVersion.find().sort({ packId: 1, effectiveFrom: -1 }).lean(), active: registeredVersions(req.user.tenantId) })));
const rvIn = z.object({ packId: z.string(), version: z.string().min(1).max(20), effectiveFrom: ymd, effectiveTo: ymd.optional(), employeeCategory: z.string().default('all'), overrides: z.record(z.any()), sourceRef: z.string().max(300).optional(), sourceUrls: z.array(z.string().url()).max(5).default([]), changeNote: z.string().max(300).optional(), testCases: z.array(z.object({ name: z.string(), input: z.record(z.any()), expect: z.record(z.any()) })).max(50).default([]) });
r.post('/rules/registry', HR, ah(async (req, res) => {
  const b = rvIn.parse(req.body); composePack(b); // throws when the base pack does not exist for that date
  const v = await RuleVersion.create({ ...b, status: 'draft', createdBy: req.user.id }); await audit(req, 'rules.version.create', 'RuleVersion', v._id, null, { packId: b.packId, version: b.version }); res.status(201).json(v);
}));
r.post('/rules/registry/:id/test', HR, ah(async (req, res) => { const v = await RuleVersion.findById(req.params.id); if (!v) throw fail(404, 'Version not found'); const t = runTestCases(v.toObject()); v.lastTest = { passed: t.passed, at: new Date(), results: t.results }; await v.save(); res.json(t); }));
r.get('/rules/registry/:id/preview', HR, ah(async (req, res) => {
  const v = await RuleVersion.findById(req.params.id).lean(); if (!v) throw fail(404, 'Version not found');
  const emps = await Employee.find({ status: { $in: ['active', 'notice'] } }).limit(500).lean();
  const rows = recalcPreview(v, emps, { asOf: req.query.asOf ? new Date(req.query.asOf) : new Date(Math.max(Date.now(), Date.parse(v.effectiveFrom))) });
  res.json({ rows, changed: rows.filter((x) => x.deltaFils).length, note: 'Preview only. Historical payroll is never recalculated; approved versions apply to calculations dated on/after the effective date.' });
}));
r.post('/rules/registry/:id/approve', HR, ah(async (req, res) => {
  const v = await RuleVersion.findById(req.params.id); if (!v || v.status !== 'draft') throw fail(404, 'Draft version not found');
  if (String(v.createdBy) === req.user.id) throw fail(403, 'A different HR admin must approve a rule version (maker-checker).');
  if (!v.lastTest?.passed) throw fail(409, 'Run the test cases and make sure they pass before approving.');
  v.status = 'approved'; v.approvedBy = req.user.id; v.approvedAt = new Date(); await v.save();
  registerApproved([v.toObject()]);
  await audit(req, 'rules.version.approve', 'RuleVersion', v._id, { status: 'draft' }, { status: 'approved', packId: tenantPackId(v.packId, v.tenantId) });
  res.json({ version: v, tenantPackId: tenantPackId(v.packId, v.tenantId) });
}));
r.post('/rules/registry/apply', HR, ah(async (req, res) => {
  const { establishmentId, packId } = z.object({ establishmentId: oid, packId: z.string() }).parse(req.body);
  const est = await Establishment.findById(establishmentId); if (!est) throw fail(404, 'Establishment not found');
  const target = packId;
  if (target.includes('::') && !target.endsWith(`::${req.user.tenantId}`)) throw fail(403, 'That rule pack belongs to another organisation.');
  if (target.includes('::') && !registeredVersions(req.user.tenantId).some((k) => k.startsWith(`${target}@`))) throw fail(409, 'Approve a version for this pack first.');
  const before = est.rulePackId; est.rulePackId = target; await est.save();
  await audit(req, 'rules.apply', 'Establishment', est._id, { rulePackId: before }, { rulePackId: target }); res.json({ establishmentId, rulePackId: target });
}));

// =============================================================== Feature & AI governance settings
r.get('/settings/features', HR, ah(async (req, res) => res.json(await settings())));
r.patch('/settings/features', HR, ah(async (req, res) => {
  const b = z.object({ attritionInsights: z.object({ enabled: z.boolean().optional(), individualScores: z.boolean().optional(), reviewedForBias: z.boolean().optional(), minGroupSize: z.number().int().min(3).max(50).optional() }).optional(), agentKillSwitch: z.boolean().optional(), copilotLanguages: z.array(z.string()).optional(), feeSchedule: z.record(z.any()).optional() }).parse(req.body);
  const before = await settings(); const set = {};
  for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'feeSchedule') for (const [kk, vv] of Object.entries(v)) set[`${k}.${kk}`] = vv; else set[k] = v; }
  if (set['attritionInsights.individualScores'] && !(set['attritionInsights.reviewedForBias'] ?? before.attritionInsights?.reviewedForBias)) throw fail(409, 'Record the bias/privacy review before enabling individual scores.');
  const s = await FeatureSettings.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true });
  await audit(req, 'settings.features.update', 'FeatureSettings', s._id, before, b); res.json(s);
}));

// =============================================================== Insights
r.get('/insights/forecast', requireRole('hr_admin', 'payroll_maker', 'payroll_checker'), ah(async (req, res) => {
  const months = Math.min(24, Math.max(3, Number(req.query.months) || 12)); const s = await settings();
  const [docs, deps, ests, leavers] = await Promise.all([ComplianceDocument.find({ expiryDate: { $lte: new Date(Date.now() + months * 31 * 864e5) } }).populate('employeeId', 'fullName establishmentId').lean(), Dependent.find({ residenceExpiry: { $exists: true } }).populate('employeeId', 'establishmentId').lean(), Establishment.find().select('jurisdiction name').lean(), Employee.find({ status: { $in: ['notice', 'exited'] } }).select('_id').lean()]);
  const juris = (id) => ests.find((e) => String(e._id) === String(id))?.jurisdiction || 'MAINLAND';
  const f = forecastRenewals({ months, fees: { ...DEFAULT_FEES, ...(s.feeSchedule || {}) }, leaverIds: new Set(leavers.map((x) => String(x._id))), docs: docs.map((d) => ({ ...d, employeeId: d.employeeId?._id, holder: d.employeeId?.fullName || ests.find((e) => String(e._id) === String(d.establishmentId))?.name, jurisdiction: juris(d.employeeId?.establishmentId || d.establishmentId) })), dependents: deps.map((d) => ({ ...d, jurisdiction: juris(d.employeeId?.establishmentId) })) });
  res.json(f);
}));
async function attritionFeatures() {
  const now = Date.now(); const d = (n) => new Date(now - n * 864e5); const ds = (n) => d(n).toISOString().slice(0, 10);
  const emps = await Employee.find({ status: 'active' }).select('fullName department joinDate compensation compensationHistory').lean();
  const ids = emps.map((e) => e._id);
  const [leaves, att] = await Promise.all([LeaveRequest.find({ employeeId: { $in: ids }, status: 'approved', startDate: { $gte: d(400) } }).select('employeeId type days startDate').lean(), Attendance.find({ employeeId: { $in: ids }, date: { $gte: ds(60) } }).select('employeeId date lateMinutes overtimeMinutes').lean()]);
  return emps.map((e) => {
    const id = String(e._id); const L = leaves.filter((x) => String(x.employeeId) === id); const A = att.filter((x) => String(x.employeeId) === id);
    const lastAnnual = L.filter((x) => x.type === 'annual').map((x) => +new Date(x.startDate)).sort().pop() || +new Date(e.joinDate);
    const lastPay = [e.compensation?.effectiveFrom, ...(e.compensationHistory || []).map((h) => h.effectiveFrom), e.joinDate].filter(Boolean).map((x) => +new Date(x)).sort().pop();
    return { employeeId: e._id, name: e.fullName, department: e.department, features: { singleSickDays90: L.filter((x) => x.type === 'sick' && x.days === 1 && new Date(x.startDate) >= d(90)).length, monthsSinceAnnualLeave: Math.floor((now - lastAnnual) / (30.4 * 864e5)), late30: A.filter((x) => x.date >= ds(30) && x.lateMinutes > 0).length, latePrev30: A.filter((x) => x.date < ds(30) && x.lateMinutes > 0).length, overtimeHours30: Math.round(A.filter((x) => x.date >= ds(30)).reduce((a, x) => a + (x.overtimeMinutes || 0), 0) / 60), monthsSincePayChange: Math.floor((now - lastPay) / (30.4 * 864e5)), pulseAvg: null } };
  });
}
r.get('/insights/attrition', HR, ah(async (req, res) => {
  const s = await settings(); const cfg = s.attritionInsights || {};
  if (!cfg.enabled) return res.json({ enabled: false, signals: SIGNALS.map(({ id, weight, label }) => ({ id, weight, label })), note: 'Attrition insights are off. An HR admin can enable aggregate insights in Settings after a privacy review.' });
  const rows = (await attritionFeatures()).map((x) => ({ ...x, ...scoreEmployee(x.features) }));
  const pulses = await Pulse.aggregate([{ $match: { date: { $gte: new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10) } } }, { $group: { _id: '$department', avg: { $avg: '$mood' }, n: { $sum: 1 } } }]);
  const departments = aggregateByDepartment(rows, cfg.minGroupSize || 5).map((dpt) => { const p = pulses.find((x) => (x._id || 'Unassigned') === dpt.department); return dpt.suppressed ? dpt : { ...dpt, pulseAvg: p && p.n >= (cfg.minGroupSize || 5) ? Math.round(p.avg * 10) / 10 : null }; });
  await audit(req, 'insights.attrition.view', 'Insights', 'attrition', null, { individual: !!cfg.individualScores });
  res.json({ enabled: true, signals: SIGNALS.map(({ id, weight, label }) => ({ id, weight, label })), departments, individuals: cfg.individualScores ? rows.filter((x) => x.band !== 'low').sort((a, b) => b.score - a.score).map(({ features, ...x }) => x) : undefined, note: 'Indicators are explainable rules over operational data only (no nationality, gender, age or health details). Use them to start supportive conversations, never to make employment decisions.' });
}));
r.get('/insights/nafis-roi', requireRole('hr_admin', 'payroll_maker'), ah(async (req, res) => {
  const { establishmentId, gross, months } = z.object({ establishmentId: oid, gross: z.coerce.number().positive(), months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query);
  const est = await Establishment.findById(establishmentId).lean(); if (!est) throw fail(404, 'Establishment not found');
  const a = assessEmiratisation({ employees: await Employee.find({ establishmentId }).lean(), establishment: est });
  const grossFils = Math.round(gross * 100); const n = nafisScenario({ grossWageFils: grossFils });
  const slotFine = n.finePerMonthFils;
  res.json({ assessment: { gap: a.gap, monthlyExposureFils: a.monthlyExposureFils }, nafis: n, comparison: hiringVsFine({ grossWageFils: grossFils, nafisSubsidyFils: n.modelledSubsidyFils, monthlyFineFils: slotFine, months }) });
}));

export default r;
