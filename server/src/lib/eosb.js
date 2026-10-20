// End-of-service gratuity, returned with a full calculation trace.
import { getRulePack } from './rules.js';
import { filsToPlain } from './money.js';

const DAY = 86400000;

export function calculateGratuity({ basicMonthlyFils, totalMonthlyFils, joinDate, lastWorkingDate, unpaidLeaveDays = 0, jurisdiction = 'UAE-MAINLAND', scheme, capBasis }) {
  const pack = getRulePack(jurisdiction, lastWorkingDate);
  const trace = [`Rule pack ${pack.id} v${pack.version} (${pack.status})`];

  if (scheme === 'DEWS' || pack.gratuity.basis === 'dews') {
    trace.push('Employee covered by an alternative end-of-service savings scheme; payout comes from fund balance.');
    return { amountFils: 0, scheme: 'DEWS', trace, rulePack: `${pack.id}@${pack.version}` };
  }

  const g = pack.gratuity;
  const start = Date.parse(joinDate), end = Date.parse(lastWorkingDate);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error('Invalid service dates');

  const serviceDays = Math.max(0, Math.round((end - start) / DAY) + 1 - unpaidLeaveDays);
  const years = serviceDays / 365;
  trace.push(`Service days ${serviceDays} (${unpaidLeaveDays} unpaid excluded) = ${years.toFixed(4)} years`);

  if (years < g.minServiceYears) {
    trace.push(`Under ${g.minServiceYears} year of continuous service: no gratuity.`);
    return { amountFils: 0, serviceDays, years, trace, rulePack: `${pack.id}@${pack.version}` };
  }

  const dailyFils = Math.round((basicMonthlyFils * 12) / g.dailyWageDivisor);
  trace.push(`Daily basic = ${filsToPlain(basicMonthlyFils)} x 12 / ${g.dailyWageDivisor} = ${filsToPlain(dailyFils)}`);

  const y1 = Math.min(years, 5), y2 = Math.max(0, years - 5);
  let amount = Math.round(dailyFils * (g.daysPerYearFirst5 * y1 + g.daysPerYearAfter5 * y2));
  trace.push(`First 5 yrs: ${g.daysPerYearFirst5} x ${y1.toFixed(4)} x daily`);
  if (y2 > 0) trace.push(`After 5 yrs: ${g.daysPerYearAfter5} x ${y2.toFixed(4)} x daily`);

  const basis = capBasis || g.capBasis || 'basic';
  const capWage = basis === 'total' && totalMonthlyFils ? totalMonthlyFils : basicMonthlyFils;
  const cap = capWage * g.capMonthsOfWage;
  const capped = amount > cap;
  amount = Math.min(amount, cap);
  trace.push(`Cap ${g.capMonthsOfWage} months of ${basis === 'total' && totalMonthlyFils ? 'total' : 'basic'} wage = ${filsToPlain(cap)} ${capped ? '(applied)' : '(not reached)'}`);

  return { amountFils: amount, serviceDays, years, dailyFils, capped, trace, rulePack: `${pack.id}@${pack.version}` };
}
