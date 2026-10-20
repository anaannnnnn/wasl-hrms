import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';

import { startScheduler } from './jobs/scheduler.js';
import { PayrollRun, Notification } from './models/index.js';
import { runAsSystem } from './lib/tenantContext.js';

await mongoose.connect(config.mongoUri);
console.log('MongoDB connected');
// Payroll runs now allow off-cycle/final runs in the same period: replace the old one-run-per-period index.
// Older runs predate run types: mark them as regular before syncing indexes
await runAsSystem(() => PayrollRun.updateMany({ type: { $exists: false } }, { $set: { type: 'regular', runNo: 0 } })).catch(() => {});
await PayrollRun.syncIndexes().catch((e) => console.warn('Index sync (payroll runs):', e.message));
await Notification.syncIndexes().catch((e) => console.warn('Index sync (notifications):', e.message));
startScheduler();
createApp().listen(config.port, () => console.log(`Wasl HRMS listening on http://localhost:${config.port}`));
