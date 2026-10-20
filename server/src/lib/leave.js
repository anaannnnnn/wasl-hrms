// Leave entitlements, policy validation and payroll impact. Pure functions (no DB access).
import { getRulePack } from './rules.js';

const DAY = 86400000;
const d0 = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };
export const daysBetween = (a, b) => Math.round((d0(b) - d0(a)) / DAY) + 1;
const monthsBetween = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth()) - (y.getUTCDate() < x.getUTCDate() ? 1 : 0);
};

/** Annual leave entitlement for the leave year containing `onDate` (calendar year). */
export function annualEntitlement({ joinDate, onDate = new Date(), carryForward = 0, rulePackId = 'UAE-MAINLAND' }) {
  const L = getRulePack(rulePackId, onDate).leave;
  const svc = monthsBetween(joinDate, onDate);
  if (svc < (L.minServiceMonthsForAnnual ?? 6)) return { days: 0, basis: `Under ${L.minServiceMonthsForAnnual ?? 6} months of service`, serviceMonths: svc };
  if (svc < 12) return { days: Math.min(24, svc * L.annualDaysPerMonthFirstYear) + carryForward, basis: `${L.annualDaysPerMonthFirstYear} days per month (6–12 months of service)`, serviceMonths: svc };
  // Pro-rate the first full calendar year after the first anniversary; full entitlement afterwards
  const year = new Date(onDate).getUTCFullYear();
  const join = new Date(joinDate);
  const firstFull = new Date(Date.UTC(join.getUTCFullYear() + 1, join.getUTCMonth(), join.getUTCDate()));
  let days = L.annualDays;
  if (firstFull.getUTCFullYear() === year) days = Math.round((L.annualDays * (12 - firstFull.getUTCMonth())) / 12 + 2 * firstFull.getUTCMonth());
  return { days: Math.min(L.annualDays, days) + carryForward, basis: `${L.annualDays} ${L.annualDaysUnit || 'calendar'} days per year`, serviceMonths: svc };
}

/** Balances by leave type for one employee given their leave requests (any status). */
export function leaveBalances({ employee, requests, onDate = new Date(), rulePackId = 'UAE-MAINLAND' }) {
  const L = getRulePack(rulePackId, onDate).leave;
  const year = new Date(onDate).getUTCFullYear();
  const taken = (type, statuses = ['approved']) => requests
    .filter((r) => r.type === type && statuses.includes(r.status) && new Date(r.startDate).getUTCFullYear() === year)
    .reduce((a, r) => a + r.days, 0);
  const ent = annualEntitlement({ joinDate: employee.joinDate, onDate, carryForward: employee.leaveCarryForward || 0, rulePackId });
  const annualTaken = taken('annual'), annualPending = taken('annual', ['pending']);
  const sickTaken = taken('sick');
  const sickTotal = L.sick.fullPayDays + L.sick.halfPayDays + L.sick.unpaidDays;
  return {
    annual: { entitlement: ent.days, taken: annualTaken, pending: annualPending, remaining: ent.days - annualTaken, basis: ent.basis },
    sick: { entitlement: sickTotal, taken: sickTaken, remaining: Math.max(0, sickTotal - sickTaken), fullPayLeft: Math.max(0, L.sick.fullPayDays - sickTaken), halfPayLeft: Math.max(0, L.sick.halfPayDays - Math.max(0, sickTaken - L.sick.fullPayDays)) },
    hajjUsed: requests.some((r) => r.type === 'hajj' && r.status === 'approved'),
  };
}

/** Split a sick request into full / half / unpaid days given sick days already taken this year. */
export function sickPaySplit(days, alreadyTaken, L) {
  let left = days, pos = alreadyTaken; const out = { fullDays: 0, halfDays: 0, unpaidDays: 0 };
  const take = (key, limit) => { const n = Math.max(0, Math.min(left, limit - pos)); out[key] += n; left -= n; pos += n; };
  take('fullDays', L.sick.fullPayDays);
  take('halfDays', L.sick.fullPayDays + L.sick.halfPayDays);
  take('unpaidDays', L.sick.fullPayDays + L.sick.halfPayDays + L.sick.unpaidDays);
  return { ...out, overLimit: left };
}

/**
 * Validate a new request against policy and decide its pay split.
 * Returns { ok, errors[], warnings[], split: {fullDays, halfDays, unpaidDays} }.
 */
export function evaluateRequest({ employee, request, existing, onDate = new Date(), rulePackId = 'UAE-MAINLAND' }) {
  const L = getRulePack(rulePackId, onDate).leave;
  const days = daysBetween(request.startDate, request.endDate);
  const errors = [], warnings = [];
  let split = { fullDays: days, halfDays: 0, unpaidDays: 0 };
  if (days < 1) errors.push('End date must be on or after start date.');
  const bal = leaveBalances({ employee, requests: existing, onDate, rulePackId });

  // overlap with the employee's own pending/approved leave
  const clash = existing.find((r) => ['pending', 'approved'].includes(r.status) && d0(r.startDate) <= d0(request.endDate) && d0(r.endDate) >= d0(request.startDate));
  if (clash) errors.push(`Overlaps an existing ${clash.type} request (${new Date(clash.startDate).toISOString().slice(0, 10)}).`);

  switch (request.type) {
    case 'annual':
      if (bal.annual.entitlement === 0) errors.push(`Annual leave starts after ${L.minServiceMonthsForAnnual ?? 6} months of service.`);
      else if (days > bal.annual.remaining - bal.annual.pending) {
        const over = days - Math.max(0, bal.annual.remaining - bal.annual.pending);
        warnings.push(`${over} day(s) exceed the remaining balance and will be unpaid.`);
        split = { fullDays: days - over, halfDays: 0, unpaidDays: over };
      }
      break;
    case 'sick': {
      const s = sickPaySplit(days, bal.sick.taken, L);
      if (s.overLimit) errors.push(`Exceeds the ${L.sick.fullPayDays + L.sick.halfPayDays + L.sick.unpaidDays}-day sick leave limit by ${s.overLimit} day(s).`);
      if (!request.certificateAttached && days > 1) warnings.push('A medical certificate is required for sick leave over 1 day.');
      split = { fullDays: s.fullDays, halfDays: s.halfDays, unpaidDays: s.unpaidDays };
      break;
    }
    case 'maternity':
      if (days > L.maternityTotalDays) errors.push(`Maternity leave is ${L.maternityTotalDays} days.`);
      split = { fullDays: Math.min(days, L.maternity.fullPayDays), halfDays: Math.max(0, Math.min(days - L.maternity.fullPayDays, L.maternity.halfPayDays)), unpaidDays: 0 };
      break;
    case 'parental': {
      // working days only (Mon–Fri)
      let wd = 0; for (let t = d0(request.startDate); t <= d0(request.endDate); t += DAY) { const g = new Date(t).getUTCDay(); if (g !== 0 && g !== 6) wd++; }
      if (wd > L.parentalWorkingDays) errors.push(`Parental leave is ${L.parentalWorkingDays} working days.`);
      if (!request.childBirthDate) errors.push('Child’s date of birth is required for parental leave.');
      else if (monthsBetween(request.childBirthDate, request.startDate) >= L.parentalWithinMonthsOfBirth) errors.push(`Parental leave must be taken within ${L.parentalWithinMonthsOfBirth} months of the birth.`);
      break;
    }
    case 'hajj':
      if (L.hajjOncePerEmployment && bal.hajjUsed) errors.push('Hajj leave can be taken once during employment.');
      if (days > L.hajjUnpaidDays) errors.push(`Hajj leave is up to ${L.hajjUnpaidDays} days.`);
      split = { fullDays: 0, halfDays: 0, unpaidDays: days };
      break;
    case 'unpaid':
      split = { fullDays: 0, halfDays: 0, unpaidDays: days };
      break;
    default:
      break;
  }
  return { ok: errors.length === 0, errors, warnings, days, split, balances: bal };
}

/**
 * Payroll impact of approved leave in a pay period: unpaid days + half-pay days counted as 0.5.
 * Each request's split is spread evenly over its calendar days, then clipped to the period.
 */
export function leaveDeductionDays(requests, periodStart, periodEnd) {
  let units = 0;
  for (const r of requests) {
    if (r.status !== 'approved') continue;
    const total = daysBetween(r.startDate, r.endDate);
    const from = Math.max(d0(r.startDate), d0(periodStart)), to = Math.min(d0(r.endDate), d0(periodEnd));
    if (to < from) continue;
    const share = (Math.round((to - from) / DAY) + 1) / total;
    units += share * ((r.unpaidDays || 0) + 0.5 * (r.halfDays || 0));
  }
  return Math.round(units * 2) / 2; // nearest half day
}
