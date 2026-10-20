// Daily compliance jobs, run in-process for every tenant (no Redis needed for a single instance).
// Idempotent: every alert has a dedupe key, so re-running the job or restarting the server never double-notifies.
// For multiple app instances, set JOBS_ENABLED=false on all but one (or move these to BullMQ workers).
import { Tenant, Establishment, Employee, ComplianceDocument, Notification, AgentRun, WpsSifBatch } from '../models/index.js';
import { retentionCutoffs, anonymisedFields, shouldAnonymise } from '../lib/retention.js';
import { runAsSystem, runWithTenant } from '../lib/tenantContext.js';
import { assessEmiratisation } from '../lib/emiratisation.js';
import { notify } from '../lib/notify.js';
import { dueThreshold } from '../lib/alerts.js';

const DAY = 86400000;

export async function runExpiryAlerts(tenantId, now = new Date()) {
  let sent = 0;
  await runWithTenant({ tenantId: String(tenantId), system: false }, async () => {
    const docs = await ComplianceDocument.find({ expiryDate: { $lte: new Date(now.getTime() + 90 * DAY) } }).populate('employeeId', 'fullName email phone').populate('establishmentId', 'name');
    for (const d of docs) {
      const daysLeft = Math.ceil((d.expiryDate - now) / DAY);
      const t = dueThreshold(daysLeft, (d.alertsSent || []).map((a) => a.daysBefore));
      if (t === null) continue;
      const holder = d.employeeId?.fullName || d.establishmentId?.name || 'Company';
      const what = d.docType.replace(/_/g, ' ');
      const title = t === 0 ? `${holder}: ${what} has expired` : `${holder}: ${what} expires in ${daysLeft} days`;
      await notify({ audience: 'hr', title, body: `Expiry date ${d.expiryDate.toISOString().slice(0, 10)}. Open the Document Radar to start the renewal.`, link: '#docs', severity: t <= 7 ? 'bad' : t <= 30 ? 'warn' : 'info', dedupeKey: `doc:${d._id}:${t}` });
      if (d.employeeId && t <= 30) {
        await notify({ audience: 'employee', employeeId: d.employeeId._id, title: `Your ${what} ${t === 0 ? 'has expired' : `expires in ${daysLeft} days`}`, body: 'HR will contact you about the renewal. Please keep your documents ready.', severity: 'warn', dedupeKey: `doc-emp:${d._id}:${t}` }, { email: d.employeeId.email, phone: d.employeeId.phone });
      }
      d.alertsSent.push({ daysBefore: t, sentAt: now });
      await d.save();
      sent++;
    }
  });
  return sent;
}

export async function runEmiratisationAlerts(tenantId, now = new Date()) {
  await runWithTenant({ tenantId: String(tenantId) }, async () => {
    for (const est of await Establishment.find({ jurisdiction: 'MAINLAND' }).lean()) {
      const a = assessEmiratisation({ employees: await Employee.find({ establishmentId: est._id }).lean(), establishment: est, onDate: now });
      for (const al of a.alerts || []) {
        await notify({ audience: 'hr', title: `${est.name}: ${al.msg}`, body: a.monthlyExposureFils ? `Projected fine AED ${(a.monthlyExposureFils / 100).toLocaleString('en-AE')}/month.` : 'Open Emiratisation to review.', link: '#emi', severity: al.severity, dedupeKey: `emi:${est._id}:${al.code}:${now.toISOString().slice(0, 7)}` });
      }
    }
  });
}

// PDPL retention: purge expired operational data and anonymise long-exited employees (unless on legal hold).
export async function runRetention(tenant, now = new Date()) {
  const c = retentionCutoffs(tenant.settings?.retention, now);
  return runWithTenant({ tenantId: String(tenant._id) }, async () => {
    const n = await Notification.deleteMany({ createdAt: { $lt: c.notificationsBefore } });
    const a = await AgentRun.deleteMany({ createdAt: { $lt: c.agentRunsBefore } });
    const s = await WpsSifBatch.deleteMany({ createdAt: { $lt: c.sifBefore } });
    let anon = 0;
    for (const e of await Employee.find({ status: 'exited', anonymisedAt: { $exists: false } }).lean()) {
      if (!shouldAnonymise(e, c.exitedBefore)) continue;
      await Employee.updateOne({ _id: e._id }, { $set: anonymisedFields(e) });
      anon++;
    }
    return { notifications: n.deletedCount, agentRuns: a.deletedCount, sifFiles: s.deletedCount, anonymised: anon };
  });
}

export async function runDailyJobs(now = new Date()) {
  const tenants = await runAsSystem(() => Tenant.find().lean());
  for (const t of tenants) {
    try { await runExpiryAlerts(t._id, now); await runEmiratisationAlerts(t._id, now); await runRetention(t, now); } catch (e) { console.error(`[jobs] tenant ${t._id}:`, e.message); }
  }
}

export function startScheduler() {
  if (process.env.JOBS_ENABLED === 'false') return;
  const tick = () => runDailyJobs().catch((e) => console.error('[jobs]', e.message));
  setTimeout(tick, 15000); // shortly after boot
  setInterval(tick, 6 * 60 * 60 * 1000); // every 6 hours; dedupe keys keep it to one alert per threshold
  console.log('Compliance scheduler started (expiry 90/60/30/7 days, Emiratisation)');
}
