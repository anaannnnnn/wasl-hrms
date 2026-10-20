// Workspace features: tasks, calendar events, weekly hours, who's away timeline, applicant tracker and wellness pulse.
import { Router } from 'express';
import { z } from 'zod';
import { Applicant, Task, CalendarEvent, Pulse, Employee, LeaveRequest, Attendance } from '../models/index.js';
import { authenticate, requireRole, restrictEmployees, isStaff, audit, ah } from '../middleware/auth.js';
import { localParts, UAE_HOLIDAYS } from '../lib/attendance.js';
import { toFils } from '../lib/money.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const STAFF = requireRole('hr_admin', 'manager', 'payroll_maker', 'payroll_checker');
const today = () => localParts(new Date()).date;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Last 7 days of hours (own, or company average for staff)
async function weekHours(filter) {
  const t = today(); const from = addDays(t, -6);
  const recs = await Attendance.find({ ...filter, date: { $gte: from, $lte: t } }).select('date employeeId minutesWorked clockIn clockOut').lean();
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i); const day = recs.filter((x) => x.date === date);
    const people = new Set(day.map((x) => String(x.employeeId))).size;
    const minutes = day.reduce((a, x) => a + (x.minutesWorked || 0), 0);
    return { date, weekday: new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }), hours: people ? Math.round((minutes / people / 60) * 10) / 10 : 0, people };
  });
}
const upcomingEvents = (dept) => CalendarEvent.find({ date: { $gte: today(), $lte: addDays(today(), 21) }, $or: [{ audience: 'all' }, ...(dept ? [{ audience: 'department', department: dept }] : [{ audience: 'hr' }, { audience: 'department' }])] }).sort({ date: 1, start: 1 }).limit(8).lean();

// ---------------- Workspace summaries ----------------
r.get('/workspace', STAFF, ah(async (req, res) => {
  const [tasks, events, hours, pendingLeave, applicants] = await Promise.all([
    Task.find({ ownerUserId: req.user.id }).sort({ done: 1, dueDate: 1 }).limit(12).lean(),
    upcomingEvents(null), weekHours({}),
    LeaveRequest.countDocuments({ status: 'pending' }), Applicant.countDocuments({ stage: { $nin: ['hired', 'rejected'] } }),
  ]);
  res.json({ date: today(), tasks, events, hours, counts: { pendingLeave, openApplicants: applicants } });
}));

r.get('/me/workspace', ah(async (req, res) => {
  const emp = req.user.employeeId ? await Employee.findById(req.user.employeeId).select('department').lean() : null;
  const [tasks, events, hours, pulse] = await Promise.all([
    Task.find({ employeeId: req.user.employeeId }).sort({ done: 1, dueDate: 1 }).limit(12).lean(),
    upcomingEvents(emp?.department || 'none'), weekHours({ employeeId: req.user.employeeId }),
    Pulse.findOne({ employeeId: req.user.employeeId, date: today() }).lean(),
  ]);
  res.json({ date: today(), tasks, events, hours, pulseToday: pulse });
}));

// ---------------- Tasks ----------------
const taskIn = z.object({ title: z.string().min(2).max(160), dueDate: z.string().optional(), employeeId: z.string().optional() });
r.post('/tasks', STAFF, ah(async (req, res) => {
  const b = taskIn.parse(req.body);
  const t = await Task.create({ title: b.title, dueDate: b.dueDate ? new Date(b.dueDate) : undefined, ...(b.employeeId ? { employeeId: b.employeeId } : { ownerUserId: req.user.id }), createdBy: req.user.id });
  res.status(201).json(t);
}));
r.post('/me/tasks', ah(async (req, res) => {
  const b = taskIn.omit({ employeeId: true }).parse(req.body);
  res.status(201).json(await Task.create({ title: b.title, dueDate: b.dueDate ? new Date(b.dueDate) : undefined, employeeId: req.user.employeeId, createdBy: req.user.id }));
}));
const toggle = (scope) => ah(async (req, res) => {
  const { done } = z.object({ done: z.boolean() }).parse(req.body);
  const q = { _id: req.params.id, ...(scope === 'me' ? { employeeId: req.user.employeeId } : {}) };
  const t = await Task.findOneAndUpdate(q, { done, doneAt: done ? new Date() : null }, { new: true }).lean();
  if (!t) return res.status(404).json({ error: 'Task not found' });
  res.json(t);
});
r.patch('/tasks/:id', STAFF, toggle('staff'));
r.patch('/me/tasks/:id', toggle('me'));

// ---------------- Calendar events ----------------
r.post('/events', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ title: z.string().min(2).max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().optional(), end: z.string().optional(), detail: z.string().max(200).optional(), audience: z.enum(['all', 'hr', 'department']).default('all'), department: z.string().optional() }).parse(req.body);
  res.status(201).json(await CalendarEvent.create(b));
}));

// ---------------- Who's away (month timeline) ----------------
async function awayMonth(month, empFilter) {
  const first = `${month}-01`; const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
  const emps = await Employee.find({ status: { $in: ['active', 'notice', 'onboarding'] }, ...empFilter }).select('fullName jobTitle department employeeNo').sort({ fullName: 1 }).lean();
  const leaves = await LeaveRequest.find({ employeeId: { $in: emps.map((e) => e._id) }, status: { $in: ['approved', 'pending'] }, startDate: { $lte: new Date(`${last}T23:59:59Z`) }, endDate: { $gte: new Date(`${first}T00:00:00Z`) } }).lean();
  const byEmp = {};
  for (const l of leaves) (byEmp[String(l.employeeId)] ||= []).push({ _id: l._id, type: l.type, status: l.status, start: new Date(l.startDate).toISOString().slice(0, 10), end: new Date(l.endDate).toISOString().slice(0, 10), days: l.days, reason: l.reason });
  const rows = emps.map((e) => ({ employee: e, leaves: byEmp[String(e._id)] || [] }));
  return { month, first, last, holidays: UAE_HOLIDAYS.filter((h) => h.date >= first && h.date <= last), rows, awayCount: rows.filter((x) => x.leaves.length).length };
}
const monthQ = (q) => (/^\d{4}-\d{2}$/.test(q || '') ? q : today().slice(0, 7));
r.get('/away', STAFF, ah(async (req, res) => res.json(await awayMonth(monthQ(req.query.month), { ...(req.query.department ? { department: req.query.department } : {}), ...(req.query.establishmentId ? { establishmentId: req.query.establishmentId } : {}) }))));
// Employees see their own team (names and dates only, no leave type or reason)
r.get('/me/away', ah(async (req, res) => {
  const me = await Employee.findById(req.user.employeeId).select('department establishmentId').lean();
  const d = await awayMonth(monthQ(req.query.month), { department: me?.department, establishmentId: me?.establishmentId });
  d.rows = d.rows.map((x) => ({ employee: { fullName: x.employee.fullName, jobTitle: x.employee.jobTitle, department: x.employee.department, _id: x.employee._id }, leaves: x.leaves.map((l) => ({ start: l.start, end: l.end, status: l.status, type: String(x.employee._id) === String(req.user.employeeId) ? l.type : 'away' })) }));
  res.json(d);
}));

// ---------------- Applicant tracker ----------------
const STAGES = ['applied', 'screening', 'interviewed', 'offer', 'hired', 'rejected'];
r.get('/applicants', STAFF, ah(async (req, res) => res.json(await Applicant.find().sort({ stage: 1, order: 1, updatedAt: -1 }).lean())));
r.post('/applicants', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const b = z.object({ name: z.string().min(2).max(120), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(30).optional(), role: z.string().max(120), department: z.string().max(80).optional(), visaStatus: z.enum(['visit_visa', 'residence_on_notice', 'golden_visa', 'uae_national', 'outside_uae', 'other']).default('other'), expectedSalary: z.union([z.string(), z.number()]).optional(), source: z.string().max(60).optional(), notes: z.string().max(1000).optional() }).parse(req.body);
  const a = await Applicant.create({ ...b, email: b.email || undefined, expectedSalaryFils: b.expectedSalary ? toFils(b.expectedSalary) : undefined, stage: 'applied', movedAt: new Date() });
  await audit(req, 'applicant.create', 'Applicant', a._id, null, { role: b.role });
  res.status(201).json(a);
}));
r.patch('/applicants/:id', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const b = z.object({ stage: z.enum(STAGES).optional(), rating: z.number().int().min(0).max(5).optional(), notes: z.string().max(1000).optional(), order: z.number().optional() }).parse(req.body);
  const a = await Applicant.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Applicant not found' });
  const before = { stage: a.stage };
  if (b.stage && b.stage !== a.stage) { a.stage = b.stage; a.movedAt = new Date(); }
  for (const k of ['rating', 'notes', 'order']) if (k in b) a[k] = b[k];
  await a.save();
  if (b.stage && b.stage !== before.stage) await audit(req, 'applicant.stage', 'Applicant', a._id, before, { stage: a.stage });
  res.json(a);
}));

// ---------------- Wellness pulse ----------------
r.post('/me/pulse', ah(async (req, res) => {
  const b = z.object({ mood: z.number().int().min(1).max(5), energy: z.number().int().min(1).max(5).optional(), workload: z.number().int().min(1).max(5).optional(), comment: z.string().max(500).optional() }).parse(req.body);
  const emp = await Employee.findById(req.user.employeeId).select('department').lean();
  const p = await Pulse.findOneAndUpdate({ employeeId: req.user.employeeId, date: today() }, { ...b, department: emp?.department }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  res.json({ ok: true, date: p.date, message: 'Thanks for checking in. Your answers are only shown to HR as team averages.' });
}));

// HR sees aggregates only; teams with fewer than 3 responses are hidden to protect anonymity
r.get('/pulse/summary', requireRole('hr_admin'), ah(async (req, res) => {
  const days = Math.min(90, Number(req.query.days) || 30);
  const from = addDays(today(), -(days - 1));
  const list = await Pulse.find({ date: { $gte: from } }).select('employeeId department mood energy workload comment date').lean();
  const active = await Employee.countDocuments({ status: 'active' });
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const depts = {};
  for (const p of list) (depts[p.department || 'Other'] ||= []).push(p);
  const byDept = Object.entries(depts).map(([department, xs]) => ({ department, responses: xs.length, mood: avg(xs.map((x) => x.mood)), energy: avg(xs.filter((x) => x.energy).map((x) => x.energy)), workload: avg(xs.filter((x) => x.workload).map((x) => x.workload)), hidden: xs.length < 3 }))
    .map((d) => (d.hidden ? { department: d.department, responses: d.responses, hidden: true } : d)).sort((a, b) => (b.responses - a.responses));
  const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => { const s = addDays(from, i * 7), e = addDays(s, 6); const xs = list.filter((p) => p.date >= s && p.date <= e); return { from: s, to: e, mood: avg(xs.map((x) => x.mood)), responses: xs.length }; });
  const comments = list.filter((p) => p.comment).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map((p) => ({ date: p.date, comment: p.comment }));
  res.json({ days, responses: list.length, participation: active ? Math.round((new Set(list.map((p) => String(p.employeeId))).size / active) * 100) : 0, mood: avg(list.map((p) => p.mood)), energy: avg(list.filter((p) => p.energy).map((p) => p.energy)), workload: avg(list.filter((p) => p.workload).map((p) => p.workload)), byDept, weeks, comments });
}));

export default r;
