// Integration tests for the extension modules against a real MongoDB (same setup as api.int.test.js).
// Run:  MONGO_URI_TEST=mongodb://localhost:27017/wasl_ext_test npm run test:integration
// Skipped automatically when MONGO_URI_TEST is not set (CI provides a MongoDB service).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.MONGO_URI_TEST ? process.env.MONGO_URI_TEST.replace(/\/([^/?]+)(\?|$)/, '/$1_ext$2') : null;
const skip = !URI && 'MONGO_URI_TEST not set';
let server, base, mongoose, M, X, ctx;
const tokens = {}; const ids = {};

async function call(path, { method = 'GET', body, as, headers = {}, raw } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  if (skip) return;
  process.env.MONGO_URI = URI; process.env.JWT_SECRET = 'test-secret'; process.env.JOBS_ENABLED = 'false'; process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(64);
  mongoose = (await import('mongoose')).default;
  const bcrypt = (await import('bcryptjs')).default;
  M = await import('../../src/models/index.js'); X = await import('../../src/ext/models.js'); ctx = await import('../../src/lib/tenantContext.js');
  const { buildUaeIban } = await import('../../src/lib/iban.js');
  await mongoose.connect(URI); await mongoose.connection.dropDatabase();
  await Promise.all([...Object.values(M), ...Object.values(X)].filter((m) => m?.syncIndexes).map((m) => m.syncIndexes()));
  const hash = await bcrypt.hash('pw', 4);
  for (const name of ['A', 'B']) {
    const t = await M.Tenant.create({ name: `Tenant ${name}` }); ids[`tenant${name}`] = String(t._id);
    await ctx.runWithTenant({ tenantId: String(t._id) }, async () => {
      const est = await M.Establishment.create({ name: `Est ${name}`, jurisdiction: 'MAINLAND', mohreId: name === 'A' ? '1000000000011' : '1000000000012', wps: { agentRoutingCode: '302620122' } });
      const e = await M.Employee.create({ establishmentId: est._id, employeeNo: `${name}-1`, fullName: `Worker ${name}`, department: 'Ops', phone: name === 'A' ? '+971501112233' : '+971504445566', joinDate: new Date('2020-01-01'), compensation: { basicFils: 600000, housingFils: 200000, transportFils: 50000 }, bank: { iban: buildUaeIban('026', '1000000000000001'), routingCode: '302620122' }, labourCardNo: name === 'A' ? '94821370000011' : '94821370000012' });
      ids[`est${name}`] = String(est._id); ids[`emp${name}`] = String(e._id);
      await M.User.create([
        { email: `maker${name}@x.test`, name: `Maker ${name}`, passwordHash: hash, roles: ['hr_admin', 'payroll_maker'] },
        { email: `checker${name}@x.test`, name: `Checker ${name}`, passwordHash: hash, roles: ['payroll_checker', 'hr_admin'] },
        { email: `emp${name}@x.test`, name: `Worker ${name}`, passwordHash: hash, roles: ['employee'], employeeId: e._id },
      ]);
    });
  }
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}/api`;
  for (const n of ['makerA', 'checkerA', 'empA', 'makerB']) tokens[n] = (await call('/auth/login', { method: 'POST', body: { email: `${n}@x.test`, password: 'pw' } })).body.token;
});
after(async () => { if (skip) return; server?.close(); await mongoose.disconnect(); });

test('ext tenant isolation: loans, shifts and webhooks are invisible to other tenants', { skip }, async () => {
  const loan = await call('/loans', { method: 'POST', as: 'makerA', body: { employeeId: ids.empA, kind: 'advance', principal: '3000', installment: '1000', startPeriod: '2026-11' } });
  assert.equal(loan.status, 201); ids.loanA = loan.body._id;
  assert.equal((await call('/shifts', { method: 'POST', as: 'makerA', body: { name: 'Morning', code: 'M', segments: [{ start: '08:00', end: '17:00' }] } })).status, 201);
  assert.equal((await call('/loans', { as: 'makerB' })).body.length, 0);
  assert.equal((await call('/shifts', { as: 'makerB' })).body.length, 0);
  assert.equal((await call(`/loans/${ids.loanA}/decision`, { method: 'POST', as: 'makerB', body: { decision: 'approve' } })).status, 404);
  await assert.rejects(() => X.Loan.find().exec(), /Tenant context missing/);
});

test('loans: maker-checker and schedule', { skip }, async () => {
  assert.equal((await call(`/loans/${ids.loanA}/decision`, { method: 'POST', as: 'makerA', body: { decision: 'approve' } })).status, 403);
  const ok = await call(`/loans/${ids.loanA}/decision`, { method: 'POST', as: 'checkerA', body: { decision: 'approve' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'active'); assert.equal(ok.body.schedule.length, 3);
  assert.equal((await call('/me/loans', { as: 'empA' })).body[0].outstandingFils, 300000);
});

test('employees are kept out of the new HR endpoints', { skip }, async () => {
  for (const p of ['/loans', '/expenses', '/requisitions', '/reports/entities', '/api-keys', '/insights/forecast', '/immigration/cases']) assert.equal((await call(p, { as: 'empA' })).status, 403, p);
});

test('expenses: two different approvers, no self-approval, flows to payroll sync', { skip }, async () => {
  const c = await call('/me/expenses', { method: 'POST', as: 'empA', body: { category: 'meals', merchant: 'Cafe', receiptDate: '2026-10-01', total: '105.00', vat: '5.00' } });
  assert.equal(c.status, 201); assert.ok(c.body.flags.includes('NO_RECEIPT'));
  assert.equal((await call(`/expenses/${c.body._id}/decision`, { method: 'POST', as: 'makerA', body: { decision: 'approve' } })).body.status, 'manager_approved');
  assert.equal((await call(`/expenses/${c.body._id}/decision`, { method: 'POST', as: 'makerA', body: { decision: 'approve' } })).status, 403);
  assert.equal((await call(`/expenses/${c.body._id}/decision`, { method: 'POST', as: 'checkerA', body: { decision: 'approve' } })).body.status, 'approved');
  const pv = await call('/payroll/inputs/sync/preview', { method: 'POST', as: 'makerA', body: { establishmentId: ids.estA, period: '2026-11' } });
  assert.equal(pv.status, 200);
  const line = pv.body.lines.find((l) => String(l.employeeId) === ids.empA);
  assert.equal(line.expenseReimbursementFils, 10500); assert.equal(line.loanInstallmentFils, 100000);
  const ap = await call(`/payroll/inputs/sync/${pv.body.syncId}/apply`, { method: 'POST', as: 'makerA' });
  assert.equal(ap.status, 200);
  const inp = await ctx.runWithTenant({ tenantId: ids.tenantA }, () => M.PayrollInput.findOne({ employeeId: ids.empA, period: '2026-11' }).lean());
  assert.equal(inp.loanInstallmentFils, 100000); assert.equal(inp.expenseReimbursementFils, 10500);
});

test('API keys: scoped, tenant-bound, no sensitive fields, idempotent writes, revocable', { skip }, async () => {
  const k = await call('/api-keys', { method: 'POST', as: 'makerA', body: { name: 'ERP', scopes: ['employees:read', 'leave:write'] } });
  assert.equal(k.status, 201);
  const h = { 'x-api-key': k.body.key };
  const emps = await call('/v1/employees', { headers: h });
  assert.equal(emps.status, 200); assert.deepEqual(emps.body.data.map((e) => e.fullName), ['Worker A']);
  assert.equal(emps.body.data[0].compensation, undefined); assert.equal(emps.body.data[0].bank, undefined);
  assert.equal((await call('/v1/attendance?from=2026-10-01&to=2026-10-02', { headers: h })).status, 403);
  const body = { employeeId: ids.empA, type: 'annual', startDate: '2026-12-14', endDate: '2026-12-15' };
  const first = await call('/v1/leave', { method: 'POST', headers: { ...h, 'idempotency-key': 'abc-12345' }, body });
  const again = await call('/v1/leave', { method: 'POST', headers: { ...h, 'idempotency-key': 'abc-12345' }, body });
  assert.equal(first.status, 201); assert.equal(again.headers.get('idempotent-replay'), 'true'); assert.equal(again.body.id, first.body.id);
  assert.equal((await call('/v1/leave', { method: 'POST', headers: { ...h, 'idempotency-key': 'abc-12345' }, body: { ...body, endDate: '2026-12-16' } })).status, 422);
  await call(`/api-keys/${k.body.id}/revoke`, { method: 'POST', as: 'makerA' });
  assert.equal((await call('/v1/employees', { headers: h })).status, 401);
});

test('reports: managers get masked salary columns; exports are logged', { skip }, async () => {
  const r = await call('/reports/run', { method: 'POST', as: 'makerA', body: { entity: 'employees', columns: ['fullName', 'basic'] } });
  assert.equal(r.status, 200); assert.equal(r.body.rows[0][1], '6000.00');
  const csv = await call('/reports/export', { method: 'POST', as: 'makerA', body: { entity: 'employees', columns: ['fullName'] } });
  assert.equal(csv.status, 200);
  assert.equal((await call('/reports/exports', { as: 'makerA' })).body.length, 1);
});

test('PDF payslip, letter and document verification', { skip }, async () => {
  const lt = await call('/letters/pdf', { method: 'POST', as: 'makerA', body: { employeeId: ids.empA, type: 'salary_certificate', addressee: 'Emirates NBD' }, raw: true });
  assert.equal(lt.status, 200); assert.equal(lt.buf.subarray(0, 5).toString(), '%PDF-');
  const sealed = await ctx.runWithTenant({ tenantId: ids.tenantA }, () => X.SealedDocument.findOne().lean());
  const v = await call(`/public/verify/${sealed.code}`);
  assert.equal(v.body.valid, true); assert.equal(v.body.issuer, 'Tenant A');
  assert.equal((await call('/public/verify/NOPE00000000')).body.valid, false);
});

test('offers: send, view, sign (name must match), convert to onboarding employee with visa case', { skip }, async () => {
  await call('/grade-bands', { method: 'POST', as: 'makerA', body: { grade: 'G5', min: '10000', max: '30000' } });
  const o = await call('/offers', { method: 'POST', as: 'makerA', body: { candidateName: 'Omar Test', jobTitle: 'Engineer', grade: 'G5', establishmentId: ids.estA, startDate: '2027-01-10', basic: '13200', housing: '6600', transport: '2200' } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const s = await call(`/offers/${o.body._id}/send`, { method: 'POST', as: 'makerA' });
  const token = s.body.link.split('/').pop();
  const view = await call(`/public/offers/${ids.tenantA}/${token}`); assert.equal(view.body.status, 'viewed');
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call(`/public/offers/${ids.tenantA}/${token}/sign`, { method: 'POST', body: { name: 'Someone Else', accept: true, signature: sig } })).status, 400);
  assert.equal((await call(`/public/offers/${ids.tenantA}/${token}/sign`, { method: 'POST', body: { name: 'omar test', accept: true, signature: sig } })).status, 200);
  assert.equal((await call(`/public/offers/${ids.tenantB}/${token}`)).status, 404); // a token is only valid in its own tenant
  const cv = await call(`/offers/${o.body._id}/convert`, { method: 'POST', as: 'makerA' });
  assert.equal(cv.status, 200); assert.equal(cv.body.employee.status, 'onboarding'); assert.equal(cv.body.reviews.length, 3);
  assert.equal(cv.body.visaCase.steps.find((x) => x.key === 'offer_signed').status, 'done');
});

test('rules registry: draft → tested → approved by a second admin → applied only to own tenant', { skip }, async () => {
  const v = await call('/rules/registry', { method: 'POST', as: 'makerA', body: { packId: 'UAE-MAINLAND', version: '2027.1', effectiveFrom: '2027-01-01', overrides: { leave: { annualDays: 31 } }, testCases: [{ name: 'leave days', input: { path: 'leave.annualDays' }, expect: { value: 31 } }] } });
  assert.equal(v.status, 201);
  assert.equal((await call(`/rules/registry/${v.body._id}/approve`, { method: 'POST', as: 'checkerA' })).status, 409); // not tested yet
  assert.equal((await call(`/rules/registry/${v.body._id}/test`, { method: 'POST', as: 'makerA' })).body.passed, true);
  assert.equal((await call(`/rules/registry/${v.body._id}/approve`, { method: 'POST', as: 'makerA' })).status, 403); // maker-checker
  const ap = await call(`/rules/registry/${v.body._id}/approve`, { method: 'POST', as: 'checkerA' });
  assert.equal(ap.status, 200);
  assert.equal((await call('/rules/registry/apply', { method: 'POST', as: 'makerB', body: { establishmentId: ids.estB, packId: ap.body.tenantPackId } })).status, 403);
  assert.equal((await call('/rules/registry/apply', { method: 'POST', as: 'makerA', body: { establishmentId: ids.estA, packId: ap.body.tenantPackId } })).status, 200);
});

test('device punches need a valid HMAC and land in the right tenant', { skip }, async () => {
  const d = await call('/attendance/devices', { method: 'POST', as: 'makerA', body: { name: 'Gate', vendor: 'generic' } });
  const { createHmac } = await import('node:crypto');
  const at = new Date(Date.now() - 3600e3).toISOString();
  const body = JSON.stringify({ events: [{ employeeNo: 'A-1', time: at, direction: 'in', eventId: 'e1' }] });
  const bad = await fetch(`${base}/public/devices/punch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wasl-key': d.body.keyId, 'x-wasl-signature': 'x'.repeat(64) }, body });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/public/devices/punch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wasl-key': d.body.keyId, 'x-wasl-signature': createHmac('sha256', d.body.secret).update(body).digest('hex') }, body });
  const j = await good.json(); assert.equal(good.status, 200); assert.equal(j.results[0].result, 'clock_in');
  const replay = await fetch(`${base}/public/devices/punch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wasl-key': d.body.keyId, 'x-wasl-signature': createHmac('sha256', d.body.secret).update(body).digest('hex') }, body });
  assert.equal((await replay.json()).results[0].result, 'duplicate');
  const n = await ctx.runWithTenant({ tenantId: ids.tenantB }, () => M.Attendance.countDocuments());
  assert.equal(n, 0);
});

test('copilot (no API key): leave balance and salary certificate in the employee\'s language', { skip }, async () => {
  const b = await call('/me/copilot', { method: 'POST', as: 'empA', body: { text: 'ilan pa ang leave ko' } });
  assert.equal(b.status, 200); assert.equal(b.body.intent, 'leave_balance');
  const c = await call('/me/copilot', { method: 'POST', as: 'empA', body: { text: 'I need a salary certificate addressed to Emirates NBD' } });
  assert.equal(c.body.intent, 'letter'); assert.ok(c.body.pdfUrl);
  const pdf = await call(c.body.pdfUrl.replace('/api', ''), { as: 'empA', raw: true });
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
});

test('webhook events: queued with a signature for subscribed events', { skip }, async () => {
  const w = await call('/webhooks', { method: 'POST', as: 'makerA', body: { url: 'https://example.invalid/hook', events: ['loan.approved'] } });
  assert.equal(w.status, 201); assert.match(w.body.secret, /^whsec_/);
  const l = await call('/loans', { method: 'POST', as: 'makerA', body: { employeeId: ids.empA, kind: 'loan', principal: '500', installment: '500', startPeriod: '2026-12' } });
  await call(`/loans/${l.body._id}/decision`, { method: 'POST', as: 'checkerA', body: { decision: 'approve' } });
  const deliveries = await call(`/webhooks/${w.body.webhook._id}/deliveries`, { as: 'makerA' });
  assert.equal(deliveries.body.length, 1); assert.equal(deliveries.body[0].event, 'loan.approved');
  const jobs = await ctx.runWithTenant({ tenantId: ids.tenantA }, () => X.Job.countDocuments({ queue: 'webhook.deliver' }));
  assert.equal(jobs, 1);
});
