// Prometheus-format metrics (no dependency): request counts and latency histogram by route & status,
// plus job-queue depth. GET /metrics requires METRICS_TOKEN (Bearer) when set, otherwise localhost only.
import { Job } from '../models.js';
import { runAsSystem } from '../../lib/tenantContext.js';

const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const counts = new Map(); const hist = new Map();
const norm = (p) => p.replace(/[0-9a-f]{24}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').replace(/(wsl_|dev_)[\w-]+/g, ':key').replace(/\/(offers|verify)\/[^/]+(\/[^/]+)?/, '/$1/:token');
export function metricsMiddleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.path.startsWith('/api')) return;
    const route = `${req.method} ${norm(req.baseUrl + (req.route?.path || req.path))}`; const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const k = `${route}|${res.statusCode}`; counts.set(k, (counts.get(k) || 0) + 1);
    const h = hist.get(route) || { b: new Array(BUCKETS.length).fill(0), sum: 0, n: 0 }; BUCKETS.forEach((b, i) => { if (ms <= b) h.b[i]++; }); h.sum += ms; h.n++; hist.set(route, h);
  });
  next();
}
const lbl = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
export async function metricsHandler(req, res) {
  const tok = process.env.METRICS_TOKEN;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (tok ? req.headers.authorization !== `Bearer ${tok}` : !local) return res.status(401).end();
  const lines = ['# TYPE wasl_http_requests_total counter'];
  for (const [k, v] of counts) { const [route, status] = k.split('|'); lines.push(`wasl_http_requests_total{route="${lbl(route)}",status="${status}"} ${v}`); }
  lines.push('# TYPE wasl_http_request_duration_ms histogram');
  for (const [route, h] of hist) { BUCKETS.forEach((b, i) => lines.push(`wasl_http_request_duration_ms_bucket{route="${lbl(route)}",le="${b}"} ${h.b[i]}`)); lines.push(`wasl_http_request_duration_ms_bucket{route="${lbl(route)}",le="+Inf"} ${h.n}`, `wasl_http_request_duration_ms_sum{route="${lbl(route)}"} ${h.sum.toFixed(1)}`, `wasl_http_request_duration_ms_count{route="${lbl(route)}"} ${h.n}`); }
  try { const js = await runAsSystem(() => Job.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }])); lines.push('# TYPE wasl_jobs gauge', ...js.map((j) => `wasl_jobs{state="${j._id}"} ${j.n}`)); } catch { /* db down */ }
  lines.push('# TYPE wasl_process_resident_memory_bytes gauge', `wasl_process_resident_memory_bytes ${process.memoryUsage().rss}`, '# TYPE wasl_process_uptime_seconds gauge', `wasl_process_uptime_seconds ${Math.round(process.uptime())}`);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4'); res.end(`${lines.join('\n')}\n`);
}
