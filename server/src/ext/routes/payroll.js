// Payroll & finance extensions: loans/advances/fines ledger, overtime from attendance, payroll-input sync,
// airfare accrual & encashment, accounting journals, bank rejections, reconciliation, variance, FX, real PDF payslips.
import { Router } from 'express';
import { Employee, Establishment, PayrollRun, PayrollInput, WpsSifBatch, Attendance } from '../../models/index.js';
import { authenticate, requireRole, restrictEmployees, audit, ah } from '../../middleware/auth.js';
import { localParts } from '../../lib/attendance.js';
import { toFils } from '../../lib/money.js';
import { Loan, AirfarePolicy, AirfareAccount, AirfareRequest, AccountMapping, BankRejection, PayrollPolicy, FxRate, PayrollInputSync, OvertimeApproval, ExpenseClaim, RosterEntry, PublicHoliday } from '../models.js';
import { overtimePay, buildSchedule, periodDeductions, outstandingFils, accrueAirfare, monthlyAirfareAccrual, buildJournal, journalFile, parseRejectionCsv, matchRejections, reconcileRun, comparePeriods, convertFromAed, addMonths } from '../lib/payrollPlus.js';
import { holidaySet, weekday } from '../lib/time.js';
import { payslipPdf } from '../lib/pdfDocs.js';
import { z, fail, money, ymd, ym, oid, sendPdf, sendCsv, sealedPdf, emitEvent } from './_util.js';

const r = Router();
r.use(authenticate, restrictEmployees);
const MAKER = requireRole('payroll_maker', 'hr_admin');
const PAYROLL = requireRole('payroll_maker', 'payroll_checker', 'hr_admin');
const policy = async () => (await PayrollPolicy.findOne().lean()) || (await PayrollPolicy.create({})).toObject();
const periodBounds = (p) => { const [y, m] = p.split('-').map(Number); return { start: `${p}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; };

// =============================================================== Loans, advances, fines
r.get('/loans', PAYROLL, ah(async (req, res) => {
  const q = {}; if (req.query.employeeId) q.employeeId = req.query.employeeId; if (req.query.status) q.status = req.query.status;
  const loans = await Loan.find(q).sort({ createdAt: -1 }).populate('employeeId', 'fullName employeeNo').lean();
  res.json(loans.map((l) => ({ ...l, outstandingFils: outstandingFils(l) })));
}));
const loanIn = z.object({ employeeId: oid, kind: z.enum(['loan', 'advance', 'fine']), principal: money, installment: money, startPeriod: ym, reason: z.string().max(300).optional() });
r.post('/loans', MAKER, ah(async (req, res) => {
  const b = loanIn.parse(req.body);
  if (!(await Employee.exists({ _id: b.employeeId }))) throw fail(404, 'Employee not found');
  const schedule = buildSchedule({ principalFils: b.principal, installmentFils: b.installment, startPeriod: b.startPeriod });
  const loan = await Loan.create({ employeeId: b.employeeId, kind: b.kind, reason: b.reason, principalFils: b.principal, installmentFils: b.installment, startPeriod: b.startPeriod, schedule, status: 'pending', createdBy: req.user.id });
  await audit(req, 'loan.create', 'Loan', loan._id, null, { kind: b.kind, principalFils: b.principal, instalments: schedule.length });
  res.status(201).json(loan);
}));
r.post('/loans/:id/decision', requireRole('hr_admin', 'payroll_checker'), ah(async (req, res) => {
  const { decision } = z.object({ decision: z.enum(['approve', 'reject']) }).parse(req.body);
  const loan = await Loan.findById(req.params.id); if (!loan) throw fail(404, 'Loan not found');
  if (loan.status !== 'pending') throw fail(409, 'This loan was already decided.');
  if (String(loan.createdBy) === req.user.id) throw fail(403, 'A different person must approve a loan they created (maker-checker).');
  loan.status = decision === 'approve' ? 'active' : 'rejected'; loan.approvedBy = req.user.id; loan.approvedAt = new Date(); await loan.save();
  await audit(req, `loan.${decision}`, 'Loan', loan._id, { status: 'pending' }, { status: loan.status });
  await emitEvent(`loan.${decision === 'approve' ? 'approved' : 'rejected'}`, { loanId: String(loan._id), employeeId: String(loan.employeeId) });
  res.json(loan);
}));
r.post('/loans/:id/reschedule', MAKER, ah(async (req, res) => {
  const b = z.object({ installment: money, startPeriod: ym }).parse(req.body);
  const loan = await Loan.findById(req.params.id); if (!loan || loan.status !== 'active') throw fail(404, 'Active loan not found');
  const before = loan.schedule.map((s) => s.toObject()); const left = outstandingFils(loan);
  const kept = loan.schedule.filter((s) => s.status === 'deducted' || s.status === 'skipped');
  loan.schedule = [...kept, ...buildSchedule({ principalFils: left, installmentFils: b.installment, startPeriod: b.startPeriod })]; loan.installmentFils = b.installment; await loan.save();
  await audit(req, 'loan.reschedule', 'Loan', loan._id, { schedule: before }, { schedule: loan.schedule });
  res.json(loan);
}));
r.post('/loans/:id/write-off', requireRole('hr_admin'), ah(async (req, res) => {
  const { note } = z.object({ note: z.string().min(3).max(300) }).parse(req.body);
  const loan = await Loan.findById(req.params.id); if (!loan) throw fail(404, 'Loan not found');
  loan.schedule.forEach((s) => { if (['due', 'deferred', 'synced'].includes(s.status)) { s.status = 'skipped'; s.note = note; } }); loan.status = 'written_off'; await loan.save();
  await audit(req, 'loan.write_off', 'Loan', loan._id, null, { note }); res.json(loan);
}));
r.get('/me/loans', ah(async (req, res) => res.json((await Loan.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean()).map((l) => ({ ...l, outstandingFils: outstandingFils(l) })))));
r.post('/me/loans', ah(async (req, res) => {
  const b = z.object({ kind: z.enum(['loan', 'advance']), principal: money, installment: money, startPeriod: ym, reason: z.string().min(3).max(300) }).parse(req.body);
  const loan = await Loan.create({ employeeId: req.user.employeeId, kind: b.kind, reason: b.reason, principalFils: b.principal, installmentFils: b.installment, startPeriod: b.startPeriod, schedule: buildSchedule({ principalFils: b.principal, installmentFils: b.installment, startPeriod: b.startPeriod }), status: 'pending', createdBy: req.user.id });
  await audit(req, 'loan.request', 'Loan', loan._id, null, { kind: b.kind, principalFils: b.principal }); res.status(201).json(loan);
}));

// =============================================================== Overtime from attendance
async function overtimeFor(est, period, employees, pol) {
  const { start, end } = periodBounds(period);
  const [att, roster, hols] = await Promise.all([
    Attendance.find({ employeeId: { $in: employees.map((e) => e._id) }, date: { $gte: start, $lte: end }, 'clockOut.at': { $exists: true } }).lean(),
    RosterEntry.find({ employeeId: { $in: employees.map((e) => e._id) }, date: { $gte: start, $lte: end } }).lean(),
    PublicHoliday.find({ date: { $gte: start, $lte: end } }).lean(),
  ]);
  const holidays = holidaySet(hols, est._id); const tz = est.shift?.timezone || 'Asia/Dubai';
  return employees.map((e) => {
    const mine = att.filter((a) => String(a.employeeId) === String(e._id));
    const days = mine.map((a) => {
      const ro = roster.find((x) => String(x.employeeId) === String(e._id) && x.date === a.date);
      return { date: a.date, clockInLocalMin: localParts(a.clockIn.at, tz).minutes, clockOutLocalMin: localParts(a.clockOut.at, tz).minutes, overtimeMinutes: a.overtimeMinutes || 0, restDay: ro ? ro.restDay : pol.restDays.includes(weekday(a.date)), holiday: holidays.has(a.date) };
    });
    return { employee: e, ot: overtimePay({ basicMonthlyFils: e.compensation.basicFils, days, rulePackId: est.rulePackId, onDate: `${period}-01`, hoursPerDay: pol.standardHoursPerDay || 8 }) };
  });
}
r.get('/payroll/overtime', PAYROLL, ah(async (req, res) => {
  const { establishmentId, period } = z.object({ establishmentId: oid, period: ym }).parse(req.query);
  const est = await Establishment.findById(establishmentId).lean(); if (!est) throw fail(404, 'Establishment not found');
  const emps = await Employee.find({ establishmentId, status: { $in: ['active', 'notice'] } }).lean();
  const rows = await overtimeFor(est, period, emps, await policy());
  const approvals = await OvertimeApproval.find({ period, employeeId: { $in: emps.map((e) => e._id) } }).lean();
  res.json(rows.filter((x) => x.ot.totalFils).map(({ employee: e, ot }) => ({ employeeId: e._id, employeeName: e.fullName, ...ot, approval: approvals.find((a) => String(a.employeeId) === String(e._id)) || null })));
}));
r.post('/payroll/overtime/:employeeId/decision', requireRole('hr_admin', 'manager'), ah(async (req, res) => {
  const b = z.object({ period: ym, decision: z.enum(['approved', 'rejected']), normalMinutes: z.number().int().min(0).optional(), premiumMinutes: z.number().int().min(0).optional(), compensatoryRest: z.boolean().default(false) }).parse(req.body);
  const e = await Employee.findById(req.params.employeeId).lean(); if (!e) throw fail(404, 'Employee not found');
  const est = await Establishment.findById(e.establishmentId).lean();
  const [{ ot }] = await overtimeFor(est, b.period, [e], await policy());
  const doc = await OvertimeApproval.findOneAndUpdate({ employeeId: e._id, period: b.period }, { $set: { status: b.decision, decidedBy: req.user.id, decidedAt: new Date(), computed: ot, compensatoryRest: b.compensatoryRest, approvedMinutes: { normal: Math.min(b.normalMinutes ?? ot.normalMinutes, ot.normalMinutes), premium: Math.min(b.premiumMinutes ?? ot.premiumMinutes, ot.premiumMinutes) } } }, { upsert: true, new: true });
  await audit(req, `overtime.${b.decision}`, 'OvertimeApproval', doc._id, null, { period: b.period, approvedMinutes: doc.approvedMinutes, compensatoryRest: b.compensatoryRest });
  res.json(doc);
}));

// =============================================================== Payroll input sync (overtime + loans + fines + expenses → PayrollInput)
async function buildSync(est, period) {
  const pol = await policy();
  const emps = await Employee.find({ establishmentId: est._id, status: { $in: ['active', 'notice'] } }).lean();
  const ids = emps.map((e) => e._id);
  const [ots, approvals, loans, expenses, existing] = await Promise.all([
    overtimeFor(est, period, emps, pol), OvertimeApproval.find({ period, employeeId: { $in: ids } }).lean(),
    Loan.find({ employeeId: { $in: ids }, status: 'active' }).lean(),
    ExpenseClaim.find({ employeeId: { $in: ids }, status: 'approved' }).lean(), PayrollInput.find({ period, employeeId: { $in: ids } }).lean(),
  ]);
  return emps.map((e) => {
    const id = String(e._id); const { ot } = ots.find((x) => String(x.employee._id) === id);
    const appr = approvals.find((a) => String(a.employeeId) === id);
    let overtimeFils = ot.totalFils;
    if (pol.overtimeRequiresApproval) {
      if (appr?.status !== 'approved') overtimeFils = 0;
      else { const hourly = e.compensation.basicFils / 30 / (pol.standardHoursPerDay || 8); overtimeFils = appr.compensatoryRest ? 0 : Math.round((hourly * ot.trace.rates.normal * appr.approvedMinutes.normal) / 60 + (hourly * ot.trace.rates.premium * appr.approvedMinutes.premium) / 60); }
    }
    const reimb = expenses.filter((x) => String(x.employeeId) === id).reduce((a, x) => a + x.totalFils, 0);
    const c = e.compensation; const fixed = c.basicFils + c.housingFils + c.transportFils + (c.allowances || []).reduce((a, x) => a + x.amountFils, 0);
    const prev = existing.find((x) => String(x.employeeId) === id) || {};
    const ded = periodDeductions({ loans: loans.filter((l) => String(l.employeeId) === id), period, grossFils: fixed + overtimeFils + reimb + (prev.commissionFils || 0), basicMonthlyFils: c.basicFils, capPct: 50 });
    return { employeeId: e._id, employeeName: e.fullName, overtimeFils, overtimeTrace: { ...ot.trace, approval: appr?.status || (pol.overtimeRequiresApproval ? 'pending' : 'not_required') }, loanInstallmentFils: ded.loanInstallmentFils, fineFils: ded.fineFils, expenseReimbursementFils: reimb, loanItems: ded.items, expenseIds: expenses.filter((x) => String(x.employeeId) === id).map((x) => x._id), before: { overtimeFils: prev.overtimeFils || 0, loanInstallmentFils: prev.loanInstallmentFils || 0, fineFils: prev.fineFils || 0, expenseReimbursementFils: prev.expenseReimbursementFils || 0 } };
  });
}
r.post('/payroll/inputs/sync/preview', MAKER, ah(async (req, res) => {
  const { establishmentId, period } = z.object({ establishmentId: oid, period: ym }).parse(req.body);
  const est = await Establishment.findById(establishmentId).lean(); if (!est) throw fail(404, 'Establishment not found');
  const run = await PayrollRun.findOne({ establishmentId, period, type: 'regular' }).lean();
  if (run?.locked) throw fail(409, 'This payroll is approved and locked. Use an off-cycle run for corrections.');
  const lines = await buildSync(est, period);
  const doc = await PayrollInputSync.create({ establishmentId, period, lines, status: 'preview' });
  res.json({ syncId: doc._id, lines: lines.map(({ loanItems, expenseIds, ...l }) => ({ ...l, loanItems, expenseCount: expenseIds.length })), note: 'Nothing is written to payroll until you apply this preview. Then recompute the payroll run.' });
}));
r.post('/payroll/inputs/sync/:id/apply', MAKER, ah(async (req, res) => {
  const sync = await PayrollInputSync.findById(req.params.id); if (!sync || sync.status !== 'preview') throw fail(404, 'Preview not found or already applied');
  if (Date.now() - sync.createdAt > 30 * 60 * 1000) throw fail(409, 'This preview is older than 30 minutes; run a fresh preview.');
  const est = await Establishment.findById(sync.establishmentId).lean(); const fresh = await buildSync(est, sync.period);
  for (const l of fresh) {
    await PayrollInput.findOneAndUpdate({ employeeId: l.employeeId, period: sync.period }, { $set: { overtimeFils: l.overtimeFils, loanInstallmentFils: l.loanInstallmentFils, fineFils: l.fineFils, expenseReimbursementFils: l.expenseReimbursementFils } }, { upsert: true, setDefaultsOnInsert: true });
    for (const it of l.loanItems) if (it.amountFils > 0) await Loan.updateOne({ _id: it.loanId, 'schedule.period': it.period }, { $set: { 'schedule.$.status': 'synced', 'schedule.$.note': `Synced to ${sync.period}${it.deferredFils ? `; ${it.deferredFils} fils deferred` : ''}` } });
    if (l.expenseIds.length) await ExpenseClaim.updateMany({ _id: { $in: l.expenseIds } }, { $set: { status: 'queued_for_payroll', payrollPeriod: sync.period } });
  }
  sync.lines = fresh; sync.status = 'applied'; sync.appliedBy = req.user.id; sync.appliedAt = new Date(); await sync.save();
  await audit(req, 'payroll.inputs.sync', 'PayrollInputSync', sync._id, null, { period: sync.period, employees: fresh.length });
  res.json({ applied: fresh.length, message: 'Inputs updated. Recompute the payroll run to include them.' });
}));

// =============================================================== Airfare
r.get('/airfare/policies', PAYROLL, ah(async (req, res) => res.json(await AirfarePolicy.find().lean())));
r.post('/airfare/policies', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ name: z.string().min(2), cycleMonths: z.number().int().min(1).max(48).default(12), travelClass: z.enum(['economy', 'premium', 'business']).default('economy'), includeDependents: z.boolean().default(false), maxDependents: z.number().int().min(0).max(8).default(0), allowEncashment: z.boolean().default(true), fares: z.array(z.object({ iata: z.string().regex(/^[A-Z]{3}$/), city: z.string().optional(), adult: money, child: money.optional() })).min(1) }).parse(req.body);
  const p = await AirfarePolicy.create({ ...b, fares: b.fares.map((f) => ({ iata: f.iata, city: f.city, adultFils: f.adult, childFils: f.child ?? f.adult })) });
  await audit(req, 'airfare.policy.create', 'AirfarePolicy', p._id, null, { name: b.name }); res.status(201).json(p);
}));
r.post('/airfare/accounts', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ employeeId: oid, policyId: oid, homeIata: z.string().regex(/^[A-Z]{3}$/), dependentsCovered: z.number().int().min(0).default(0) }).parse(req.body);
  const [e, p] = await Promise.all([Employee.findById(b.employeeId).lean(), AirfarePolicy.findById(b.policyId).lean()]);
  if (!e || !p) throw fail(404, 'Employee or policy not found');
  monthlyAirfareAccrual({ policy: p, homeIata: b.homeIata, dependentsCovered: b.dependentsCovered });
  const acc = await AirfareAccount.findOneAndUpdate({ employeeId: e._id }, { $set: { policyId: p._id, homeIata: b.homeIata, dependentsCovered: b.dependentsCovered, eligibleFrom: e.joinDate } }, { upsert: true, new: true });
  await audit(req, 'airfare.account.set', 'AirfareAccount', acc._id, null, b); res.json(acc);
}));
r.get('/airfare/accounts', PAYROLL, ah(async (req, res) => res.json(await AirfareAccount.find().populate('employeeId', 'fullName employeeNo').populate('policyId', 'name').lean())));
r.post('/airfare/accrue', MAKER, ah(async (req, res) => {
  const { period } = z.object({ period: ym }).parse(req.body);
  let total = 0, n = 0;
  for (const acc of await AirfareAccount.find()) {
    const [p, e] = await Promise.all([AirfarePolicy.findById(acc.policyId).lean(), Employee.findById(acc.employeeId).select('joinDate status').lean()]);
    if (!p || !e || e.status === 'exited') continue;
    const { entries, addedFils } = accrueAirfare({ account: acc, policy: p, uptoPeriod: period, joinPeriod: new Date(e.joinDate).toISOString().slice(0, 7) });
    if (!entries.length) continue;
    acc.ledger.push(...entries.map((x) => ({ ...x, at: new Date(), by: req.user.id }))); acc.balanceFils += addedFils; acc.lastAccruedPeriod = period; await acc.save(); total += addedFils; n++;
  }
  await audit(req, 'airfare.accrue', 'AirfareAccount', '', null, { period, accounts: n, totalFils: total }); res.json({ accounts: n, totalFils: total });
}));
r.get('/me/airfare', ah(async (req, res) => {
  const acc = await AirfareAccount.findOne({ employeeId: req.user.employeeId }).populate('policyId').lean();
  res.json({ account: acc, requests: await AirfareRequest.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 }).lean() });
}));
r.post('/me/airfare/requests', ah(async (req, res) => {
  const b = z.object({ kind: z.enum(['encash', 'booking']), amount: money.optional(), travelDate: ymd.optional(), returnDate: ymd.optional(), travellers: z.number().int().min(1).max(9).default(1), notes: z.string().max(300).optional() }).parse(req.body);
  const acc = await AirfareAccount.findOne({ employeeId: req.user.employeeId }).populate('policyId').lean();
  if (!acc) throw fail(400, 'You have no airfare entitlement set up. Ask HR.');
  if (b.kind === 'encash' && !acc.policyId?.allowEncashment) throw fail(400, 'Your airfare policy does not allow cash encashment.');
  const amt = b.amount ?? acc.balanceFils; if (amt <= 0 || amt > acc.balanceFils) throw fail(400, `You can request up to AED ${(acc.balanceFils / 100).toFixed(2)}.`);
  const rq = await AirfareRequest.create({ employeeId: req.user.employeeId, kind: b.kind, amountFils: amt, travelDate: b.travelDate, returnDate: b.returnDate, travellers: b.travellers, notes: b.notes });
  await audit(req, 'airfare.request', 'AirfareRequest', rq._id, null, { kind: b.kind, amountFils: amt }); res.status(201).json(rq);
}));
r.get('/airfare/requests', PAYROLL, ah(async (req, res) => res.json(await AirfareRequest.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).populate('employeeId', 'fullName employeeNo establishmentId').lean())));
r.post('/airfare/requests/:id/decision', requireRole('hr_admin'), ah(async (req, res) => {
  const { decision, period } = z.object({ decision: z.enum(['approved', 'rejected']), period: ym.optional() }).parse(req.body);
  const rq = await AirfareRequest.findById(req.params.id); if (!rq || rq.status !== 'pending') throw fail(404, 'Pending request not found');
  const acc = await AirfareAccount.findOne({ employeeId: rq.employeeId }); const e = await Employee.findById(rq.employeeId).lean();
  rq.status = decision; rq.decidedBy = req.user.id; rq.decidedAt = new Date();
  if (decision === 'approved') {
    if (rq.amountFils > acc.balanceFils) throw fail(409, 'Balance is no longer sufficient.');
    acc.ledger.push({ at: new Date(), kind: rq.kind === 'encash' ? 'encashment' : 'booking', amountFils: -rq.amountFils, refId: String(rq._id), by: req.user.id, note: rq.kind }); acc.balanceFils -= rq.amountFils; await acc.save();
    if (rq.kind === 'encash') { // pay through an off-cycle run (draft → existing maker-checker approval)
      const p = period || new Date().toISOString().slice(0, 7);
      const last = await PayrollRun.findOne({ establishmentId: e.establishmentId, period: p, type: 'offcycle' }).sort({ runNo: -1 }).lean();
      const line = { employeeId: e._id, employeeName: e.fullName, fixedFils: 0, variableFils: rq.amountFils, grossFils: rq.amountFils, deductionsFils: 0, netFils: rq.amountFils, unpaidLeaveDays: 0, flags: [{ code: 'OFFCYCLE', severity: 'info', msg: 'Airfare encashment' }], held: false };
      const run = await PayrollRun.create({ establishmentId: e.establishmentId, period: p, type: 'offcycle', runNo: (last?.runNo || 0) + 1, title: `Airfare encashment · ${e.fullName}`, lines: [line], totals: { grossFils: rq.amountFils, netFils: rq.amountFils, heldFils: 0 }, rulePack: 'n/a', makerId: req.user.id, status: 'draft' });
      rq.offcycleRunId = run._id;
    }
  }
  await rq.save(); await audit(req, `airfare.request.${decision}`, 'AirfareRequest', rq._id, null, { amountFils: rq.amountFils, offcycleRunId: rq.offcycleRunId });
  res.json(rq);
}));

// =============================================================== Accounting journal export
r.get('/accounting/mapping', PAYROLL, ah(async (req, res) => res.json((await AccountMapping.findOne({ establishmentId: null }).lean()) || new AccountMapping({}).toObject())));
r.put('/accounting/mapping', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ accounts: z.record(z.string().max(40)), costCentreBy: z.enum(['none', 'department', 'establishment']).optional() }).parse(req.body);
  const m = await AccountMapping.findOneAndUpdate({ establishmentId: null }, { $set: { ...Object.fromEntries(Object.entries(b.accounts).map(([k, v]) => [`accounts.${k}`, v])), ...(b.costCentreBy ? { costCentreBy: b.costCentreBy } : {}) } }, { upsert: true, new: true });
  await audit(req, 'accounting.mapping.update', 'AccountMapping', m._id, null, b); res.json(m);
}));
r.get('/payroll/runs/:id/journal', PAYROLL, ah(async (req, res) => {
  const { format = 'erp', preview } = req.query;
  const run = await PayrollRun.findById(req.params.id).lean(); if (!run) throw fail(404, 'Payroll run not found');
  if (!['approved', 'exported', 'paid'].includes(run.status) && !preview) throw fail(409, 'Journals are exported after the payroll is approved. Add ?preview=1 to preview.');
  const mapping = (await AccountMapping.findOne({ establishmentId: run.establishmentId }).lean()) || (await AccountMapping.findOne({ establishmentId: null }).lean()) || new AccountMapping({}).toObject();
  const employees = await Employee.find({ _id: { $in: run.lines.map((l) => l.employeeId) } }).select('department compensation').lean();
  const inputs = await PayrollInput.find({ period: run.period, employeeId: { $in: run.lines.map((l) => l.employeeId) } }).lean();
  const j = buildJournal({ run, employees, mapping, inputsByEmployee: run.type === 'regular' ? Object.fromEntries(inputs.map((i) => [String(i.employeeId), i])) : {} });
  if (!j.balanced) throw fail(500, `Journal does not balance (debits ${j.debitFils}, credits ${j.creditFils}).`);
  const [y, m] = run.period.split('-').map(Number); const date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const ref = `PR-${run.period}${run.type !== 'regular' ? `-${run.type}${run.runNo}` : ''}`;
  if (req.query.json) return res.json({ ...j, reference: ref, date });
  const f = journalFile(j, { format, date, reference: ref, narration: `Payroll ${run.period} ${run.title || ''}`.trim() });
  await audit(req, 'accounting.journal.export', 'PayrollRun', run._id, null, { format, lines: j.lines.length, debitFils: j.debitFils });
  sendCsv(res, f.body, f.filename);
}));

// =============================================================== Bank rejections & reconciliation
r.post('/payroll/runs/:id/rejections/import', MAKER, ah(async (req, res) => {
  const { csv, commit } = z.object({ csv: z.string().min(5).max(2_000_000), commit: z.boolean().default(false) }).parse(req.body);
  const run = await PayrollRun.findById(req.params.id).lean(); if (!run) throw fail(404, 'Payroll run not found');
  const emps = await Employee.find({ _id: { $in: run.lines.map((l) => l.employeeId) } }).select('+bank.iban +labourCardNo fullName').lean();
  const rows = matchRejections(parseRejectionCsv(csv), run.lines, emps, toFils);
  if (!commit) return res.json({ preview: true, rows });
  const batch = new Date().toISOString(); const created = [];
  for (const x of rows.filter((y) => y.matched)) {
    const e = emps.find((y) => String(y._id) === String(x.employeeId));
    created.push(await BankRejection.create({ payrollRunId: run._id, employeeId: x.employeeId, employeeName: x.employeeName, ibanLast4: e.bank?.iban?.slice(-4), labourCardLast4: e.labourCardNo?.slice(-4), amountFils: x.amountFils, reasonCode: x.reasonCode, reason: x.reason, importBatch: batch }));
  }
  await audit(req, 'payroll.rejections.import', 'PayrollRun', run._id, null, { imported: created.length, unmatched: rows.length - created.length });
  await emitEvent('payroll.rejections.imported', { payrollRunId: String(run._id), count: created.length });
  res.json({ imported: created.length, unmatched: rows.filter((y) => !y.matched) });
}));
r.get('/payroll/rejections', PAYROLL, ah(async (req, res) => res.json(await BankRejection.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }).limit(500).lean())));
r.post('/payroll/rejections/:id/resolve', MAKER, ah(async (req, res) => {
  const b = z.object({ status: z.enum(['corrected', 'repaid', 'written_off']), resolution: z.string().min(3).max(300) }).parse(req.body);
  const x = await BankRejection.findById(req.params.id); if (!x) throw fail(404, 'Rejection not found');
  const before = x.status; Object.assign(x, b, { resolvedBy: req.user.id, resolvedAt: new Date() }); await x.save();
  await audit(req, 'payroll.rejection.resolve', 'BankRejection', x._id, { status: before }, b); res.json(x);
}));
r.get('/payroll/runs/:id/reconciliation', PAYROLL, ah(async (req, res) => {
  const run = await PayrollRun.findById(req.params.id).lean(); if (!run) throw fail(404, 'Payroll run not found');
  const sif = await WpsSifBatch.findOne({ payrollRunId: run._id }).sort({ createdAt: -1 }).select('totalFils recordCount filename status').lean();
  const rej = await BankRejection.find({ payrollRunId: run._id }).lean();
  res.json({ ...reconcileRun({ run, sif, rejections: rej }), rejections: rej, sif });
}));
r.get('/payroll/runs/:id/compare', PAYROLL, ah(async (req, res) => {
  const run = await PayrollRun.findById(req.params.id).lean(); if (!run) throw fail(404, 'Payroll run not found');
  const prev = await PayrollRun.findOne({ establishmentId: run.establishmentId, type: 'regular', period: addMonths(run.period, -1) }).lean();
  const pol = await policy();
  res.json({ period: run.period, prevPeriod: prev?.period || null, ...comparePeriods(run.lines, prev?.lines || [], Number(req.query.threshold) || pol.varianceThresholdPct) });
}));

// =============================================================== Payroll policy & FX
r.get('/payroll/policy', PAYROLL, ah(async (req, res) => res.json(await policy())));
r.patch('/payroll/policy', requireRole('hr_admin'), ah(async (req, res) => {
  const b = z.object({ varianceThresholdPct: z.number().min(1).max(100).optional(), reportingCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(6).optional(), conversionDatePolicy: z.enum(['period_end', 'payment_date', 'fixed']).optional(), overtimeRequiresApproval: z.boolean().optional(), restDays: z.array(z.number().int().min(0).max(6)).max(3).optional(), standardHoursPerDay: z.number().min(4).max(12).optional(), expenseCutoffDay: z.number().int().min(1).max(28).optional() }).parse(req.body);
  const before = await policy(); const p = await PayrollPolicy.findOneAndUpdate({}, { $set: b }, { upsert: true, new: true });
  await audit(req, 'payroll.policy.update', 'PayrollPolicy', p._id, before, b); res.json(p);
}));
r.get('/fx', PAYROLL, ah(async (req, res) => res.json(await FxRate.find().sort({ date: -1 }).limit(200).lean())));
r.post('/fx', requireRole('hr_admin', 'payroll_maker'), ah(async (req, res) => {
  const b = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), date: ymd, aedPerUnit: z.string().regex(/^\d+(\.\d{1,8})?$/), source: z.string().max(80).optional() }).parse(req.body);
  if (b.currency === 'AED') throw fail(400, 'AED is the base currency.');
  const x = await FxRate.findOneAndUpdate({ currency: b.currency, date: b.date }, { $set: b }, { upsert: true, new: true });
  await audit(req, 'fx.rate.set', 'FxRate', x._id, null, b); res.json(x);
}));
r.get('/payroll/runs/:id/fx', PAYROLL, ah(async (req, res) => {
  const run = await PayrollRun.findById(req.params.id).lean(); if (!run) throw fail(404, 'Payroll run not found');
  const pol = await policy(); const { end } = periodBounds(run.period);
  const asOf = pol.conversionDatePolicy === 'payment_date' && run.approvedAt ? run.approvedAt.toISOString().slice(0, 10) : end;
  const out = [];
  for (const cur of pol.reportingCurrencies.filter((c) => c !== 'AED')) {
    const rate = await FxRate.findOne({ currency: cur, date: { $lte: asOf } }).sort({ date: -1 }).lean();
    out.push(rate ? { currency: cur, rateDate: rate.date, aedPerUnit: rate.aedPerUnit, gross: convertFromAed(run.totals.grossFils, rate.aedPerUnit), net: convertFromAed(run.totals.netFils, rate.aedPerUnit) } : { currency: cur, missing: true });
  }
  res.json({ base: 'AED', asOf, policy: pol.conversionDatePolicy, totals: run.totals, conversions: out, note: 'Converted amounts are in minor units (cents). Reporting only; WPS is always paid in AED.' });
}));

// =============================================================== Real PDF payslips
async function payslipBuffer(req, runId, employeeId, selfService) {
  const run = await PayrollRun.findById(runId).lean(); if (!run) throw fail(404, 'Payroll run not found');
  if (selfService && !['approved', 'exported', 'paid'].includes(run.status)) throw fail(404, 'Payslip not released yet.');
  const line = run.lines.find((l) => String(l.employeeId) === String(employeeId)); if (!line) throw fail(404, 'Employee not in this run');
  const e = await Employee.findById(employeeId).lean(); const est = await Establishment.findById(run.establishmentId).lean();
  const ytdRuns = await PayrollRun.find({ establishmentId: run.establishmentId, period: { $gte: `${run.period.slice(0, 4)}-01`, $lte: run.period }, status: { $in: ['approved', 'exported', 'paid'] }, 'lines.employeeId': e._id }).lean();
  const ytd = ytdRuns.reduce((a, x) => { const l = x.lines.find((y) => String(y.employeeId) === String(e._id)); return { grossFils: a.grossFils + (l?.grossFils || 0), netFils: a.netFils + (l?.netFils || 0) }; }, { grossFils: 0, netFils: 0 });
  const buf = await sealedPdf(req, { kind: 'payslip', title: `Payslip ${run.period}`, employeeId: e._id }, (s) => payslipPdf({ employee: e, establishment: est, run, line, ytd, seal: s }));
  return { buf, name: `payslip-${e.employeeNo}-${run.period}.pdf` };
}
r.get('/payroll/runs/:id/payslips/:employeeId/pdf', PAYROLL, ah(async (req, res) => { const { buf, name } = await payslipBuffer(req, req.params.id, req.params.employeeId, false); sendPdf(res, buf, name); }));
r.get('/me/payslips/:runId/pdf', ah(async (req, res) => { const { buf, name } = await payslipBuffer(req, req.params.runId, req.user.employeeId, true); sendPdf(res, buf, name, false); }));

export default r;
