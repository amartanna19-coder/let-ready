'use strict';

const auth = require('../auth');
const compliance = require('../compliance');
const store = require('../store');
const { buildPropertyDetail, attentionFromDetail } = require('../details');
const { HttpError } = require('../errors');

function me({ user }) {
  return { body: { user: { email: user.email, email_reminders: user.email_reminders === 1 } } };
}

function setPreferences({ db, user, body }) {
  if (typeof body.email_reminders !== 'boolean') throw new HttpError(400, 'email_reminders must be yes or no.');
  db.prepare('UPDATE users SET email_reminders = ? WHERE id = ?').run(body.email_reminders ? 1 : 0, user.id);
  return { body: { email_reminders: body.email_reminders } };
}

function dashboard({ db, user, today }) {
  const day = today();
  const views = store.listProperties(db, user.id).map((property) => {
    const detail = buildPropertyDetail(db, property, day);
    return { detail, attention: attentionFromDetail(detail) };
  });

  const attention = views
    .flatMap(({ detail, attention: entries }) =>
      entries.map((entry) => ({ ...entry, property_id: detail.property.id, address: detail.property.address })),
    )
    .sort(compliance.compareUrgency);

  return {
    body: {
      summary: compliance.combineSummaries(views.map(({ detail }) => detail.summary)),
      attention,
      properties: views.map(({ detail, attention: entries }) => ({
        id: detail.property.id,
        address: detail.property.address,
        postcode: detail.property.postcode,
        borough: detail.property.borough,
        score: detail.summary.score,
        attention_count: entries.length,
      })),
    },
  };
}

// Everything the account holds, except password hashes and document contents.
function exportAccount({ db, user, now }) {
  const properties = store.listProperties(db, user.id).map((property) => ({
    ...property,
    compliance_records: store.loadRecords(db, property.id),
    tenancies: store.loadTenancies(db, property.id),
    documents: store.loadDocuments(db, property.id),
  }));
  return {
    body: {
      exported_at: new Date(now()).toISOString(),
      account: { email: user.email, email_reminders: user.email_reminders === 1 },
      properties,
    },
    headers: { 'Content-Disposition': 'attachment; filename="let-ready-export.json"' },
  };
}

function deleteAccount({ db, user, body, token, config }) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!row || !password || !auth.verifyPassword(password, row.password_hash)) {
    throw new HttpError(400, 'Enter your current password to delete your account.');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  auth.deleteSession(db, token);
  return { body: { ok: true }, headers: { 'Set-Cookie': auth.clearedSessionCookie(config.secureCookies) } };
}

module.exports = { me, setPreferences, dashboard, exportAccount, deleteAccount };
