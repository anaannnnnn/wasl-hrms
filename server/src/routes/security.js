// Security & privacy routes: two-factor sign-in, user administration (unlock, roles), PDPL data export.
import { Router } from 'express';
import { z } from 'zod';
import { User, Employee, LeaveRequest, PayrollRun, ComplianceDocument, ServiceRequest, Notification } from '../models/index.js';
import { authenticate, restrictEmployees, requireRole, audit, ah } from '../middleware/auth.js';
import { newSecret, verifyTotp, otpauthUrl } from '../lib/totp.js';
import { encryptField, decryptField } from '../lib/fieldcrypt.js';

const r = Router();
r.use(authenticate, restrictEmployees);

// ---------------- Two-factor sign-in ----------------
r.get('/mfa/status', ah(async (req, res) => {
  const u = await User.findById(req.user.id).lean();
  res.json({ enabled: !!u?.mfaEnabled });
}));

r.post('/mfa/setup', ah(async (req, res) => {
  const u = await User.findById(req.user.id).select('+mfaSecret');
  if (u.mfaEnabled) return res.status(400).json({ error: 'Two-factor sign-in is already on. Turn it off first to re-enrol.' });
  const secret = newSecret();
  u.mfaSecret = encryptField(secret);
  await u.save();
  res.json({ secret, otpauth: otpauthUrl(secret, u.email) });
}));

r.post('/mfa/enable', ah(async (req, res) => {
  const { code } = z.object({ code: z.string() }).parse(req.body);
  const u = await User.findById(req.user.id).select('+mfaSecret');
  if (!u.mfaSecret) return res.status(400).json({ error: 'Start setup first.' });
  if (!verifyTotp(decryptField(u.mfaSecret), code)) return res.status(400).json({ error: 'That code is not valid. Check the time on your phone and try the next code.' });
  u.mfaEnabled = true; await u.save();
  await audit(req, 'security.mfa.enable', 'User', u._id, null, null);
  res.json({ enabled: true });
}));

r.post('/mfa/disable', ah(async (req, res) => {
  const { code } = z.object({ code: z.string() }).parse(req.body);
  const u = await User.findById(req.user.id).select('+mfaSecret');
  if (!u.mfaEnabled) return res.json({ enabled: false });
  if (!verifyTotp(decryptField(u.mfaSecret), code)) return res.status(400).json({ error: 'That code is not valid.' });
  u.mfaEnabled = false; u.mfaSecret = undefined; await u.save();
  await audit(req, 'security.mfa.disable', 'User', u._id, null, null);
  res.json({ enabled: false });
}));

// ---------------- User administration ----------------
r.get('/users', requireRole('hr_admin'), ah(async (req, res) => {
  const list = await User.find().populate('employeeId', 'fullName').sort({ email: 1 }).lean();
  res.json(list.map((u) => ({ _id: u._id, email: u.email, name: u.name, roles: u.roles, active: u.active, mfaEnabled: !!u.mfaEnabled, locked: !!(u.lockedUntil && new Date(u.lockedUntil) > new Date()), lastLoginAt: u.lastLoginAt, employee: u.employeeId?.fullName })));
}));

r.post('/users/:id/unlock', requireRole('hr_admin'), ah(async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  await audit(req, 'security.user.unlock', 'User', req.params.id, null, null);
  res.json({ ok: true });
}));

r.post('/users/:id/reset-mfa', requireRole('hr_admin'), ah(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Ask another administrator to reset your own two-factor sign-in.' });
  await User.updateOne({ _id: req.params.id }, { $set: { mfaEnabled: false }, $unset: { mfaSecret: 1 } });
  await audit(req, 'security.mfa.reset', 'User', req.params.id, null, null);
  res.json({ ok: true });
}));

r.patch('/users/:id', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ roles: z.array(z.enum(['hr_admin', 'payroll_maker', 'payroll_checker', 'manager', 'employee'])).min(1).optional(), active: z.boolean().optional() }).parse(req.body);
  if (req.params.id === req.user.id && (b.active === false || (b.roles && !b.roles.includes('hr_admin')))) return res.status(400).json({ error: 'You cannot remove your own admin access.' });
  const before = await User.findById(req.params.id).lean();
  await User.updateOne({ _id: req.params.id }, { $set: b });
  await audit(req, 'security.user.update', 'User', req.params.id, { roles: before?.roles, active: before?.active }, b);
  res.json({ ok: true });
}));

// ---------------- PDPL: access to personal data ----------------
// Employees can download everything held about them (right of access). HR can export for any employee.
async function exportFor(employeeId) {
  const [employee, leave, docs, requests, runs, notes] = await Promise.all([
    Employee.findById(employeeId).select('+bank.iban +labourCardNo').lean(),
    LeaveRequest.find({ employeeId }).lean(),
    ComplianceDocument.find({ employeeId }).select('-storageKey').lean(),
    ServiceRequest.find({ employeeId }).lean(),
    PayrollRun.find({ 'lines.employeeId': employeeId, status: { $in: ['approved', 'exported', 'paid'] } }).select('period type lines.$').lean(),
    Notification.find({ employeeId }).lean(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    notice: 'Personal data held by your employer in Wasl HRMS (UAE Federal Decree-Law No. 45 of 2021). Contact HR to correct anything inaccurate.',
    employee, leave, documents: docs, requests,
    payslips: runs.map((x) => ({ period: x.period, type: x.type, ...x.lines[0] })), notifications: notes,
  };
}
r.get('/me/export', ah(async (req, res) => {
  if (!req.user.employeeId) return res.status(400).json({ error: 'Your login is not linked to an employee record.' });
  await audit(req, 'privacy.export.self', 'Employee', req.user.employeeId, null, null);
  res.attachment('my-data.json').json(await exportFor(req.user.employeeId));
}));
r.get('/employees/:id/export', requireRole('hr_admin'), ah(async (req, res) => {
  await audit(req, 'privacy.export', 'Employee', req.params.id, null, null);
  res.attachment(`employee-${req.params.id}.json`).json(await exportFor(req.params.id));
}));

r.post('/employees/:id/legal-hold', requireRole('hr_admin'), ah(async (req, res) => {
  const { hold } = z.object({ hold: z.boolean() }).parse(req.body);
  await Employee.updateOne({ _id: req.params.id }, { legalHold: hold });
  await audit(req, 'privacy.legal_hold', 'Employee', req.params.id, null, { hold });
  res.json({ ok: true });
}));

export default r;
