import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { AuditLog } from '../models/index.js';

export const signToken = (user) =>
  jwt.sign({ sub: String(user._id), tid: String(user.tenantId), roles: user.roles, name: user.name, eid: user.employeeId ? String(user.employeeId) : undefined }, config.jwtSecret, { expiresIn: config.jwtExpires });

// Verifies JWT, then runs the rest of the request inside the tenant context.
export function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  let p;
  try { p = jwt.verify(token, config.jwtSecret); } catch { return res.status(401).json({ error: 'Your session expired. Sign in again.' }); }
  req.user = { id: p.sub, tenantId: p.tid, roles: p.roles || [], name: p.name, employeeId: p.eid };
  req.correlationId = req.headers['x-correlation-id'] || randomUUID();
  runWithTenant({ tenantId: p.tid, userId: p.sub }, () => next());
}

export const requireRole = (...roles) => (req, res, next) =>
  req.user.roles.some((r) => roles.includes(r) || r === 'owner')
    ? next()
    : res.status(403).json({ error: `This action needs one of: ${roles.join(', ')}` });

// Employees (no staff role) may only reach their own self-service endpoints. Everything else is HR/manager data.
const STAFF = ['owner', 'hr_admin', 'payroll_maker', 'payroll_checker', 'manager'];
const EMPLOYEE_ALLOWED = [/^\/me(\/|$)/, /^\/self(\/|$)/, /^\/notifications(\/|$)/, /^\/agent(\/|$)/, /^\/mfa(\/|$)/];
export function restrictEmployees(req, res, next) {
  if (req.user.roles.some((r) => STAFF.includes(r))) return next();
  if (EMPLOYEE_ALLOWED.some((re) => re.test(req.path)) || (req.method === 'POST' && req.path === '/leave')) return next();
  return res.status(403).json({ error: 'This page is for HR staff. Use My Workspace for your own records.' });
}
export const isStaff = (user) => user.roles.some((r) => STAFF.includes(r));

export const audit = (req, action, entity, entityId, before, after, actorType = 'user') =>
  AuditLog.create({ actorId: req.user.id, actorType, action, entity, entityId: String(entityId ?? ''), before, after, ip: req.ip, correlationId: req.correlationId });

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
