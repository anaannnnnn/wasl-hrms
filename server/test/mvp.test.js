import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualEntitlement, leaveBalances, sickPaySplit, evaluateRequest, leaveDeductionDays } from '../src/lib/leave.js';
import { finalSettlement } from '../src/lib/settlement.js';
import { calculateGratuity } from '../src/lib/eosb.js';
import { assessEmiratisation } from '../src/lib/emiratisation.js';
import { dueThreshold } from '../src/lib/alerts.js';
import { parseCsv, validateImport } from '../src/lib/importer.js';
import { renderPayslip, renderLetter } from '../src/lib/documents.js';
import { getRulePack, listRulePacks } from '../src/lib/rules.js';
import { buildUaeIban } from '../src/lib/iban.js';

const L = getRulePack('UAE-MAINLAND', '2026-10-01').leave;
const emp = (o = {}) => ({ _id: 'e1', fullName: 'Test Person', employeeNo: 'T-1', joinDate: new Date('2020-01-01'), status: 'active', contractType: 'full-time', pensionRegistered: true, paidViaWps: true, mohreSkillLevel: 3, isUaeNational: false, compensation: { basicFils: 600000, housingFils: 300000, transportFils: 100000 }, ...o });

test('leave: no annual leave before 6 months, 2/month until 12 months, 30 after', () => {
  assert.equal(annualEntitlement({ joinDate: '2026-06-01', onDate: '2026-10-20' }).days, 0);
  assert.equal(annualEntitlement({ joinDate: '2026-01-10', onDate: '2026-10-20' }).days, 18);
  assert.equal(annualEntitlement({ joinDate: '2020-01-01', onDate: '2026-10-20' }).days, 30);
});

test('leave: sick pay splits 15 full / 30 half / 45 unpaid', () => {
  assert.deepEqual(sickPaySplit(20, 0, L), { fullDays: 15, halfDays: 5, unpaidDays: 0, overLimit: 0 });
  assert.deepEqual(sickPaySplit(10, 40, L), { fullDays: 0, halfDays: 5, unpaidDays: 5, overLimit: 0 });
  assert.equal(sickPaySplit(5, 88, L).overLimit, 3);
});

test('leave: annual over balance becomes unpaid; hajj once; overlap blocked', () => {
  const existing = [{ type: 'annual', status: 'approved', startDate: '2026-02-01', endDate: '2026-02-25', days: 25 }];
  const ev = evaluateRequest({ employee: emp(), request: { type: 'annual', startDate: '2026-11-01', endDate: '2026-11-10' }, existing, onDate: '2026-10-20' });
  assert.ok(ev.ok); assert.equal(ev.split.unpaidDays, 5); assert.equal(ev.split.fullDays, 5);
  const hajj = evaluateRequest({ employee: emp(), request: { type: 'hajj', startDate: '2026-12-01', endDate: '2026-12-10' }, existing: [{ type: 'hajj', status: 'approved', startDate: '2024-06-01', endDate: '2024-06-20', days: 20 }], onDate: '2026-10-20' });
  assert.ok(!hajj.ok);
  const clash = evaluateRequest({ employee: emp(), request: { type: 'annual', startDate: '2026-02-10', endDate: '2026-02-11' }, existing, onDate: '2026-10-20' });
  assert.ok(clash.errors.some((e) => e.includes('Overlaps')));
});

test('leave: parental needs birth date within 6 months, max 5 working days', () => {
  const bad = evaluateRequest({ employee: emp(), request: { type: 'parental', startDate: '2026-10-19', endDate: '2026-10-27' }, existing: [], onDate: '2026-10-20' });
  assert.ok(!bad.ok);
  const good = evaluateRequest({ employee: emp(), request: { type: 'parental', startDate: '2026-10-19', endDate: '2026-10-23', childBirthDate: '2026-09-01' }, existing: [], onDate: '2026-10-20' });
  assert.ok(good.ok, good.errors.join());
});

test('leave: approved unpaid and half-pay days flow into the right payroll month', () => {
  const reqs = [
    { status: 'approved', startDate: '2026-10-29', endDate: '2026-11-02', unpaidDays: 5, halfDays: 0 }, // 3 days in Oct
    { status: 'approved', startDate: '2026-10-05', endDate: '2026-10-08', unpaidDays: 0, halfDays: 4 }, // 2 units
    { status: 'pending', startDate: '2026-10-10', endDate: '2026-10-12', unpaidDays: 3 },
  ];
  assert.equal(leaveDeductionDays(reqs, '2026-10-01', '2026-10-31'), 5);
});

test('gratuity: cap uses total remuneration when configured (PRD)', () => {
  const r = calculateGratuity({ basicMonthlyFils: 280000, totalMonthlyFils: 500000, joinDate: '1990-01-01', lastWorkingDate: '2026-10-31' });
  assert.ok(r.amountFils > 280000 * 24 - 1);
  assert.ok(r.amountFils <= 500000 * 24);
  const b = calculateGratuity({ basicMonthlyFils: 280000, totalMonthlyFils: 500000, joinDate: '1990-01-01', lastWorkingDate: '2026-10-31', capBasis: 'basic' });
  assert.equal(b.amountFils, 280000 * 24);
});

test('final settlement adds pro-rata salary, leave encashment, gratuity and notice; minus loans', () => {
  const s = finalSettlement({ employee: emp(), lastWorkingDate: '2026-10-15', unusedLeaveDays: 10, noticePayDays: 30, outstandingLoanFils: 100000 });
  assert.equal(s.components.proRataSalaryFils, Math.round((1000000 * 15) / 31));
  assert.equal(s.components.leaveEncashmentFils, 200000); // 10 × 6000/30 AED
  assert.equal(s.components.noticePayFils, 1000000);
  assert.ok(s.components.gratuityFils > 0);
  assert.equal(s.netFils, s.grossFils - 100000);
});

test('emiratisation: replacement grace protects a recently vacated slot; threshold warning', () => {
  const base = [...Array(36)].map(() => emp());
  const national = emp({ isUaeNational: true });
  const leaver = emp({ isUaeNational: true, status: 'exited', exitDate: new Date('2026-10-01') });
  const a = assessEmiratisation({ employees: [...base, national, leaver], establishment: { jurisdiction: 'MAINLAND', designatedSector: true }, onDate: '2026-10-20' });
  assert.equal(a.rawGap, 1); assert.equal(a.gap, 0); assert.equal(a.inGrace.length, 1); assert.equal(a.monthlyExposureFils, 0);
  const later = assessEmiratisation({ employees: [...base, national, leaver], establishment: { jurisdiction: 'MAINLAND', designatedSector: true }, onDate: '2026-12-15' });
  assert.equal(later.gap, 1);
});

test('emiratisation: Tier 1 uses the next semi-annual checkpoint', () => {
  const staff = [...Array(100)].map(() => emp());
  const june = assessEmiratisation({ employees: staff, establishment: { jurisdiction: 'MAINLAND' }, onDate: '2026-03-01' });
  const dec = assessEmiratisation({ employees: staff, establishment: { jurisdiction: 'MAINLAND' }, onDate: '2026-08-01' });
  assert.equal(june.tier, 1); assert.equal(june.required, 9); assert.equal(dec.required, 10);
});

test('alerts: thresholds 90/60/30/7 fire once each, then expiry', () => {
  assert.equal(dueThreshold(100, []), null);
  assert.equal(dueThreshold(85, []), 90);
  assert.equal(dueThreshold(85, [90]), null);
  assert.equal(dueThreshold(25, [90, 60]), 30);
  assert.equal(dueThreshold(5, [90, 60, 30]), 7);
  assert.equal(dueThreshold(-1, [90, 60, 30, 7]), 0);
  assert.equal(dueThreshold(-3, [0]), null);
});

test('import: CSV parsing with quotes; validation catches bad rows and duplicates', () => {
  assert.deepEqual(parseCsv('a,"b, c",d\n1,"say ""hi""",3\n'), [['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
  const iban = buildUaeIban('033', '1234567890123456');
  const csv = `employee_no,full_name,join_date,basic,iban,labour_card_no\nA-1,One,2024-01-01,5000,${iban},12345678901234\nA-1,Dup,2024-01-01,5000,,\nA-3,Bad,01/02/2024,abc,AE00,123\n`;
  const r = validateImport(csv, { existingEmployeeNos: ['X-9'] });
  assert.equal(r.valid.length, 1);
  assert.ok(r.errors.some((e) => e.row === 3 && e.field === 'employee_no'));
  assert.ok(r.errors.filter((e) => e.row === 4).length >= 3);
  assert.equal(r.valid[0].data.compensation.basicFils, 500000);
});

test('documents: payslip and bilingual letters render with key content', () => {
  const est = { name: 'Al Noor Trading LLC', nameAr: 'شركة النور', mohreId: '1000000042817', wps: { agentName: 'Emirates NBD' } };
  const html = renderPayslip({ employee: emp({ fullNameAr: 'تجربة' }), establishment: est, run: { period: '2026-10', rulePack: 'UAE-MAINLAND@2026.1' }, line: { fixedFils: 1000000, variableFils: 50000, deductionsFils: 0, netFils: 1050000, unpaidLeaveDays: 0 } });
  assert.match(html, /Net pay/); assert.match(html, /10,500\.00/); assert.match(html, /قسيمة/);
  for (const type of ['salary_certificate', 'bank_transfer', 'noc', 'experience']) {
    const l = renderLetter({ type, employee: emp(), establishment: est, addressee: 'Emirates NBD', reference: 'LTR-1' });
    assert.match(l, /Test Person/); assert.match(l, /dir=/);
  }
  assert.throws(() => renderLetter({ type: 'nope', employee: emp(), establishment: est }));
});

test('rules registry lists every jurisdiction profile with source metadata', () => {
  const ids = listRulePacks().map((p) => p.id);
  for (const id of ['UAE-MAINLAND', 'DIFC', 'FREEZONE-STANDARD', 'ADGM']) assert.ok(ids.includes(id));
  assert.equal(getRulePack('FREEZONE-STANDARD', '2026-10-01').emiratisation, null);
  assert.ok(listRulePacks().every((p) => p.status && p.changeLog?.length));
});
