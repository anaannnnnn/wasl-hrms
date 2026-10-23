import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';

import { startScheduler } from './jobs/scheduler.js';
import { initExt } from './ext/index.js'; // extension jobs + rule registry (additive)
import { PayrollRun, Notification, Tenant, User, Attendance, Applicant } from './models/index.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAsSystem } from './lib/tenantContext.js';

await mongoose.connect(config.mongoUri);
console.log('MongoDB connected');

// Demo database self-heal: if this is the Al Noor demo tenant but it predates the current demo data
// (no employee logins or no attendance), reload the demo data once. Real customer databases are never touched
// because they don't contain the demo tenant. Disable with DEMO_AUTO_SEED=false.
if (process.env.DEMO_AUTO_SEED !== 'false') {
  try {
    const needsSeed = await runAsSystem(async () => {
      const tenants = await Tenant.countDocuments();
      const demo = await Tenant.findOne({ name: 'Al Noor Trading LLC' }).lean();
      if (tenants === 0) return 'empty database';
      if (!demo || tenants > 1) return null;
      const hasEmployeeLogin = await User.exists({ email: 'ahmed@alnoor.demo' });
      const hasAttendance = await Attendance.exists({});
      const hasApplicants = await Applicant.exists({});
      return !hasEmployeeLogin || !hasAttendance || !hasApplicants ? 'demo data is out of date' : null;
    });
    if (needsSeed) {
      console.log(`Demo data: ${needsSeed}, reloading demo data…`);
      const seed = fileURLToPath(new URL('./seed.js', import.meta.url));
      await new Promise((resolve) => execFile(process.execPath, [seed], { env: process.env, timeout: 180000 }, (err, out, errOut) => {
        if (err) console.error('Demo seed failed:', errOut || err.message); else console.log(out.trim().split('\n').slice(-6).join('\n'));
        resolve();
      }));
    }
  } catch (e) { console.warn('Demo data check skipped:', e.message); }
}
// Payroll runs now allow off-cycle/final runs in the same period: replace the old one-run-per-period index.
// Older runs predate run types: mark them as regular before syncing indexes
await runAsSystem(() => PayrollRun.updateMany({ type: { $exists: false } }, { $set: { type: 'regular', runNo: 0 } })).catch(() => {});
await PayrollRun.syncIndexes().catch((e) => console.warn('Index sync (payroll runs):', e.message));
await Notification.syncIndexes().catch((e) => console.warn('Index sync (notifications):', e.message));
// Attendance allows several sessions per day: replaces the old one-record-per-day unique index.
await Attendance.syncIndexes().catch((e) => console.warn('Index sync (attendance):', e.message));
startScheduler();
await initExt();
createApp().listen(config.port, () => console.log(`Wasl HRMS listening on http://localhost:${config.port}`));
