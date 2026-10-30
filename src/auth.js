'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'letready_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSession(db, userId, now = Date.now()) {
  const token = newToken();
  const expiresAt = now + SESSION_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

function findSessionUser(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT users.id, users.email, users.email_reminders
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at >= ?`,
    )
    .get(hashToken(token), now);
  return row || null;
}

function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function purgeExpired(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
}

// Returns the token to email. Only its hash is stored, and each token is single-use.
function createPasswordReset(db, userId, now = Date.now()) {
  const token = newToken();
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    now + RESET_MS,
  );
  return token;
}

// Returns the user id for a valid, unused, unexpired token, or null.
function findPasswordReset(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?')
    .get(hashToken(token), now);
  return row ? row.user_id : null;
}

function markPasswordResetUsed(db, token, now = Date.now()) {
  db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now, hashToken(token));
}

function readSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function sessionCookie(token, expiresAt, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function clearedSessionCookie(secure) {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', secure ? 'Secure' : null]
    .filter(Boolean)
    .join('; ');
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  findSessionUser,
  deleteSession,
  deleteUserSessions,
  purgeExpired,
  createPasswordReset,
  findPasswordReset,
  markPasswordResetUsed,
  readSessionToken,
  sessionCookie,
  clearedSessionCookie,
};
