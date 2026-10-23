// Dependency-free gzip for text responses (JSON, JS, CSS, HTML, SVG). Typical win: 70-80% smaller payloads.
import zlib from 'node:zlib';

const COMPRESSIBLE = /json|text|javascript|css|svg|xml/;
export function compression(req, res, next) {
  if (req.method === 'HEAD' || !/\bgzip\b/.test(req.headers['accept-encoding'] || '') || req.path === '/metrics') return next();
  let gz = null; let decided = false;
  const write = res.write.bind(res); const end = res.end.bind(res);
  const decide = () => {
    if (decided) return; decided = true;
    if (res.headersSent) return;
    const ct = String(res.getHeader('content-type') || ''); const len = Number(res.getHeader('content-length') || 0);
    if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304 || res.getHeader('content-encoding') || !COMPRESSIBLE.test(ct) || (len && len < 1024)) return;
    res.removeHeader('content-length'); res.setHeader('content-encoding', 'gzip'); res.setHeader('vary', 'Accept-Encoding');
    gz = zlib.createGzip({ level: 6 });
    gz.on('data', (c) => write(c)); gz.on('end', () => end()); gz.on('error', () => end());
    // Streams piped into res (express.static) pause when write() returns false and wait for 'drain' on res;
    // the gzip stream is what fills up, so its drain must be re-emitted on res or large files hang forever.
    gz.on('drain', () => res.emit('drain'));
  };
  res.write = (chunk, enc, cb) => { decide(); return gz ? gz.write(chunk, enc, cb) : write(chunk, enc, cb); };
  res.end = (chunk, enc, cb) => {
    decide();
    if (!gz) return end(chunk, enc, cb);
    if (typeof chunk === 'function') gz.end(); else if (chunk != null) gz.end(chunk, typeof enc === 'string' ? enc : undefined); else gz.end();
    return res;
  };
  next();
}
