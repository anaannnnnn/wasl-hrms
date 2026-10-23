// Explainable insight engines: visa & insurance cash-flow forecast, and an opt-in, aggregate-first
// attrition/burnout indicator. No opaque models and no protected attributes are used anywhere here.

// Default government/insurance cost assumptions in fils. Every tenant can override these
// (FeatureSettings.feeSchedule). They are planning estimates, not quotes — confirm with your PRO/typing centre.
export const DEFAULT_FEES = {
  residence_visa: { MAINLAND: 350000, FREEZONE: 450000, label: 'Residence visa renewal (incl. medical, EID, typing)' },
  emirates_id: { MAINLAND: 37000, FREEZONE: 37000, label: 'Emirates ID renewal' },
  labour_card: { MAINLAND: 125000, FREEZONE: 0, label: 'Work permit renewal' },
  health_insurance: { MAINLAND: 180000, FREEZONE: 180000, label: 'Health insurance (per member, annual)' },
  passport: { MAINLAND: 0, FREEZONE: 0, label: 'Passport (employee cost)' },
  driving_licence: { MAINLAND: 0, FREEZONE: 0, label: 'Driving licence' },
  trade_licence: { MAINLAND: 1500000, FREEZONE: 1800000, label: 'Trade licence renewal' },
  establishment_card: { MAINLAND: 200000, FREEZONE: 200000, label: 'Establishment card renewal' },
  dependent_visa: { MAINLAND: 300000, FREEZONE: 350000, label: 'Dependent residence visa renewal' },
};

const ym = (d) => new Date(d).toISOString().slice(0, 7);
const monthsAhead = (from, n) => { const out = []; const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); } return out; };

/**
 * Forecast renewal spend by month.
 * docs: [{docType, expiryDate, jurisdiction, holder}], dependents: [{residenceExpiry, jurisdiction}],
 * exits: employee ids leaving before renewal (excluded).
 */
export function forecastRenewals({ docs, dependents = [], months = 12, now = new Date(), fees = DEFAULT_FEES, leaverIds = new Set() }) {
  const buckets = Object.fromEntries(monthsAhead(now, months).map((m) => [m, { month: m, totalFils: 0, items: [] }]));
  const overdue = { totalFils: 0, items: [] };
  const push = (when, type, juris, holder, ref) => {
    const fee = fees[type]; if (!fee) return;
    const amount = fee[juris] ?? fee.MAINLAND ?? 0; if (!amount) return;
    const item = { type, label: fee.label, holder, amountFils: amount, expiry: new Date(when).toISOString().slice(0, 10), ref };
    const m = ym(when);
    if (new Date(when) < now) { overdue.items.push(item); overdue.totalFils += amount; } else if (buckets[m]) { buckets[m].items.push(item); buckets[m].totalFils += amount; }
  };
  for (const d of docs) { if (d.employeeId && leaverIds.has(String(d.employeeId))) continue; push(d.expiryDate, d.docType, d.jurisdiction || 'MAINLAND', d.holder, String(d._id || '')); }
  for (const dp of dependents) if (dp.residenceExpiry) push(dp.residenceExpiry, 'dependent_visa', dp.jurisdiction || 'MAINLAND', dp.name, String(dp._id || ''));
  const series = Object.values(buckets);
  return { months: series, overdue, totalFils: series.reduce((a, b) => a + b.totalFils, 0) + overdue.totalFils, peak: series.reduce((a, b) => (b.totalFils > (a?.totalFils || 0) ? b : a), null), assumptions: fees };
}

/**
 * Attrition / burnout indicators. Each signal is a transparent rule with a weight; the score is the sum.
 * Inputs are operational facts only (leave, attendance, overtime, pay changes, pulse). Never nationality, gender, age, health detail.
 */
export const SIGNALS = [
  { id: 'single_sick_days', weight: 20, label: 'Several single-day sick leaves in 90 days', test: (f) => f.singleSickDays90 >= 3 },
  { id: 'leave_hoarding', weight: 10, label: 'Has not taken annual leave in 9+ months', test: (f) => f.monthsSinceAnnualLeave >= 9 },
  { id: 'late_trend', weight: 15, label: 'Late arrivals rising (last 30 vs prior 30 days)', test: (f) => f.late30 >= 4 && f.late30 > f.latePrev30 * 1.5 },
  { id: 'overtime_load', weight: 20, label: 'Sustained overtime (> 20 h in 30 days)', test: (f) => f.overtimeHours30 > 20 },
  { id: 'pay_stagnant', weight: 15, label: 'No pay change in 24+ months', test: (f) => f.monthsSincePayChange >= 24 },
  { id: 'low_pulse', weight: 20, label: 'Low wellbeing check-ins (avg ≤ 2.5)', test: (f) => f.pulseAvg != null && f.pulseAvg <= 2.5 },
];

export function scoreEmployee(features) {
  const hits = SIGNALS.filter((s) => s.test(features));
  const score = Math.min(100, hits.reduce((a, s) => a + s.weight, 0));
  return { score, band: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low', reasons: hits.map((h) => h.label), suggestions: suggest(hits.map((h) => h.id)) };
}

function suggest(ids) {
  const s = [];
  if (ids.includes('overtime_load') || ids.includes('leave_hoarding')) s.push('Plan time off and rebalance workload with the manager.');
  if (ids.includes('pay_stagnant')) s.push('Review pay against the grade band at the next cycle.');
  if (ids.includes('late_trend') || ids.includes('single_sick_days')) s.push('Have a supportive 1:1 check-in; ask about commute, shifts or wellbeing.');
  if (ids.includes('low_pulse')) s.push('Follow up on team-level wellbeing themes (no individual follow-up on anonymous pulses).');
  return s;
}

/** Department-level aggregates; groups smaller than minGroupSize are suppressed to protect individuals. */
export function aggregateByDepartment(scored, minGroupSize = 5) {
  const groups = {};
  for (const s of scored) (groups[s.department || 'Unassigned'] ||= []).push(s);
  return Object.entries(groups).map(([department, arr]) => arr.length < minGroupSize
    ? { department, headcount: arr.length, suppressed: true }
    : { department, headcount: arr.length, avgScore: Math.round(arr.reduce((a, x) => a + x.score, 0) / arr.length), high: arr.filter((x) => x.band === 'high').length, topReasons: topN(arr.flatMap((x) => x.reasons), 3) });
}
const topN = (arr, n) => Object.entries(arr.reduce((m, r) => ((m[r] = (m[r] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, n).map(([reason, count]) => ({ reason, count }));

/** Visa cost of hiring vs. Emiratisation fines — used by the NAFIS ROI view alongside the MVP's nafisScenario(). */
export function hiringVsFine({ grossWageFils, nafisSubsidyFils, monthlyFineFils, months = 12 }) {
  const hireCost = (grossWageFils - nafisSubsidyFils) * months; const fineCost = monthlyFineFils * months;
  return { months, hireNetCostFils: hireCost, fineCostFils: fineCost, differenceFils: fineCost - hireCost, cheaper: hireCost <= fineCost ? 'hire' : 'fine' };
}
