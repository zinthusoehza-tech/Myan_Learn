// lib/auth.js — simple password hashing + tokens
// NOTE: sha256 is fine for a class app. For production, switch to bcrypt.
const crypto = require('crypto');

const hashPassword = (p) =>
  crypto.createHash('sha256').update(String(p)).digest('hex');

const verifyPassword = (p, h) => hashPassword(p) === String(h || '');

const generateToken = (u) =>
  crypto.createHash('sha256').update(String(u) + Date.now() + Math.random()).digest('hex');

module.exports = { hashPassword, verifyPassword, generateToken };
