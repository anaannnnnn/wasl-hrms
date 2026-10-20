import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import api from './routes/api.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', api);

  if (config.serveWeb) {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
    app.use(express.static(web));
  }

  app.use((err, req, res, next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Some fields are missing or invalid.', fields: err.flatten().fieldErrors });
    if (err?.code === 11000) return res.status(409).json({ error: 'A record with these details already exists.' });
    if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid ID.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again; if it repeats, share the correlation ID with support.', correlationId: req.correlationId });
  });
  return app;
}
