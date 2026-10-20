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
import security from './routes/security.js';
import attendance from './routes/attendance.js';
import employees360 from './routes/employees360.js';
import workspace from './routes/workspace.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline style attributes are used for layout
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({ origin: config.corsOrigin }));
  // Larger bodies only where files are uploaded (base64) or CSVs imported
  app.use(['/api/documents', '/api/import'], express.json({ limit: '12mb' }));
  app.use('/api/me/clock-in', express.json({ limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' } }));
  app.use('/api/agent', rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many AI requests. Wait a minute.' } }));
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down and try again shortly.' } }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', api);
  app.use('/api', mvp);
  app.use('/api', security);
  app.use('/api', attendance);
  app.use('/api', employees360);
  app.use('/api', workspace);

  if (config.serveWeb) {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
    app.use(express.static(web));
    // Friendly entry points: /employee opens the employee sign-in, /hr the HR sign-in (same single-page app)
    app.get(['/employee', '/employee/', '/hr', '/hr/'], (req, res) => res.sendFile(path.join(web, 'index.html')));
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
