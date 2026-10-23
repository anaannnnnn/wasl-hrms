// Public, versioned REST API (/api/v1) for integrations. API-key auth with scopes, per-key rate limits,
// Idempotency-Key support on writes, tenant isolation via the same tenant context as the app, and
// no sensitive fields (salary, IBAN, identifiers) in responses.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Employee, Establishment, LeaveRequest, Attendance, PayrollRun, AuditLog } from '../../models/index.js';
import { runAsSystem, runWithTenant } from '../../lib/tenantContext.js';
import { evaluateRequest } from '../../lib/leave.js';
import { ApiKey, IdempotencyRecord } from '../models.js';
import { parseApiKey, apiKeyMatches, requestHash } from '../lib/platform.js';
import { applyDevicePunch } from './time.js';
import { z, fail, ymd, oid, emitEvent } from './_util.js';

const r = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

r.use(ah(async (req, res, next) => {
  const raw = req.headers['x-api-key'] || (String(req.headers.authorization || '').startsWith('Bearer wsl_') ? String(req.headers.authorization).slice(7) : null);
  const parsed = parseApiKey(raw);
  if (!parsed) return res.status(401).json({ error: 'Missing or malformed API key.' });
  const key = await runAsSystem(() => ApiKey.findOne({ prefix: parsed.prefix, revokedAt: null }).lean());
  if (!apiKeyMatches(key, parsed)) return res.status(401).json({ error: 'Invalid API key.' });
  req.apiKey = key; req.user = { id: null, tenantId: String(key.tenantId), roles: ['api'], name: `API key ${key.name}` }; req.correlationId = req.headers['x-correlation-id'] || `api-${Date.now()}`;
  runAsSystem(() => ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } })).catch(() => {});
  runWithTenant({ tenantId: String(key.tenantId), userId: null }, () => next());
}));
r.use(rateLimit({ windowMs: 60 * 1000, max: 600, keyGenerator: (req) => req.apiKey.prefix, standardHeaders: true, legacyHeaders: false, message: { error: 'Rate limit exceeded (600 requests/minute per key).' } }));
const scope = (s) => (req, res, next) => (req.apiKey.scopes.includes(s) ? next() : res.status(403).json({ error: `This key lacks the ${s} scope.` }));
const log = (req, action, entity, id, after) => AuditLog.create({ actorType: 'system', action, entity, entityId: String(id ?? ''), after: { ...after, apiKey: req.apiKey.prefix }, correlationId: req.correlationId }).catch(() => {});

/** Replays the stored response for a repeated Idempotency-Key; rejects reuse with a different body. */
const idempotent = (fn) => ah(async (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) return fn(req, res);
  if (!/^[\w-]{8,100}$/.test(key)) throw fail(400, 'Idempotency-Key must be 8–100 letters, digits, - or _.');
  const route = `${req.method} ${req.baseUrl}${req.route.path}`; const h = requestHash(req.body);
  const prev = await IdempotencyRecord.findOne({ key, route }).lean();
  if (prev) { if (prev.requestHash !== h) throw fail(422, 'This Idempotency-Key was used with a different request body.'); res.setHeader('Idempotent-Replay', 'true'); return res.status(prev.status).json(prev.response); }
  // Hold the response until the record is stored, so an immediate retry always sees it (no race).
  const json = res.json.bind(res); let captured; res.json = (body) => { captured = body; return res; };
  try { await fn(req, res); } finally { res.json = json; }
  if (captured === undefined) return;
  if (res.statusCode < 500) await IdempotencyRecord.create({ key, route, requestHash: h, status: res.statusCode, response: captured }).catch(() => {});
  return json(captured);
});
const page = (req) => ({ limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)), skip: Math.max(0, Number(req.query.offset) || 0) });
const pubEmp = (e) => ({ id: e._id, employeeNo: e.employeeNo, fullName: e.fullName, fullNameAr: e.fullNameAr, email: e.email, jobTitle: e.jobTitle, department: e.department, managerId: e.managerId, establishmentId: e.establishmentId, status: e.status, contractType: e.contractType, joinDate: e.joinDate, exitDate: e.exitDate, updatedAt: e.updatedAt });

r.get('/employees', scope('employees:read'), ah(async (req, res) => {
  const { limit, skip } = page(req); const q = { ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.updatedSince ? { updatedAt: { $gte: new Date(req.query.updatedSince) } } : {}) };
  const [rows, total] = await Promise.all([Employee.find(q).sort({ _id: 1 }).skip(skip).limit(limit).lean(), Employee.countDocuments(q)]);
  res.json({ data: rows.map(pubEmp), total, limit, offset: skip });
}));
r.get('/employees/:id', scope('employees:read'), ah(async (req, res) => { const e = await Employee.findById(oid.parse(req.params.id)).lean(); if (!e) throw fail(404, 'Not found'); res.json(pubEmp(e)); }));
r.get('/establishments', scope('employees:read'), ah(async (req, res) => res.json({ data: (await Establishment.find().select('name nameAr jurisdiction freeZone emirate').lean()).map(({ _id, ...x }) => ({ id: _id, ...x })) })));

r.get('/leave', scope('leave:read'), ah(async (req, res) => {
  const { limit, skip } = page(req);
  const q = { ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.employeeId ? { employeeId: req.query.employeeId } : {}), ...(req.query.from ? { endDate: { $gte: new Date(req.query.from) } } : {}) };
  const rows = await LeaveRequest.find(q).sort({ startDate: -1 }).skip(skip).limit(limit).select('employeeId type startDate endDate days status createdAt').lean();
  res.json({ data: rows.map(({ _id, ...x }) => ({ id: _id, ...x })), limit, offset: skip });
}));
r.post('/leave', scope('leave:write'), idempotent(async (req, res) => {
  const b = z.object({ employeeId: oid, type: z.enum(['annual', 'sick', 'parental', 'hajj', 'unpaid', 'other']), startDate: ymd, endDate: ymd, reason: z.string().max(300).optional() }).parse(req.body);
  const employee = await Employee.findById(b.employeeId).lean(); if (!employee) throw fail(404, 'Employee not found');
  const est = await Establishment.findById(employee.establishmentId).lean();
  const ev = evaluateRequest({ employee, request: b, existing: await LeaveRequest.find({ employeeId: employee._id }).lean(), rulePackId: est?.rulePackId });
  if (!ev.ok) return res.status(422).json({ error: ev.errors.join(' '), warnings: ev.warnings });
  const lr = await LeaveRequest.create({ employeeId: employee._id, type: b.type, startDate: b.startDate, endDate: b.endDate, reason: b.reason, days: ev.days, ...ev.split, warnings: ev.warnings, source: 'web' });
  await log(req, 'leave.create.api', 'LeaveRequest', lr._id, { via: 'api', days: ev.days });
  await emitEvent('leave.created', { leaveRequestId: String(lr._id), employeeId: String(employee._id), days: ev.days });
  res.status(201).json({ id: lr._id, status: lr.status, days: ev.days, warnings: ev.warnings });
}));

r.get('/attendance', scope('attendance:read'), ah(async (req, res) => {
  const { from, to } = z.object({ from: ymd, to: ymd }).parse(req.query);
  if (Date.parse(to) - Date.parse(from) > 62 * 864e5) throw fail(400, 'Range is limited to 62 days.');
  const { limit, skip } = page(req);
  const rows = await Attendance.find({ date: { $gte: from, $lte: to }, ...(req.query.employeeId ? { employeeId: req.query.employeeId } : {}) }).sort({ date: 1 }).skip(skip).limit(limit).select('employeeId date seq clockIn.at clockOut.at minutesWorked lateMinutes overtimeMinutes status source').lean();
  res.json({ data: rows.map(({ _id, ...x }) => ({ id: _id, ...x })), limit, offset: skip });
}));
r.post('/attendance/punches', scope('attendance:write'), idempotent(async (req, res) => {
  const { punches } = z.object({ punches: z.array(z.object({ employeeNo: z.string(), time: z.string().datetime({ offset: true }), direction: z.enum(['in', 'out', 'auto']).default('auto'), eventId: z.string().max(80).optional() })).min(1).max(200) }).parse(req.body);
  const device = { _id: null, vendor: 'api', name: req.apiKey.name, establishmentId: null };
  const results = [];
  for (const p of punches) results.push({ eventId: p.eventId, result: await applyDevicePunch({ device, employeeNo: p.employeeNo, at: new Date(p.time), direction: p.direction, eventId: p.eventId ? `api:${p.eventId}` : undefined }) });
  await log(req, 'attendance.api_punches', 'Attendance', '', { count: punches.length });
  res.json({ results });
}));

r.get('/payroll/runs', scope('payroll:read'), ah(async (req, res) => {
  const rows = await PayrollRun.find(req.query.period ? { period: req.query.period } : {}).sort({ period: -1 }).limit(50).select('establishmentId period type runNo status totals approvedAt').lean();
  res.json({ data: rows.map(({ _id, ...x }) => ({ id: _id, ...x })) });
}));

r.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', fields: err.flatten().fieldErrors });
  if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid ID.' });
  if (err?.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Internal error', correlationId: req.correlationId });
});
export default r;
