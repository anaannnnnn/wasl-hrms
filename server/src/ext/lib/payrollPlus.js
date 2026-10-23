// Pure payroll engines added after the MVP: overtime pay from attendance, loan schedules, airfare accrual,
// accounting journals, bank-rejection matching, variance checks and FX reporting. All money is integer fils.
import { getRulePack } from '../../lib/rules.js';
import { filsToPlain } from '../../lib/money.js';

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- Overtime
/** Minutes of [startMin, endMin) (minutes from local midnight, end may exceed 1440) that fall in the night window. */
export function nightMinutes(startMin, endMin, nightStart = '22:00', nightEnd = '04:00') {
  const ns = hm(nightStart), ne = hm(nightEnd);
  let total = 0;
  for (let day = -1; day <= 1; day++) {
    const base = day * 1440;
    const windows = ns > ne ? [[base + ns, base + 1440 + ne]] : [[base + ns, base + ne]];
    for (const [a, b] of windows) total += Math.max(0, Math.min(endMin, b) - Math.max(startMin, a));
  }
  return total;
}

/**
 * Classify overtime for one day of attendance.
 * normal OT at 125%, premium (night 22:00-04:00, rest day, public holiday) at 150%.
 * The overtime is assumed to be the LAST minutes worked (after the standard day), which is the usual case.
 */
export function classifyDayOvertime({ date, clockInLocalMin, clockOutLocalMin, overtimeMinutes, restDay = false, holiday = false, pack }) {
  const ot = Math.max(0, Math.round(overtimeMinutes || 0));
  if (!ot) return { date, normal: 0, premium: 0, reason: null };
  if (restDay || holiday) return { date, normal: 0, premium: ot, reason: holiday ? 'public_holiday' : 'rest_day' };
  let end = clockOutLocalMin; if (end <= clockInLocalMin) end += 1440;
  const start = end - ot;
  const night = nightMinutes(start, end, pack.overtime.nightStart, pack.overtime.nightEnd);
  return { date, normal: ot - night, premium: night, reason: night ? 'night' : 'normal' };
}

/** Hourly basic wage in fils: basic / 30 days / standard hours per day (8 by default; 6 during Ramadan is handled by attendance). */
export const hourlyBasicFils = (basicMonthlyFils, hoursPerDay = 8) => basicMonthlyFils / 30 / hoursPerDay;

export function overtimePay({ basicMonthlyFils, days, rulePackId = 'UAE-MAINLAND', onDate, hoursPerDay = 8 }) {
  const pack = getRulePack(rulePackId, onDate);
  const rows = days.map((d) => classifyDayOvertime({ ...d, pack }));
  const normalMin = rows.reduce((a, r) => a + r.normal, 0);
  const premiumMin = rows.reduce((a, r) => a + r.premium, 0);
  const hourly = hourlyBasicFils(basicMonthlyFils, hoursPerDay);
  const normalFils = Math.round((hourly * pack.overtime.normal * normalMin) / 60);
  const premiumFils = Math.round((hourly * pack.overtime.nightOrRestDay * premiumMin) / 60);
  return {
    totalFils: normalFils + premiumFils, normalMinutes: normalMin, premiumMinutes: premiumMin, normalFils, premiumFils,
    trace: { rulePack: `${pack.id}@${pack.version}`, hourlyBasicFils: Math.round(hourly * 100) / 100, rates: { normal: pack.overtime.normal, premium: pack.overtime.nightOrRestDay }, days: rows.filter((r) => r.normal || r.premium) },
  };
}

// ---------------------------------------------------------------- Loans, advances, fines
export const addMonths = (p, n) => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };

/** Equal instalments; the final instalment absorbs the remainder so the schedule sums exactly to the principal. */
export function buildSchedule({ principalFils, installmentFils, startPeriod }) {
  if (!Number.isInteger(principalFils) || principalFils <= 0) throw new Error('Principal must be a positive amount.');
  if (!Number.isInteger(installmentFils) || installmentFils <= 0) throw new Error('Instalment must be a positive amount.');
  const out = []; let left = principalFils; let i = 0;
  while (left > 0) { const amt = Math.min(installmentFils, left); out.push({ period: addMonths(startPeriod, i++), amountFils: amt, status: 'due' }); left -= amt; if (i > 240) throw new Error('Schedule longer than 20 years; increase the instalment.'); }
  return out;
}

export const outstandingFils = (loan) => (loan.schedule || []).filter((s) => ['due', 'synced', 'deferred'].includes(s.status)).reduce((a, s) => a + s.amountFils, 0);

/**
 * Deductions for a period across all loans, respecting the deduction cap (default 50% of total wage across all deductions).
 * Fines are taken first only up to 5 days' basic wage per month (UAE practice; confirm), then loans/advances in creation order.
 * Anything that does not fit is deferred to the next period.
 */
export function periodDeductions({ loans, period, grossFils, otherDeductionsFils = 0, basicMonthlyFils = 0, capPct = 50 }) {
  let room = Math.max(0, Math.floor((grossFils * capPct) / 100) - otherDeductionsFils);
  const finesCap = Math.round((basicMonthlyFils / 30) * 5);
  const items = []; let fines = 0, loansTotal = 0;
  const due = loans.filter((l) => l.status === 'active').flatMap((l) => l.schedule.filter((s) => s.period <= period && ['due', 'deferred', 'synced'].includes(s.status)).map((s) => ({ loan: l, s })));
  due.sort((a, b) => (a.loan.kind === 'fine' ? -1 : 0) - (b.loan.kind === 'fine' ? -1 : 0) || String(a.s.period).localeCompare(b.s.period));
  for (const { loan, s } of due) {
    let take = Math.min(s.amountFils, room);
    if (loan.kind === 'fine') take = Math.min(take, Math.max(0, finesCap - fines));
    if (take <= 0) { items.push({ loanId: String(loan._id), period: s.period, amountFils: 0, deferredFils: s.amountFils, kind: loan.kind }); continue; }
    room -= take; if (loan.kind === 'fine') fines += take; else loansTotal += take;
    items.push({ loanId: String(loan._id), period: s.period, amountFils: take, deferredFils: s.amountFils - take, kind: loan.kind });
  }
  return { loanInstallmentFils: loansTotal, fineFils: fines, items, capFils: Math.floor((grossFils * capPct) / 100) };
}

// ---------------------------------------------------------------- Airfare accrual
/** Monthly accrual = (adult fare + covered dependents x child/adult fare) / cycleMonths. */
export function monthlyAirfareAccrual({ policy, homeIata, dependentsCovered = 0 }) {
  const fare = (policy.fares || []).find((f) => f.iata === homeIata);
  if (!fare) throw new Error(`No reference fare for ${homeIata}. Add it to the airfare policy.`);
  const deps = Math.min(dependentsCovered, policy.includeDependents ? policy.maxDependents : 0);
  const annual = fare.adultFils + deps * (fare.childFils || fare.adultFils);
  return { monthlyFils: Math.round(annual / (policy.cycleMonths || 12)), ticketValueFils: annual, fare };
}

export function accrueAirfare({ account, policy, uptoPeriod, joinPeriod }) {
  const { monthlyFils } = monthlyAirfareAccrual({ policy, homeIata: account.homeIata, dependentsCovered: account.dependentsCovered });
  const entries = []; let p = account.lastAccruedPeriod ? addMonths(account.lastAccruedPeriod, 1) : joinPeriod;
  while (p <= uptoPeriod) { entries.push({ period: p, kind: 'accrual', amountFils: monthlyFils, note: `Accrual ${account.homeIata}` }); p = addMonths(p, 1); if (entries.length > 600) break; }
  return { entries, addedFils: entries.reduce((a, e) => a + e.amountFils, 0) };
}

// ---------------------------------------------------------------- Accounting journals
/** Build a balanced journal (debits = credits, to the fils) from payroll run lines + employee compensation. */
export function buildJournal({ run, employees, mapping, inputsByEmployee = {} }) {
  const A = mapping.accounts; const by = mapping.costCentreBy || 'none';
  const lines = [];
  const add = (account, debit, credit, memo, cc) => { if (debit || credit) lines.push({ account, debitFils: debit, creditFils: credit, memo, costCentre: cc || '' }); };
  for (const l of run.lines || []) {
    if (l.held) continue;
    const e = employees.find((x) => String(x._id) === String(l.employeeId)) || {};
    const cc = by === 'department' ? (e.department || 'General') : by === 'establishment' ? String(run.establishmentId) : '';
    const inp = inputsByEmployee[String(l.employeeId)] || {};
    const c = e.compensation || {};
    const fixedParts = run.type === 'regular' ? [[A.salaryExpense, c.basicFils || 0, 'Basic'], [A.housingExpense, c.housingFils || 0, 'Housing'], [A.transportExpense, c.transportFils || 0, 'Transport'], [A.otherAllowanceExpense, (c.allowances || []).reduce((a, x) => a + (x.amountFils || 0), 0), 'Allowances']] : [];
    // scale fixed parts to the actual fixed amount paid (unpaid leave, part month) keeping the total exact
    const fixedSum = fixedParts.reduce((a, x) => a + x[1], 0); let allocated = 0;
    fixedParts.forEach(([acc, amt, memo], i) => {
      const v = i === fixedParts.length - 1 ? (l.fixedFils || 0) - allocated : Math.round(fixedSum ? (amt * (l.fixedFils || 0)) / fixedSum : 0);
      allocated += v; add(acc, v, 0, `${memo} · ${l.employeeName}`, cc);
    });
    const ot = Math.min(inp.overtimeFils || 0, l.variableFils || 0); const reimb = Math.min(inp.expenseReimbursementFils || 0, (l.variableFils || 0) - ot);
    add(A.overtimeExpense, ot, 0, `Overtime · ${l.employeeName}`, cc);
    add(A.reimbursementExpense, reimb, 0, `Reimbursements · ${l.employeeName}`, cc);
    add(run.type === 'final' ? A.gratuityProvision : A.otherAllowanceExpense, (l.variableFils || 0) - ot - reimb, 0, `${run.type === 'regular' ? 'Variable pay' : run.title || run.type} · ${l.employeeName}`, cc);
    if (run.type !== 'regular') add(A.salaryExpense, (l.fixedFils || 0), 0, `Fixed · ${l.employeeName}`, cc);
    const fines = Math.min(inp.fineFils || 0, l.deductionsFils || 0); const loan = Math.min(inp.loanInstallmentFils || 0, (l.deductionsFils || 0) - fines);
    add(A.finesIncome, 0, fines, `Fines · ${l.employeeName}`, cc);
    add(A.loanReceivable, 0, loan, `Loan recovery · ${l.employeeName}`, cc);
    // fixedFils is already net of unpaid-leave deduction, so the payable is what was expensed minus recoveries (= net pay)
    add(A.salariesPayable, 0, (l.fixedFils || 0) + (l.variableFils || 0) - fines - loan, `Net pay · ${l.employeeName}`, cc);
  }
  const debit = lines.reduce((a, x) => a + x.debitFils, 0), credit = lines.reduce((a, x) => a + x.creditFils, 0);
  return { lines, debitFils: debit, creditFils: credit, balanced: debit === credit };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** Format a journal for import into an accounting system. */
export function journalFile(journal, { format, date, reference, narration }) {
  const L = journal.lines;
  switch (format) {
    case 'xero': // Xero "Manual Journal" CSV import
      return { filename: `xero-journal-${reference}.csv`, contentType: 'text/csv', body: toCsv(['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1'], L.map((x) => [narration, date, x.memo, x.account, 'No VAT', filsToPlain(x.debitFils - x.creditFils), x.costCentre ? 'Department' : '', x.costCentre])) };
    case 'zoho': // Zoho Books journal import
      return { filename: `zoho-journal-${reference}.csv`, contentType: 'text/csv', body: toCsv(['Journal Date', 'Reference Number', 'Journal Notes', 'Account', 'Description', 'Debit', 'Credit', 'Reporting Tag'], L.map((x) => [date, reference, narration, x.account, x.memo, x.debitFils ? filsToPlain(x.debitFils) : '', x.creditFils ? filsToPlain(x.creditFils) : '', x.costCentre])) };
    case 'quickbooks': // QuickBooks Online journal entry import
      return { filename: `qbo-journal-${reference}.csv`, contentType: 'text/csv', body: toCsv(['JournalNo', 'JournalDate', 'AccountName', 'Debits', 'Credits', 'Description', 'Name', 'Class'], L.map((x) => [reference, date, x.account, x.debitFils ? filsToPlain(x.debitFils) : '', x.creditFils ? filsToPlain(x.creditFils) : '', x.memo, '', x.costCentre])) };
    default: // generic ERP (SAP/Oracle/Odoo friendly)
      return { filename: `journal-${reference}.csv`, contentType: 'text/csv', body: toCsv(['posting_date', 'reference', 'account', 'cost_centre', 'debit', 'credit', 'currency', 'memo'], L.map((x) => [date, reference, x.account, x.costCentre, filsToPlain(x.debitFils), filsToPlain(x.creditFils), 'AED', x.memo])) };
  }
}

// ---------------------------------------------------------------- Bank rejections & reconciliation
/**
 * Parse a bank/agent rejection file (CSV). Accepts columns (any order, case-insensitive):
 * labour_card | employee_id | iban, amount, reason_code, reason.
 */
export function parseRejectionCsv(text) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) throw new Error('The file has no rejection rows.');
  const split = (r) => r.match(/("([^"]|"")*"|[^,]*)(,|$)/g).filter((x) => x !== '').map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(rows[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, '_'));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = { lc: col('labour_card', 'labour_card_no', 'labor_card', 'employee_id', 'person_id'), iban: col('iban', 'account'), amt: col('amount', 'net_salary', 'salary'), code: col('reason_code', 'code', 'return_code'), reason: col('reason', 'description', 'remarks') };
  if (ix.amt < 0 || (ix.lc < 0 && ix.iban < 0)) throw new Error('The file needs an amount column and a labour card or IBAN column.');
  return rows.slice(1).map((r, i) => { const c = split(r); return { row: i + 2, labourCard: ix.lc >= 0 ? c[ix.lc]?.replace(/\D/g, '') : '', iban: ix.iban >= 0 ? c[ix.iban]?.replace(/\s/g, '').toUpperCase() : '', amount: c[ix.amt], reasonCode: ix.code >= 0 ? c[ix.code] : '', reason: ix.reason >= 0 ? c[ix.reason] : '' }; });
}

export function matchRejections(rows, runLines, employees, toFils) {
  return rows.map((r) => {
    const e = employees.find((x) => (r.labourCard && x.labourCardNo === r.labourCard) || (r.iban && x.bank?.iban === r.iban));
    const line = e && runLines.find((l) => String(l.employeeId) === String(e._id));
    let amountFils = null; try { amountFils = toFils(r.amount); } catch { /* reported below */ }
    const problems = [];
    if (!e) problems.push('No employee matches this labour card / IBAN.');
    else if (!line) problems.push('Employee is not in this payroll run.');
    if (amountFils == null) problems.push(`Amount "${r.amount}" is not a valid AED amount.`);
    else if (line && amountFils !== line.netFils) problems.push(`Amount ${filsToPlain(amountFils)} differs from paid net ${filsToPlain(line.netFils)}.`);
    return { ...r, employeeId: e?._id, employeeName: e?.fullName, amountFils, matched: !!(e && line), problems };
  });
}

export function reconcileRun({ run, sif, rejections = [] }) {
  const paidLines = (run.lines || []).filter((l) => !l.held);
  const runNet = paidLines.reduce((a, l) => a + l.netFils, 0);
  const rejected = rejections.reduce((a, r) => a + (r.amountFils || 0), 0);
  const repaid = rejections.filter((r) => r.status === 'repaid').reduce((a, r) => a + (r.amountFils || 0), 0);
  const checks = [
    { id: 'run_vs_sif', label: 'Payroll net equals SIF total', ok: !sif || sif.totalFils === runNet, detail: sif ? `${filsToPlain(runNet)} vs ${filsToPlain(sif.totalFils)}` : 'No SIF generated yet' },
    { id: 'records', label: 'SIF record count equals paid employees', ok: !sif || sif.recordCount === paidLines.length, detail: sif ? `${paidLines.length} vs ${sif.recordCount}` : '' },
    { id: 'held', label: 'Held lines resolved', ok: !(run.lines || []).some((l) => l.held), detail: `${(run.lines || []).filter((l) => l.held).length} held` },
    { id: 'rejections', label: 'Bank rejections resolved', ok: rejections.every((r) => r.status !== 'open'), detail: `${rejections.filter((r) => r.status === 'open').length} open` },
  ];
  return { runNetFils: runNet, sifTotalFils: sif?.totalFils ?? null, rejectedFils: rejected, repaidFils: repaid, settledFils: runNet - rejected + repaid, checks, balanced: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------- Variance & prior-period comparison
export function comparePeriods(curLines, prevLines, thresholdPct = 15) {
  const prev = new Map(prevLines.map((l) => [String(l.employeeId), l]));
  const rows = curLines.map((l) => {
    const p = prev.get(String(l.employeeId));
    const delta = p ? l.netFils - p.netFils : null;
    const pct = p && p.netFils ? Math.round((delta / p.netFils) * 1000) / 10 : null;
    return { employeeId: l.employeeId, employeeName: l.employeeName, netFils: l.netFils, prevNetFils: p?.netFils ?? null, deltaFils: delta, deltaPct: pct, status: !p ? 'new' : Math.abs(pct) > thresholdPct ? 'over_threshold' : 'ok' };
  });
  const leavers = prevLines.filter((p) => !curLines.some((l) => String(l.employeeId) === String(p.employeeId))).map((p) => ({ employeeId: p.employeeId, employeeName: p.employeeName, netFils: 0, prevNetFils: p.netFils, deltaFils: -p.netFils, deltaPct: -100, status: 'left' }));
  const sum = (a, k) => a.reduce((x, r) => x + (r[k] || 0), 0);
  const totCur = sum(curLines, 'netFils'), totPrev = sum(prevLines, 'netFils');
  return { thresholdPct, rows: [...rows, ...leavers], totals: { netFils: totCur, prevNetFils: totPrev, deltaFils: totCur - totPrev, deltaPct: totPrev ? Math.round(((totCur - totPrev) / totPrev) * 1000) / 10 : null }, flagged: [...rows, ...leavers].filter((r) => r.status !== 'ok').length };
}

// ---------------------------------------------------------------- Multi-currency reporting (decimal-safe)
/** Convert fils (AED) to minor units of another currency using a decimal-string rate (AED per unit). Uses BigInt, no floats. */
export function convertFromAed(fils, aedPerUnit) {
  const [i, d = ''] = String(aedPerUnit).split('.');
  const scale = 10n ** BigInt(d.length);
  const rate = BigInt(i) * scale + BigInt(d || '0'); // AED per unit × scale
  // minor units of target (×100) = fils × scale / rate, rounded half up
  const num = BigInt(fils) * scale; const q = num / rate; const r = num % rate;
  return Number(r * 2n >= rate ? q + 1n : q);
}
