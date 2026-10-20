// Final settlement: pro-rata salary for days worked in the last month, unused annual leave encashment,
// end-of-service gratuity (or DEWS), notice pay in lieu, minus outstanding loans. All amounts in fils.
import { calculateGratuity } from './eosb.js';
import { getRulePack } from './rules.js';
import { filsToPlain } from './money.js';

export function finalSettlement({ employee, lastWorkingDate, unusedLeaveDays = 0, unpaidLeaveDays = 0, noticePayDays = 0, outstandingLoanFils = 0, otherDeductionsFils = 0, otherEarningsFils = 0, jurisdiction = 'UAE-MAINLAND', scheme, capBasis }) {
  const pack = getRulePack(jurisdiction, lastWorkingDate);
  const c = employee.compensation;
  const allowances = (c.allowances || []).reduce((a, x) => a + x.amountFils, 0);
  const totalMonthly = c.basicFils + c.housingFils + c.transportFils + allowances;
  const end = new Date(lastWorkingDate);
  const daysInMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  const daysWorked = end.getUTCDate();
  const trace = [`Rule pack ${pack.id} v${pack.version}`];

  const proRata = Math.round((totalMonthly * daysWorked) / daysInMonth);
  trace.push(`Salary for ${daysWorked}/${daysInMonth} days = ${filsToPlain(proRata)}`);

  const enc = pack.leaveEncashment || { basis: 'basic', divisor: 30 };
  const encDaily = Math.round((enc.basis === 'basic' ? c.basicFils : totalMonthly) / enc.divisor);
  const leavePay = Math.round(encDaily * Math.max(0, unusedLeaveDays));
  trace.push(`Leave encashment ${unusedLeaveDays} days × ${filsToPlain(encDaily)} (${enc.basis} ÷ ${enc.divisor}) = ${filsToPlain(leavePay)}`);

  const noticePay = Math.round((totalMonthly / 30) * noticePayDays);
  if (noticePayDays) trace.push(`Notice pay in lieu ${noticePayDays} days = ${filsToPlain(noticePay)}`);

  const g = calculateGratuity({ basicMonthlyFils: c.basicFils, totalMonthlyFils: totalMonthly, joinDate: employee.joinDate, lastWorkingDate, unpaidLeaveDays, jurisdiction, scheme, capBasis });
  trace.push(...g.trace.map((t) => `Gratuity: ${t}`));

  const earnings = proRata + leavePay + noticePay + g.amountFils + otherEarningsFils;
  const deductions = outstandingLoanFils + otherDeductionsFils;
  if (deductions) trace.push(`Deductions (loans ${filsToPlain(outstandingLoanFils)}, other ${filsToPlain(otherDeductionsFils)})`);
  return {
    components: { proRataSalaryFils: proRata, leaveEncashmentFils: leavePay, noticePayFils: noticePay, gratuityFils: g.amountFils, otherEarningsFils, outstandingLoanFils, otherDeductionsFils },
    grossFils: earnings, deductionsFils: deductions, netFils: earnings - deductions,
    // WPS: fixed = last month's salary; variable = everything else
    wps: { fixedFils: proRata, variableFils: earnings - proRata - deductions },
    trace, rulePack: `${pack.id}@${pack.version}`,
  };
}
