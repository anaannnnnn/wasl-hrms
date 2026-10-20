// Versioned statutory rule packs.
// Values are taken from the PRD blueprint (Part B) and MUST be validated by
// UAE employment counsel before production use. Never hardcode these elsewhere:
// read them through getRulePack(jurisdiction, date).

export const RULE_PACKS = [
  {
    id: 'UAE-MAINLAND',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    status: 'pending-legal-review',
    source: 'Federal Decree-Law No. 33 of 2021 (per PRD blueprint)',
    gratuity: {
      basis: 'basic',
      daysPerYearFirst5: 21,
      daysPerYearAfter5: 30,
      minServiceYears: 1,
      capMonthsOfWage: 24,
      dailyWageDivisor: 365, // tenant-configurable; confirm with counsel
    },
    wps: { currency: 'AED', employerIdLength: 13, routingLength: 9, labourCardLength: 14, ibanLength: 23 },
    deductions: { maxPercentOfWage: 50 },
    overtime: { normal: 1.25, nightOrRestDay: 1.5, nightStart: '22:00', nightEnd: '04:00' },
    leave: {
      annualDays: 30,
      annualDaysPerMonthFirstYear: 2,
      sick: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
      maternity: { fullPayDays: 45, halfPayDays: 15 },
      parentalWorkingDays: 5,
      hajjUnpaidDays: 30,
    },
    emiratisation: {
      tier1MinHeadcount: 50,
      tier1TargetPctByYear: { 2026: 10 },
      tier2MinHeadcount: 20,
      tier2MaxHeadcount: 49,
      tier2RequiredNationals: 2,
      finePerSlotPerMonthFils: 900000, // AED 9,000
      minQualifyingWageFils: 600000,   // AED 6,000
      nafis: { maxSubsidyPct: 50, capPerMonthFils: 700000 },
    },
  },
  {
    id: 'DIFC',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    status: 'pending-legal-review',
    source: 'DIFC Employment Law - DEWS (per PRD blueprint)',
    gratuity: { basis: 'dews', note: 'End-of-service paid from DEWS fund, not formula' },
    wps: { currency: 'AED', employerIdLength: 13, routingLength: 9, labourCardLength: 14, ibanLength: 23 },
    deductions: { maxPercentOfWage: 50 },
    emiratisation: null, // Free zones excluded from MOHRE quota per blueprint; confirm per zone
  },
];

export function getRulePack(id, onDate = new Date()) {
  const d = new Date(onDate).toISOString().slice(0, 10);
  const pack = RULE_PACKS.find(
    (p) => p.id === id && p.effectiveFrom <= d && (!p.effectiveTo || d <= p.effectiveTo),
  );
  if (!pack) throw new Error(`No rule pack ${id} effective on ${d}`);
  return pack;
}
