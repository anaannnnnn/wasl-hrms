// Emiratisation quota + penalty exposure + NAFIS hire-vs-fine scenario.
import { getRulePack } from './rules.js';

export function assessEmiratisation({ employees, establishment, onDate = new Date() }) {
  if (establishment.jurisdiction !== 'MAINLAND') {
    return { applicable: false, reason: 'Free zone establishment: MOHRE quota not applied (confirm per zone).' };
  }
  const pack = getRulePack('UAE-MAINLAND', onDate);
  const r = pack.emiratisation;
  const active = employees.filter((e) => e.status === 'active');
  const headcount = active.length;

  const qualifying = [], notQualifying = [];
  for (const e of active.filter((x) => x.isUaeNational)) {
    const c = e.compensation;
    const wage = c.basicFils + c.housingFils + c.transportFils + (c.allowances || []).reduce((a, x) => a + x.amountFils, 0);
    const reasons = [];
    if (e.contractType !== 'full-time') reasons.push('Not a full-time contract');
    if (!e.pensionRegistered) reasons.push('Pension (GPSSA) registration missing');
    if (wage < r.minQualifyingWageFils) reasons.push('Below AED 6,000 wage threshold');
    if (!e.paidViaWps) reasons.push('Not paid via WPS');
    (reasons.length ? notQualifying : qualifying).push({ id: e._id, name: e.fullName, wageFils: wage, reasons });
  }

  let tier = 0, required = 0;
  if (headcount >= r.tier1MinHeadcount) {
    tier = 1;
    const skilled = active.filter((e) => e.mohreSkillLevel >= 1 && e.mohreSkillLevel <= 5).length;
    const pct = r.tier1TargetPctByYear[new Date(onDate).getFullYear()] ?? 10;
    required = Math.ceil((skilled * pct) / 100);
  } else if (headcount >= r.tier2MinHeadcount && establishment.designatedSector) {
    tier = 2;
    required = r.tier2RequiredNationals;
  }
  const gap = Math.max(0, required - qualifying.length);
  return {
    applicable: tier > 0,
    tier, headcount, required,
    qualifyingCount: qualifying.length,
    qualifying, notQualifying, gap,
    monthlyExposureFils: gap * r.finePerSlotPerMonthFils,
    annualExposureFils: gap * r.finePerSlotPerMonthFils * 12,
    rulePack: `${pack.id}@${pack.version}`,
  };
}

export function nafisScenario({ grossWageFils, onDate = new Date() }) {
  const r = getRulePack('UAE-MAINLAND', onDate).emiratisation;
  const subsidy = Math.min(Math.round((grossWageFils * r.nafis.maxSubsidyPct) / 100), r.nafis.capPerMonthFils);
  const netCost = grossWageFils - subsidy;
  return {
    grossWageFils, modelledSubsidyFils: subsidy, netMonthlyCostFils: netCost,
    finePerMonthFils: r.finePerSlotPerMonthFils,
    annualSavingVsFineFils: (r.finePerSlotPerMonthFils - netCost) * 12,
    note: 'NAFIS eligibility depends on the candidate and programme rules; this is a scenario only.',
  };
}
