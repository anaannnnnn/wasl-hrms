// Unit tests for the engines added after the MVP (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { nightMinutes, classifyDayOvertime, overtimePay, buildSchedule, periodDeductions, outstandingFils, monthlyAirfareAccrual, accrueAirfare, buildJournal, journalFile, parseRejectionCsv, matchRejections, reconcileRun, comparePeriods, convertFromAed, addMonths } from '../src/ext/lib/payrollPlus.js';
import { workingDays, holidaySet, shiftMinutes, evaluateAgainstShift, rosterWarnings, missedPunches, ramadanOn, isNightShift } from '../src/ext/lib/time.js';
import { forecastRenewals, scoreEmployee, aggregateByDepartment, hiringVsFine } from '../src/ext/lib/insights.js';
import { newApiKey, parseApiKey, apiKeyMatches, signWebhook, verifyWebhook, verifySlack, verifyMeta, validateUpload, backoffMs, respondentHash } from '../src/ext/lib/platform.js';
import { shapeArabic, visualOrder, PdfDoc } from '../src/ext/lib/pdf.js';
import { payslipPdf, letterPdf, offerPdf } from '../src/ext/lib/pdfDocs.js';
import { parseHireFallback, validateHire, onboardingSteps, parseCopilotFallback, detectLang, reply, matchScore, parseLooseDate } from '../src/ext/lib/agents.js';
import { verifyJwt } from '../src/ext/lib/oidc.js';
import { composePack, runTestCases, recalcPreview, registerApproved, tenantPackId } from '../src/ext/lib/rulesRegistry.js';
import { getRulePack } from '../src/lib/rules.js';
import { toFils } from '../src/lib/money.js';
import { createHmac } from 'node:crypto';

const pack = getRulePack('UAE-MAINLAND', '2026-10-01');

// ---------------- Overtime ----------------
test('night window minutes across midnight', () => {
  assert.equal(nightMinutes(21 * 60, 23 * 60), 60);      // 21:00-23:00 → 1h in 22:00-04:00
  assert.equal(nightMinutes(23 * 60, 26 * 60), 180);     // 23:00-02:00 next day
  assert.equal(nightMinutes(3 * 60, 5 * 60), 60);        // 03:00-05:00
  assert.equal(nightMinutes(9 * 60, 17 * 60), 0);
});
test('day overtime is normal, night or rest-day premium', () => {
  assert.deepEqual(classifyDayOvertime({ date: 'd', clockInLocalMin: 480, clockOutLocalMin: 1140, overtimeMinutes: 60, pack }), { date: 'd', normal: 60, premium: 0, reason: 'normal' });
  const late = classifyDayOvertime({ date: 'd', clockInLocalMin: 600, clockOutLocalMin: 23 * 60, overtimeMinutes: 120, pack });
  assert.equal(late.normal, 60); assert.equal(late.premium, 60);
  assert.equal(classifyDayOvertime({ date: 'd', clockInLocalMin: 480, clockOutLocalMin: 1000, overtimeMinutes: 90, restDay: true, pack }).premium, 90);
});
test('overtime pay = hourly basic x 1.25 / 1.5, rounded to the fils', () => {
  // basic 9,000 → hourly 9000/30/8 = 37.5 AED; 2h normal = 93.75; 1h premium = 56.25
  const r = overtimePay({ basicMonthlyFils: 900000, days: [{ date: '2026-10-01', clockInLocalMin: 480, clockOutLocalMin: 1140, overtimeMinutes: 120 }, { date: '2026-10-03', clockInLocalMin: 480, clockOutLocalMin: 600, overtimeMinutes: 60, restDay: true }], onDate: '2026-10-01' });
  assert.equal(r.normalFils, 9375); assert.equal(r.premiumFils, 5625); assert.equal(r.totalFils, 15000);
});

// ---------------- Loans ----------------
test('loan schedule sums exactly to the principal', () => {
  const s = buildSchedule({ principalFils: 1000001, installmentFils: 300000, startPeriod: '2026-11' });
  assert.equal(s.length, 4); assert.equal(s.reduce((a, x) => a + x.amountFils, 0), 1000001);
  assert.equal(s[3].period, '2027-02'); assert.equal(s[3].amountFils, 100001);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.throws(() => buildSchedule({ principalFils: 0, installmentFils: 1, startPeriod: '2026-01' }));
});
test('deductions respect the 50% cap and defer the remainder; fines capped at 5 days basic', () => {
  const loans = [
    { _id: 'L1', kind: 'loan', status: 'active', schedule: [{ period: '2026-10', amountFils: 400000, status: 'due' }] },
    { _id: 'F1', kind: 'fine', status: 'active', schedule: [{ period: '2026-10', amountFils: 200000, status: 'due' }] },
  ];
  const r = periodDeductions({ loans, period: '2026-10', grossFils: 1000000, basicMonthlyFils: 600000 });
  assert.equal(r.fineFils, 100000);          // 5 days of 6,000/30 = 1,000
  assert.equal(r.loanInstallmentFils, 400000);
  assert.ok(r.fineFils + r.loanInstallmentFils <= r.capFils);
  const tight = periodDeductions({ loans, period: '2026-10', grossFils: 600000, basicMonthlyFils: 600000 });
  assert.equal(tight.fineFils + tight.loanInstallmentFils, 300000);
  assert.ok(tight.items.some((i) => i.deferredFils > 0));
  assert.equal(outstandingFils(loans[0]), 400000);
});

// ---------------- Airfare ----------------
test('airfare accrues monthly from IATA reference fare', () => {
  const policy = { cycleMonths: 12, includeDependents: true, maxDependents: 2, fares: [{ iata: 'COK', adultFils: 180000, childFils: 120000 }] };
  const m = monthlyAirfareAccrual({ policy, homeIata: 'COK', dependentsCovered: 3 });
  assert.equal(m.ticketValueFils, 420000); assert.equal(m.monthlyFils, 35000);
  const a = accrueAirfare({ account: { homeIata: 'COK', dependentsCovered: 0, lastAccruedPeriod: '2026-08' }, policy, uptoPeriod: '2026-10' });
  assert.equal(a.entries.length, 2); assert.equal(a.addedFils, 30000);
  assert.throws(() => monthlyAirfareAccrual({ policy, homeIata: 'XXX' }), /No reference fare/);
});

// ---------------- Journal ----------------
test('payroll journal balances to the fils (with unpaid leave, OT, loans, fines)', () => {
  const employees = [{ _id: 'e1', department: 'Ops', compensation: { basicFils: 600000, housingFils: 250000, transportFils: 50000, allowances: [{ amountFils: 10001 }] } }];
  const fixed = 910001 - Math.round(910001 / 30); // one unpaid day
  const run = { type: 'regular', establishmentId: 'x', lines: [{ employeeId: 'e1', employeeName: 'A', fixedFils: fixed, variableFils: 45000, deductionsFils: Math.round(910001 / 30) + 70000, netFils: 910001 + 45000 - Math.round(910001 / 30) - 70000 }] };
  const j = buildJournal({ run, employees, mapping: { accounts: { salaryExpense: 'S', housingExpense: 'H', transportExpense: 'T', otherAllowanceExpense: 'O', overtimeExpense: 'OT', reimbursementExpense: 'R', salariesPayable: 'P', loanReceivable: 'L', finesIncome: 'F' }, costCentreBy: 'department' }, inputsByEmployee: { e1: { overtimeFils: 45000, loanInstallmentFils: 50000, fineFils: 20000 } } });
  assert.ok(j.balanced, `debits ${j.debitFils} credits ${j.creditFils}`);
  assert.equal(j.lines.find((l) => l.account === 'P').creditFils, run.lines[0].netFils);
  for (const f of ['xero', 'zoho', 'quickbooks', 'erp']) { const out = journalFile(j, { format: f, date: '2026-10-31', reference: 'PR-2026-10', narration: 'Payroll' }); assert.ok(out.body.split('\n').length > j.lines.length); }
});

// ---------------- Rejections & reconciliation ----------------
test('bank rejection CSV parsing and matching', () => {
  const rows = parseRejectionCsv('Labour Card,Amount,Reason Code,Reason\n94821370000001,8350.00,R03,Account closed\n99999999999999,10,R01,Unknown\n');
  assert.equal(rows.length, 2);
  const m = matchRejections(rows, [{ employeeId: 'e1', netFils: 835000 }], [{ _id: 'e1', fullName: 'A', labourCardNo: '94821370000001', bank: {} }], toFils);
  assert.equal(m[0].matched, true); assert.equal(m[0].problems.length, 0);
  assert.equal(m[1].matched, false);
  assert.throws(() => parseRejectionCsv('a,b\n1,2'), /amount column/);
});
test('reconciliation flags SIF mismatch and open rejections', () => {
  const r = reconcileRun({ run: { lines: [{ netFils: 100, held: false }, { netFils: 50, held: false }] }, sif: { totalFils: 150, recordCount: 2 }, rejections: [{ amountFils: 50, status: 'open' }] });
  assert.equal(r.checks.find((c) => c.id === 'run_vs_sif').ok, true);
  assert.equal(r.balanced, false); assert.equal(r.settledFils, 100);
});
test('prior-period comparison flags variances over threshold, joiners and leavers', () => {
  const c = comparePeriods([{ employeeId: 'a', netFils: 1200 }, { employeeId: 'b', netFils: 1000 }, { employeeId: 'n', netFils: 500 }], [{ employeeId: 'a', netFils: 1000 }, { employeeId: 'b', netFils: 1000 }, { employeeId: 'x', netFils: 700 }], 15);
  assert.equal(c.rows.find((r) => r.employeeId === 'a').status, 'over_threshold');
  assert.equal(c.rows.find((r) => r.employeeId === 'b').status, 'ok');
  assert.equal(c.rows.find((r) => r.employeeId === 'n').status, 'new');
  assert.equal(c.rows.find((r) => r.employeeId === 'x').status, 'left');
  assert.equal(c.flagged, 3);
});
test('FX conversion is decimal-safe (BigInt) with half-up rounding', () => {
  assert.equal(convertFromAed(367250, '3.6725'), 100000);   // AED 3,672.50 = USD 1,000.00
  assert.equal(convertFromAed(1, '3.6725'), 0); assert.equal(convertFromAed(2, '3.6725'), 1);
  // properties: identity at rate 1, monotonic, and within half a minor unit of the exact value
  let prev = -1;
  for (let n = 0; n < 50000; n += 977) {
    assert.equal(convertFromAed(n, '1'), n);
    const v = convertFromAed(n, '3.6725'); assert.ok(v >= prev); prev = v;
    assert.ok(Math.abs(v - n / 3.6725) <= 0.5 + 1e-9);
  }
});

// ---------------- Time ----------------
test('working days skip weekends and public holidays', () => {
  const h = holidaySet([{ date: '2026-12-04', name: 'Company day' }]);
  const r = workingDays('2026-11-30', '2026-12-06', { holidays: h });
  assert.equal(r.holidays.length, 4); // Dec 1,2,3 + company day 4
  assert.equal(r.weekend, 2); assert.equal(r.working, 1);
});
test('split & overnight shifts, lateness, early out, break rules, Ramadan', () => {
  const split = { segments: [{ start: '08:00', end: '12:00' }, { start: '16:00', end: '20:00' }], breakMin: 60, graceMin: 10 };
  assert.equal(shiftMinutes(split), 480);
  const night = { segments: [{ start: '22:00', end: '06:00' }], breakMin: 60 };
  assert.equal(shiftMinutes(night), 420); assert.ok(isNightShift(night));
  assert.equal(shiftMinutes({ segments: [{ start: '08:00', end: '17:00' }], breakMin: 60 }, { ramadan: true }), 360);
  const ev = evaluateAgainstShift({ clockInMin: 22 * 60 + 20, clockOutMin: 7 * 60, shift: { ...night, graceMin: 15 } });
  assert.equal(ev.lateMinutes, 5); assert.equal(ev.minutesWorked, 460); assert.equal(ev.overtimeMinutes, 40);
  assert.ok(evaluateAgainstShift({ clockInMin: 480, clockOutMin: 1080, shift: { segments: [{ start: '08:00', end: '17:00' }], breakMin: 60 }, breakTakenMin: 10 }).flags.some((f) => f.code === 'BREAK_SHORT'));
  assert.ok(evaluateAgainstShift({ clockInMin: 480, clockOutMin: null, shift: split }).flags.some((f) => f.code === 'MISSED_PUNCH'));
});
test('roster warnings, missed punches, Ramadan windows', () => {
  const shifts = [{ _id: 's', segments: [{ start: '08:00', end: '18:00' }], breakMin: 0 }];
  const week = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, shiftId: 's' }));
  const w = rosterWarnings(week, shifts, { leaveDates: new Set(['2026-11-03']) });
  assert.ok(w.some((x) => x.code === 'NO_REST_DAY')); assert.ok(w.some((x) => x.code === 'OVER_HOURS')); assert.ok(w.some((x) => x.code === 'ON_LEAVE'));
  assert.equal(missedPunches([{ date: '2026-10-20', clockIn: { at: 1 } }, { date: '2026-10-21', clockIn: { at: 1 } }, { date: '2026-10-19', clockIn: { at: 1 }, clockOut: { at: 2 } }], '2026-10-21').length, 1);
  assert.ok(ramadanOn('2027-02-20', [{ start: '2027-02-08', end: '2027-03-09' }]));
  assert.equal(ramadanOn('2027-04-01', [{ start: '2027-02-08', end: '2027-03-09' }]), null);
});

// ---------------- Insights ----------------
test('renewal forecast buckets by month, skips leavers, reports overdue', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const f = forecastRenewals({ now, months: 6, docs: [{ docType: 'residence_visa', expiryDate: new Date('2026-12-10'), holder: 'A' }, { docType: 'health_insurance', expiryDate: new Date('2026-10-01'), holder: 'B' }, { docType: 'residence_visa', expiryDate: new Date('2027-01-05'), holder: 'C', employeeId: 'gone' }], leaverIds: new Set(['gone']) });
  assert.equal(f.months.length, 6); assert.equal(f.months.find((m) => m.month === '2026-12').totalFils, 350000);
  assert.equal(f.overdue.totalFils, 180000); assert.equal(f.months.find((m) => m.month === '2027-01').totalFils, 0);
});
test('attrition indicators are explainable and aggregate with small-group suppression', () => {
  const s = scoreEmployee({ singleSickDays90: 3, monthsSinceAnnualLeave: 10, late30: 0, latePrev30: 0, overtimeHours30: 25, monthsSincePayChange: 30, pulseAvg: null });
  assert.equal(s.score, 65); assert.equal(s.band, 'high'); assert.equal(s.reasons.length, 4); assert.ok(s.suggestions.length);
  const agg = aggregateByDepartment([...Array(5)].map(() => ({ ...s, department: 'Ops' })).concat([{ ...s, department: 'HR' }]), 5);
  assert.equal(agg.find((a) => a.department === 'HR').suppressed, true);
  assert.equal(agg.find((a) => a.department === 'Ops').high, 5);
  assert.equal(hiringVsFine({ grossWageFils: 1000000, nafisSubsidyFils: 500000, monthlyFineFils: 900000, months: 12 }).cheaper, 'hire');
});

// ---------------- Platform ----------------
test('API keys store only a hash and verify', () => {
  const k = newApiKey(); const p = parseApiKey(k.key);
  assert.equal(p.prefix, k.prefix); assert.ok(apiKeyMatches({ hash: k.hash }, p));
  assert.equal(apiKeyMatches({ hash: k.hash }, parseApiKey(`wsl_${k.prefix}_${'x'.repeat(30)}`)), false);
  assert.equal(parseApiKey('nope'), null);
});
test('webhook signatures verify and reject replays/tampering', () => {
  const body = JSON.stringify({ a: 1 }); const t = 1_800_000_000;
  const h = signWebhook('s3cret', body, t);
  assert.ok(verifyWebhook('s3cret', body, h, { now: t + 10 }));
  assert.equal(verifyWebhook('s3cret', body, h, { now: t + 1000 }), false);
  assert.equal(verifyWebhook('s3cret', body + ' ', h, { now: t }), false);
  assert.equal(backoffMs(1), 30000); assert.equal(backoffMs(3), 120000);
});
test('Slack and Meta inbound signatures', () => {
  const ts = 1_800_000_000; const raw = 'text=hi';
  const sig = `v0=${createHmac('sha256', 'ss').update(`v0:${ts}:${raw}`).digest('hex')}`;
  assert.ok(verifySlack('ss', raw, ts, sig, ts)); assert.equal(verifySlack('ss', raw, ts, sig, ts + 999), false);
  assert.ok(verifyMeta('app', raw, `sha256=${createHmac('sha256', 'app').update(raw).digest('hex')}`));
});
test('uploads are validated by magic bytes', () => {
  assert.ok(validateUpload(Buffer.from('%PDF-1.7 ...'), 'application/pdf').ok);
  assert.equal(validateUpload(Buffer.from('MZ\x90\x00'), 'application/pdf').ok, false);
  assert.equal(validateUpload(Buffer.from('%PDF-1.7'), 'image/png').ok, false);
  assert.notEqual(respondentHash('k', 's1', 'e1'), respondentHash('k', 's2', 'e1'));
});

// ---------------- PDF ----------------
test('Arabic shaping uses contextual forms and lam-alef ligatures', () => {
  assert.equal(shapeArabic('لا'), 'ﻻ');
  assert.equal(shapeArabic('بب'), 'ﺑﺐ');
  assert.equal(shapeArabic('\u0631\u0627\u062A\u0628'), '\uFEAD\uFE8D\uFE97\uFE90'); // reh does not join left, so alef is isolated
  assert.equal(visualOrder('Salary 2026'), 'Salary 2026');
  assert.ok(visualOrder('راتب 2026').startsWith('2026'));
});
test('PDF documents are valid PDF files', () => {
  const est = { name: 'Al Noor', nameAr: 'النور', jurisdiction: 'MAINLAND', wps: {} };
  const e = { fullName: 'Ravi', employeeNo: 'A1', joinDate: new Date('2021-01-01'), compensation: { basicFils: 600000, housingFils: 200000, transportFils: 50000, allowances: [] }, bank: {} };
  for (const buf of [
    payslipPdf({ employee: e, establishment: est, run: { period: '2026-10', type: 'regular' }, line: { fixedFils: 850000, variableFils: 0, deductionsFils: 0, netFils: 850000 }, seal: { code: 'ABC' } }),
    letterPdf({ type: 'noc', employee: e, establishment: est, seal: { code: 'ABC' } }),
    offerPdf({ offer: { candidateName: 'Omar', jobTitle: 'Engineer', startDate: new Date('2026-11-01'), basicFils: 1320000, housingFils: 660000, transportFils: 220000, probationMonths: 6, noticeDays: 30 }, establishment: est, seal: { code: 'ABC' }, signature: { name: 'Omar', at: new Date(), ip: '1.1.1.1', docHash: 'abc' } }),
  ]) { const s = buf.toString('latin1'); assert.ok(s.startsWith('%PDF-1.7')); assert.ok(s.trimEnd().endsWith('%%EOF')); assert.match(s, /\/Type \/Catalog/); }
  const d = new PdfDoc(); assert.ok(d.width('abc', 10) > 10);
});

// ---------------- Agents ----------------
test('hire command fallback extraction + validation against grade bands', () => {
  const p = parseHireFallback("Hire Omar Al-Maktoum as Senior Frontend Engineer under Establishment Card #2 starting Nov 1st, AED 22,000 total package (60% basic, 30% housing, 10% transport), Mainland visa.");
  assert.equal(p.candidateName, 'Omar Al-Maktoum'); assert.equal(p.jobTitle, 'Senior Frontend Engineer'); assert.equal(p.totalPackageAed, 22000);
  assert.deepEqual(p.split, { basicPct: 60, housingPct: 30, transportPct: 10 }); assert.equal(p.establishmentRef, '#2'); assert.equal(p.visa, 'mainland');
  const v = validateHire({ ...p, startDate: '2099-11-01' }, { gradeBands: [{ grade: 'G7', minFils: 1500000, maxFils: 2500000 }], establishment: { jurisdiction: 'MAINLAND' } });
  assert.ok(v.ok); assert.equal(v.comp.basicFils + v.comp.housingFils + v.comp.transportFils, 2200000); assert.equal(v.comp.grade, 'G7');
  const bad = validateHire({ ...p, startDate: '2099-11-01', split: { basicPct: 40, housingPct: 40, transportPct: 10 } }, { establishment: null });
  assert.equal(bad.ok, false); assert.ok(bad.issues.length >= 2);
  assert.equal(onboardingSteps({ startDate: '2026-11-01' }).length, 9);
  assert.equal(parseLooseDate('starting 1 Nov 2027'), '2027-11-01');
});
test('copilot understands several languages without an API key', () => {
  const now = new Date('2026-10-21T08:00:00Z');
  const a = parseCopilotFallback('I want to apply for 3 days annual leave next week.', now);
  assert.equal(a.intent, 'leave'); assert.equal(a.params.days, 3); assert.equal(a.params.startDate, '2026-10-26');
  assert.equal(parseCopilotFallback('I need a salary certificate addressed to Emirates NBD', now).params.addressee, 'Emirates NBD');
  assert.equal(parseCopilotFallback('أريد إجازة 3 أيام من 12 نوفمبر', now).intent, 'leave');
  assert.equal(parseCopilotFallback('मुझे सैलरी सर्टिफिकेट चाहिए', now).intent, 'letter');
  assert.equal(parseCopilotFallback('ilan pa ang leave ko', now).intent, 'leave_balance');
  assert.equal(detectLang('مرحبا'), 'ar'); assert.equal(detectLang('नमस्ते'), 'hi'); assert.equal(detectLang('നമസ്കാരം'), 'ml');
  assert.match(reply('ar', 'balance', 10, 5), /10/); assert.match(reply('xx', 'unknown'), /Sorry/);
});
test('CV match score is explainable', () => {
  const m = matchScore({ skills: ['React', 'TypeScript'], totalYears: 5, inUae: true }, { requirements: ['react', 'node'] });
  assert.ok(m.score > 50); assert.deepEqual(m.missing, ['node']);
});

// ---------------- OIDC ----------------
test('OIDC ID token verification (RS256, iss, aud, exp, nonce)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const now = 1_800_000_000;
  const mk = (claims) => { const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url'); const p = Buffer.from(JSON.stringify(claims)).toString('base64url'); const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url'); return `${h}.${p}.${s}`; };
  const good = mk({ iss: 'https://idp', aud: 'cid', exp: now + 300, nonce: 'n', email: 'a@b.c' });
  assert.equal(verifyJwt(good, { keys: [jwk] }, { issuer: 'https://idp', audience: 'cid', nonce: 'n', now }).email, 'a@b.c');
  assert.throws(() => verifyJwt(good, { keys: [jwk] }, { issuer: 'https://evil', audience: 'cid', nonce: 'n', now }), /issuer/);
  assert.throws(() => verifyJwt(good, { keys: [jwk] }, { issuer: 'https://idp', audience: 'cid', nonce: 'x', now }), /nonce/);
  assert.throws(() => verifyJwt(good, { keys: [jwk] }, { issuer: 'https://idp', audience: 'cid', nonce: 'n', now: now + 9999 }), /expired/);
  assert.throws(() => verifyJwt(good.slice(0, -4) + 'AAAA', { keys: [jwk] }, { issuer: 'https://idp', audience: 'cid', now }), /signature/);
});

// ---------------- Rules registry ----------------
test('rule versions: compose, test, preview, tenant-scoped registration', () => {
  const rv = { tenantId: 'T1', packId: 'UAE-MAINLAND', version: '2027.1', effectiveFrom: '2027-01-01', status: 'approved', overrides: { gratuity: { daysPerYearFirst5: 25 } }, testCases: [{ name: 'path', input: { path: 'gratuity.daysPerYearFirst5' }, expect: { value: 25 } }] };
  const p = composePack(rv); assert.equal(p.gratuity.daysPerYearFirst5, 25); assert.equal(p.leave.annualDays, pack.leave.annualDays);
  assert.equal(runTestCases(rv).passed, true);
  const prev = recalcPreview(rv, [{ _id: 'e', fullName: 'E', joinDate: new Date('2020-01-01'), compensation: { basicFils: 600000, housingFils: 0, transportFils: 0 } }], { asOf: new Date('2027-06-30') });
  assert.equal(prev.length, 1);
  registerApproved([rv]);
  assert.equal(getRulePack(tenantPackId('UAE-MAINLAND', 'T1'), '2027-02-01').version, '2027.1');
  assert.throws(() => getRulePack(tenantPackId('UAE-MAINLAND', 'T2'), '2027-02-01')); // other tenant unaffected
  assert.equal(getRulePack('UAE-MAINLAND', '2027-02-01').gratuity.daysPerYearFirst5, pack.gratuity.daysPerYearFirst5); // code pack untouched
});

test('tenant rule pack still resolves dates before its first approved version', () => {
  registerApproved([{ tenantId: 'T9', packId: 'UAE-MAINLAND', version: '2028.1', effectiveFrom: '2028-01-01', status: 'approved', overrides: { leave: { annualDays: 32 } } }]);
  const id = tenantPackId('UAE-MAINLAND', 'T9');
  assert.equal(getRulePack(id, '2026-06-01').version, pack.version);
  assert.equal(getRulePack(id, '2028-02-01').leave.annualDays, 32);
});
