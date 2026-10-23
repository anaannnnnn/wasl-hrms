process.env.JWT_SECRET = 'smoke'; process.env.JOBS_ENABLED = 'false';
const mongoose = (await import('mongoose')).default;
mongoose.set('bufferCommands', false);
const { createApp } = await import('../../src/app.js');
const { signToken } = await import('../../src/middleware/auth.js');
const app = createApp(); const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const T = (roles, eid) => signToken({ _id: '64b000000000000000000001', tenantId: '64b0000000000000000000aa', roles, name: 'X', employeeId: eid });
const hr = T(['hr_admin', 'payroll_maker']), emp = T(['employee'], '64b0000000000000000000e1'), mgr = T(['manager']);
const call = async (m, p, tok, body) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j; try { j = await r.json(); } catch { j = null; } return { s: r.status, j }; };
const checks = [
  ['GET', '/healthz', null, null, 200],
  ['GET', '/metrics', null, null, 200],
  ['POST', '/api/loans', hr, { kind: 'loan' }, 400],              // validation before DB
  ['POST', '/api/loans', emp, {}, 403],                           // employee blocked from staff routes
  ['POST', '/api/me/loans', emp, { kind: 'x' }, 400],
  ['POST', '/api/shifts', mgr, {}, 403],                           // manager can't create shifts (HR only)
  ['POST', '/api/shifts', hr, { name: 'Night', code: 'N', segments: [{ start: '25:00', end: '06:00' }] }, 400],
  ['PUT', '/api/roster', hr, { entries: [] }, 400],
  ['POST', '/api/me/expenses', emp, { category: 'meals' }, 400],
  ['POST', '/api/grade-bands', hr, { grade: 'G1', min: 100, max: 50 }, 400],
  ['POST', '/api/offers', hr, {}, 400],
  ['POST', '/api/reports/run', hr, { entity: 'nope' }, 400],
  ['POST', '/api/api-keys', mgr, { name: 'x', scopes: ['employees:read'] }, 403],
  ['POST', '/api/webhooks', hr, { url: 'not a url', events: [] }, 400],
  ['POST', '/api/rules/registry', hr, {}, 400],
  ['POST', '/api/agent2/propose', hr, { command: 'hi' }, 400],
  ['POST', '/api/me/copilot', emp, { text: '' }, 400],
  ['POST', '/api/me/copilot/voice', emp, { audio: 'AAAA', mime: 'audio/webm' }, 501], // no STT provider configured
  ['GET', '/api/v1/employees', null, null, 401],
  ['GET', '/api/v1/employees', 'wsl_badkey', null, 401],
  ['POST', '/api/public/devices/punch', null, { events: [] }, 'db'],
  ['GET', '/api/public/whatsapp/webhook?hub.verify_token=x&hub.challenge=1', null, null, 403],
  ['POST', '/api/public/whatsapp/webhook', null, { entry: [] }, 401],
  ['POST', '/api/public/slack/command', null, null, 401],
  ['GET', '/api/public/careers/not-an-id', null, null, 404],
  ['GET', '/api/me/payslips/64b000000000000000000001/pdf', null, null, 401],
  ['GET', '/api/payroll/overtime?establishmentId=bad&period=2026-10', hr, null, 400],
  ['POST', '/api/payroll/inputs/sync/preview', hr, { establishmentId: 'x' }, 400],
  ['GET', '/api/insights/attrition', mgr, null, 403],
  ['POST', '/api/me/attendance/disputes', emp, { date: '2099-01-01', kind: 'missed_punch', reason: 'forgot to clock out' }, 400],
  ['POST', '/api/me/surveys/64b000000000000000000001', emp, { answers: { q1: 11 } }, 'db'],
  ['GET', '/api/employees', hr, null, 'db'],                       // an existing MVP route still reached normally
  ['POST', '/api/auth/login', null, { email: 'a@b.c', password: 'x' }, 'db'],
];
let bad = 0;
for (const [m, p, tok, body, want] of checks) {
  const r = await call(m, p, tok, body);
  const ok = want === 'db' ? r.s >= 400 && r.s !== 404 : r.s === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${m} ${p} -> ${r.s}${ok ? '' : ` (wanted ${want}) ${JSON.stringify(r.j).slice(0, 160)}`}`);
}
srv.close(); console.log(bad ? `${bad} failed` : 'ALL OK'); process.exit(bad ? 1 : 0);
