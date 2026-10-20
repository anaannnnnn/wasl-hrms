import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { base32Encode, hotp, totp, verifyTotp, newSecret } from '../src/lib/totp.js';
import { encryptField, decryptField, isEncrypted } from '../src/lib/fieldcrypt.js';
import { retentionCutoffs, shouldAnonymise, anonymisedFields } from '../src/lib/retention.js';
import { toFils, filsToPlain } from '../src/lib/money.js';
import { preflight } from '../src/lib/wps.js';
import { buildUaeIban } from '../src/lib/iban.js';

test('totp: RFC 6238 SHA-1 test vectors', () => {
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(hotp(s, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(s, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(s, Math.floor(2000000000 / 30), 8), '69279037');
});

test('totp: accepts current and adjacent window, rejects others and junk', () => {
  const s = newSecret(); const now = 1_800_000_000_000;
  assert.ok(verifyTotp(s, totp(s, now), now));
  assert.ok(verifyTotp(s, totp(s, now - 30000), now));
  assert.ok(!verifyTotp(s, totp(s, now - 120000), now));
  assert.ok(!verifyTotp(s, 'abc123', now));
  assert.ok(!verifyTotp(s, '', now));
});

test('field encryption: round trip, random IV, tamper detection, key rotation', () => {
  const k1 = randomBytes(32).toString('hex'), k2 = randomBytes(32).toString('base64');
  process.env.FIELD_ENCRYPTION_KEY = k1;
  const a = encryptField('AE070331234567890123456'), b = encryptField('AE070331234567890123456');
  assert.ok(isEncrypted(a)); assert.notEqual(a, b);
  assert.equal(decryptField(a), 'AE070331234567890123456');
  assert.equal(encryptField(a), a, 'never double-encrypts');
  assert.equal(decryptField('plain-legacy-value'), 'plain-legacy-value');
  const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptField(tampered));
  process.env.FIELD_ENCRYPTION_KEY = k2; process.env.FIELD_ENCRYPTION_KEY_OLD = k1;
  assert.equal(decryptField(a), 'AE070331234567890123456', 'old key still decrypts during rotation');
  delete process.env.FIELD_ENCRYPTION_KEY; delete process.env.FIELD_ENCRYPTION_KEY_OLD;
  assert.equal(encryptField('x'), 'x', 'no key configured: stored as-is (development)');
});

test('retention: cutoffs and anonymisation respect legal hold', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const c = retentionCutoffs({ exitedEmployeeYears: 5 }, now);
  assert.equal(c.notificationsBefore.toISOString().slice(0, 10), '2026-04-23');
  const old = { status: 'exited', exitDate: '2020-01-01', employeeNo: 'X-1' };
  assert.ok(shouldAnonymise(old, c.exitedBefore));
  assert.ok(!shouldAnonymise({ ...old, legalHold: true }, c.exitedBefore));
  assert.ok(!shouldAnonymise({ ...old, exitDate: '2025-01-01' }, c.exitedBefore));
  assert.ok(!shouldAnonymise({ ...old, status: 'active' }, c.exitedBefore));
  const f = anonymisedFields(old);
  assert.equal(f.fullName, 'Former employee X-1'); assert.equal(f['bank.iban'], null);
});

// Property-style checks (PRD A5): money rounding and WPS totals over many random inputs
test('money: random AED strings round-trip exactly through fils', () => {
  for (let i = 0; i < 2000; i++) {
    const aed = `${Math.floor(Math.random() * 1e6)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
    assert.equal(filsToPlain(toFils(aed)), aed.replace(/^0+(?=\d)/, ''));
  }
});

test('wps: SCR total always equals the sum of EDR rows for random batches', () => {
  for (let n = 0; n < 50; n++) {
    const rows = Array.from({ length: 1 + Math.floor(Math.random() * 40) }, (_, i) => ({
      name: `E${i}`, labourCardNo: String(94821370000000 + n * 100 + i), routingCode: '302620122', iban: buildUaeIban('026', String(10000 + n * 100 + i)),
      periodStart: '2026-10-01', periodEnd: '2026-10-31', days: 31, fixedFils: Math.floor(Math.random() * 5_000_000), variableFils: Math.floor(Math.random() * 300_000), leaveDays: 0,
    }));
    const pf = preflight({ establishment: { mohreId: '1000000042817', agentRoutingCode: '302620122' }, salaryMonth: '2026-10', createdAt: new Date('2026-10-20T10:00:00Z'), rows });
    assert.equal(pf.checks.find((c) => c.id === 'TOTALS').status, 'pass');
    assert.equal(pf.totalFils, rows.reduce((a, r) => a + r.fixedFils + r.variableFils, 0));
  }
});
