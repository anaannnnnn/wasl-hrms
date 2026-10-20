import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { AuditLog } from '../models/index.js';

export const signToken = (user) =>
  jwt.sign({ sub: String(user._id), tid: String(user.tenantId), roles: user.roles, name: user.name }, config.jwtSecret, { expiresIn: config.jwtExpires });

// Verifies JWT, then runs the rest of the request inside the tenant context.
export function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  let p;
  try { p = jwt.verify(token, config.jwtSecret); } catch { return res.status(401).json({ error: 'Your session expired. Sign in again.' }); }
  req.user = { id: p.sub, tenantId: p.tid, roles: p.roles || [], name: p.name };
  req.correlationId = req.headers['x-correlation-id'] || randomUUID();
  runWithTenant({ tenantId: p.tid, userId: p.sub }, () => next());
}

export const requireRole = (...roles) => (req, res, next) =>
  req.user.roles.some((r) => roles.includes(r) || r === 'owner')
    ? next()
    : res.status(403).json({ error: `This action needs one of: ${roles.join(', ')}` });

export const audit = (req, action, entity, entityId, before, after, actorType = 'user') =>
  AuditLog.create({ actorId: req.user.id, actorType, action, entity, entityId: String(entityId ?? ''), before, after, ip: req.ip, correlationId: req.correlationId });

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
