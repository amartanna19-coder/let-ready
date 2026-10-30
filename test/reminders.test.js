'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { queueReminders } = require('../src/reminders');
const { enqueue, createTransport, processOutbox, backoffMs, MAX_ATTEMPTS } = require('../src/mailer');
const { runJobs } = require('../src/jobs');

const NOW = Date.parse('2026-10-30T09:00:00Z');

function seed(db, { email = 'reminders@example.com', reminders = 1 } = {}) {
  const user = db
    .prepare('INSERT INTO users (email, password_hash, email_reminders) VALUES (?, ?, ?)')
    .run(email, 'scrypt$00$00', reminders);
  const property = db
    .prepare('INSERT INTO properties (user_id, address, postcode, has_gas, is_hmo) VALUES (?, ?, ?, 1, 0)')
    .run(Number(user.lastInsertRowid), '12 Example Road', 'E1 6AN');
  return { userId: Number(user.lastInsertRowid), propertyId: Number(property.lastInsertRowid) };
}

function setEicr(db, propertyId, completedOn) {
  db.prepare(
    `INSERT INTO compliance_records (property_id, item_type, completed_on) VALUES (?, 'eicr', ?)
     ON CONFLICT (property_id, item_type) DO UPDATE SET completed_on = excluded.completed_on`,
  ).run(propertyId, completedOn);
}

function outbox(db) {
  return db.prepare('SELECT * FROM outbox ORDER BY id').all();
}

// EICR completed 2021-11-04 expires 2026-11-04. From 2026-10-30 that is 5 days away.
test('a reminder is queued once per deadline and bucket, however often the job runs', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  setEicr(db, propertyId, '2021-11-04');

  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://letready.example' }), 1);
  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://letready.example' }), 0);
  assert.equal(queueReminders({ db, today: '2026-10-31', now: NOW, appUrl: 'https://letready.example' }), 0);

  const [message] = outbox(db);
  assert.equal(message.to_address, 'reminders@example.com');
  assert.equal(message.subject, 'Let Ready: Electrical installation condition report (EICR) is due within 7 days');
  assert.match(message.body, /12 Example Road/);
  assert.match(message.body, /Date: 2026-11-04/);
  assert.match(message.body, /https:\/\/letready\.example/);
});

test('an expired deadline sends a second, separate reminder', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  setEicr(db, propertyId, '2021-11-04');
  queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://x.example' });

  assert.equal(queueReminders({ db, today: '2026-11-05', now: NOW, appUrl: 'https://x.example' }), 1);
  const expired = outbox(db)[1];
  assert.match(expired.subject, /has expired$/);
});

test('deadlines further out than 30 days do not trigger reminders', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  setEicr(db, propertyId, '2026-10-01'); // expires 2031-10-01
  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://x.example' }), 0);
});

test('users who have turned reminders off get nothing', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db, { reminders: 0 });
  setEicr(db, propertyId, '2021-11-04');
  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://x.example' }), 0);
  assert.equal(outbox(db).length, 0);
});

test('deposit deadlines send reminders too, one per tenancy check', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  // Deposit received 2026-10-05, so the 30-day deadline is 2026-11-04, 5 days after 2026-10-30.
  db.prepare(
    'INSERT INTO tenancies (property_id, tenant_name, start_date, deposit_received_on) VALUES (?, ?, ?, ?)',
  ).run(propertyId, 'Jo Bloggs', '2026-10-05', '2026-10-05');

  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://x.example' }), 2);
  const subjects = outbox(db).map((message) => message.subject);
  assert.ok(subjects.some((subject) => subject.includes('Deposit protected for Jo Bloggs')));
  assert.ok(subjects.some((subject) => subject.includes('Prescribed information given to Jo Bloggs')));
});

test('a completed deposit step never triggers a reminder', () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  db.prepare(
    `INSERT INTO tenancies (property_id, tenant_name, start_date, deposit_received_on, deposit_protected_on, prescribed_info_given_on)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(propertyId, 'Done', '2026-10-05', '2026-10-05', '2026-10-06', '2026-10-06');
  assert.equal(queueReminders({ db, today: '2026-10-30', now: NOW, appUrl: 'https://x.example' }), 0);
});

test('processOutbox sends pending messages and marks them sent', async () => {
  const db = openDatabase(':memory:');
  enqueue(db, { to: 'a@example.com', subject: 'One', body: 'Body', now: NOW });
  enqueue(db, { to: 'b@example.com', subject: 'Two', body: 'Body', now: NOW });
  const sent = [];
  const transport = { send: async (message) => sent.push(message.subject) };

  const counts = await processOutbox({ db, transport, now: NOW });
  assert.deepEqual(counts, { sent: 2, retried: 0, failed: 0 });
  assert.deepEqual(sent, ['One', 'Two']);
  assert.ok(outbox(db).every((message) => message.status === 'sent' && message.sent_at === NOW));

  // Nothing is sent twice.
  assert.deepEqual(await processOutbox({ db, transport, now: NOW + 1000 }), { sent: 0, retried: 0, failed: 0 });
});

test('a failing send is retried with backoff, then marked failed after the maximum attempts', async () => {
  const db = openDatabase(':memory:');
  enqueue(db, { to: 'a@example.com', subject: 'Retry me', body: 'Body', now: NOW });
  const transport = {
    send: async () => {
      throw new Error('Provider down');
    },
  };

  let time = NOW;
  let counts = await processOutbox({ db, transport, now: time });
  assert.deepEqual(counts, { sent: 0, retried: 1, failed: 0 });
  let row = outbox(db)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, NOW + backoffMs(1));
  assert.equal(row.last_error, 'Provider down');

  // Not due yet, so nothing is attempted.
  assert.deepEqual(await processOutbox({ db, transport, now: NOW + 1 }), { sent: 0, retried: 0, failed: 0 });

  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    time = outbox(db)[0].next_attempt_at;
    counts = await processOutbox({ db, transport, now: time });
  }
  assert.deepEqual(counts, { sent: 0, retried: 0, failed: 1 });
  row = outbox(db)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, MAX_ATTEMPTS);
});

test('backoff doubles and is capped at six hours', () => {
  assert.equal(backoffMs(1), 2 * 60 * 1000);
  assert.equal(backoffMs(2), 4 * 60 * 1000);
  assert.equal(backoffMs(3), 8 * 60 * 1000);
  assert.equal(backoffMs(30), 6 * 60 * 60 * 1000);
});

test('long provider errors are trimmed before they are stored', async () => {
  const db = openDatabase(':memory:');
  enqueue(db, { to: 'a@example.com', subject: 'Long', body: 'Body', now: NOW });
  await processOutbox({ db, transport: { send: async () => { throw new Error('x'.repeat(5000)); } }, now: NOW });
  assert.equal(outbox(db)[0].last_error.length, 500);
});

test('the Resend transport posts the message to the Resend API with a bearer key', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
  };
  const transport = createTransport({ provider: 'resend', apiKey: 're_test_key', from: 'Let Ready <hello@example.com>', fetch: fetchImpl });

  await transport.send({ to_address: 'landlord@example.com', subject: 'Subject', body: 'Plain text body' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer re_test_key');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    from: 'Let Ready <hello@example.com>',
    to: ['landlord@example.com'],
    subject: 'Subject',
    text: 'Plain text body',
  });
});

test('a provider error response is reported as a failure', async () => {
  const transport = createTransport({
    provider: 'resend',
    apiKey: 'k',
    from: 'a@example.com',
    fetch: async () => new Response('{"error":"nope"}', { status: 422 }),
  });
  await assert.rejects(transport.send({ to_address: 'x@example.com', subject: 's', body: 'b' }), /status 422/);
});

test('email sending is off by default, and misconfiguration is caught at start-up', () => {
  assert.equal(createTransport({ provider: 'none', from: '', apiKey: '' }), null);
  assert.throws(() => createTransport({ provider: 'resend', apiKey: '', from: 'a@example.com' }), /RESEND_API_KEY/);
  assert.throws(() => createTransport({ provider: 'resend', apiKey: 'k', from: '' }), /MAIL_FROM/);
  assert.throws(() => createTransport({ provider: 'carrier-pigeon', apiKey: '', from: '' }), /Unknown MAIL_PROVIDER/);
});

test('with email off, the background job queues nothing and sends nothing', async () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  setEicr(db, propertyId, '2021-11-04');
  const result = await runJobs({ db, transport: null, appUrl: 'https://x.example', today: '2026-10-30', now: NOW });
  assert.equal(result.skipped_sending, true);
  assert.equal(outbox(db).length, 0);
});

test('the background job queues and sends reminders end to end', async () => {
  const db = openDatabase(':memory:');
  const { propertyId } = seed(db);
  setEicr(db, propertyId, '2021-11-04');
  const sent = [];
  const transport = { send: async (message) => sent.push(message.to_address) };

  const result = await runJobs({ db, transport, appUrl: 'https://x.example', today: '2026-10-30', now: NOW });
  assert.equal(result.reminders_queued, 1);
  assert.deepEqual(result.outbox, { sent: 1, retried: 0, failed: 0 });
  assert.deepEqual(sent, ['reminders@example.com']);
});
