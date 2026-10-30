'use strict';

const auth = require('./auth');
const { queueReminders } = require('./reminders');
const { processOutbox } = require('./mailer');

// One pass of background work. Safe to run repeatedly: reminders are idempotent,
// and outbox messages are only sent once they are marked as sent.
async function runJobs({ db, transport, appUrl, today, now }) {
  const result = { reminders_queued: 0, outbox: { sent: 0, retried: 0, failed: 0 }, skipped_sending: false };

  auth.purgeExpired(db, now);

  if (!transport) {
    // Without a provider, reminders are not queued, so no backlog builds up.
    result.skipped_sending = true;
    return result;
  }

  result.reminders_queued = queueReminders({ db, today, now, appUrl });
  result.outbox = await processOutbox({ db, transport, now });
  return result;
}

module.exports = { runJobs };
