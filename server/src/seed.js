// Seeds a demo tenant: Al Noor Trading LLC (Dubai Mainland SME, 38 staff).
// All people, IDs and accounts are fictional.  Usage: npm run seed
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { runAsSystem, runWithTenant } from './lib/tenantContext.js';
import { Tenant, User, Establishment, Employee, ComplianceDocument, LeaveRequest, PayrollInput, PayrollRun, AuditLog } from './models/index.js';
import { buildUaeIban } from './lib/iban.js';
import { toFils } from './lib/money.js';
import { calculateLine } from './lib/payroll.js';

const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY);
const PASSWORD = 'Demo@2026';

const PEOPLE = [
  ['Rashid Al Suwaidi', 'راشد السويدي', 'Operations Manager', 'Operations', 'UAE', true, 24000, 12000, 3000, '2019-03-10', 2],
  ['Priya Menon', 'بريا مينون', 'Finance Lead', 'Finance', 'India', false, 18000, 9000, 2000, '2020-07-01', 2],
  ['Joseph Dela Cruz', 'جوزيف ديلا كروز', 'Warehouse Supervisor', 'Warehouse', 'Philippines', false, 6500, 3000, 1000, '2018-01-15', 3],
  ['Ahmed Khan', 'أحمد خان', 'Delivery Driver', 'Logistics', 'Pakistan', false, 3000, 1500, 500, '2022-05-20', 4],
  ['Fatima Al Hashmi', 'فاطمة الهاشمي', 'HR Officer', 'HR', 'UAE', true, 5500, 2500, 1000, '2026-02-01', 3],
  ['Anil Kumar', 'أنيل كومار', 'Storekeeper', 'Warehouse', 'India', false, 2800, 1200, 500, '2016-09-05', 4],
  ['Grace Okafor', 'غريس أوكافور', 'Sales Executive', 'Sales', 'Nigeria', false, 7000, 3500, 1500, '2023-11-12', 3],
  ['Mohammed Saleh', 'محمد صالح', 'Accountant', 'Finance', 'Egypt', false, 9000, 4500, 1500, '2021-04-18', 2],
  ['Ravi Shrestha', 'رافي شريستا', 'Delivery Driver', 'Logistics', 'Nepal', false, 3000, 1500, 500, '2024-08-01', 4],
  ['Layla Haddad', 'ليلى حداد', 'Customer Service', 'Sales', 'Jordan', false, 5000, 2500, 1000, '2025-01-06', 3],
];
const FILLER_ROLES = [['Picker', 'Warehouse', 4, 2200], ['Driver', 'Logistics', 4, 2600], ['Sales Associate', 'Sales', 3, 4200], ['Admin Assistant', 'Operations', 3, 3800]];
const NATS = ['India', 'Pakistan', 'Philippines', 'Bangladesh', 'Egypt', 'Nepal', 'Sri Lanka'];

await mongoose.connect(config.mongoUri);
console.log('Connected. Resetting demo data…');
await runAsSystem(async () => {
  await Promise.all([Tenant, User, Establishment, Employee, ComplianceDocument, LeaveRequest, PayrollInput, PayrollRun].map((m) => m.deleteMany({})));
  await mongoose.connection.collection('auditlogs').deleteMany({});
});

const tenant = await Tenant.create({ name: 'Al Noor Trading LLC', plan: 'growth' });

await runWithTenant({ tenantId: String(tenant._id) }, async () => {
  const est = await Establishment.create({
    name: 'Al Noor Trading LLC', nameAr: 'شركة النور للتجارة ذ.م.م', jurisdiction: 'MAINLAND', rulePackId: 'UAE-MAINLAND', emirate: 'Dubai',
    mohreId: '1000000042817', tradeLicenceNo: 'DED-884213', tradeLicenceExpiry: inDays(37), establishmentCardExpiry: inDays(12),
    designatedSector: true, wps: { agentName: 'Emirates NBD', agentRoutingCode: '302620122' },
  });

  const emps = [];
  let i = 0;
  const mk = async (p, extra = {}) => {
    i++;
    const [name, ar, role, dept, nat, uae, basic, housing, transport, join, skill] = p;
    emps.push(await Employee.create({
      establishmentId: est._id, employeeNo: `ANT-${100 + i}`, fullName: name, fullNameAr: ar, jobTitle: role, department: dept,
      nationality: nat, isUaeNational: uae, mohreSkillLevel: skill, joinDate: new Date(join), status: 'active',
      pensionRegistered: uae && name !== 'Fatima Al Hashmi', paidViaWps: true,
      compensation: { basicFils: toFils(basic), housingFils: toFils(housing), transportFils: toFils(transport), effectiveFrom: new Date(join) },
      bank: { iban: buildUaeIban('026', String(1010000000000000 + i * 7919137)), routingCode: '302620122', bankName: 'Emirates NBD' },
      labourCardNo: String(94821370000000 + i * 7919), emiratesIdLast4: String(1000 + i * 37).slice(-4),
      ...extra,
    }));
  };
  for (const p of PEOPLE) await mk(p);
  for (let k = 0; k < 28; k++) {
    const [role, dept, skill, basic] = FILLER_ROLES[k % FILLER_ROLES.length];
    const y = 2017 + (k % 9);
    await mk([`Staff Member ${String(k + 1).padStart(2, '0')}`, null, role, dept, NATS[k % NATS.length], false, basic, Math.round(basic * 0.4), 400, `${y}-0${(k % 9) + 1}-1${k % 9}`, skill]);
  }
  const by = (n) => emps.find((e) => e.fullName === n);

  // A deliberately broken IBAN so WPS pre-flight has something to catch
  const ravi = await Employee.findById(by('Ravi Shrestha')._id).select('+bank.iban');
  ravi.bank.iban = 'AE070260001015432198765';
  await ravi.save();

  // Users
  const hash = await bcrypt.hash(PASSWORD, 10);
  await User.create([
    { email: 'admin@alnoor.demo', name: 'Fatima Al Hashmi', passwordHash: hash, roles: ['hr_admin', 'payroll_maker'], employeeId: by('Fatima Al Hashmi')._id },
    { email: 'checker@alnoor.demo', name: 'Priya Menon', passwordHash: hash, roles: ['payroll_checker'], employeeId: by('Priya Menon')._id },
    { email: 'manager@alnoor.demo', name: 'Rashid Al Suwaidi', passwordHash: hash, roles: ['manager'], employeeId: by('Rashid Al Suwaidi')._id },
  ]);

  // Documents
  await ComplianceDocument.create([
    { ownerType: 'employee', employeeId: by('Ahmed Khan')._id, docType: 'residence_visa', expiryDate: inDays(8) },
    { ownerType: 'employee', employeeId: by('Ravi Shrestha')._id, docType: 'emirates_id', expiryDate: inDays(19) },
    { ownerType: 'employee', employeeId: by('Grace Okafor')._id, docType: 'passport', expiryDate: inDays(27) },
    { ownerType: 'employee', employeeId: by('Joseph Dela Cruz')._id, docType: 'labour_card', expiryDate: inDays(44) },
    { ownerType: 'employee', employeeId: by('Anil Kumar')._id, docType: 'health_insurance', expiryDate: inDays(58) },
    { ownerType: 'employee', employeeId: by('Layla Haddad')._id, docType: 'residence_visa', expiryDate: inDays(83) },
    { ownerType: 'establishment', establishmentId: est._id, docType: 'establishment_card', expiryDate: inDays(12) },
    { ownerType: 'establishment', establishmentId: est._id, docType: 'trade_licence', expiryDate: inDays(37) },
  ]);

  // Leave
  await LeaveRequest.create([
    { employeeId: by('Joseph Dela Cruz')._id, type: 'annual', startDate: inDays(8), endDate: inDays(10), days: 3 },
    { employeeId: by('Anil Kumar')._id, type: 'annual', startDate: inDays(8), endDate: inDays(11), days: 4 },
    { employeeId: by('Grace Okafor')._id, type: 'sick', startDate: inDays(1), endDate: inDays(1), days: 1 },
  ]);

  // Payroll: last month (paid) and this month inputs
  const now = new Date();
  const per = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const thisP = per(now), prevP = per(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const prevInputs = { 'Ahmed Khan': { overtimeFils: 40000 }, 'Grace Okafor': { overtimeFils: 37000 } };
  const prevLines = emps.map((e) => ({ ...calculateLine(e, prevInputs[e.fullName]), employeeName: e.fullName, held: false }));
  await PayrollRun.create({
    establishmentId: est._id, period: prevP, status: 'paid', locked: true, rulePack: 'UAE-MAINLAND@2026.1',
    lines: prevLines,
    totals: { grossFils: prevLines.reduce((a, l) => a + l.grossFils, 0), netFils: prevLines.reduce((a, l) => a + l.netFils, 0), heldFils: 0 },
  });
  await PayrollInput.create([
    { employeeId: by('Ahmed Khan')._id, period: thisP, overtimeFils: 42000 },
    { employeeId: by('Grace Okafor')._id, period: thisP, overtimeFils: 126000 },
    { employeeId: by('Joseph Dela Cruz')._id, period: thisP, unpaidLeaveDays: 2 },
  ]);

  console.log(`Seeded ${emps.length} employees, establishment ${est.name}, periods ${prevP} (paid) and ${thisP} (inputs).`);
});

console.log(`\nSign in at http://localhost:${config.port}\n  admin@alnoor.demo   / ${PASSWORD}  (HR admin + payroll maker)\n  checker@alnoor.demo / ${PASSWORD}  (payroll checker)\n  manager@alnoor.demo / ${PASSWORD}  (line manager)`);
await mongoose.disconnect();
