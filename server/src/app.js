import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import api from './routes/api.js';
import mvp from './routes/mvp.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigin }));
  // Larger bodies only where files are uploaded (base64) or CSVs imported
  app.use(['/api/documents', '/api/import'], express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', api);
  app.use('/api', mvp);

  if (config.serveWeb) {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
    app.use(express.static(web));
  }

  app.use((err, req, res, next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Some fields are missing or invalid.', fields: err.flatten().fieldErrors });
    if (err?.code === 11000) return res.status(409).json({ error: 'A record with these details already exists.' });
    if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid ID.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large. The limit is 8 MB.' });
    if (err?.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again; if it repeats, share the correlation ID with support.', correlationId: req.correlationId });
  });
  return app;
}
