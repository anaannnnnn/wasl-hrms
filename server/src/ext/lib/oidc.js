// Minimal OpenID Connect (authorization code + PKCE) for SSO with Microsoft Entra ID, Google Workspace, Okta etc.
// ID tokens are verified locally: RS256 signature against the provider JWKS, issuer, audience, expiry and nonce.
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const cache = new Map();
async function getJson(url) {
  const hit = cache.get(url); if (hit && hit.exp > Date.now()) return hit.v;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SSO provider error (${res.status}) at ${new URL(url).host}`);
  const v = await res.json(); cache.set(url, { v, exp: Date.now() + 3600 * 1000 }); return v;
}
export const discover = (issuer) => getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);

export function pkcePair() { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; }

export async function authorizeUrl({ issuer, clientId, redirectUri, state, nonce, challenge, scope = 'openid email profile' }) {
  const d = await discover(issuer);
  const u = new URL(d.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

export async function exchangeCode({ issuer, clientId, clientSecret, redirectUri, code, verifier }) {
  const d = await discover(issuer);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, ...(clientSecret ? { client_secret: clientSecret } : {}) });
  const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id_token) throw new Error(`SSO sign-in failed: ${j.error_description || j.error || res.status}`);
  return j.id_token;
}

/** Verify an RS256 JWT with a JWKS document. Pure enough to unit test with a local key. */
export function verifyJwt(token, jwks, { issuer, audience, nonce, now = Math.floor(Date.now() / 1000), leeway = 60 }) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url')); const claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error(`Unsupported token algorithm ${header.alg}`);
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys?.length === 1 ? jwks.keys[0] : null);
  if (!jwk) throw new Error('Signing key not found');
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('ID token signature is invalid');
  // Entra multi-tenant issuers contain {tenantid}; allow the template form
  const issOk = claims.iss === issuer || (issuer.includes('{tenantid}') && claims.iss === issuer.replace('{tenantid}', claims.tid));
  if (!issOk) throw new Error('ID token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error('ID token audience mismatch');
  if (claims.exp && now > claims.exp + leeway) throw new Error('ID token expired');
  if (nonce && claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  return claims;
}

export async function verifyIdToken(token, { issuer, clientId, nonce }) {
  const d = await discover(issuer); const jwks = await getJson(d.jwks_uri);
  return verifyJwt(token, jwks, { issuer: d.issuer, audience: clientId, nonce });
}
