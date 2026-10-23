// Request-scoped tenant context + a Mongoose plugin that enforces it on every
// query, aggregate and save. A query without a tenant context throws, so a
// forgotten filter can never leak another tenant's data.
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

const als = new AsyncLocalStorage();

// A Mongoose Query/Aggregate only runs when awaited, which would be *after* als.run() returns and the context is
// gone. So `runWithTenant(ctx, () => Model.find())` must start the query inside the context: call exec() here.
const execInside = (r) => (r && typeof r.exec === 'function' && typeof r.then === 'function' ? r.exec() : r);
export const runWithTenant = (ctx, fn) => als.run(ctx, () => execInside(fn()));
export const currentTenant = () => als.getStore();
// For seeding / platform jobs only. Never call from a request handler.
export const runAsSystem = (fn) => als.run({ system: true }, () => execInside(fn()));

export function tenantPlugin(schema) {
  schema.add({ tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true } });

  const scope = function () {
    const ctx = currentTenant();
    if (!ctx) throw new Error('Tenant context missing: query blocked');
    if (ctx.system) return;
    this.where({ tenantId: ctx.tenantId });
  };
  for (const op of ['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'distinct']) {
    schema.pre(op, scope);
  }
  schema.pre('aggregate', function () {
    const ctx = currentTenant();
    if (!ctx) throw new Error('Tenant context missing: aggregate blocked');
    if (!ctx.system) this.pipeline().unshift({ $match: { tenantId: new mongoose.Types.ObjectId(ctx.tenantId) } });
  });
  schema.pre('validate', function () {
    const ctx = currentTenant();
    if (!ctx) throw new Error('Tenant context missing: save blocked');
    if (ctx.system) return;
    if (this.tenantId && String(this.tenantId) !== String(ctx.tenantId)) throw new Error('Cross-tenant write blocked');
    this.tenantId = ctx.tenantId;
  });
  schema.pre('insertMany', function (next, docs) {
    const ctx = currentTenant();
    if (!ctx) return next(new Error('Tenant context missing'));
    if (!ctx.system) for (const d of docs) d.tenantId = ctx.tenantId;
    next();
  });
}
