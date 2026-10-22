// Time & attendance extensions: shift templates (split/night), drag-and-drop roster, public holidays, Ramadan
// windows, attendance disputes & missed punches (employee-visible edit trail), biometric devices, liveness checks,
// and a holiday-aware team calendar.
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { Employee, Establishment, Attendance, LeaveRequest, Notification } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { localParts, evaluateDay, UAE_HOLIDAYS } from '../../lib/attendance.js';
import { encryptField } from '../../lib/fieldcrypt.js';
import { aiEnabled, callClaude } from '../../lib/ai.js';
import { ShiftTemplate, RosterEntry, PublicHoliday, RamadanPeriod, AttendanceDispute, AttendanceDevice, DevicePunch, LivenessCheck } from '../models.js';
import { rosterWarnings, shiftMinutes, isNightShift, holidaySet, workingDays, addDays, missedPunches, hm } from '../lib/time.js';
import { z, fail, ymd, oid, decodeUpload, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const HR = requireRole('hr_admin');
const MGR = requireRole('hr_admin', 'manager');
const today = () => localParts(new Date()).date;
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

// ---------------- Shift templates ----------------
r.get('/shifts', MGR, ah(async (req, res) => res.json((await ShiftTemplate.find().sort({ name: 1 }).lean()).map((s) => ({ ...s, minutes: shiftMinutes(s), night: isNightShift(s) })))));
const shiftIn = z.object({ name: z.string().min(2).max(60), code: z.string().min(1).max(8).regex(/^[A-Z0-9-]+$/i), segments: z.array(z.object({ start: hhmm, end: hhmm })).min(1).max(3), breakMin: z.number().int().min(0).max(180).default(60), paidBreak: z.boolean().default(false), graceMin: z.number().int().min(0).max(120).default(15), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), ramadanReduceMin: z.number().int().min(0).max(240).default(120) });
r.post('/shifts', HR, ah(async (req, res) => { const b = shiftIn.parse(req.body); const s = await ShiftTemplate.create({ ...b, code: b.code.toUpperCase() }); await audit(req, 'shift.create', 'ShiftTemplate', s._id, null, b); res.status(201).json(s); }));
r.patch('/shifts/:id', HR, ah(async (req, res) => { const b = shiftIn.partial().parse(req.body); const before = await ShiftTemplate.findById(req.params.id).lean(); if (!before) throw fail(404, 'Shift not found'); const s = await ShiftTemplate.findByIdAndUpdate(req.params.id, { $set: b }, { new: true }); await audit(req, 'shift.update', 'ShiftTemplate', s._id, before, b); res.json(s); }));
r.delete('/shifts/:id', HR, ah(async (req, res) => {
  if (await RosterEntry.exists({ shiftId: req.params.id, date: { $gte: today() } })) throw fail(409, 'This shift is used in upcoming rosters. Reassign those days first.');
  await ShiftTemplate.deleteOne({ _id: req.params.id }); await audit(req, 'shift.delete', 'ShiftTemplate', req.params.id); res.json({ ok: true });
}));

// ---------------- Roster (week/month grid) ----------------
r.get('/roster', MGR, ah(async (req, res) => {
  const { from, to, establishmentId, department } = z.object({ from: ymd, to: ymd, establishmentId: oid.optional(), department: z.string().optional() }).parse(req.query);
  if (Date.parse(to) - Date.parse(from) > 62 * 864e5) throw fail(400, 'Pick a range of up to two months.');
  const empQ = { status: { $in: ['active', 'notice', 'onboarding'] }, ...(establishmentId ? { establishmentId } : {}), ...(department ? { department } : {}) };
  const emps = await Employee.find(empQ).select('fullName employeeNo department establishmentId').sort({ department: 1, fullName: 1 }).lean();
  const ids = emps.map((e) => e._id);
  const [entries, shifts, leaves, hols] = await Promise.all([
    RosterEntry.find({ employeeId: { $in: ids }, date: { $gte: from, $lte: to } }).lean(), ShiftTemplate.find().lean(),
    LeaveRequest.find({ employeeId: { $in: ids }, status: 'approved', startDate: { $lte: new Date(`${to}T23:59:59Z`) }, endDate: { $gte: new Date(`${from}T00:00:00Z`) } }).select('employeeId startDate endDate type').lean(),
    PublicHoliday.find({ date: { $gte: from, $lte: to } }).lean(),
  ]);
  const holidays = Object.fromEntries(holidaySet(hols, establishmentId)); const leaveDays = {};
  for (const l of leaves) for (let d = new Date(l.startDate).toISOString().slice(0, 10); d <= new Date(l.endDate).toISOString().slice(0, 10); d = addDays(d, 1)) (leaveDays[String(l.employeeId)] ||= {})[d] = l.type;
  const warnings = Object.fromEntries(emps.map((e) => [String(e._id), rosterWarnings(entries.filter((x) => String(x.employeeId) === String(e._id)), shifts, { leaveDates: new Set(Object.keys(leaveDays[String(e._id)] || {})) })]));
  res.json({ from, to, employees: emps, entries, shifts: shifts.map((s) => ({ ...s, minutes: shiftMinutes(s), night: isNightShift(s) })), leave: leaveDays, holidays: Object.fromEntries(Object.entries(holidays).filter(([d]) => d >= from && d <= to)), warnings });
}));
r.put('/roster', MGR, ah(async (req, res) => {
  const { entries } = z.object({ entries: z.array(z.object({ employeeId: oid, date: ymd, shiftId: oid.nullable().optional(), restDay: z.boolean().default(false), note: z.string().max(120).optional(), clear: z.boolean().optional() })).min(1).max(2000) }).parse(req.body);
  const emps = await Employee.find({ _id: { $in: [...new Set(entries.map((e) => e.employeeId))] } }).select('establishmentId').lean();
  if (emps.length !== new Set(entries.map((e) => e.employeeId)).size) throw fail(400, 'One or more employees were not found.');
  let n = 0;
  for (const e of entries) {
    if (e.clear) { await RosterEntry.deleteOne({ employeeId: e.employeeId, date: e.date }); n++; continue; }
    const est = emps.find((x) => String(x._id) === e.employeeId)?.establishmentId;
    await RosterEntry.findOneAndUpdate({ employeeId: e.employeeId, date: e.date }, { $set: { shiftId: e.restDay ? null : e.shiftId, restDay: e.restDay, note: e.note, establishmentId: est, createdBy: req.user.id, publishedAt: null } }, { upsert: true }); n++;
  }
  await audit(req, 'roster.update', 'RosterEntry', '', null, { entries: n }); res.json({ saved: n });
}));
r.post('/roster/publish', MGR, ah(async (req, res) => {
  const { from, to } = z.object({ from: ymd, to: ymd }).parse(req.body);
  const unpublished = await RosterEntry.find({ date: { $gte: from, $lte: to }, publishedAt: null }).select('employeeId').lean();
  await RosterEntry.updateMany({ date: { $gte: from, $lte: to }, publishedAt: null }, { $set: { publishedAt: new Date() } });
  for (const id of new Set(unpublished.map((x) => String(x.employeeId)))) await Notification.create({ audience: 'employee', employeeId: id, title: 'Your shift roster is published', body: `Shifts from ${from} to ${to} are now available in Attendance.`, link: '#eclock' }).catch(() => {});
  await audit(req, 'roster.publish', 'RosterEntry', '', null, { from, to, employees: new Set(unpublished.map((x) => String(x.employeeId))).size });
  await emitEvent('roster.published', { from, to });
  res.json({ published: unpublished.length });
}));
r.post('/roster/copy-week', MGR, ah(async (req, res) => {
  const { fromWeekStart, toWeekStart } = z.object({ fromWeekStart: ymd, toWeekStart: ymd }).parse(req.body);
  const src = await RosterEntry.find({ date: { $gte: fromWeekStart, $lte: addDays(fromWeekStart, 6) } }).lean();
  const shift = Math.round((Date.parse(toWeekStart) - Date.parse(fromWeekStart)) / 864e5);
  for (const e of src) await RosterEntry.findOneAndUpdate({ employeeId: e.employeeId, date: addDays(e.date, shift) }, { $set: { shiftId: e.shiftId, restDay: e.restDay, establishmentId: e.establishmentId, createdBy: req.user.id, publishedAt: null } }, { upsert: true });
  await audit(req, 'roster.copy_week', 'RosterEntry', '', null, { fromWeekStart, toWeekStart, entries: src.length }); res.json({ copied: src.length });
}));
r.get('/me/roster', ah(async (req, res) => {
  const from = today(); const to = addDays(from, 27);
  const [entries, shifts] = await Promise.all([RosterEntry.find({ employeeId: req.user.employeeId, date: { $gte: from, $lte: to }, publishedAt: { $ne: null } }).sort({ date: 1 }).lean(), ShiftTemplate.find().lean()]);
  res.json(entries.map((e) => ({ date: e.date, restDay: e.restDay, note: e.note, shift: shifts.find((s) => String(s._id) === String(e.shiftId)) || null })));
}));

// ---------------- Public holidays & Ramadan ----------------
r.get('/holidays', ah(async (req, res) => {
  const year = String(req.query.year || new Date().getUTCFullYear());
  const own = await PublicHoliday.find({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).sort({ date: 1 }).lean();
  const builtIn = UAE_HOLIDAYS.filter((h) => h.date.startsWith(year) && !own.some((o) => o.date === h.date)).map((h) => ({ ...h, builtIn: true }));
  res.json([...own, ...builtIn].sort((a, b) => a.date.localeCompare(b.date)));
}));
r.post('/holidays', HR, ah(async (req, res) => { const b = z.object({ date: ymd, name: z.string().min(2).max(80), nameAr: z.string().max(80).optional(), establishmentId: oid.optional(), estimated: z.boolean().default(false), source: z.string().max(200).optional() }).parse(req.body); const h = await PublicHoliday.create(b); await audit(req, 'holiday.create', 'PublicHoliday', h._id, null, b); res.status(201).json(h); }));
r.delete('/holidays/:id', HR, ah(async (req, res) => { await PublicHoliday.deleteOne({ _id: req.params.id }); await audit(req, 'holiday.delete', 'PublicHoliday', req.params.id); res.json({ ok: true }); }));
r.get('/ramadan', ah(async (req, res) => res.json({ periods: await RamadanPeriod.find().sort({ start: -1 }).lean(), activeToday: process.env.RAMADAN_MODE === 'true' })));
r.post('/ramadan', HR, ah(async (req, res) => { const b = z.object({ year: z.number().int(), start: ymd, end: ymd, reduceMin: z.number().int().min(0).max(240).default(120), estimated: z.boolean().default(true) }).parse(req.body); if (b.end < b.start) throw fail(400, 'End is before start.'); const p = await RamadanPeriod.create(b); await audit(req, 'ramadan.create', 'RamadanPeriod', p._id, null, b); res.status(201).json(p); }));

// ---------------- Working-days calculator & team calendar ----------------
r.get('/calendar/working-days', ah(async (req, res) => {
  const { from, to, establishmentId } = z.object({ from: ymd, to: ymd, establishmentId: oid.optional() }).parse(req.query);
  const hols = await PublicHoliday.find({ date: { $gte: from, $lte: to } }).lean();
  res.json(workingDays(from, to, { holidays: holidaySet(hols, establishmentId), weekend: (req.query.weekend ? String(req.query.weekend).split(',').map(Number) : [0, 6]) }));
}));
r.get('/calendar/team', MGR, ah(async (req, res) => {
  const { month, department } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), department: z.string().optional() }).parse(req.query);
  const from = `${month}-01`; const to = addDays(addDays(from, 32).slice(0, 8) + '01', -1);
  const emps = await Employee.find({ status: { $in: ['active', 'notice'] }, ...(department ? { department } : {}) }).select('fullName department').lean();
  const [leaves, hols] = await Promise.all([LeaveRequest.find({ employeeId: { $in: emps.map((e) => e._id) }, status: { $in: ['approved', 'pending'] }, startDate: { $lte: new Date(`${to}T23:59:59Z`) }, endDate: { $gte: new Date(`${from}T00:00:00Z`) } }).lean(), PublicHoliday.find({ date: { $gte: from, $lte: to } }).lean()]);
  const holidays = holidaySet(hols);
  const byDay = {};
  for (const l of leaves) for (let d = new Date(l.startDate).toISOString().slice(0, 10); d <= new Date(l.endDate).toISOString().slice(0, 10); d = addDays(d, 1)) if (d >= from && d <= to) (byDay[d] ||= []).push({ employeeId: l.employeeId, status: l.status, type: l.type, department: emps.find((e) => String(e._id) === String(l.employeeId))?.department });
  const overlaps = Object.entries(byDay).filter(([, a]) => { const c = {}; a.forEach((x) => (c[x.department] = (c[x.department] || 0) + 1)); return Object.values(c).some((n) => n >= 2); }).map(([d]) => d);
  res.json({ month, holidays: Object.fromEntries([...holidays].filter(([d]) => d >= from && d <= to)), byDay, overlaps, leave: leaves.map((l) => ({ ...l, workingDays: workingDays(new Date(l.startDate).toISOString().slice(0, 10), new Date(l.endDate).toISOString().slice(0, 10), { holidays }).working })) });
}));

// ---------------- Disputes & missed punches (transparent edits) ----------------
r.post('/me/attendance/disputes', ah(async (req, res) => {
  const b = z.object({ date: ymd, attendanceId: oid.optional(), kind: z.enum(['missed_punch', 'wrong_time', 'not_late', 'overtime_claim', 'other']), requestedIn: hhmm.optional(), requestedOut: hhmm.optional(), reason: z.string().min(5).max(500) }).parse(req.body);
  if (b.date > today()) throw fail(400, 'You can only dispute past days.');
  if (b.attendanceId && !(await Attendance.exists({ _id: b.attendanceId, employeeId: req.user.employeeId }))) throw fail(404, 'Attendance record not found');
  const d = await AttendanceDispute.create({ ...b, employeeId: req.user.employeeId });
  await Notification.create({ audience: 'manager', title: 'Attendance correction requested', body: `${b.kind.replace('_', ' ')} on ${b.date}: ${b.reason.slice(0, 80)}`, link: '#timeplus' }).catch(() => {});
  await audit(req, 'attendance.dispute.create', 'AttendanceDispute', d._id, null, b); res.status(201).json(d);
}));
r.get('/me/attendance/disputes', ah(async (req, res) => res.json(await AttendanceDispute.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean())));
r.get('/attendance/disputes', MGR, ah(async (req, res) => res.json(await AttendanceDispute.find(req.query.status ? { status: req.query.status } : { status: 'open' }).sort({ createdAt: -1 }).populate('employeeId', 'fullName employeeNo department').lean())));
r.post('/attendance/disputes/:id/decision', MGR, ah(async (req, res) => {
  const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(300).optional(), clockIn: hhmm.optional(), clockOut: hhmm.optional() }).parse(req.body);
  const d = await AttendanceDispute.findById(req.params.id); if (!d || d.status !== 'open') throw fail(404, 'Open dispute not found');
  d.status = b.decision; d.decidedBy = req.user.id; d.decidedAt = new Date(); d.decisionNote = b.note;
  if (b.decision === 'approved' && (b.clockIn || b.clockOut || d.requestedIn || d.requestedOut)) {
    const emp = await Employee.findById(d.employeeId).lean(); const est = await Establishment.findById(emp.establishmentId).lean();
    const toDate = (t) => new Date(`${d.date}T${t}:00+04:00`); // UAE time (no DST)
    let rec = d.attendanceId ? await Attendance.findById(d.attendanceId) : await Attendance.findOne({ employeeId: d.employeeId, date: d.date }).sort({ seq: 1 });
    const before = rec ? { clockIn: rec.clockIn?.at, clockOut: rec.clockOut?.at, minutesWorked: rec.minutesWorked } : null;
    if (!rec) rec = new Attendance({ employeeId: d.employeeId, establishmentId: emp.establishmentId, date: d.date, seq: 0, source: 'hr', status: 'present' });
    const ci = b.clockIn || d.requestedIn; const co = b.clockOut || d.requestedOut;
    if (ci) rec.clockIn = { ...(rec.clockIn?.toObject?.() || rec.clockIn || {}), at: toDate(ci), device: 'HR correction' };
    if (co) { let out = toDate(co); if (rec.clockIn?.at && out < rec.clockIn.at) out = new Date(out.getTime() + 864e5); rec.clockOut = { ...(rec.clockOut?.toObject?.() || rec.clockOut || {}), at: out, device: 'HR correction' }; }
    if (rec.clockIn?.at && rec.clockOut?.at) { const ev = evaluateDay({ clockInAt: rec.clockIn.at, clockOutAt: rec.clockOut.at, shift: est?.shift }); rec.minutesWorked = ev.minutesWorked; rec.overtimeMinutes = ev.overtimeMinutes; }
    if (d.kind === 'not_late') { rec.lateMinutes = 0; rec.status = 'present'; }
    rec.flags = [...(rec.flags || []).filter((f) => f.code !== 'MISSED_PUNCH'), { code: 'HR_APPROVED', msg: `Corrected by manager: ${b.note || d.kind}` }];
    await rec.save();
    d.edit = { before, after: { clockIn: rec.clockIn?.at, clockOut: rec.clockOut?.at, minutesWorked: rec.minutesWorked }, by: req.user.name, at: new Date() };
    await audit(req, 'attendance.correct', 'Attendance', rec._id, before, d.edit.after);
  }
  await d.save();
  await Notification.create({ audience: 'employee', employeeId: d.employeeId, title: `Attendance correction ${b.decision}`, body: `${d.date}: ${b.note || ''}`, link: '#eclock' }).catch(() => {});
  await audit(req, `attendance.dispute.${b.decision}`, 'AttendanceDispute', d._id, null, { note: b.note }); res.json(d);
}));
r.get('/attendance/missed-punches', MGR, ah(async (req, res) => {
  const recs = await Attendance.find({ date: { $gte: addDays(today(), -14), $lt: today() }, 'clockOut.at': { $exists: false } }).populate('employeeId', 'fullName employeeNo department').lean();
  res.json(missedPunches(recs, today()).map((x) => ({ _id: x._id, date: x.date, employee: x.employeeId, clockIn: x.clockIn?.at })));
}));

// ---------------- Biometric devices (ZKTeco / Hikvision push) ----------------
r.get('/attendance/devices', HR, ah(async (req, res) => res.json(await AttendanceDevice.find().lean())));
r.post('/attendance/devices', HR, ah(async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(60), vendor: z.enum(['zkteco', 'hikvision', 'generic']), serial: z.string().max(60).optional(), establishmentId: oid.optional() }).parse(req.body);
  const secret = randomBytes(24).toString('base64url'); const keyId = `dev_${randomBytes(6).toString('hex')}`;
  const d = await AttendanceDevice.create({ ...b, keyId, secretEnc: encryptField(secret) });
  await audit(req, 'device.create', 'AttendanceDevice', d._id, null, { name: b.name, vendor: b.vendor });
  res.status(201).json({ device: d, keyId, secret, pushUrl: '/api/public/devices/punch', note: 'Copy the secret now; it is not shown again. Sign each push body with HMAC-SHA256 (header X-Wasl-Signature) or use the vendor adapter/middleware with these credentials.' });
}));
r.patch('/attendance/devices/:id', HR, ah(async (req, res) => { const b = z.object({ active: z.boolean().optional(), name: z.string().optional(), establishmentId: oid.optional() }).parse(req.body); const d = await AttendanceDevice.findByIdAndUpdate(req.params.id, { $set: b }, { new: true }); await audit(req, 'device.update', 'AttendanceDevice', req.params.id, null, b); res.json(d); }));
r.get('/attendance/devices/:id/punches', HR, ah(async (req, res) => res.json(await DevicePunch.find({ deviceId: req.params.id }).sort({ at: -1 }).limit(200).lean())));

// ---------------- Liveness check (challenge → two frames) ----------------
const CHALLENGES = ['Turn your head slightly to the left', 'Turn your head slightly to the right', 'Smile', 'Look up briefly', 'Blink twice'];
r.post('/me/liveness/challenge', ah(async (req, res) => {
  const challenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
  const c = await LivenessCheck.create({ employeeId: req.user.employeeId, challenge, expiresAt: new Date(Date.now() + 2 * 60 * 1000) });
  res.json({ id: c._id, challenge, expiresAt: c.expiresAt });
}));
r.post('/me/liveness/:id', ah(async (req, res) => {
  const b = z.object({ frameA: z.string().max(1_400_000), frameB: z.string().max(1_400_000) }).parse(req.body);
  const c = await LivenessCheck.findOne({ _id: req.params.id, employeeId: req.user.employeeId }); if (!c || c.usedAt) throw fail(404, 'Challenge not found or already used');
  if (c.expiresAt < new Date()) throw fail(410, 'The challenge expired. Start again.');
  const A = decodeUpload(b.frameA, 1_000_000), B = decodeUpload(b.frameB, 1_000_000);
  if (A.equals(B)) { Object.assign(c, { passed: false, method: 'frame-diff', detail: 'Identical frames (possible photo replay).', usedAt: new Date(), attendanceDate: today() }); await c.save(); return res.json({ passed: false, detail: c.detail }); }
  let passed = null, detail = 'Two distinct frames captured; HR can review.', method = 'frame-diff', score = null;
  if (aiEnabled()) {
    try {
      const img = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
      const out = await callClaude({ system: 'You check selfie liveness for attendance. Be conservative. Do not identify the person or describe sensitive traits.', messages: [{ role: 'user', content: [img(A), img(B), { type: 'text', text: `Frame 1 is neutral. Frame 2 should show the same live person doing: "${c.challenge}". Is this a live person (not a photo of a screen/print) performing the action, and the same person in both frames?` }] }], tools: [{ name: 'verdict', description: 'Liveness verdict', input_schema: { type: 'object', properties: { live: { type: 'boolean' }, samePerson: { type: 'boolean' }, actionPerformed: { type: 'boolean' }, confidence: { type: 'number' }, note: { type: 'string' } }, required: ['live', 'samePerson', 'actionPerformed', 'confidence'] } }], toolChoice: { type: 'tool', name: 'verdict' }, maxTokens: 300 });
      const v = out.content?.find((x) => x.type === 'tool_use')?.input;
      if (v) { passed = v.live && v.samePerson && v.actionPerformed && v.confidence >= 0.7; score = v.confidence; detail = v.note || (passed ? 'Liveness confirmed' : 'Liveness not confirmed'); method = 'ai-vision'; }
    } catch (e) { detail = `AI check unavailable (${e.message}); flagged for HR review.`; }
  }
  Object.assign(c, { passed, score, method, detail, usedAt: new Date(), attendanceDate: today() }); await c.save();
  if (passed === false) await Notification.create({ audience: 'hr', title: 'Liveness check failed', body: `An employee clock-in liveness check failed: ${detail}`, link: '#timeplus', severity: 'warn' }).catch(() => {});
  res.json({ passed, method, detail });
}));
r.get('/attendance/liveness', HR, ah(async (req, res) => res.json(await LivenessCheck.find({ usedAt: { $exists: true } }).sort({ createdAt: -1 }).limit(200).populate('employeeId', 'fullName employeeNo').lean())));

export default r;

/** Apply a device punch to attendance (used by the public device endpoint, inside the tenant context). */
export async function applyDevicePunch({ device, employeeNo, at, direction = 'auto', eventId, verifyMode, raw }) {
  const emp = await Employee.findOne({ employeeNo, status: { $in: ['active', 'notice', 'onboarding'] } }).lean();
  const log = async (result, employeeId) => { try { await DevicePunch.create({ deviceId: device._id, employeeNo, employeeId, at, direction, verifyMode, raw, eventId, result }); } catch (e) { if (e?.code === 11000) return 'duplicate'; throw e; } return result; };
  if (!emp) return log('unknown_employee');
  if (eventId && (await DevicePunch.exists({ deviceId: device._id, eventId }))) return 'duplicate';
  const est = await Establishment.findById(device.establishmentId || emp.establishmentId).lean();
  const local = localParts(at, est?.shift?.timezone);
  const open = await Attendance.findOne({ employeeId: emp._id, 'clockIn.at': { $gte: new Date(at.getTime() - 20 * 3600e3), $lte: at }, 'clockOut.at': { $exists: false } }).sort({ 'clockIn.at': -1 });
  const dir = direction === 'auto' ? (open ? 'out' : 'in') : direction;
  if (dir === 'in') {
    if (open) return log('already_in', emp._id);
    const seq = await Attendance.countDocuments({ employeeId: emp._id, date: local.date });
    const late = seq === 0 ? Math.max(0, local.minutes - hm(est?.shift?.start || '08:00') - (est?.shift?.graceMin ?? 15)) : 0;
    await Attendance.create({ employeeId: emp._id, establishmentId: emp.establishmentId, date: local.date, seq, source: 'kiosk', clockIn: { at, device: `${device.vendor}:${device.serial || device.name}`, insideGeofence: true }, lateMinutes: late, status: late ? 'late' : 'present', flags: late ? [{ code: 'LATE', msg: `${late} min after the grace period` }] : [] });
    return log('clock_in', emp._id);
  }
  if (!open) return log('no_open_session', emp._id);
  const ev = evaluateDay({ clockInAt: open.clockIn.at, clockOutAt: at, shift: est?.shift, ramadan: process.env.RAMADAN_MODE === 'true' });
  open.clockOut = { at, device: `${device.vendor}:${device.serial || device.name}`, insideGeofence: true }; open.minutesWorked = ev.minutesWorked; open.overtimeMinutes = ev.overtimeMinutes;
  if (ev.overtimeMinutes > 0) open.flags.push({ code: 'OVERTIME', msg: `${Math.round(ev.overtimeMinutes / 6) / 10} h beyond the standard day` });
  await open.save();
  return log('clock_out', emp._id);
}

