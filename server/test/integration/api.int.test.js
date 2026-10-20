// Integration tests against a real MongoDB. Run with:  MONGO_URI_TEST=mongodb://localhost:27017/wasl_test npm run test:integration
// Skipped automatically when MONGO_URI_TEST is not set (CI provides a MongoDB service).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.MONGO_URI_TEST;
const skip = !URI && 'MONGO_URI_TEST not set';
let server, base, mongoose, M, ctx, bcrypt;
const tokens = {};

async function call(path, { method = 'GET', body, as } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

before(async () => {
  if (skip) return;
  process.env.MONGO_URI = URI; process.env.JWT_SECRET = 'test-secret'; process.env.JOBS_ENABLED = 'false';
  process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
  mongoose = (await import('mongoose')).default;
  bcrypt = (await import('bcryptjs')).default;
  M = await import('../../src/models/index.js');
  ctx = await import('../../src/lib/tenantContext.js');
  const { buildUaeIban } = await import('../../src/lib/iban.js');
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(M).filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const hash = await bcrypt.hash('pw', 4);
  for (const name of ['A', 'B']) {
    const t = await M.Tenant.create({ name: `Tenant ${name}` });
    await ctx.runWithTenant({ tenantId: String(t._id) }, async () => {
      const est = await M.Establishment.create({ name: `Est ${name}`, jurisdiction: 'MAINLAND', mohreId: name === 'A' ? '1000000000001' : '1000000000002', wps: { agentRoutingCode: '302620122' } });
      const e = await M.Employee.create({ establishmentId: est._id, employeeNo: `${name}-1`, fullName: `Worker ${name}`, joinDate: new Date('2020-01-01'), compensation: { basicFils: 500000, housingFils: 200000, transportFils: 50000 }, bank: { iban: buildUaeIban('026', '1000000000000001'), routingCode: '302620122' }, labourCardNo: name === 'A' ? '94821370000001' : '94821370000002' });
      await M.User.create([
        { email: `maker${name}@t.test`, name: `Maker ${name}`, passwordHash: hash, roles: ['hr_admin', 'payroll_maker'] },
        { email: `checker${name}@t.test`, name: `Checker ${name}`, passwordHash: hash, roles: ['payroll_checker'] },
        { email: `emp${name}@t.test`, name: `Worker ${name}`, passwordHash: hash, roles: ['employee'], employeeId: e._id },
      ]);
    });
  }
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}/api`;
  for (const n of ['makerA', 'checkerA', 'empA', 'makerB']) tokens[n] = (await call('/auth/login', { method: 'POST', body: { email: `${n}@t.test`, password: 'pw' } })).body.token;
});
after(async () => { if (skip) return; server?.close(); await mongoose.disconnect(); });

test('tenant isolation: each tenant sees only its own employees', { skip }, async () => {
  const a = await call('/employees', { as: 'makerA' }); const b = await call('/employees', { as: 'makerB' });
  assert.deepEqual(a.body.map((e) => e.fullName), ['Worker A']);
  assert.deepEqual(b.body.map((e) => e.fullName), ['Worker B']);
});

test('tenant isolation: fetching another tenant\'s record by id fails', { skip }, async () => {
  const a = await call('/employees', { as: 'makerA' });
  const otherId = a.body[0]._id;
  const r = await call(`/employees/${otherId}/export`, { as: 'makerB' });
  assert.equal(r.body.employee, null);
});

test('tenant isolation: a query without tenant context is blocked', { skip }, async () => {
  await assert.rejects(() => M.Employee.find().exec(), /Tenant context missing/);
});

test('encryption: IBAN and labour card are ciphertext in the database, masked in the API', { skip }, async () => {
  const raw = await mongoose.connection.collection('employees').findOne({ employeeNo: 'A-1' });
  assert.match(raw.bank.iban, /^enc:v1:/); assert.match(raw.labourCardNo, /^enc:v1:/);
  const api = (await call('/employees', { as: 'makerA' })).body[0];
  assert.equal(api.bank.iban, undefined); assert.match(api.bank.ibanMasked, /AE•• •••• \d{4}/); assert.equal(api.ibanValid, true);
});

test('employees cannot reach HR data, only their own workspace', { skip }, async () => {
  assert.equal((await call('/employees', { as: 'empA' })).status, 403);
  assert.equal((await call('/payroll/runs', { as: 'empA' })).status, 403);
  const me = await call('/me/profile', { as: 'empA' });
  assert.equal(me.status, 200); assert.equal(me.body.fullName, 'Worker A');
});

test('payroll end to end: compute → submit → checker approves → SIF exports with matching totals', { skip }, async () => {
  const [est] = (await call('/establishments', { as: 'makerA' })).body;
  const period = new Date().toISOString().slice(0, 7);
  const run = (await call('/payroll/runs', { method: 'POST', as: 'makerA', body: { establishmentId: est._id, period } })).body;
  assert.equal(run.lines.length, 1);
  assert.equal((await call(`/payroll/runs/${run._id}/submit`, { method: 'POST', as: 'makerA' })).body.status, 'pending_approval');
  assert.equal((await call(`/payroll/runs/${run._id}/approve`, { method: 'POST', as: 'makerA' })).status, 403, 'maker cannot approve own run');
  assert.equal((await call(`/payroll/runs/${run._id}/approve`, { method: 'POST', as: 'checkerA' })).body.status, 'approved');
  const sif = (await call(`/payroll/runs/${run._id}/sif`, { method: 'POST', as: 'checkerA' })).body;
  assert.match(sif.filename, /^1000000000001\d{12}\.sif$/);
  const lines = sif.content.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^EDR,94821370000001,302620122,AE/);
  const slip = await call(`/me/payslips/${run._id}`, { as: 'empA' });
  assert.equal(slip.status, 200); assert.match(slip.body, /Net pay/);
});

test('leave policy: preview splits pay; employee can only request for self', { skip }, async () => {
  const pv = await call('/leave', { method: 'POST', as: 'empA', body: { type: 'sick', startDate: '2026-11-02', endDate: '2026-11-21', preview: true } });
  assert.equal(pv.body.split.fullDays, 15); assert.equal(pv.body.split.halfDays, 5);
});

test('login lockout after 5 wrong passwords', { skip }, async () => {
  for (let i = 0; i < 5; i++) await call('/auth/login', { method: 'POST', body: { email: 'checkerB@t.test', password: 'wrong' } });
  const r = await call('/auth/login', { method: 'POST', body: { email: 'checkerB@t.test', password: 'pw' } });
  assert.equal(r.status, 423);
});
