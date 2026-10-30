'use strict';

const auth = require('../auth');
const { transaction } = require('../db');
const { HttpError } = require('../errors');
const { enqueue } = require('../mailer');
const validate = require('../validate');
const { enforce } = require('./common');

function startSession({ db, config, now }, user, status = 200) {
  const { token, expiresAt } = auth.createSession(db, user.id, now());
  return {
    status,
    body: { user: { email: user.email, email_reminders: user.email_reminders === 1 } },
    headers: { 'Set-Cookie': auth.sessionCookie(token, expiresAt, config.secureCookies) },
  };
}

function register(context) {
  const { db, body, limiters, ip } = context;
  enforce(limiters.register, ip);

  const email = validate.cleanEmail(body.email);
  const password = validate.cleanPassword(body.password);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists.');
  }
  const result = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, auth.hashPassword(password));
  return startSession(context, { id: Number(result.lastInsertRowid), email, email_reminders: 1 }, 201);
}

function login(context) {
  const { db, body, limiters, ip } = context;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  enforce(limiters.loginByIp, ip);
  enforce(limiters.loginByEmail, email || '(none)');

  const user = db.prepare('SELECT id, email, email_reminders, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !password || !auth.verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  limiters.loginByEmail.reset(email);
  return startSession(context, user);
}

function logout({ db, token, config }) {
  auth.deleteSession(db, token);
  return { body: { ok: true }, headers: { 'Set-Cookie': auth.clearedSessionCookie(config.secureCookies) } };
}

// Always answers the same way, so the response never reveals whether an
// account exists. The reset email is queued only when the account exists.
function forgotPassword(context) {
  const { db, body, limiters, ip, config, now } = context;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  enforce(limiters.forgotByIp, ip);
  enforce(limiters.forgotByEmail, email || '(none)');

  const user = email ? db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) : undefined;
  if (user) {
    transaction(db, () => {
      const token = auth.createPasswordReset(db, user.id, now());
      enqueue(db, {
        to: user.email,
        subject: 'Reset your Let Ready password',
        body: [
          'We received a request to reset your Let Ready password.',
          '',
          `Reset it here (the link expires in one hour): ${config.appUrl}/#/reset?token=${token}`,
          '',
          "If you did not ask for this, you can ignore this email. Your password will not change.",
        ].join('\n'),
        now: now(),
      });
    });
  }

  return {
    body: {
      ok: true,
      message: 'If an account exists for that email, we have sent a reset link.',
    },
  };
}

function resetPassword(context) {
  const { db, body, limiters, ip, now } = context;
  enforce(limiters.resetByIp, ip);

  const password = validate.cleanPassword(body.password);
  const token = typeof body.token === 'string' ? body.token : '';

  transaction(db, () => {
    const userId = auth.findPasswordReset(db, token, now());
    if (!userId) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), userId);
    auth.markPasswordResetUsed(db, token, now());
    auth.deleteUserSessions(db, userId);
  });
  return { body: { ok: true } };
}

module.exports = { register, login, logout, forgotPassword, resetPassword };
