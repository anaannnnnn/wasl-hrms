// Demo data for the extension modules, so every screen of the prototype has realistic content.
// Runs inside a tenant context. Idempotent: clears this tenant's extension collections first.
import { randomBytes, createHash } from 'node:crypto';
import { Employee, Establishment, Applicant, User } from '../models/index.js';
import { config } from '../config.js';
import { encryptField } from '../lib/fieldcrypt.js';
import * as X from './models.js';
import { buildSchedule, addMonths } from './lib/payrollPlus.js';
import { onboardingSteps } from './lib/agents.js';
import { respondentHash, newApiKey } from './lib/platform.js';

const DAY = 864e5;
const d = (n) => new Date(Date.now() + n * DAY);
const ymd = (n) => d(n).toISOString().slice(0, 10);
const ym = (n = 0) => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 7); };
const mondayOffset = () => { const wd = (new Date().getUTCDay() + 6) % 7; return -wd; };

export async function seedExtDemo() {
  // wipe this tenant's extension data (tenant plugin scopes deleteMany to the current tenant)
  for (const m of Object.values(X)) if (m?.deleteMany && m.modelName !== 'ExtState') await m.deleteMany({});

  const ests = await Establishment.find().sort({ createdAt: 1 }).lean();
  const main = ests.find((e) => e.jurisdiction === 'MAINLAND') || ests[0];
  const emps = await Employee.find({ status: { $in: ['active', 'notice', 'onboarding'] } }).sort({ employeeNo: 1 }).lean();
  if (!emps.length) return { skipped: 'no employees' };
  const by = (name) => emps.find((e) => e.fullName === name) || emps[0];
  const pick = (i) => emps[i % emps.length];
  const admin = await User.findOne({ email: 'admin@alnoor.demo' }).lean();
  const checker = await User.findOne({ email: 'checker@alnoor.demo' }).lean();
  const ahmed = by('Ahmed Khan'), grace = by('Grace Okafor');

  // ---------- settings ----------
  await X.PayrollPolicy.create({ varianceThresholdPct: 15, reportingCurrencies: ['AED', 'USD', 'INR', 'PHP'], overtimeRequiresApproval: true, restDays: [0], standardHoursPerDay: 8 });
  await X.FeatureSettings.create({ attritionInsights: { enabled: true, individualScores: false, reviewedForBias: true, minGroupSize: 3 } });
  await X.FxRate.insertMany([['USD', '3.6725'], ['INR', '0.04375'], ['PHP', '0.06420'], ['GBP', '4.6550']].map(([currency, aedPerUnit]) => ({ currency, aedPerUnit, date: ymd(-1), source: 'Demo rates' })));
  await X.GradeBand.insertMany([['G3', 'Associate', 4000, 8000], ['G4', 'Officer', 7000, 12000], ['G5', 'Senior', 10000, 18000], ['G6', 'Supervisor', 15000, 24000], ['G7', 'Lead', 18000, 30000], ['G8', 'Manager', 28000, 45000]].map(([grade, title, mn, mx]) => ({ grade, title, minFils: mn * 100, maxFils: mx * 100, basicPctMin: 50 })));
  await X.AccountMapping.create({});

  // ---------- time ----------
  const shifts = await X.ShiftTemplate.insertMany([
    { name: 'Morning', code: 'M', segments: [{ start: '07:00', end: '16:00' }], breakMin: 60, color: '#2563eb' },
    { name: 'General', code: 'G', segments: [{ start: '09:00', end: '18:00' }], breakMin: 60, color: '#0f766e' },
    { name: 'Evening', code: 'E', segments: [{ start: '14:00', end: '23:00' }], breakMin: 60, color: '#d97706' },
    { name: 'Night', code: 'N', segments: [{ start: '22:00', end: '06:00' }], breakMin: 60, color: '#7c3aed' },
    { name: 'Split retail', code: 'SP', segments: [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }], breakMin: 0, color: '#059669' },
  ]);
  const roster = []; const start = mondayOffset();
  emps.filter((e) => String(e.establishmentId) === String(main._id)).slice(0, 18).forEach((e, i) => {
    for (let k = 0; k < 14; k++) {
      const date = ymd(start + k); const rest = (k + i) % 7 === 6;
      const sh = ['Warehouse', 'Logistics', 'Operations'].includes(e.department) ? shifts[[0, 2, 3][(i + Math.floor(k / 7)) % 3]] : e.department === 'Sales' ? shifts[4] : shifts[1];
      roster.push({ employeeId: e._id, establishmentId: e.establishmentId, date, restDay: rest, shiftId: rest ? null : sh._id, publishedAt: k < 7 ? new Date() : null, createdBy: admin?._id });
    }
  });
  await X.RosterEntry.insertMany(roster);
  await X.PublicHoliday.insertMany([{ date: ymd(24), name: 'Company Family Day', nameAr: 'يوم العائلة', establishmentId: main._id }]);
  await X.RamadanPeriod.create({ year: 2027, start: '2027-02-08', end: '2027-03-09', estimated: true });
  await X.AttendanceDispute.insertMany([
    { employeeId: pick(3)._id, date: ymd(-1), kind: 'missed_punch', requestedOut: '18:05', reason: 'Phone battery died at the client site.' },
    { employeeId: pick(6)._id, date: ymd(-2), kind: 'not_late', reason: 'Metro Red Line was suspended for 40 minutes (RTA notice attached in chat).' },
    { employeeId: ahmed._id, date: ymd(-6), kind: 'overtime_claim', requestedOut: '21:30', reason: 'Stayed for the Jebel Ali delivery.', status: 'approved', decidedAt: d(-5), decisionNote: 'Approved by manager', edit: { before: { clockOut: d(-6) }, after: { clockOut: d(-6) }, by: 'Omar Haddad' } },
  ]);
  await X.AttendanceDevice.create({ name: 'Warehouse gate · Al Quoz', vendor: 'zkteco', serial: 'ZK-SF1008-2231', establishmentId: main._id, keyId: `dev_${randomBytes(6).toString('hex')}`, secretEnc: encryptField(randomBytes(24).toString('base64url')), lastSeenAt: d(-0.02) });
  await X.OvertimeApproval.insertMany([pick(2), pick(4)].map((e, i) => ({ employeeId: e._id, period: ym(0), status: i ? 'pending' : 'approved', approvedMinutes: { normal: 360, premium: 120 }, decidedAt: i ? undefined : new Date() })));

  // ---------- payroll+ ----------
  const loanSpecs = [[pick(1), 'advance', 3000, 1000, -1, 'active', 'School fees'], [pick(5), 'loan', 12000, 1500, 1, 'pending', 'Family medical expenses'], [pick(7), 'fine', 500, 500, 0, 'active', 'Traffic fine on company vehicle (RTA)'], [grace, 'advance', 2000, 1000, 1, 'pending', 'Rent deposit']];
  for (const [e, kind, p, inst, startOff, status, reason] of loanSpecs) {
    const schedule = buildSchedule({ principalFils: p * 100, installmentFils: inst * 100, startPeriod: ym(startOff) });
    if (status === 'active' && startOff < 0) schedule[0].status = 'deducted';
    await X.Loan.create({ employeeId: e._id, kind, principalFils: p * 100, installmentFils: inst * 100, startPeriod: ym(startOff), schedule, status, reason, createdBy: admin?._id, ...(status === 'active' ? { approvedBy: checker?._id, approvedAt: d(-20) } : {}) });
  }
  const ap = await X.AirfarePolicy.create({ name: 'Standard economy (annual)', cycleMonths: 12, travelClass: 'economy', includeDependents: true, maxDependents: 2, allowEncashment: true, fares: [['COK', 'Kochi', 1800, 1200], ['KTM', 'Kathmandu', 1650, 1100], ['MNL', 'Manila', 2200, 1500], ['LOS', 'Lagos', 3600, 2400], ['KHI', 'Karachi', 1100, 800], ['CMB', 'Colombo', 1500, 1000], ['BOM', 'Mumbai', 1300, 900]].map(([iata, city, a, c]) => ({ iata, city, adultFils: a * 100, childFils: c * 100 })) });
  const homes = { India: 'COK', Nepal: 'KTM', Philippines: 'MNL', Nigeria: 'LOS', Pakistan: 'KHI', 'Sri Lanka': 'CMB' };
  for (const e of emps.filter((x) => homes[x.nationality]).slice(0, 8)) {
    const fare = ap.fares.find((f) => f.iata === homes[e.nationality]); const monthly = Math.round(fare.adultFils / 12);
    const ledger = Array.from({ length: 9 }, (_, i) => ({ at: d(-30 * (9 - i)), period: ym(i - 8), kind: 'accrual', amountFils: monthly, note: `Accrual ${fare.iata}` }));
    await X.AirfareAccount.create({ employeeId: e._id, policyId: ap._id, homeIata: fare.iata, dependentsCovered: 0, eligibleFrom: e.joinDate, ledger, balanceFils: monthly * 9, lastAccruedPeriod: ym(0) });
  }
  const air = await X.AirfareAccount.findOne().lean();
  if (air) await X.AirfareRequest.create({ employeeId: air.employeeId, kind: 'encash', amountFils: Math.min(air.balanceFils, 120000), status: 'pending', notes: 'Not travelling this year' });
  const cats = [['Careem', 'travel', 84, -3, 'submitted'], ['ENOC', 'fuel', 210, -9, 'manager_approved'], ['Al Safadi Restaurant', 'client', 465, -12, 'approved'], ['du Telecom', 'telecom', 157.5, -20, 'approved'], ['Virgin Megastore', 'office', 68.25, -2, 'submitted'], ['Udemy', 'training', 199, -30, 'rejected']];
  await X.ExpenseClaim.insertMany(cats.map(([merchant, category, total, off, status], i) => ({ employeeId: [ahmed, grace, pick(2), pick(4), ahmed, pick(8)][i]._id, merchant, category, receiptDate: d(off), totalFils: Math.round(total * 100), vatFils: Math.round((total * 100 * 5) / 105), description: { client: 'Dinner with Emaar procurement team', fuel: 'Site visits Dubai South' }[category] || '', status, flags: i === 1 ? ['POSSIBLE_DUPLICATE'] : [], approvals: status !== 'submitted' ? [{ level: 1, role: 'manager', decision: status === 'rejected' ? 'reject' : 'approve', at: d(off + 1) }] : [] })));

  // ---------- people ops ----------
  const pol = await X.InsurancePolicy.create({
    insurer: 'Daman', tpa: 'NAS', plan: 'Enhanced Silver', policyNo: 'DMN-GRP-2026-1184', emirate: 'Dubai', startDate: new Date(`${new Date().getUTCFullYear()}-01-01`), endDate: new Date(`${new Date().getUTCFullYear()}-12-31`), premiumPerMemberFils: 420000, brokerContact: 'Lockton UAE · +971 4 000 0000',
    network: [['Mediclinic City Hospital', 'hospital', 'Dubai', 'Healthcare City', 25.2309, 55.3227], ['Saudi German Hospital', 'hospital', 'Dubai', 'Al Barsha', 25.0985, 55.1802], ['Aster Clinic', 'clinic', 'Dubai', 'Al Qusais', 25.2771, 55.3732], ['NMC Royal Hospital', 'hospital', 'Dubai', 'DIP', 24.9888, 55.1655], ['Life Pharmacy', 'pharmacy', 'Dubai', 'Al Quoz', 25.1378, 55.2386], ['Prime Medical Center', 'clinic', 'Dubai', 'Jumeirah', 25.2042, 55.2475], ['Cleveland Clinic Abu Dhabi', 'hospital', 'Abu Dhabi', 'Al Maryah Island', 24.5004, 54.3897], ['Burjeel Hospital', 'hospital', 'Abu Dhabi', 'Al Najda', 24.4919, 54.3708], ['Al Zahra Hospital', 'hospital', 'Sharjah', 'Al Zahra', 25.3349, 55.3889], ['Unilabs', 'lab', 'Dubai', 'Al Wasl', 25.1969, 55.2547], ['Aster Pharmacy', 'pharmacy', 'Sharjah', 'Al Nahda', 25.3010, 55.3720], ['Medcare Hospital', 'hospital', 'Dubai', 'Al Safa', 25.1758, 55.2390]].map(([name, type, emirate, area, lat, lng], i) => ({ name, type, emirate, area, lat, lng, phone: '800 4 2626', directBilling: i % 5 !== 3 })),
  });
  await X.InsuranceMember.insertMany(emps.slice(0, 30).map((e, i) => ({ policyId: pol._id, employeeId: e._id, memberName: e.fullName, relation: 'self', cardNo: `DMN ${4400 + i} ${String(1000 + i * 37).slice(-4)} ${String(7000 + i * 13).slice(-4)}`, validFrom: pol.startDate, validTo: pol.endDate })));
  await X.BenefitRequest.insertMany([{ employeeId: grace._id, kind: 'dependent_add', dependent: { name: 'Chidi Okafor', relation: 'son', dateOfBirth: d(-60) }, notes: 'Newborn, birth certificate ready' }, { employeeId: pick(9)._id, kind: 'card_replacement', notes: 'Card lost at the airport', status: 'sent_to_broker' }]);
  await X.Perk.insertMany([['15% off groceries', 'Carrefour (MAF)', 'Groceries', 'WASL15'], ['Gym membership AED 99/month', 'GymNation', 'Fitness', 'GN-CORP'], ['20% off family dining', 'The Entertainer', 'Dining', 'ENT-ALNOOR'], ['Free salary transfer + no minimum balance', 'Emirates NBD', 'Banking', ''], ['Discounted Salik tags', 'RTA', 'Transport', '']].map(([title, provider, category, code]) => ({ title, provider, category, code, description: `${title} for Al Noor staff` })));
  await X.Dependent.insertMany([[ahmed, 'Ayesha Khan', 'spouse', 70], [ahmed, 'Zayd Khan', 'son', 70], [grace, 'Emeka Okafor', 'spouse', 25], [pick(4), 'Lakshmi Nair', 'spouse', 240]].map(([e, name, relation, exp]) => ({ employeeId: e._id, name, relation, sponsor: 'employee', residenceExpiry: d(exp), emiratesIdExpiry: d(exp + 2), passportExpiry: d(900) })));
  const assets = await X.CompanyAsset.insertMany([['LT-0042', 'laptop', 'ThinkPad T14 Gen 4', 4], ['LT-0043', 'laptop', 'MacBook Air M3', 6], ['PH-0110', 'phone', 'Samsung A55', 0], ['PH-0111', 'phone', 'iPhone 15', 1], ['VH-0007', 'vehicle', 'Toyota Hiace (Dubai V 48213)', 2], ['AC-0201', 'access_card', 'HID iClass', 3], ['TL-0012', 'tools', 'Zebra handheld scanner', 5], ['LT-0044', 'laptop', 'Dell Latitude 5450', null]].map(([tag, kind, model, holder]) => ({ tag, kind, model, serial: `SN${createHash('md5').update(tag).digest('hex').slice(0, 8).toUpperCase()}`, valueFils: kind === 'vehicle' ? 11000000 : 450000, status: holder == null ? 'in_stock' : 'assigned', assignedTo: holder == null ? null : (holder === 0 ? ahmed : pick(holder))._id, assignedAt: holder == null ? null : d(-120), history: [{ at: d(-130), action: 'created' }] })));
  await X.AssetRequest.create({ employeeId: grace._id, kind: 'laptop', reason: 'Sales demos at client sites', neededBy: d(10) });

  // ---------- talent ----------
  const reqs = await X.JobRequisition.insertMany([
    { title: 'Senior Frontend Engineer', department: 'Technology', establishmentId: main._id, headcount: 1, grade: 'G7', budgetMinFils: 1800000, budgetMaxFils: 2500000, location: 'Dubai · Business Bay', description: 'Build our customer portal with React and TypeScript. Arabic RTL experience is a plus.', requirements: ['React', 'TypeScript', 'RTL', 'Accessibility'], status: 'open', publicSlug: 'senior-frontend-engineer-a1', publishedAt: d(-12), createdBy: admin?._id },
    { title: 'Warehouse Associate', department: 'Warehouse', establishmentId: main._id, headcount: 4, grade: 'G3', budgetMinFils: 400000, budgetMaxFils: 550000, location: 'Dubai · Al Quoz', description: 'Pick, pack and dispatch for our FMCG clients. Forklift licence preferred.', requirements: ['Forklift', 'Inventory', 'Shift work'], status: 'open', publicSlug: 'warehouse-associate-b2', publishedAt: d(-5), createdBy: admin?._id },
    { title: 'Emirati Graduate Trainee (Finance)', department: 'Finance', establishmentId: main._id, headcount: 2, grade: 'G4', budgetMinFils: 900000, budgetMaxFils: 1200000, location: 'Dubai', description: 'NAFIS-eligible graduate programme in finance operations.', requirements: ['Accounting', 'Excel', 'Arabic'], status: 'pending_approval', createdBy: admin?._id },
  ]);
  const applicants = await Applicant.find().lean();
  for (const [i, a] of applicants.entries()) {
    const rq = reqs[i % 2]; const score = 45 + ((i * 17) % 50);
    await X.CandidateProfile.create({ applicantId: a._id, requisitionId: rq._id, parsed: { skills: rq.requirements.slice(0, 2 + (i % 2)), totalYears: 2 + (i % 7), inUae: i % 3 !== 0, engine: 'rules' }, match: { score, reasons: [`Has ${rq.requirements[0]}`, `${2 + (i % 7)} years' experience`] } });
  }
  const omar = await X.Offer.create({ candidateName: 'Omar Al-Maktoum', candidateEmail: 'omar.almaktoum@example.ae', jobTitle: 'Senior Frontend Engineer', grade: 'G7', establishmentId: main._id, requisitionId: reqs[0]._id, startDate: d(38), basicFils: 1320000, housingFils: 660000, transportFils: 220000, otherFils: 0, visaType: 'UAE National (no visa)', status: 'signed', signature: { name: 'Omar Al-Maktoum', at: d(-2), ip: '94.200.12.8', docHash: createHash('sha256').update('omar').digest('hex') }, documents: [{ kind: 'passport', fileName: 'passport.pdf', at: d(-2) }, { kind: 'education_certificate', fileName: 'degree.pdf', at: d(-2) }], validation: { issues: [], warnings: [] }, createdBy: admin?._id, source: 'agent' });
  const token = randomBytes(24).toString('base64url');
  await X.Offer.create({ candidateName: 'Joy Santos', candidateEmail: 'joy.santos@example.ph', jobTitle: 'Warehouse Associate', grade: 'G3', establishmentId: main._id, requisitionId: reqs[1]._id, startDate: d(21), basicFils: 300000, housingFils: 150000, transportFils: 50000, otherFils: 0, visaType: 'Mainland employment visa', status: 'sent', signTokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: d(6), validation: { issues: [], warnings: [] }, createdBy: admin?._id });
  await X.ImmigrationCase.create({ offerId: omar._id, subjectName: 'Omar Al-Maktoum', establishmentId: main._id, kind: 'new_hire', jurisdiction: 'MAINLAND', steps: onboardingSteps({ startDate: ymd(38), visa: 'uae_national' }).map((s, i) => ({ ...s, status: i === 0 ? 'done' : 'todo' })), source: 'agent' });
  const ren = onboardingSteps({ startDate: ymd(20) });
  await X.ImmigrationCase.create({ employeeId: pick(3)._id, subjectName: pick(3).fullName, establishmentId: main._id, kind: 'renewal', steps: [{ key: 'medical', name: 'Medical fitness test', owner: 'employee', status: 'done', costFils: 32000, dueDate: d(-6), doneAt: d(-7) }, { key: 'eid', name: 'Emirates ID renewal', owner: 'pro', status: 'submitted', costFils: 37000, dueDate: d(-1), dependsOn: ['medical'], reference: 'ICP-784-2026-118' }, { key: 'insurance', name: 'Health insurance valid for visa term', owner: 'insurer', status: 'done', dueDate: d(-10) }, { key: 'contract', name: 'Contract renewal / labour card', owner: 'typing_centre', status: 'rejected', rejectionReason: 'Salary on contract does not match WPS', attempts: 1, dueDate: d(2) }, { key: 'visa', name: 'Residence visa renewal', owner: 'pro', status: 'todo', dueDate: d(12), dependsOn: ['medical', 'eid', 'insurance', 'contract'] }], status: 'blocked' });
  await X.ImmigrationCase.create({ employeeId: pick(11)._id, subjectName: pick(11).fullName, establishmentId: main._id, kind: 'cancellation', graceUntil: d(25), steps: [{ key: 'settlement', name: 'Final settlement paid via WPS', owner: 'hr', status: 'done' }, { key: 'labour_cancel', name: 'Work permit cancellation', owner: 'typing_centre', status: 'in_progress', dueDate: d(3), dependsOn: ['settlement'] }, { key: 'visa_cancel', name: 'Residence visa cancellation', owner: 'pro', status: 'todo', dueDate: d(8), dependsOn: ['labour_cancel'] }], status: 'open' });
  void ren;

  // ---------- performance & engagement ----------
  const cycle = `${new Date().getUTCFullYear()}-H2`;
  const g1 = await X.Goal.create({ ownerType: 'company', title: 'Zero WPS rejections this year', cycle, keyResults: [{ title: 'Payroll runs with zero bank rejections', start: 0, target: 6, current: 4 }, { title: 'IBANs validated before cut-off (%)', start: 80, target: 100, current: 97 }], createdBy: admin?._id });
  const g2 = await X.Goal.create({ ownerType: 'company', title: 'Reach 2% Emiratisation in skilled roles', cycle, keyResults: [{ title: 'Qualifying UAE nationals hired', start: 0, target: 3, current: 1 }], status: 'at_risk', createdBy: admin?._id });
  const g3 = await X.Goal.create({ ownerType: 'department', department: 'Logistics', parentId: g1._id, title: 'On-time delivery 98%', cycle, keyResults: [{ title: 'On-time deliveries (%)', start: 90, target: 98, current: 95 }], createdBy: admin?._id });
  await X.Goal.create({ ownerType: 'employee', employeeId: ahmed._id, parentId: g3._id, title: 'Cut route delays on the Jebel Ali run', cycle, keyResults: [{ title: 'Late drops per week', start: 9, target: 2, current: 4 }, { title: 'Customer ratings ≥ 4.5', start: 0, target: 20, current: 13 }], createdBy: admin?._id });
  await X.Goal.create({ ownerType: 'employee', employeeId: grace._id, parentId: g2._id, title: 'Grow key-account revenue by 12%', cycle, keyResults: [{ title: 'Revenue growth (%)', start: 0, target: 12, current: 7 }], createdBy: admin?._id });
  for (const e of emps.filter((x) => Date.now() - new Date(x.joinDate) < 200 * DAY).slice(0, 3)) {
    for (const [kind, n] of [['probation_30', 30], ['probation_60', 60], ['probation_90', 90]]) await X.Review.create({ employeeId: e._id, kind, cycle: 'probation', dueDate: new Date(new Date(e.joinDate).getTime() + n * DAY), reviewers: [{ employeeId: e._id, relation: 'self' }, { relation: 'hr' }], status: n === 30 ? 'completed' : 'scheduled', ...(n === 30 ? { outcome: { rating: 4, recommendation: 'none', note: 'Good start' } } : {}) });
  }
  await X.Review.create({ employeeId: grace._id, kind: '360', cycle, dueDate: d(9), status: 'in_progress', reviewers: [{ employeeId: grace._id, relation: 'self', ratings: [4, 4, 5, 4, 4], submittedAt: d(-1) }, { employeeId: ahmed._id, relation: 'peer', invitedAt: d(-3) }, { employeeId: pick(5)._id, relation: 'peer', ratings: [5, 4, 4, 5, 4], strengths: 'Always ready to help on big accounts', submittedAt: d(-2) }] });
  await X.Recognition.insertMany([[pick(1), ahmed, 'team_player', 'Covered two night shifts back to back during the Eid rush.'], [ahmed, grace, 'customer_hero', 'Saved the Al Futtaim account with a same-day delivery.'], [grace, pick(4), 'mentor', 'Patiently trained the new warehouse joiners on the scanners.'], [pick(6), pick(2), 'safety_star', 'Spotted the forklift brake issue before anyone got hurt.'], [pick(3), pick(8), 'innovator', 'Built the route-planning sheet that saved us 3 hours a day.'], [pick(9), pick(1), 'above_and_beyond', 'Handled the DEWA audit paperwork over the weekend.']].map(([f, t, badge, message], i) => ({ fromEmployeeId: f._id, toEmployeeId: t._id, badge, message, createdAt: d(-i) })));
  await X.Announcement.insertMany([
    { title: 'Town hall: plans for next year', titleAr: 'لقاء عام: خطط العام القادم', kind: 'townhall', body: 'Join the CEO in the Al Quoz warehouse canteen. Lunch provided. Remote staff can join on Teams.', eventAt: d(5), pinned: true, publishedAt: d(-1), publishedBy: admin?._id },
    { title: 'New: request letters and expenses in the app', kind: 'news', body: 'Salary certificates are now issued instantly as signed PDFs, and you can snap receipts for expenses.', publishedAt: d(-3), publishedBy: admin?._id },
    { title: 'Updated leave policy for Hajj', kind: 'policy', body: 'Hajj leave can now be requested 60 days in advance.', publishedAt: d(-9), publishedBy: admin?._id },
  ]);
  const sv = await X.Survey.create({ title: `Quarterly eNPS · ${new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`, kind: 'enps', status: 'open', opensAt: d(-6), closesAt: d(8), minGroupSize: 3, questions: [{ id: 'q1', text: 'How likely are you to recommend Al Noor as a place to work? (0–10)', type: 'scale10' }, { id: 'q2', text: 'What is one thing we should improve?', type: 'text' }] });
  const comments = ['More predictable shift rosters please', 'Great team spirit in logistics', 'AC in the warehouse needs fixing', 'Faster reimbursement for fuel', 'Loved the new clock-in app', '', 'Career growth path for drivers', ''];
  await X.SurveyResponse.insertMany(emps.filter((e) => String(e._id) !== String(ahmed._id)).slice(0, 14).map((e, i) => ({ surveyId: sv._id, respondentHash: respondentHash(config.jwtSecret, String(sv._id), String(e._id)), department: e.department, answers: { q1: [9, 10, 8, 7, 9, 6, 10, 9, 5, 8, 9, 10, 7, 9][i], ...(comments[i % comments.length] ? { q2: comments[i % comments.length] } : {}) } })));

  // ---------- platform ----------
  if (admin) {
    await X.SavedReport.insertMany([{ name: 'Headcount by department', entity: 'employees', columns: ['employeeNo', 'fullName', 'department', 'jobTitle', 'nationality', 'joinDate'], filters: { status: 'active' }, schedule: 'monthly', recipients: ['cfo@alnoor.demo'], ownerUserId: admin._id, shared: true, lastRunAt: d(-3) }, { name: 'Pending expenses', entity: 'expenses', columns: ['employee', 'merchant', 'total', 'status'], filters: { status: 'submitted' }, schedule: 'weekly', recipients: [], ownerUserId: admin._id }]);
    const k = newApiKey(); await X.ApiKey.create({ name: 'Odoo ERP sync', prefix: k.prefix, hash: k.hash, scopes: ['employees:read', 'leave:read'], createdBy: admin._id, lastUsedAt: d(-0.1) });
  }
  await X.Webhook.create({ url: 'https://hooks.example.ae/wasl/payroll', events: ['payroll.approved', 'employee.created'], secretEnc: encryptField(`whsec_${randomBytes(18).toString('base64url')}`), description: 'Finance ERP', active: true, lastStatus: 200, lastDeliveryAt: d(-1) });
  await X.Connector.insertMany([{ kind: 'accounting', provider: 'xero', config: { tenantName: 'Al Noor Trading LLC' }, enabled: true, health: { status: 'ok', checkedAt: d(-0.5), detail: 'Journal CSV export' } }, { kind: 'whatsapp', provider: 'meta_cloud', config: {}, enabled: false }]);
  await X.RuleVersion.create({ packId: 'UAE-MAINLAND', version: `${new Date().getUTCFullYear() + 1}.1`, effectiveFrom: `${new Date().getUTCFullYear() + 1}-01-01`, overrides: { gratuity: { dailyWageDivisor: 360 } }, sourceRef: 'Counsel memo (draft) — confirm divisor', changeNote: 'Align daily wage divisor with company policy', testCases: [{ name: 'divisor', input: { path: 'gratuity.dailyWageDivisor' }, expect: { value: 360 } }], status: 'draft', createdBy: admin?._id });
  await X.CopilotMessage.insertMany([{ employeeId: ahmed._id, channel: 'app', lang: 'en', text: 'How many leave days do I have?', intent: 'leave_balance', reply: 'You have 18 annual leave days and 15 full-pay sick days left.', createdAt: d(-1) }, { employeeId: ahmed._id, channel: 'whatsapp', lang: 'hi', text: 'मुझे सैलरी सर्टिफिकेट चाहिए', intent: 'letter', reply: 'आपका प्रमाणपत्र तैयार है। My requests से डाउनलोड करें।', createdAt: d(-4) }]);
  return { ok: true, employees: emps.length, period: addMonths(ym(0), 0) };
}
