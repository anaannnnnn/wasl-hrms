import 'dotenv/config';
import dns from 'node:dns';

// Fix for "querySrv ECONNREFUSED" on some Windows/router DNS setups
if ((process.env.MONGO_URI || '').startsWith('mongodb+srv://')) {
  dns.setServers((process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',').map((s) => s.trim()));
}

const required = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  mongoUri: required('MONGO_URI', 'mongodb://localhost:27017/wasl_hrms'),
  jwtSecret: required('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-only-change-me'),
  jwtExpires: process.env.JWT_EXPIRES || '8h',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  serveWeb: process.env.SERVE_WEB !== 'false',
};
