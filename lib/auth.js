const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'myanlearn-secret-2026';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'myanlearn-salt').digest('hex');
}
function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}
function generateToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
}
module.exports = { hashPassword, verifyPassword, generateToken };