import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'crypto';
import { promisify } from 'util';

const SECRET = process.env.AUTH_SECRET || 'dev-secret-change-in-production';
if (!process.env.AUTH_SECRET) {
  console.warn('AUTH_SECRET is not set — using a dev-only fallback. Set AUTH_SECRET in production.');
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Each hash takes ~20ms of solid CPU. The async one does that on a background
// thread, so a burst of logins can't freeze everyone's games while it hashes.
// Same settings as scryptSync, so existing passwords still check out.
const scryptAsync = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// A minimal signed session token — not a general-purpose JWT, just an
// HMAC-signed JSON payload for this client/server pair. No external
// dependency needed for something this contained.
export function createToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
