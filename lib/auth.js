// lib/auth.js — Salted scrypt password hashing + HMAC-signed tokens
const crypto = require('crypto');

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'CHANGE_ME_IN_ENV_' + 'nihongo';
const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const s = String(stored);

  // New format: scrypt:salt:hash
  if (s.startsWith('scrypt:')) {
    const [, salt, hash] = s.split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Legacy format: raw sha256 hex (unsalted) — backward compatible
  const legacy = crypto.createHash('sha256').update(String(password)).digest('hex');
  const a = Buffer.from(legacy, 'hex');
  const b = Buffer.from(s, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateToken(username) {
  const payload = JSON.stringify({
    u: String(username),
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30, // 30 days
  });
  const body = b64url(payload);
  const sig = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch (e) { return null; }
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken };
