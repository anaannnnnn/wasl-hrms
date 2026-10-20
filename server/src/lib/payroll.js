// Deterministic payroll line calculation (fils). AI never changes these numbers.
import { getRulePack } from './rules.js';

export function calculateLine(emp, inputs = {}, { jurisdiction = 'UAE-MAINLAND', periodDays = 30, onDate } = {}) {
  const pack = getRulePack(jurisdiction, onDate);
  const c = emp.compensation;
  const allowances = (c.allowances || []).reduce((a, x) => a + x.amountFils, 0);
  const fixed = c.basicFils + c.housingFils + c.transportFils + allowances;

  const variable = (inputs.overtimeFils || 0) + (inputs.commissionFils || 0) + (inputs.expenseReimbursementFils || 0);
  const unpaidDays = inputs.unpaidLeaveDays || 0;
  const unpaidDeduction = Math.round((fixed / periodDays) * unpaidDays);
  const otherDeductions = (inputs.loanInstallmentFils || 0) + (inputs.fineFils || 0);

  const gross = fixed + variable;
  const deductions = unpaidDeduction + otherDeductions;
  const maxDeductionPct = pack.deductions.maxPercentOfWage;
  const discretionaryPct = gross ? (otherDeductions / gross) * 100 : 0;

  const flags = [];
  if (discretionaryPct > maxDeductionPct) flags.push({ code: 'DEDUCTION_CAP', severity: 'block', msg: `Deductions ${discretionaryPct.toFixed(1)}% exceed ${maxDeductionPct}% cap` });

  return {
    employeeId: emp._id,
    fixedFils: fixed - unpaidDeduction, // WPS "fixed salary" after unpaid leave
    variableFils: variable,
    grossFils: gross,
    deductionsFils: deductions,
    netFils: gross - deductions,
    unpaidLeaveDays: unpaidDays,
    flags,
    rulePack: `${pack.id}@${pack.version}`,
  };
}

// Month-over-month anomaly detection (rule based; explainable)
export function detectAnomalies(line, prevLine, emp, pack) {
  const out = [];
  if (prevLine && prevLine.variableFils > 0) {
    const pct = ((line.variableFils - prevLine.variableFils) / prevLine.variableFils) * 100;
    if (pct > 50) out.push({ code: 'VARIABLE_SPIKE', severity: 'warn', msg: `Variable pay +${pct.toFixed(0)}% vs last month` });
  } else if (!prevLine && line.variableFils > line.fixedFils * 0.15) {
    out.push({ code: 'VARIABLE_HIGH', severity: 'warn', msg: 'Variable pay above 15% of fixed with no prior month to compare' });
  }
  if (prevLine) {
    const pct = ((line.netFils - prevLine.netFils) / Math.max(prevLine.netFils, 1)) * 100;
    if (Math.abs(pct) > 25) out.push({ code: 'NET_VARIANCE', severity: 'warn', msg: `Net pay ${pct > 0 ? '+' : ''}${pct.toFixed(0)}% vs last month` });
  }
  const e = pack?.emiratisation;
  if (e && emp.isUaeNational && line.grossFils < e.minQualifyingWageFils) {
    out.push({ code: 'EMIRATI_BELOW_MIN', severity: 'warn', msg: 'UAE national below quota wage threshold this month' });
  }
  if (line.unpaidLeaveDays > 0) out.push({ code: 'UNPAID_LEAVE', severity: 'info', msg: `${line.unpaidLeaveDays} unpaid leave day(s) deducted` });
  return out;
}
