// Durable background job queue stored in MongoDB (no Redis needed).
// Retries with exponential backoff, a dead-letter state after maxAttempts, idempotency keys,
// atomic claiming (safe with several app instances) and operator replay.
import os from 'node:os';
import { Job } from '../models.js';
import { runAsSystem, runWithTenant } from '../../lib/tenantContext.js';
import { backoffMs } from './platform.js';

const handlers = new Map();
const WORKER = `${os.hostname()}:${process.pid}`;
const LOCK_MS = 10 * 60 * 1000;

export const registerHandler = (queue, fn) => handlers.set(queue, fn);
export const registeredQueues = () => [...handlers.keys()];

/** Enqueue inside the current tenant context. Same idempotencyKey = same job (no duplicates on retry). */
export async function enqueue(queue, payload = {}, { runAt = new Date(), maxAttempts = 5, idempotencyKey, name } = {}) {
  if (idempotencyKey) {
    const existing = await Job.findOne({ idempotencyKey }).lean();
    if (existing) return existing;
  }
  try { return await Job.create({ queue, name: name || queue, payload, runAt, maxAttempts, idempotencyKey }); } catch (e) {
    if (e?.code === 11000 && idempotencyKey) return Job.findOne({ idempotencyKey }).lean();
    throw e;
  }
}

/** Claim and run one due job. Returns the job or null. */
export async function runOnce(now = new Date()) {
  const job = await runAsSystem(() => Job.findOneAndUpdate(
    { queue: { $in: registeredQueues() }, $or: [{ state: 'queued', runAt: { $lte: now } }, { state: 'running', lockedAt: { $lt: new Date(now - LOCK_MS) } }] },
    { $set: { state: 'running', lockedAt: now, lockedBy: WORKER }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  ));
  if (!job) return null;
  const fn = handlers.get(job.queue);
  try {
    const result = await runWithTenant({ tenantId: String(job.tenantId), userId: null }, () => fn(job.payload, job));
    await runAsSystem(() => Job.updateOne({ _id: job._id }, { $set: { state: 'done', result: result ?? null, finishedAt: new Date(), lastError: null } }));
  } catch (e) {
    const dead = job.attempts >= job.maxAttempts;
    await runAsSystem(() => Job.updateOne({ _id: job._id }, { $set: { state: dead ? 'dead' : 'queued', lastError: String(e?.message || e).slice(0, 500), runAt: new Date(Date.now() + backoffMs(job.attempts, 15000)), ...(dead ? { finishedAt: new Date() } : {}) } }));
  }
  return job;
}

let timer = null;
export function startWorker({ intervalMs = 5000, batch = 10 } = {}) {
  if (timer) return;
  const tick = async () => { try { for (let i = 0; i < batch; i++) if (!(await runOnce())) break; } catch (e) { console.warn('Job worker:', e.message); } };
  timer = setInterval(tick, intervalMs); timer.unref?.();
}
export const stopWorker = () => { clearInterval(timer); timer = null; };

/** Operator replay of a dead/failed job (tenant scoped). */
export const replay = (id) => Job.findOneAndUpdate({ _id: id, state: { $in: ['dead', 'failed', 'done'] } }, { $set: { state: 'queued', runAt: new Date(), attempts: 0, lastError: null } }, { new: true });
