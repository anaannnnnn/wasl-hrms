// Attendance (clock in/out with selfie + GPS), employee home dashboard, digital employee tag,
// employee AI assistant, and HR attendance monitoring.
import { Router } from 'express';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Attendance, Employee, Establishment, LeaveRequest, PayrollRun, ComplianceDocument, ServiceRequest, Notification } from '../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../middleware/auth.js';
import { evaluateClockIn, evaluateDay, summarize, localParts, upcomingHolidays } from '../lib/attendance.js';
import { leaveBalances } from '../lib/leave.js';
import { aiEnabled, callClaude } from '../lib/ai.js';
import { config } from '../config.js';

const r = Router();
r.use(authenticate, restrictEmployees);

const DAY = 864e5;
const myEmp = async (req) => {
  if (!req.user.employeeId) { const e = new Error('Your login is not linked to an employee record.'); e.status = 400; throw e; }
  const emp = await Employee.findById(req.user.employeeId).lean();
  if (!emp) { const e = new Error('Employee record not found.'); e.status = 404; throw e; }
  return emp;
};
const siteOf = async (emp) => Establishment.findById(emp.establishmentId).select('name geo shift rulePackId').lean();
const isRamadan = () => process.env.RAMADAN_MODE === 'true';
const pub = (a) => ({ ...a, photo: undefined });
// Combine a day's sessions (sorted by seq) into one view: first in, last out, totals, open session.
function dayView(records = []) {
  const list = [...records].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(pub);
  if (!list.length) return null;
  const first = list[0], last = list.at(-1);
  const flags = []; const seen = new Set();
  for (const r of list) for (const f of r.flags || []) if (!seen.has(f.code)) { seen.add(f.code); flags.push(f); }
  return {
    _id: first._id, date: first.date, sessions: list, current: last, open: !last.clockOut?.at,
    clockIn: first.clockIn, clockOut: last.clockOut?.at ? last.clockOut : null, hasPhoto: list.some((r) => r.hasPhoto),
    minutesWorked: list.reduce((a, r) => a + (r.minutesWorked || 0), 0), overtimeMinutes: list.reduce((a, r) => a + (r.overtimeMinutes || 0), 0),
    lateMinutes: first.lateMinutes || 0, flags,
  };
}

const gpsSchema = z.object({
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100000).optional(), gpsError: z.string().max(200).optional(), device: z.string().max(200).optional(),
});

// ---------------- Employee: clock in / out ----------------
r.get('/me/attendance/today', ah(async (req, res) => {
  const emp = await myEmp(req); const site = await siteOf(emp);
  const { date } = localParts(new Date(), site?.shift?.timezone);
  const recs = await Attendance.find({ employeeId: emp._id, date }).lean();
  res.json({ date, record: dayView(recs), site: { name: site?.name, label: site?.geo?.label, lat: site?.geo?.lat, lng: site?.geo?.lng, radiusM: site?.geo?.radiusM, shift: site?.shift }, ramadan: isRamadan() });
}));

r.post('/me/clock-in', ah(async (req, res) => {
  const b = gpsSchema.extend({ photo: z.string().regex(/^data:image\/(jpeg|png|webp);base64,/, 'Take a photo to clock in.').max(1_400_000, 'Photo is too large.') }).parse(req.body);
  const emp = await myEmp(req); const site = await siteOf(emp);
  const now = new Date();
  const ev = evaluateClockIn({ at: now, gps: Number.isFinite(b.lat) ? { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM } : { error: b.gpsError }, site: site?.geo && { ...site.geo, label: site.geo.label || site.name }, shift: site?.shift, timeZone: site?.shift?.timezone, ramadan: isRamadan() });
  const open = await Attendance.findOne({ employeeId: emp._id, 'clockIn.at': { $gte: new Date(Date.now() - 20 * 3600e3) }, 'clockOut.at': { $exists: false } }).lean();
  if (open) return res.status(409).json({ error: `You are already clocked in since ${new Date(open.clockIn.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: site?.shift?.timezone || 'Asia/Dubai' })}. Clock out first.` });
  const seq = await Attendance.countDocuments({ employeeId: emp._id, date: ev.date });
  if (seq > 0) { ev.lateMinutes = 0; ev.status = 'present'; ev.flags = ev.flags.filter((f) => f.code !== 'LATE'); } // lateness only applies to the first clock-in of the day
  const rec = await Attendance.create({
    employeeId: emp._id, establishmentId: emp.establishmentId, date: ev.date, seq, source: /Mobi|Android|iPhone/i.test(b.device || req.headers['user-agent'] || '') ? 'mobile' : 'web',
    clockIn: { at: now, lat: b.lat, lng: b.lng, accuracyM: b.accuracyM, distanceM: ev.distanceM, insideGeofence: ev.insideGeofence, gpsError: b.gpsError, device: (b.device || req.headers['user-agent'] || '').slice(0, 200) },
    photo: b.photo, hasPhoto: true, lateMinutes: ev.lateMinutes, status: ev.status, flags: ev.flags,
  });
  if (ev.flags.some((f) => f.code === 'OUTSIDE_GEOFENCE' || f.code === 'NO_GPS')) {
    await Notification.create({ audience: 'hr', title: `Clock-in needs review: ${emp.fullName}`, body: ev.flags.map((f) => f.msg).join(' · '), link: '#attendance', severity: 'warn' }).catch(() => {});
  }
  await audit(req, 'attendance.clock_in', 'Attendance', rec._id, null, { date: ev.date, inside: ev.insideGeofence, late: ev.lateMinutes });
  res.status(201).json({ record: pub(rec.toObject()), message: seq > 0 ? 'Clocked in again. Welcome back!' : ev.lateMinutes ? `Clocked in · ${ev.lateMinutes} min late` : 'Clocked in. Have a good shift!' });
}));

r.post('/me/clock-out', ah(async (req, res) => {
  const b = gpsSchema.parse(req.body);
  const emp = await myEmp(req); const site = await siteOf(emp);
  // the open record may be from yesterday for a night shift
  const rec = await Attendance.findOne({ employeeId: emp._id, 'clockIn.at': { $gte: new Date(Date.now() - 20 * 3600e3) }, 'clockOut.at': { $exists: false } }).sort({ 'clockIn.at': -1 });
  if (!rec) return res.status(400).json({ error: 'You are not clocked in. Clock in first.' });
  const now = new Date();
  const d = evaluateDay({ clockInAt: rec.clockIn.at, clockOutAt: now, shift: site?.shift, ramadan: isRamadan() });
  // Overtime is judged on the whole day: earlier sessions count toward the standard day
  const earlier = await Attendance.find({ employeeId: emp._id, date: rec.date, _id: { $ne: rec._id } }).select('minutesWorked').lean();
  const before = earlier.reduce((a, r) => a + (r.minutesWorked || 0), 0);
  const std = d.standardMinutes ?? 480;
  d.overtimeMinutes = Math.max(0, before + d.minutesWorked - std) - Math.max(0, before - std);
  let distanceM = null, inside = null;
  if (Number.isFinite(b.lat) && site?.geo?.lat != null) {
    const ev = evaluateClockIn({ at: now, gps: { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM }, site: site.geo, shift: { start: '00:00', graceMin: 1440 } });
    distanceM = ev.distanceM; inside = ev.insideGeofence;
  }
  rec.clockOut = { at: now, lat: b.lat, lng: b.lng, accuracyM: b.accuracyM, distanceM, insideGeofence: inside, gpsError: b.gpsError, device: (b.device || req.headers['user-agent'] || '').slice(0, 200) };
  rec.minutesWorked = d.minutesWorked; rec.overtimeMinutes = d.overtimeMinutes;
  if (d.overtimeMinutes > 0) rec.flags.push({ code: 'OVERTIME', msg: `${Math.round(d.overtimeMinutes / 6) / 10} h beyond the standard day` });
  await rec.save();
  await audit(req, 'attendance.clock_out', 'Attendance', rec._id, null, { minutes: d.minutesWorked });
  const total = before + d.minutesWorked;
  res.json({ record: pub(rec.toObject()), message: `Clocked out · ${Math.floor(total / 60)}h ${total % 60}m worked today` });
}));

r.get('/me/attendance', ah(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const list = await Attendance.find({ employeeId: req.user.employeeId, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).sort({ date: -1 }).lean();
  res.json({ month, records: list.map(pub), summary: summarize(list) });
}));

r.get('/me/attendance/:id/photo', ah(async (req, res) => {
  const a = await Attendance.findOne({ _id: req.params.id, employeeId: req.user.employeeId }).select('+photo').lean();
  if (!a?.photo) return res.status(404).json({ error: 'No photo for this day.' });
  res.json({ photo: a.photo });
}));

// ---------------- Employee: home dashboard ----------------
r.get('/me/home', ah(async (req, res) => {
  const emp = await myEmp(req); const site = await siteOf(emp);
  const { date } = localParts(new Date(), site?.shift?.timezone);
  const month = date.slice(0, 7);
  const [today, monthRecs, requests, docs, runs, leaves, notes] = await Promise.all([
    Attendance.find({ employeeId: emp._id, date }).lean(),
    Attendance.find({ employeeId: emp._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).lean(),
    ServiceRequest.find({ employeeId: emp._id }).sort({ createdAt: -1 }).limit(5).lean(),
    ComplianceDocument.find({ employeeId: emp._id }).sort({ expiryDate: 1 }).lean(),
    PayrollRun.find({ status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': emp._id }).sort({ period: -1 }).limit(6).lean(),
    LeaveRequest.find({ employeeId: emp._id }).sort({ startDate: -1 }).lean(),
    Notification.find({ $or: [{ employeeId: emp._id }, { audience: 'employee', employeeId: { $exists: false } }] }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  const lineOf = (run) => run.lines.find((l) => String(l.employeeId) === String(emp._id));
  const pays = runs.map((run) => ({ runId: run._id, period: run.period, type: run.type, netFils: lineOf(run)?.netFils || 0 })).reverse();
  res.json({
    profile: { fullName: emp.fullName, fullNameAr: emp.fullNameAr, employeeNo: emp.employeeNo, jobTitle: emp.jobTitle, department: emp.department, joinDate: emp.joinDate, establishment: site?.name },
    date, today: dayView(today), shift: site?.shift, site: site?.geo ? { label: site.geo.label || site.name, radiusM: site.geo.radiusM } : null,
    month: summarize(monthRecs),
    balances: leaveBalances({ employee: emp, requests: leaves, rulePackId: site?.rulePackId }),
    upcomingLeave: leaves.filter((l) => ['pending', 'approved'].includes(l.status) && new Date(l.endDate) >= new Date(date)).slice(0, 3),
    payslips: pays,
    documents: docs.map((d) => ({ _id: d._id, docType: d.docType, expiryDate: d.expiryDate, daysLeft: Math.ceil((new Date(d.expiryDate) - Date.now()) / DAY) })).slice(0, 4),
    requests, holidays: upcomingHolidays(date), notifications: notes,
  });
}));

// ---------------- Employee: digital tag (QR) ----------------
const tagSig = (tid, eid) => createHmac('sha256', config.jwtSecret).update(`wasl-tag:${tid}:${eid}`).digest('base64url').slice(0, 22);
r.get('/me/tag', ah(async (req, res) => {
  const emp = await myEmp(req); const site = await siteOf(emp);
  res.json({ token: `WASL1.${req.user.tenantId}.${emp._id}.${tagSig(req.user.tenantId, emp._id)}`, employeeNo: emp.employeeNo, fullName: emp.fullName, fullNameAr: emp.fullNameAr, jobTitle: emp.jobTitle, department: emp.department, establishment: site?.name, nationality: emp.nationality, joinDate: emp.joinDate });
}));
// HR/kiosk: verify a scanned tag
r.post('/attendance/verify-tag', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const [v, tid, eid, sig] = String(req.body?.token || '').split('.');
  const good = v === 'WASL1' && tid === req.user.tenantId && sig && sig.length === 22 && timingSafeEqual(Buffer.from(sig), Buffer.from(tagSig(tid, eid)));
  if (!good) return res.status(400).json({ error: 'This tag is not valid for your company.' });
  const emp = await Employee.findById(eid).select('fullName employeeNo jobTitle department status').lean();
  res.json({ valid: !!emp, employee: emp });
}));

// ---------------- Employee: AI assistant ----------------
r.post('/me/assistant', ah(async (req, res) => {
  const { message } = z.object({ message: z.string().min(1).max(600) }).parse(req.body);
  const emp = await myEmp(req); const site = await siteOf(emp);
  const leaves = await LeaveRequest.find({ employeeId: emp._id }).lean();
  const bal = leaveBalances({ employee: emp, requests: leaves, rulePackId: site?.rulePackId });
  const runs = await PayrollRun.find({ status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': emp._id }).sort({ period: -1 }).limit(3).lean();
  const last = runs[0] && runs[0].lines.find((l) => String(l.employeeId) === String(emp._id));
  const docs = await ComplianceDocument.find({ employeeId: emp._id }).sort({ expiryDate: 1 }).lean();
  const { date } = localParts(new Date(), site?.shift?.timezone);
  const today = dayView(await Attendance.find({ employeeId: emp._id, date }).lean());
  const ctx = {
    name: emp.fullName, jobTitle: emp.jobTitle, annualLeaveRemaining: bal.annual?.remaining, annualEntitlement: bal.annual?.entitlement, sickFullPayLeft: bal.sick?.fullPayLeft,
    lastPayslip: last ? { period: runs[0].period, netAED: (last.netFils / 100).toFixed(2) } : null,
    documents: docs.map((d) => ({ type: d.docType, expires: new Date(d.expiryDate).toISOString().slice(0, 10) })),
    clockedInToday: !!today?.clockIn?.at, clockedOut: !!today && !today.open, shift: site?.shift, holidays: upcomingHolidays(date),
  };
  const s = message.toLowerCase();
  const actions = [];
  if (/leave|vacation|holiday off|إجازة|chutti|chhutti/.test(s)) actions.push({ label: 'Apply for leave', go: 'eleave' });
  if (/payslip|salary|pay slip|راتب|tankhwah/.test(s)) actions.push({ label: 'Open payslips', go: 'epay' });
  if (/certificate|letter|noc|شهادة/.test(s)) actions.push({ label: 'Request a letter', go: 'ereq' });
  if (/clock|attendance|check.?in|حضور/.test(s)) actions.push({ label: 'Go to attendance', go: 'eclock' });
  if (/visa|emirates id|passport|document|وثيقة/.test(s)) actions.push({ label: 'My documents', go: 'edocs' });

  let reply;
  if (aiEnabled()) {
    try {
      const out = await callClaude({
        system: `You are Wasl, a friendly HR assistant for employees of a UAE company. Answer in the same language the employee writes in (English, Arabic, Hindi, Urdu, Malayalam or Tagalog). Use ONLY the JSON data provided about this employee and general UAE labour-law facts; never invent numbers. Keep answers under 80 words. You cannot take actions yourself: tell the employee which button to use. For anything you are unsure about, say HR will confirm.`,
        messages: [{ role: 'user', content: `Employee data: ${JSON.stringify(ctx)}\n\nQuestion: ${message}` }],
        maxTokens: 300,
      });
      reply = out.content?.find((c) => c.type === 'text')?.text?.trim();
    } catch { /* fall back to rules */ }
  }
  if (!reply) {
    if (/leave|vacation|إجازة/.test(s)) reply = `You have ${ctx.annualLeaveRemaining} of ${ctx.annualEntitlement} annual leave days left this year, and ${ctx.sickFullPayLeft} full-pay sick days. Use “Apply for leave” to send a request to your manager.`;
    else if (/payslip|salary|راتب/.test(s)) reply = ctx.lastPayslip ? `Your latest payslip is for ${ctx.lastPayslip.period}: net AED ${Number(ctx.lastPayslip.netAED).toLocaleString('en-AE', { minimumFractionDigits: 2 })}. Open Payslips to view or save it.` : 'No payslip has been released to you yet. HR releases payslips after payroll is approved.';
    else if (/certificate|letter|noc/.test(s)) reply = 'You can request a salary certificate, salary transfer letter, NOC or experience letter from Requests. Letters are issued in English, Arabic or both, usually within 2 working days.';
    else if (/clock|attendance|check.?in/.test(s)) reply = ctx.clockedInToday ? (ctx.clockedOut ? 'You have clocked in and out today.' : 'You are clocked in. Remember to clock out at the end of your shift.') : `You have not clocked in today. Your shift starts at ${ctx.shift?.start || '08:00'}. Clocking in needs a selfie and your location.`;
    else if (/visa|emirates id|passport|document/.test(s)) reply = ctx.documents.length ? `Your documents on file: ${ctx.documents.map((d) => `${d.type.replace(/_/g, ' ')} (expires ${d.expires})`).join(', ')}.` : 'No documents are on file for you yet. Ask HR to upload them.';
    else if (/holiday|public holiday|eid|national day/.test(s)) reply = `Upcoming UAE public holidays: ${ctx.holidays.map((h) => `${h.name} ${h.date}${h.estimated ? ' (estimated)' : ''}`).join(', ')}.`;
    else reply = 'I can help with your leave balance, payslips, letters, attendance, documents and public holidays. What do you need?';
  }
  await audit(req, 'assistant.ask', 'Employee', emp._id, null, { chars: message.length, ai: aiEnabled() }, 'agent');
  res.json({ reply, actions, ai: aiEnabled() });
}));

// ---------------- HR: attendance monitor ----------------
r.get('/attendance', requireRole('hr_admin', 'manager', 'payroll_maker'), ah(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localParts(new Date()).date;
  const empQ = { status: 'active', ...(req.query.establishmentId ? { establishmentId: req.query.establishmentId } : {}) };
  const [emps, recs, leaves] = await Promise.all([
    Employee.find(empQ).select('fullName employeeNo department jobTitle establishmentId').lean(),
    Attendance.find({ date, ...(req.query.establishmentId ? { establishmentId: req.query.establishmentId } : {}) }).lean(),
    LeaveRequest.find({ status: 'approved', startDate: { $lte: new Date(`${date}T23:59:59Z`) }, endDate: { $gte: new Date(`${date}T00:00:00Z`) } }).select('employeeId type').lean(),
  ]);
  const grouped = {}; for (const a of recs) (grouped[String(a.employeeId)] ||= []).push(a);
  const byEmp = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, dayView(v)]));
  const onLeave = Object.fromEntries(leaves.map((l) => [String(l.employeeId), l.type]));
  const rows = emps.map((e) => {
    const a = byEmp[String(e._id)];
    const state = a ? (a.open ? 'in' : 'out') : onLeave[String(e._id)] ? 'leave' : 'absent';
    return { employee: e, state, leaveType: onLeave[String(e._id)], record: a };
  }).sort((x, y) => ['in', 'out', 'leave', 'absent'].indexOf(x.state) - ['in', 'out', 'leave', 'absent'].indexOf(y.state));
  res.json({
    date, rows,
    counts: { total: rows.length, in: rows.filter((x) => x.state === 'in').length, out: rows.filter((x) => x.state === 'out').length, leave: rows.filter((x) => x.state === 'leave').length, absent: rows.filter((x) => x.state === 'absent').length, late: Object.values(byEmp).filter((a) => a.lateMinutes > 0).length, outside: Object.values(byEmp).filter((a) => a.sessions.some((x) => x.clockIn?.insideGeofence === false)).length },
  });
}));

r.get('/attendance/:id/photo', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const a = await Attendance.findById(req.params.id).select('+photo').lean();
  if (!a?.photo) return res.status(404).json({ error: 'No photo for this record.' });
  await audit(req, 'attendance.photo.view', 'Attendance', a._id);
  res.json({ photo: a.photo });
}));

r.patch('/attendance/:id', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const b = z.object({ note: z.string().min(3).max(300), approveException: z.boolean().optional() }).parse(req.body);
  const a = await Attendance.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Record not found.' });
  const before = { flags: a.flags.map((f) => f.code) };
  a.note = b.note;
  if (b.approveException) a.flags = a.flags.filter((f) => !['OUTSIDE_GEOFENCE', 'NO_GPS', 'LOW_GPS_ACCURACY'].includes(f.code)).concat([{ code: 'HR_APPROVED', msg: `Approved by HR: ${b.note}` }]);
  await a.save();
  await audit(req, 'attendance.review', 'Attendance', a._id, before, { flags: a.flags.map((f) => f.code), note: b.note });
  res.json(pub(a.toObject()));
}));

export default r;
