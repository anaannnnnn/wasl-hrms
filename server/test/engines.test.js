import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFils, filsToPlain } from '../src/lib/money.js';
import { isValidUaeIban, buildUaeIban } from '../src/lib/iban.js';
import { calculateGratuity } from '../src/lib/eosb.js';
import { preflight, sifFilename } from '../src/lib/wps.js';
import { assessEmiratisation, nafisScenario } from '../src/lib/emiratisation.js';
import { calculateLine } from '../src/lib/payroll.js';

test('money: decimal-safe conversion', () => {
  assert.equal(toFils('0.1') + toFils('0.2'), toFils('0.3'));
  assert.equal(toFils('1,234.5'), 123450);
  assert.equal(filsToPlain(123405), '1234.05');
  assert.throws(() => toFils('12.345'));
});

test('iban: build and validate UAE IBAN', () => {
  const ib = buildUaeIban('026', '1010000000000001');
  assert.equal(ib.length, 23);
  assert.ok(isValidUaeIban(ib));
  assert.ok(!isValidUaeIban(ib.slice(0, 22) + ((Number(ib[22]) + 1) % 10)));
  assert.ok(!isValidUaeIban('AE070260001015432198765'));
});

test('gratuity: under 1 year pays nothing', () => {
  const r = calculateGratuity({ basicMonthlyFils: 500000, joinDate: '2026-02-01', lastWorkingDate: '2026-10-31' });
  assert.equal(r.amountFils, 0);
});

test('gratuity: exactly 5 years = 105 days of basic', () => {
  const basic = 365000; // daily = 365000*12/365 = 12000 fils
  const r = calculateGratuity({ basicMonthlyFils: basic, joinDate: '2021-03-01', lastWorkingDate: '2026-02-28' }); // 1826 days incl both ends
  assert.equal(r.dailyFils, 12000);
  assert.equal(r.serviceDays, 1826);
  const yrs = 1826 / 365; // a leap day makes this 5.0027 years
  assert.ok(Math.abs(r.amountFils - 12000 * (21 * 5 + 30 * (yrs - 5))) <= 1);
});

test('gratuity: exit date with no rule pack is refused', () => {
  assert.throws(() => calculateGratuity({ basicMonthlyFils: 1, joinDate: '2020-01-01', lastWorkingDate: '2024-12-30' }), /No rule pack/);
});

test('gratuity: over 5 years uses 30 days and cap applies', () => {
  const r = calculateGratuity({ basicMonthlyFils: 280000, joinDate: '1990-01-01', lastWorkingDate: '2026-10-31' });
  assert.equal(r.amountFils, 280000 * 24);
  assert.ok(r.capped);
});

test('gratuity: unpaid leave reduces service', () => {
  const a = calculateGratuity({ basicMonthlyFils: 300000, joinDate: '2020-01-01', lastWorkingDate: '2026-01-01' });
  const b = calculateGratuity({ basicMonthlyFils: 300000, joinDate: '2020-01-01', lastWorkingDate: '2026-01-01', unpaidLeaveDays: 30 });
  assert.ok(b.amountFils < a.amountFils);
});

test('gratuity: DEWS returns zero with trace', () => {
  const r = calculateGratuity({ basicMonthlyFils: 300000, joinDate: '2020-01-01', lastWorkingDate: '2026-01-01', scheme: 'DEWS' });
  assert.equal(r.amountFils, 0);
  assert.equal(r.scheme, 'DEWS');
});

const est = { mohreId: '1000000042817', agentRoutingCode: '302620122' };
const row = (i, extra = {}) => ({ name: `E${i}`, labourCardNo: String(94821370000000 + i), routingCode: '302620122', iban: buildUaeIban('026', String(1000 + i)), periodStart: '2026-10-01', periodEnd: '2026-10-31', days: 31, fixedFils: 333333 + i, variableFils: 1001, leaveDays: 0, ...extra });

test('wps: totals match to the fils and file is well formed', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(i));
  const pf = preflight({ establishment: est, salaryMonth: '2026-10', createdAt: new Date('2026-10-19T14:32:05Z'), rows });
  assert.equal(pf.blocking, 0);
  const lines = pf.content.trim().split('\r\n');
  assert.equal(lines.length, 26);
  assert.match(lines[0], /^SCR,1000000042817,302620122,2026-10-19,1432,102026,25,/);
  assert.equal(pf.filename, '1000000042817261019143205.sif');
  assert.equal(sifFilename('1000000042817', new Date('2026-10-19T14:32:05Z')), pf.filename);
});

test('wps: bad IBAN and short labour card block the file and are held', () => {
  const rows = [row(1), row(2, { iban: 'AE070260001015432198765' }), row(3, { labourCardNo: '123' })];
  const pf = preflight({ establishment: est, salaryMonth: '2026-10', createdAt: new Date(), rows });
  assert.ok(pf.blocking >= 2);
  assert.equal(pf.recordCount, 1);
  assert.equal(pf.heldRows, 2);
});

const emp = (o) => ({ _id: Math.random(), status: 'active', contractType: 'full-time', pensionRegistered: true, paidViaWps: true, mohreSkillLevel: 3, isUaeNational: false, compensation: { basicFils: 500000, housingFils: 200000, transportFils: 50000 }, ...o });

test('emiratisation: tier 2 SME needs 2 qualifying nationals', () => {
  const employees = [...Array(36)].map(() => emp({})).concat([emp({ isUaeNational: true }), emp({ isUaeNational: true, pensionRegistered: false })]);
  const r = assessEmiratisation({ employees, establishment: { jurisdiction: 'MAINLAND', designatedSector: true }, onDate: '2026-10-19' });
  assert.equal(r.tier, 2);
  assert.equal(r.required, 2);
  assert.equal(r.qualifyingCount, 1);
  assert.equal(r.gap, 1);
  assert.equal(r.monthlyExposureFils, 900000);
});

test('emiratisation: free zone not applicable', () => {
  assert.equal(assessEmiratisation({ employees: [], establishment: { jurisdiction: 'FREEZONE' } }).applicable, false);
});

test('nafis: subsidy capped', () => {
  const r = nafisScenario({ grossWageFils: 2000000, onDate: '2026-10-19' });
  assert.equal(r.modelledSubsidyFils, 700000);
});

test('payroll: unpaid leave deduction and totals', () => {
  const l = calculateLine(emp({}), { unpaidLeaveDays: 2, overtimeFils: 10000 }, { onDate: '2026-10-01' });
  assert.equal(l.grossFils, 760000);
  assert.equal(l.deductionsFils, 50000);
  assert.equal(l.netFils, 710000);
  assert.equal(l.fixedFils, 700000);
});

test('payroll: deduction above 50% is blocked', () => {
  const l = calculateLine(emp({}), { loanInstallmentFils: 400000 }, { onDate: '2026-10-01' });
  assert.ok(l.flags.some((f) => f.code === 'DEDUCTION_CAP'));
});
