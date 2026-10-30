'use strict';

const MAX_ATTEMPTS = 5;
const RESEND_URL = 'https://api.resend.com/emails';

// Messages are written to an outbox table first, then sent by a worker.
// A failed send is retried with backoff; nothing is lost if the process restarts.

function enqueue(db, { to, subject, body, now }) {
  db.prepare(
    'INSERT INTO outbox (to_address, subject, body, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
  ).run(to, subject, body, 'pending', now, now);
}

// Waits 1 minute after the first failure, doubling each time, capped at 6 hours.
function backoffMs(attempts) {
  return Math.min(2 ** attempts * 60 * 1000, 6 * 60 * 60 * 1000);
}

function resendTransport({ apiKey, from, fetchImpl }) {
  return {
    async send(message) {
      const response = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to_address],
          subject: message.subject,
          text: message.body,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        throw new Error(`Email provider responded with status ${response.status}`);
      }
    },
  };
}

// provider 'none' (the default) queues messages without sending them. That is
// the safe default until a real provider and sender address are configured.
function createTransport(mailConfig) {
  if (mailConfig.provider === 'none') return null;
  if (mailConfig.provider === 'resend') {
    if (!mailConfig.apiKey) throw new Error('RESEND_API_KEY is required when MAIL_PROVIDER=resend.');
    if (!mailConfig.from) throw new Error('MAIL_FROM is required when sending email.');
    return resendTransport({ apiKey: mailConfig.apiKey, from: mailConfig.from, fetchImpl: mailConfig.fetch || fetch });
  }
  throw new Error(`Unknown MAIL_PROVIDER: ${mailConfig.provider}`);
}

// Sends up to batchSize due messages. Returns counts for logging and tests.
async function processOutbox({ db, transport, now, batchSize = 20 }) {
  const counts = { sent: 0, retried: 0, failed: 0 };
  if (!transport) return counts;

  const due = db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
    )
    .all(now, batchSize);

  for (const message of due) {
    const attempts = message.attempts + 1;
    try {
      await transport.send(message);
      db.prepare(
        "UPDATE outbox SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?",
      ).run(attempts, now, message.id);
      counts.sent += 1;
    } catch (error) {
      const errorText = String(error.message || error).slice(0, 500);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(
          attempts,
          errorText,
          message.id,
        );
        counts.failed += 1;
      } else {
        db.prepare(
          'UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
        ).run(attempts, now + backoffMs(attempts), errorText, message.id);
        counts.retried += 1;
      }
    }
  }
  return counts;
}

module.exports = { enqueue, createTransport, processOutbox, backoffMs, MAX_ATTEMPTS };
