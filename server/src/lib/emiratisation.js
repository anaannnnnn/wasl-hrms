// Emiratisation quota, checkpoints, replacement grace, threshold alerts, penalty exposure and NAFIS scenario.
import { getRulePack } from './rules.js';

const wageOf = (c) => c.basicFils + c.housingFils + c.transportFils + (c.allowances || []).reduce((a, x) => a + x.amountFils, 0);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };

/** Next semi-annual checkpoint on or after `onDate` (Tier 1). */
export function nextCheckpoint(r, onDate) {
  const d = new Date(onDate).toISOString().slice(0, 10);
  return (r.tier1Checkpoints || []).find((c) => c.date >= d) || (r.tier1Checkpoints || []).at(-1) || null;
}

export function assessEmiratisation({ employees, establishment, onDate = new Date() }) {
  const pack = getRulePack(establishment.rulePackId || 'UAE-MAINLAND', onDate);
  const r = pack.emiratisation;
  if (establishment.jurisdiction !== 'MAINLAND' || !r) {
    return { applicable: false, reason: 'Free zone establishment: MOHRE quota not applied (confirm per zone).', rulePack: `${pack.id}@${pack.version}` };
  }
  const active = employees.filter((e) => e.status === 'active');
  const headcount = active.length;

  const qualifying = [], notQualifying = [];
  for (const e of active.filter((x) => x.isUaeNational)) {
    const wage = wageOf(e.compensation);
    const reasons = [];
    if (e.contractType !== 'full-time') reasons.push('Not a full-time contract');
    if (!e.pensionRegistered) reasons.push('Pension (GPSSA) registration missing');
    if (wage < r.minQualifyingWageFils) reasons.push('Below AED 6,000 wage threshold');
    if (!e.paidViaWps) reasons.push('Not paid via WPS');
    (reasons.length ? notQualifying : qualifying).push({ id: e._id, name: e.fullName, wageFils: wage, reasons });
  }

  // UAE nationals who left recently: their slot is protected for the replacement grace period
  const graceUntil = (e) => addMonths(e.exitDate, r.replacementGraceMonths || 2);
  const inGrace = employees
    .filter((e) => e.isUaeNational && e.status === 'exited' && e.exitDate && graceUntil(e) >= new Date(onDate))
    .map((e) => ({ id: e._id, name: e.fullName, exitDate: e.exitDate, graceUntil: graceUntil(e) }));

  let tier = 0, required = 0, checkpoint = null;
  if (headcount >= r.tier1MinHeadcount) {
    tier = 1;
    const skilled = active.filter((e) => e.mohreSkillLevel >= 1 && e.mohreSkillLevel <= 5).length;
    checkpoint = nextCheckpoint(r, onDate);
    const pct = checkpoint?.pct ?? r.tier1TargetPctByYear[new Date(onDate).getUTCFullYear()] ?? 10;
    required = Math.ceil((skilled * pct) / 100);
  } else if (headcount >= r.tier2MinHeadcount && establishment.designatedSector) {
    tier = 2;
    required = r.tier2RequiredNationals;
  }
  const rawGap = Math.max(0, required - qualifying.length);
  const gap = Math.max(0, rawGap - inGrace.length); // fined slots exclude those still in grace

  // Headcount threshold alerts (e.g. crossing 20 in a designated sector, or 50/100/150)
  const thresholds = r.headcountThresholds || [];
  const crossed = thresholds.filter((t) => headcount >= t).at(-1) ?? null;
  const next = thresholds.find((t) => headcount < t) ?? null;
  const alerts = [];
  if (next && next - headcount <= 3) alerts.push({ severity: 'warn', code: 'THRESHOLD_NEAR', msg: `${next - headcount} hire(s) away from the ${next}-employee threshold` });
  if (gap > 0) alerts.push({ severity: 'bad', code: 'QUOTA_GAP', msg: `${gap} unfilled Emirati slot(s)${checkpoint ? ` ahead of the ${checkpoint.date} checkpoint` : ''}` });
  if (inGrace.length) alerts.push({ severity: 'info', code: 'GRACE', msg: `${inGrace.length} slot(s) in the ${r.replacementGraceMonths}-month replacement grace period` });

  return {
    applicable: tier > 0, tier, headcount, required, checkpoint,
    qualifyingCount: qualifying.length, qualifying, notQualifying, inGrace,
    gap, rawGap, thresholds: { crossed, next },
    monthlyExposureFils: gap * r.finePerSlotPerMonthFils,
    annualExposureFils: gap * r.finePerSlotPerMonthFils * 12,
    alerts,
    reason: tier === 0 ? (headcount < r.tier2MinHeadcount ? `Below ${r.tier2MinHeadcount} employees` : 'Not in a designated sector and below 50 employees') : undefined,
    rulePack: `${pack.id}@${pack.version}`,
  };
}

export function nafisScenario({ grossWageFils, hires = 1, onDate = new Date() }) {
  const r = getRulePack('UAE-MAINLAND', onDate).emiratisation;
  const subsidy = Math.min(Math.round((grossWageFils * r.nafis.maxSubsidyPct) / 100), r.nafis.capPerMonthFils);
  const netCost = grossWageFils - subsidy;
  return {
    grossWageFils, hires, modelledSubsidyFils: subsidy, netMonthlyCostFils: netCost,
    finePerMonthFils: r.finePerSlotPerMonthFils,
    annualSavingVsFineFils: (r.finePerSlotPerMonthFils - netCost) * 12 * hires,
    note: 'NAFIS eligibility depends on the candidate and programme rules; this is a scenario only.',
  };
}
