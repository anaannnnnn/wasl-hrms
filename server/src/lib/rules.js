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
    sourceUrls: ['https://www.mohre.gov.ae/assets/download/4bde9a71/labour-law-en.aspx', 'https://u.ae/en/information-and-services/jobs/employment-in-the-private-sector'],
    approvedBy: null,
    approvedAt: null,
    tests: 'server/test/engines.test.js',
    changeLog: [{ version: '2026.1', date: '2026-10-20', note: 'Initial pack from PRD Part B; adds Tier 1 checkpoints, replacement grace, total-remuneration gratuity cap.' }],
    gratuity: {
      basis: 'basic',
      daysPerYearFirst5: 21,
      daysPerYearAfter5: 30,
      minServiceYears: 1,
      capMonthsOfWage: 24,
      // PRD Part B: "capped at 2 years' total remuneration". Tenants can switch to 'basic' after legal review.
      capBasis: 'total',
      dailyWageDivisor: 365, // tenant-configurable; confirm with counsel
    },
    leaveEncashment: { basis: 'basic', divisor: 30 },
    wps: { currency: 'AED', employerIdLength: 13, routingLength: 9, labourCardLength: 14, ibanLength: 23 },
    deductions: { maxPercentOfWage: 50 },
    overtime: { normal: 1.25, nightOrRestDay: 1.5, nightStart: '22:00', nightEnd: '04:00' },
    leave: {
      annualDays: 30,
      annualDaysPerMonthFirstYear: 2,
      sick: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
      maternity: { fullPayDays: 45, halfPayDays: 15 },
      parentalWorkingDays: 5,
      parentalWithinMonthsOfBirth: 6,
      maternityTotalDays: 60,
      hajjOncePerEmployment: true,
      minServiceMonthsForAnnual: 6,
      hajjUnpaidDays: 30,
    },
    emiratisation: {
      tier1MinHeadcount: 50,
      tier1TargetPctByYear: { 2026: 10 },
      // Semi-annual 1% checkpoints (PRD Part B): 9% by 30 Jun 2026, 10% by 31 Dec 2026
      tier1Checkpoints: [{ date: '2026-06-30', pct: 9 }, { date: '2026-12-31', pct: 10 }],
      replacementGraceMonths: 2,
      headcountThresholds: [20, 50, 100, 150],
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

// Other jurisdiction profiles, derived from the Mainland pack and overridden where the regime differs.
// Each is separately versioned so a change to one never silently changes another.
const MAINLAND = RULE_PACKS[0];
const DIFC = RULE_PACKS.find((p) => p.id === 'DIFC');
Object.assign(DIFC, {
  overtime: MAINLAND.overtime,
  leave: { ...MAINLAND.leave, annualDays: 20, annualDaysUnit: 'working', note: 'DIFC Employment Law: 20 working days; confirm with counsel' },
  leaveEncashment: MAINLAND.leaveEncashment,
  sourceUrls: ['https://www.difc.ae/business/laws-regulations/legal-database/difc-laws/employment-law-difc-law-no-2-2019'],
  approvedBy: null, approvedAt: null, tests: 'server/test/engines.test.js', changeLog: [{ version: '2026.1', date: '2026-10-20', note: 'DEWS end-of-service; 20 working days annual leave.' }],
});
RULE_PACKS.push(
  {
    ...MAINLAND,
    id: 'FREEZONE-STANDARD',
    source: 'Free zone employment regulations (DMCC, JAFZA, DAFZA, SHAMS etc.): Mainland labour law applies with free-zone visa processes; confirm per zone',
    sourceUrls: [],
    emiratisation: null,
    changeLog: [{ version: '2026.1', date: '2026-10-20', note: 'Mainland gratuity and leave; no MOHRE Emiratisation quota.' }],
  },
  {
    ...MAINLAND,
    id: 'ADGM',
    source: 'ADGM Employment Regulations 2019 (confirm pension/end-of-service arrangements with counsel)',
    sourceUrls: ['https://www.adgm.com/legal-framework/employment'],
    emiratisation: null,
    changeLog: [{ version: '2026.1', date: '2026-10-20', note: 'Placeholder profile: Mainland formulas until legal review.' }],
  },
);

export const listRulePacks = () => RULE_PACKS.map(({ id, version, effectiveFrom, effectiveTo, status, source, sourceUrls, approvedBy, approvedAt, tests, changeLog, gratuity, emiratisation, leave, overtime, deductions }) => ({ id, version, effectiveFrom, effectiveTo, status, source, sourceUrls, approvedBy, approvedAt, tests, changeLog, gratuity, emiratisation, leave, overtime, deductions }));

export function getRulePack(id, onDate = new Date()) {
  const d = new Date(onDate).toISOString().slice(0, 10);
  const pack = RULE_PACKS.find(
    (p) => p.id === id && p.effectiveFrom <= d && (!p.effectiveTo || d <= p.effectiveTo),
  );
  if (!pack) throw new Error(`No rule pack ${id} effective on ${d}`);
  return pack;
}
