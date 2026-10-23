// Regression: gzip middleware must not stall piped (streamed) responses such as express.static files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { compression } from '../src/ext/lib/compress.js';

test('large piped responses complete and decompress intact', async () => {
  const body = Buffer.from('console.log("wasl");\n'.repeat(20000)); // ~420 KB, far above stream buffers
  const srv = http.createServer((req, res) => { req.path = req.url; compression(req, res, () => { res.setHeader('content-type', 'application/javascript'); Readable.from([...Array(100)].map((_, i) => body.subarray(i * 4200, (i + 1) * 4200))).pipe(res); }); });
  await new Promise((r) => srv.listen(0, r));
  try {
    const out = await Promise.race([
      new Promise((resolve) => http.get({ port: srv.address().port, headers: { 'accept-encoding': 'gzip' } }, (r) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => resolve({ enc: r.headers['content-encoding'], buf: Buffer.concat(b) })); })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('response hung')), 5000)),
    ]);
    assert.equal(out.enc, 'gzip');
    assert.ok(zlib.gunzipSync(out.buf).equals(body));
  } finally { srv.close(); }
});
