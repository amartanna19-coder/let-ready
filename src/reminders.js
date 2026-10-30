'use strict';

const compliance = require('./compliance');
const store = require('./store');
const { enqueue } = require('./mailer');
const { transaction } = require('./db');

const BUCKET_WORDING = {
  expired: 'has expired',
  '7': 'is due within 7 days',
  '30': 'is due within 30 days',
};

function emailFor({ appUrl, address, label, due_on, bucket }) {
  const subject = `Let Ready: ${label} ${BUCKET_WORDING[bucket]}`;
  const body = [
    `${label} ${BUCKET_WORDING[bucket]} for ${address}.`,
    '',
    `Date: ${due_on}`,
    '',
    `Review the property in Let Ready: ${appUrl}`,
    '',
    'You are getting this because email reminders are turned on in your Let Ready account.',
    'You can turn them off in Settings.',
  ].join('\n');
  return { subject, body };
}

// Queues one reminder per (deadline, bucket). reminders_sent makes it idempotent,
// so running this job twice on the same day never sends a duplicate.
function queueReminders({ db, today, now, appUrl }) {
  const users = db.prepare('SELECT id, email FROM users WHERE email_reminders = 1').all();
  let queued = 0;

  for (const user of users) {
    for (const row of db.prepare('SELECT * FROM properties WHERE user_id = ?').all(user.id)) {
      const property = store.toProperty(row);
      const records = store.loadRecords(db, property.id);
      const evaluated = compliance.evaluateProperty(property, records, today);

      const candidates = evaluated.items.map((item) => ({
        itemKey: item.type,
        label: item.label,
        status: item.status,
        daysLeft: item.days_left,
        dueOn: item.expires_on,
      }));

      for (const tenancy of store.loadTenancies(db, property.id)) {
        for (const check of compliance.tenancyChecks(tenancy, today)) {
          candidates.push({
            itemKey: `tenancy:${tenancy.id}:${check.key}`,
            label: check.label,
            status: check.status,
            daysLeft: check.days_left,
            dueOn: check.deadline,
          });
        }
      }

      for (const candidate of candidates) {
        const bucket = compliance.reminderBucket(candidate.status, candidate.daysLeft);
        if (!bucket || !candidate.dueOn) continue;

        queued += transaction(db, () => {
          const inserted = db
            .prepare(
              'INSERT OR IGNORE INTO reminders_sent (property_id, item_key, due_on, bucket) VALUES (?, ?, ?, ?)',
            )
            .run(property.id, candidate.itemKey, candidate.dueOn, bucket);
          if (inserted.changes === 0) return 0;

          const { subject, body } = emailFor({
            appUrl,
            address: property.address,
            label: candidate.label,
            due_on: candidate.dueOn,
            bucket,
          });
          enqueue(db, { to: user.email, subject, body, now });
          return 1;
        });
      }
    }
  }
  return queued;
}

module.exports = { queueReminders };
