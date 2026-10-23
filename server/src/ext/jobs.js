// Background work for the extension modules, on the durable Mongo job queue.
// Periodic sweeps are idempotent (dedupe keys / state flags), so restarts and multiple instances are safe.
import { Tenant, AuditLog, PayrollRun, Attendance, Notification, User } from '../models/index.js';
import { runAsSystem, runWithTenant } from '../lib/tenantContext.js';
import { decryptField } from '../lib/fieldcrypt.js';
import { localParts } from '../lib/attendance.js';
import { notify } from '../lib/notify.js';
import { Webhook, WebhookDelivery, PayrollInputSync, Loan, ExpenseClaim, SavedReport, ExportLog, RuleVersion, Dependent, ImmigrationCase, ExtState, Job } from './models.js';
import { registerHandler, startWorker } from './lib/queue.js';
import { signWebhook } from './lib/platform.js';
import { registerApproved } from './lib/rulesRegistry.js';
import { ramadanOn, addDays } from './lib/time.js';
import { toCsv } from './lib/payrollPlus.js';
import { emitEvent } from './routes/_util.js';
import { runReport } from './routes/platform.js';

const DAY = 864e5;
const forEachTenant = async (fn) => { for (const t of await runAsSystem(() => Tenant.find().select('_id settings').lean())) { try { await runWithTenant({ tenantId: String(t._id) }, () => fn(t)); } catch (e) { console.warn(`ext job (tenant ${t._id}):`, e.message); } } };

// ---------------------------------------------------------------- webhook delivery (queue handler)
registerHandler('webhook.deliver', async ({ deliveryId }) => {
  const d = await WebhookDelivery.findById(deliveryId); if (!d || d.state === 'delivered') return 'skip';
  const w = await Webhook.findById(d.webhookId).select('+secretEnc').lean();
  if (!w || !w.active) { d.state = 'failed'; await d.save(); return 'webhook inactive'; }
  const body = JSON.stringify(d.payload); const t0 = Date.now();
  let status = 0, error;
  try {
    const res = await fetch(w.url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'user-agent': 'Wasl-Webhooks/1', 'wasl-event': d.event, 'wasl-delivery': String(d._id), 'wasl-signature': signWebhook(decryptField(w.secretEnc), body) }, body, signal: AbortSignal.timeout(10000) });
    status = res.status;
  } catch (e) { error = e.message; }
  d.attempts.push({ at: new Date(), status, ms: Date.now() - t0, error });
  const ok = status >= 200 && status < 300;
  d.state = ok ? 'delivered' : 'pending'; await d.save();
  await Webhook.updateOne({ _id: w._id }, { $set: { lastDeliveryAt: new Date(), lastStatus: status, ...(ok ? { failures: 0 } : {}) }, ...(ok ? {} : { $inc: { failures: 1 } }) });
  if (!ok) {
    if ((w.failures || 0) + 1 >= 50) await Webhook.updateOne({ _id: w._id }, { $set: { active: false } }); // auto-disable a dead endpoint
    throw new Error(error || `HTTP ${status}`);
  }
  return status;
});

// ---------------------------------------------------------------- audit log → webhook events (covers the MVP's actions)
const AUDIT_EVENTS = { 'employee.create': 'employee.created', 'employee.import': 'employee.created', 'employee.update': 'employee.updated', 'employee.bank.update': 'employee.updated', 'leave.create': 'leave.created', 'leave.approved': 'leave.approved', 'leave.rejected': 'leave.rejected', 'payroll.compute': 'payroll.computed', 'payroll.approve': 'payroll.approved', 'wps.sif.export': 'payroll.sif_exported', 'document.upload': 'document.uploaded', 'attendance.clock_in': 'attendance.clock_in', 'attendance.clock_out': 'attendance.clock_out' };
export async function dispatchAuditEvents() {
  const st = await ExtState.findOne({ key: 'audit-webhook-cursor' }).lean();
  const since = st?.value?.at ? new Date(st.value.at) : new Date(Date.now() - 60 * 1000);
  const rows = await runAsSystem(() => AuditLog.find({ createdAt: { $gt: since }, action: { $in: Object.keys(AUDIT_EVENTS) } }).sort({ createdAt: 1 }).limit(500).lean());
  for (const a of rows) {
    const hasHooks = await runAsSystem(() => Webhook.exists({ tenantId: a.tenantId, active: true }));
    if (hasHooks) await runWithTenant({ tenantId: String(a.tenantId) }, () => emitEvent(AUDIT_EVENTS[a.action], { entity: a.entity, entityId: a.entityId, change: a.after ?? null, at: a.createdAt }, `audit:${a._id}`)).catch((e) => console.warn('webhook emit:', e.message));
  }
  if (rows.length) await ExtState.updateOne({ key: 'audit-webhook-cursor' }, { $set: { value: { at: rows[rows.length - 1].createdAt } } }, { upsert: true });
  else if (!st) await ExtState.updateOne({ key: 'audit-webhook-cursor' }, { $set: { value: { at: new Date() } } }, { upsert: true });
  return rows.length;
}

// ---------------------------------------------------------------- after payroll approval: mark loans deducted, expenses paid
export async function settleSyncedInputs() {
  let n = 0;
  for (const s of await PayrollInputSync.find({ status: 'applied', settledAt: null })) {
    const run = await PayrollRun.findOne({ establishmentId: s.establishmentId, period: s.period, type: 'regular' }).lean();
    if (!run || !['approved', 'exported', 'paid'].includes(run.status)) continue;
    for (const l of s.lines) {
      const line = run.lines.find((x) => String(x.employeeId) === String(l.employeeId)); if (!line || line.held) continue;
      for (const loan of await Loan.find({ employeeId: l.employeeId, status: 'active' })) {
        let changed = false;
        loan.schedule.forEach((it) => { if (it.status === 'synced' && it.period <= s.period) { it.status = 'deducted'; changed = true; } });
        if (loan.schedule.every((it) => ['deducted', 'skipped'].includes(it.status))) { loan.status = 'closed'; changed = true; }
        if (changed) await loan.save();
      }
      await ExpenseClaim.updateMany({ employeeId: l.employeeId, status: 'queued_for_payroll', payrollPeriod: s.period }, { $set: { status: 'paid' } });
    }
    s.settledAt = new Date(); await s.save(); n++;
  }
  return n;
}

// ---------------------------------------------------------------- reminders: missed punches, dependents & immigration
export async function remindersSweep(now = new Date()) {
  const today = localParts(now).date;
  for (const r of await Attendance.find({ date: { $gte: addDays(today, -3), $lt: today }, 'clockOut.at': { $exists: false } }).select('employeeId date').lean())
    await notify({ audience: 'employee', employeeId: r.employeeId, title: `Missed clock-out on ${r.date}`, body: 'Open Attendance → Request a correction so your hours are counted.', link: '#eclock', severity: 'warn', dedupeKey: `missed:${r._id}` });
  for (const d of await Dependent.find({ residenceExpiry: { $gte: now, $lte: new Date(+now + 60 * DAY) } }).populate('employeeId', 'fullName').lean())
    await notify({ audience: 'hr', title: `Dependent visa expiring: ${d.name}`, body: `${d.employeeId?.fullName || ''} · ${d.residenceExpiry.toISOString().slice(0, 10)}`, link: '#people', severity: 'warn', dedupeKey: `dep:${d._id}:${d.residenceExpiry.toISOString().slice(0, 10)}` });
  for (const c of await ImmigrationCase.find({ status: { $in: ['open', 'blocked'] } }).lean()) {
    const late = c.steps.filter((s) => !['done', 'skipped'].includes(s.status) && s.dueDate && s.dueDate < now);
    if (late.length) await notify({ audience: 'hr', title: `Visa case overdue: ${c.subjectName}`, body: late.map((s) => s.name).join(', '), link: '#people', severity: 'bad', dedupeKey: `imm:${c._id}:${today}` });
    if (c.graceUntil && c.graceUntil < new Date(+now + 7 * DAY)) await notify({ audience: 'hr', title: `Grace period ending: ${c.subjectName}`, body: `Ends ${c.graceUntil.toISOString().slice(0, 10)}`, link: '#people', severity: 'bad', dedupeKey: `grace:${c._id}` });
  }
}

// ---------------------------------------------------------------- scheduled reports
const due = (s, last, now) => !last || now - last >= ({ daily: 1, weekly: 7, monthly: 30 }[s] * DAY - 3600 * 1000);
export async function scheduledReports(now = new Date()) {
  for (const s of await SavedReport.find({ schedule: { $ne: 'none' } })) {
    if (!due(s.schedule, s.lastRunAt, now)) continue;
    const owner = await User.findById(s.ownerUserId).lean(); if (!owner?.active) continue;
    const out = await runReport({ id: String(owner._id), roles: owner.roles, employeeId: owner.employeeId }, { entity: s.entity, columns: s.columns, filters: s.filters || {} });
    const csv = toCsv(out.columns.map((c) => c.label), out.rows); const filename = `${s.name.replace(/[^\w-]+/g, '_')}-${now.toISOString().slice(0, 10)}.csv`;
    let emailed = false;
    if (process.env.RESEND_API_KEY && process.env.MAIL_FROM && s.recipients?.length) {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM, to: s.recipients, subject: `Wasl report: ${s.name}`, text: `${out.rows.length} rows attached.`, attachments: [{ filename, content: Buffer.from(`﻿${csv}`).toString('base64') }] }), signal: AbortSignal.timeout(20000) }).catch(() => null);
      emailed = !!res?.ok;
    }
    await ExportLog.create({ userId: owner._id, reportId: s._id, entity: s.entity, columns: out.columns.map((c) => c.key), rows: out.rows.length, sensitive: out.sensitive, format: emailed ? 'email-csv' : 'scheduled' });
    await Notification.create({ audience: 'hr', userId: owner._id, title: `Scheduled report ready: ${s.name}`, body: emailed ? `Emailed to ${s.recipients.join(', ')}` : `${out.rows.length} rows · open Reports to export`, link: '#platform' }).catch(() => {});
    s.lastRunAt = now; await s.save();
  }
}

// ---------------------------------------------------------------- Ramadan auto-mode (platform-wide; explicit RAMADAN_MODE env wins)
const BUILT_IN_RAMADAN = [{ start: '2026-02-18', end: '2026-03-19' }, { start: '2027-02-08', end: '2027-03-09' }, { start: '2028-01-28', end: '2028-02-26' }]; // estimated, moon-sighting dependent
const RAMADAN_MANUAL = process.env.RAMADAN_MODE !== undefined;
export function ramadanTick(now = new Date()) {
  if (RAMADAN_MANUAL) return process.env.RAMADAN_MODE === 'true';
  const extra = (process.env.RAMADAN_DATES || '').split(',').map((x) => x.trim().split('..')).filter((x) => x.length === 2).map(([start, end]) => ({ start, end }));
  const on = !!ramadanOn(localParts(now).date, [...BUILT_IN_RAMADAN, ...extra]);
  process.env.RAMADAN_MODE = on ? 'true' : 'false';
  return on;
}

// ---------------------------------------------------------------- rule registry (load at boot, refresh for multi-instance)
export async function loadRuleRegistry() { const v = await runAsSystem(() => RuleVersion.find({ status: 'approved' }).lean()); return registerApproved(v); }

// ---------------------------------------------------------------- start
export async function initExtJobs() {
  await loadRuleRegistry().catch((e) => console.warn('Rule registry load:', e.message));
  ramadanTick();
  await runAsSystem(() => Promise.all([Job.syncIndexes(), ExtState.syncIndexes()])).catch(() => {});
  if (process.env.JOBS_ENABLED === 'false') return;
  startWorker();
  const every = (ms, name, fn) => { const run = async () => { try { await fn(); } catch (e) { console.warn(`${name}:`, e.message); } }; setTimeout(run, 15000).unref?.(); setInterval(run, ms).unref?.(); };
  every(30 * 1000, 'webhook dispatch', () => runAsSystem(dispatchAuditEvents));
  every(60 * 1000, 'rule registry refresh', loadRuleRegistry);
  every(15 * 60 * 1000, 'ramadan', async () => ramadanTick());
  every(10 * 60 * 1000, 'payroll settlement', () => forEachTenant(settleSyncedInputs));
  every(6 * 3600 * 1000, 'reminders', () => forEachTenant(() => remindersSweep()));
  every(3600 * 1000, 'scheduled reports', () => forEachTenant(() => scheduledReports()));
}
