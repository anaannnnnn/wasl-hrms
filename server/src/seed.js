// Seeds a demo tenant: Al Noor Trading LLC (Dubai Mainland SME, 38 staff).
// All people, IDs and accounts are fictional.  Usage: npm run seed
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { runAsSystem, runWithTenant } from './lib/tenantContext.js';
import { Tenant, User, Establishment, Employee, ComplianceDocument, LeaveRequest, PayrollInput, PayrollRun, AuditLog, Notification, ServiceRequest, Attendance } from './models/index.js';
import { localParts } from './lib/attendance.js';
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
// [name, nationality, role, department, basic AED, MOHRE skill, join date]
const TEAM = [
  ['Mohammed Rafiq', 'Bangladesh', 'Picker', 'Warehouse', 2200, 4, '2019-04-12'],
  ['Sunil Perera', 'Sri Lanka', 'Forklift Operator', 'Warehouse', 2800, 4, '2018-06-03'],
  ['Arjun Nair', 'India', 'Inventory Controller', 'Warehouse', 4200, 3, '2021-09-15'],
  ['Mark Villanueva', 'Philippines', 'Picker', 'Warehouse', 2200, 4, '2023-02-20'],
  ['Imran Shah', 'Pakistan', 'Loader', 'Warehouse', 2000, 5, '2024-01-08'],
  ['Kamal Hossain', 'Bangladesh', 'Picker', 'Warehouse', 2200, 4, '2022-07-11'],
  ['Deepak Thapa', 'Nepal', 'Packer', 'Warehouse', 2100, 4, '2025-03-01'],
  ['Hassan Raza', 'Pakistan', 'Delivery Driver', 'Logistics', 2600, 4, '2020-10-19'],
  ['Bikash Gurung', 'Nepal', 'Delivery Driver', 'Logistics', 2600, 4, '2021-05-24'],
  ['Rohan Fernandes', 'India', 'Fleet Coordinator', 'Logistics', 5200, 3, '2019-11-04'],
  ['Tariq Mahmood', 'Pakistan', 'Heavy Truck Driver', 'Logistics', 3400, 4, '2017-08-14'],
  ['Joel Santos', 'Philippines', 'Delivery Driver', 'Logistics', 2600, 4, '2023-06-26'],
  ['Nadeem Akhtar', 'Pakistan', 'Dispatcher', 'Logistics', 3900, 3, '2022-03-07'],
  ['Omar Farouk', 'Egypt', 'Senior Sales Executive', 'Sales', 9500, 2, '2018-12-02'],
  ['Aisha Rahman', 'India', 'Sales Executive', 'Sales', 6500, 3, '2022-09-18'],
  ['Daniel Mensah', 'Ghana', 'Key Account Manager', 'Sales', 11000, 2, '2020-02-10'],
  ['Maria Gonzales', 'Philippines', 'Sales Coordinator', 'Sales', 4800, 3, '2024-04-15'],
  ['Yousef Nasser', 'Jordan', 'Sales Executive', 'Sales', 6500, 3, '2025-06-01'],
  ['Shreya Iyer', 'India', 'Payroll Officer', 'Finance', 7500, 2, '2021-01-11'],
  ['Kevin D\'Souza', 'India', 'AP Accountant', 'Finance', 6200, 3, '2023-08-21'],
  ['Hana Kim', 'South Korea', 'Procurement Officer', 'Operations', 8000, 2, '2022-11-14'],
  ['Samir Haddad', 'Lebanon', 'Facilities Supervisor', 'Operations', 5600, 3, '2019-05-27'],
  ['Ana Petrova', 'Bulgaria', 'Office Administrator', 'Operations', 4500, 3, '2024-09-02'],
  ['Ali Hamdan', 'Syria', 'IT Support Specialist', 'Operations', 6000, 3, '2021-07-19'],
  ['Zainab Yusuf', 'Sudan', 'Receptionist', 'Operations', 3800, 4, '2025-02-17'],
  ['Ramesh Babu', 'India', 'Maintenance Technician', 'Operations', 3500, 4, '2016-03-30'],
  ['Elena Rossi', 'Italy', 'Quality Lead', 'Operations', 9000, 2, '2023-01-09'],
  ['Prakash Rai', 'Nepal', 'Security Guard', 'Operations', 2300, 5, '2020-08-05'],
];
const FZ_TEAM = [
  ['Sara Al Mansoori', 'UAE', 'Regional Director', 'Management', 32000, 1, '2024-03-01', true],
  ['James Whitfield', 'United Kingdom', 'Trading Manager', 'Trading', 26000, 1, '2024-05-12'],
  ['Neha Kapoor', 'India', 'Trade Finance Analyst', 'Finance', 14000, 2, '2024-07-01'],
  ['Wei Chen', 'China', 'Sourcing Manager', 'Trading', 18000, 2, '2025-01-15'],
  ['Fiona Murphy', 'Ireland', 'Compliance Officer', 'Finance', 16000, 2, '2025-04-07'],
  ['Ahmad Kassem', 'Lebanon', 'Logistics Analyst', 'Trading', 11000, 2, '2025-08-18'],
];

await mongoose.connect(config.mongoUri);
console.log('Connected. Resetting demo data…');
await runAsSystem(async () => {
  await Promise.all([Tenant, User, Establishment, Employee, ComplianceDocument, LeaveRequest, PayrollInput, PayrollRun, Notification, ServiceRequest, Attendance].map((m) => m.deleteMany({})));
  await PayrollRun.syncIndexes().catch(() => {});
  await mongoose.connection.collection('auditlogs').deleteMany({});
});

const tenant = await Tenant.create({ name: 'Al Noor Trading LLC', plan: 'growth' });

await runWithTenant({ tenantId: String(tenant._id) }, async () => {
  const est = await Establishment.create({
    name: 'Al Noor Trading LLC', nameAr: 'شركة النور للتجارة ذ.م.م', jurisdiction: 'MAINLAND', rulePackId: 'UAE-MAINLAND', emirate: 'Dubai',
    mohreId: '1000000042817', tradeLicenceNo: 'DED-884213', tradeLicenceExpiry: inDays(37), establishmentCardExpiry: inDays(12),
    designatedSector: true, wps: { agentName: 'Emirates NBD', agentRoutingCode: '302620122' },
    geo: { lat: 25.1385, lng: 55.2296, radiusM: 300, label: 'Al Quoz Industrial Area 3 warehouse' }, shift: { start: '08:00', end: '17:00', graceMin: 15 },
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
  for (const [name, nat, role, dept, basic, skill, join] of TEAM) {
    await mk([name, null, role, dept, nat, false, basic, Math.round(basic * 0.4), basic >= 6000 ? 1000 : 400, join, skill]);
  }

  // Second establishment: a DMCC free-zone entity (outside the MOHRE quota)
  const fz = await Establishment.create({
    name: 'Al Noor Global FZ-LLC', nameAr: 'النور جلوبال م.م.ح', jurisdiction: 'FREEZONE', freeZone: 'DMCC', rulePackId: 'FREEZONE-STANDARD', emirate: 'Dubai',
    mohreId: '1000000058304', tradeLicenceNo: 'DMCC-209331', tradeLicenceExpiry: inDays(64), establishmentCardExpiry: inDays(91),
    wps: { agentName: 'Mashreq', agentRoutingCode: '203320101' },
    geo: { lat: 25.0693, lng: 55.1413, radiusM: 250, label: 'JLT Cluster T office' }, shift: { start: '09:00', end: '18:00', graceMin: 15 },
  });
  const fzEmps = [];
  for (const [j, [name, nat, role, dept, basic, skill, join, uae]] of FZ_TEAM.entries()) {
    fzEmps.push(await Employee.create({
      establishmentId: fz._id, employeeNo: `ANG-${201 + j}`, fullName: name, jobTitle: role, department: dept, nationality: nat, isUaeNational: !!uae,
      mohreSkillLevel: skill, joinDate: new Date(join), status: 'active', pensionRegistered: !!uae, paidViaWps: true,
      compensation: { basicFils: toFils(basic), housingFils: toFils(Math.round(basic * 0.35)), transportFils: toFils(1500), effectiveFrom: new Date(join) },
      bank: { iban: buildUaeIban('033', String(2020000000000000 + j * 5531)), routingCode: '203320101', bankName: 'Mashreq' },
      labourCardNo: String(95821370000000 + j * 6113), emiratesIdLast4: String(2000 + j * 41).slice(-4),
    }));
  }
  // A new joiner still onboarding (not in payroll yet)
  await Employee.create({
    establishmentId: est._id, employeeNo: 'ANT-150', fullName: 'Khalid Al Nuaimi', jobTitle: 'Sales Trainee', department: 'Sales', nationality: 'UAE', isUaeNational: true,
    mohreSkillLevel: 3, joinDate: inDays(12), status: 'onboarding', pensionRegistered: false, paidViaWps: true,
    compensation: { basicFils: toFils(5000), housingFils: toFils(2000), transportFils: toFils(800) },
    custom: { onboarding: [['Entry permit', true], ['Medical fitness', true], ['EID biometrics', false], ['Health insurance', false], ['MOHRE contract', false], ['Bank IBAN', false]].map(([step, done]) => ({ step, done })) },
  });
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
    // Employee self-service logins
    { email: 'ahmed@alnoor.demo', name: 'Ahmed Khan', passwordHash: hash, roles: ['employee'], employeeId: by('Ahmed Khan')._id },
    { email: 'grace@alnoor.demo', name: 'Grace Okafor', passwordHash: hash, roles: ['employee'], employeeId: by('Grace Okafor')._id },
  ]);
  await Employee.updateMany({ _id: { $in: [by('Ahmed Khan')._id, by('Grace Okafor')._id] } }, { $set: { phone: '+971500000000' } });
  await Employee.updateOne({ _id: by('Ahmed Khan')._id }, { $set: { email: 'ahmed@alnoor.demo' } });
  await Employee.updateOne({ _id: by('Grace Okafor')._id }, { $set: { email: 'grace@alnoor.demo' } });

  // A UAE national who resigned three weeks ago: their quota slot is in the 2-month replacement grace period
  await Employee.create({
    establishmentId: est._id, employeeNo: 'ANT-099', fullName: 'Mariam Al Ketbi', fullNameAr: 'مريم الكتبي', jobTitle: 'Customer Relations Officer', department: 'Sales', nationality: 'UAE', isUaeNational: true,
    mohreSkillLevel: 3, joinDate: new Date('2023-04-02'), status: 'exited', exitDate: inDays(-21), pensionRegistered: true, paidViaWps: true,
    compensation: { basicFils: toFils(7000), housingFils: toFils(2500), transportFils: toFils(1000) },
  });

  // Employee request centre
  await ServiceRequest.create([
    { employeeId: by('Ahmed Khan')._id, kind: 'letter', letterType: 'salary_certificate', addressee: 'Emirates NBD', lang: 'dual', status: 'open', reference: 'REQ-261018-A1B2', slaDueAt: inDays(1) },
    { employeeId: by('Grace Okafor')._id, kind: 'letter', letterType: 'noc', addressee: 'Embassy of Nigeria', purpose: 'travelling to Lagos for annual leave', lang: 'dual', status: 'done', reference: 'REQ-261012-C3D4', closedAt: inDays(-5) },
    { employeeId: by('Hassan Raza')._id, kind: 'bank_change', details: 'Moved salary account to Dubai Islamic Bank', payload: { iban: buildUaeIban('024', '1010000000123456') }, status: 'open', reference: 'REQ-261019-E5F6', slaDueAt: inDays(4) },
    { employeeId: by('Layla Haddad')._id, kind: 'salary_query', details: 'Overtime from 28 September is missing on my last payslip', status: 'in_progress', reference: 'REQ-261016-G7H8', slaDueAt: inDays(2) },
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
    { ownerType: 'establishment', establishmentId: fz._id, docType: 'trade_licence', expiryDate: inDays(64) },
    { ownerType: 'establishment', establishmentId: fz._id, docType: 'establishment_card', expiryDate: inDays(91) },
    { ownerType: 'employee', employeeId: by('Priya Menon')._id, docType: 'residence_visa', expiryDate: inDays(-4) },
  ]);
  // Spread more renewals across the next four months so the radar and week strip look like a real company
  const docTypes = ['residence_visa', 'emirates_id', 'passport', 'labour_card', 'health_insurance', 'driving_licence'];
  const spread = [3, 5, 11, 16, 22, 26, 31, 35, 41, 47, 52, 57, 63, 69, 74, 79, 88, 95, 103, 110, 117, 20, 9, 66];
  const pool = [...emps.slice(10), ...fzEmps];
  await ComplianceDocument.create(spread.map((d, i) => {
    const e = pool[(i * 7) % pool.length];
    const type = e.department === 'Logistics' && i % 2 ? 'driving_licence' : docTypes[i % 5];
    return { ownerType: 'employee', employeeId: e._id, docType: type, expiryDate: inDays(d), ...(i % 6 === 2 ? { renewalCase: { status: 'in_progress', steps: [{ name: 'Collect documents', done: true }, { name: 'Submit application', done: false }] } } : {}) };
  }));

  // Leave
  await LeaveRequest.create([
    { employeeId: by('Joseph Dela Cruz')._id, type: 'annual', startDate: inDays(8), endDate: inDays(10), days: 3 },
    { employeeId: by('Anil Kumar')._id, type: 'annual', startDate: inDays(8), endDate: inDays(11), days: 4 },
    { employeeId: by('Grace Okafor')._id, type: 'sick', startDate: inDays(1), endDate: inDays(1), days: 1 },
    { employeeId: by('Hassan Raza')._id, type: 'annual', startDate: inDays(14), endDate: inDays(27), days: 14, reason: 'Family visit, Lahore' },
    { employeeId: by('Aisha Rahman')._id, type: 'annual', startDate: inDays(20), endDate: inDays(24), days: 5, source: 'whatsapp' },
    { employeeId: by('Omar Farouk')._id, type: 'parental', startDate: inDays(5), endDate: inDays(9), days: 5 },
    { employeeId: by('Mohammed Rafiq')._id, type: 'annual', startDate: inDays(9), endDate: inDays(12), days: 4, source: 'mobile' },
    { employeeId: by('Layla Haddad')._id, type: 'annual', startDate: inDays(-20), endDate: inDays(-16), days: 5, status: 'approved' },
    { employeeId: by('Tariq Mahmood')._id, type: 'sick', startDate: inDays(-9), endDate: inDays(-8), days: 2, status: 'approved' },
    { employeeId: by('Kevin D\'Souza')._id, type: 'unpaid', startDate: inDays(-40), endDate: inDays(-38), days: 3, status: 'rejected' },
    { employeeId: by('Shreya Iyer')._id, type: 'hajj', startDate: inDays(60), endDate: inDays(80), days: 21, status: 'approved' },
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
  // Older paid runs (totals only) so the dashboard trend has 12 months of history
  const prevNet = prevLines.reduce((a, l) => a + l.netFils, 0);
  const prevGross = prevLines.reduce((a, l) => a + l.grossFils, 0);
  for (let k = 2; k <= 11; k++) {
    const f = 1 - k * 0.0085 + (k % 3 === 0 ? 0.004 : 0); // gentle growth with a little noise
    await PayrollRun.create({
      establishmentId: est._id, period: per(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))),
      status: 'paid', locked: true, rulePack: 'UAE-MAINLAND@2026.1', lines: [],
      totals: { grossFils: Math.round(prevGross * f), netFils: Math.round(prevNet * f), heldFils: 0 },
    });
  }

  await PayrollInput.create([
    { employeeId: by('Ahmed Khan')._id, period: thisP, overtimeFils: 42000 },
    { employeeId: by('Grace Okafor')._id, period: thisP, overtimeFils: 126000 },
    { employeeId: by('Joseph Dela Cruz')._id, period: thisP, unpaidLeaveDays: 2 },
    { employeeId: by('Hassan Raza')._id, period: thisP, overtimeFils: 38000 },
    { employeeId: by('Tariq Mahmood')._id, period: thisP, overtimeFils: 54000 },
    { employeeId: by('Bikash Gurung')._id, period: thisP, overtimeFils: 31000 },
    { employeeId: by('Omar Farouk')._id, period: thisP, commissionFils: 280000 },
    { employeeId: by('Daniel Mensah')._id, period: thisP, commissionFils: 410000 },
    { employeeId: by('Aisha Rahman')._id, period: thisP, commissionFils: 95000 },
    { employeeId: by('Mohammed Saleh')._id, period: thisP, expenseReimbursementFils: 64000 },
    { employeeId: by('Sunil Perera')._id, period: thisP, loanInstallmentFils: 50000 },
    { employeeId: by('Imran Shah')._id, period: thisP, unpaidLeaveDays: 1 },
  ]);

  // A little history in the audit log
  const admin = await User.findOne({ email: 'admin@alnoor.demo' });
  await AuditLog.create([
    { actorId: admin._id, actorType: 'user', action: 'payroll.approve', entity: 'PayrollRun', entityId: prevP, correlationId: 'seed-0001' },
    { actorId: admin._id, actorType: 'user', action: 'wps.sif.export', entity: 'WpsSifBatch', entityId: prevP, correlationId: 'seed-0002' },
    { actorId: admin._id, actorType: 'agent', action: 'agent.leave', entity: 'AgentRun', entityId: 'seed', correlationId: 'seed-0003' },
    { actorId: admin._id, actorType: 'user', action: 'document.renewal.open', entity: 'ComplianceDocument', entityId: 'seed', correlationId: 'seed-0004' },
  ]);

  // Two weeks of attendance so the HR monitor and employee history have data (Mon–Fri; UAE weekend is Sat–Sun).
  // Ahmed and Grace are left un-clocked today so their logins can demo the selfie + GPS clock-in.
  const site = { lat: 25.1385, lng: 55.2296 };
  const rnd = (i) => { const x = Math.sin(i * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const attRows = [];
  const todayLocal = localParts(new Date()).date;
  for (let back = 13; back >= 0; back--) {
    const day = new Date(Date.now() - back * 864e5);
    const { date, weekday } = localParts(day);
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    emps.forEach((e, i) => {
      const seedN = back * 100 + i;
      if (rnd(seedN) < 0.06) return; // occasional absence
      if (date === todayLocal && ['Ahmed Khan', 'Grace Okafor'].includes(e.fullName)) return;
      const lateBy = rnd(seedN + 1) < 0.15 ? 16 + Math.floor(rnd(seedN + 2) * 40) : Math.floor(rnd(seedN + 3) * 14) - 10;
      const inAt = new Date(`${date}T08:00:00+04:00`); inAt.setMinutes(inAt.getMinutes() + lateBy);
      const field = e.department === 'Logistics' && rnd(seedN + 4) < 0.25; // drivers sometimes clock in from a delivery
      const off = field ? 0.02 + rnd(seedN + 5) * 0.05 : (rnd(seedN + 6) - 0.5) * 0.002;
      const lat = site.lat + off, lng = site.lng + off / 2;
      const dist = Math.round(Math.hypot((lat - site.lat) * 111000, (lng - site.lng) * 101000));
      const inside = dist <= 300;
      const isToday = date === todayLocal;
      const stay = 9 * 60 + Math.floor(rnd(seedN + 7) * 150) - 20;
      const outAt = new Date(inAt.getTime() + stay * 60000);
      const worked = stay - 60, ot = Math.max(0, worked - 480);
      const late = Math.max(0, lateBy - 15);
      const flags = [];
      if (late) flags.push({ code: 'LATE', msg: `${late} min after the grace period` });
      if (!inside) flags.push({ code: 'OUTSIDE_GEOFENCE', msg: `Clocked in ${(dist / 1000).toFixed(1)} km from Al Quoz Industrial Area 3 warehouse` });
      const showOut = !isToday || rnd(seedN + 8) < 0.1;
      if (showOut && ot) flags.push({ code: 'OVERTIME', msg: `${Math.round(ot / 6) / 10} h beyond the standard day` });
      attRows.push({
        employeeId: e._id, establishmentId: est._id, date, source: rnd(seedN + 9) < 0.7 ? 'mobile' : 'web',
        clockIn: { at: inAt, lat, lng, accuracyM: 8 + Math.round(rnd(seedN + 10) * 30), distanceM: dist, insideGeofence: inside },
        ...(showOut ? { clockOut: { at: outAt, lat: site.lat, lng: site.lng, accuracyM: 15, distanceM: 20, insideGeofence: true }, minutesWorked: worked, overtimeMinutes: ot } : {}),
        hasPhoto: false, lateMinutes: late, status: late ? 'late' : 'present', flags,
      });
    });
  }
  await Attendance.insertMany(attRows);

  console.log(`Seeded ${emps.length + fzEmps.length + 1} employees across ${est.name} and ${fz.name}, periods ${prevP} (paid) and ${thisP} (inputs).`);
});

console.log(`\nSign in at http://localhost:${config.port}\n  admin@alnoor.demo   / ${PASSWORD}  (HR admin + payroll maker)\n  checker@alnoor.demo / ${PASSWORD}  (payroll checker)\n  manager@alnoor.demo / ${PASSWORD}  (line manager)`);
await mongoose.disconnect();
