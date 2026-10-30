'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createServer } = require('../src/server');

const TODAY = '2026-10-30';
const DAY = 24 * 60 * 60 * 1000;

async function startServer(t, options = {}) {
  const clock = { now: Date.parse('2026-10-30T12:00:00Z') };
  const db = openDatabase(':memory:');
  const server = createServer({
    db,
    config: { appUrl: 'https://letready.example', trustProxy: false, ...options.config },
    today: () => TODAY,
    now: () => clock.now,
    limits: options.limits,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, db, clock };
}

// A small cookie-keeping client, so each test user behaves like a browser.
function client(base) {
  let cookie = null;
  return {
    get cookie() {
      return cookie;
    },
    async request(method, path, body, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (options.rawBody !== undefined) {
        payload = options.rawBody;
        headers['Content-Type'] = options.contentType || 'application/json';
      } else if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body ?? {});
      }
      const response = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : payload });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const buffer = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      const data = type.includes('application/json') ? JSON.parse(buffer.toString('utf8') || 'null') : buffer.toString('utf8');
      return { status: response.status, headers: response.headers, data, buffer };
    },
  };
}

async function signedIn(base, email = 'landlord@example.com') {
  const user = client(base);
  const res = await user.request('POST', '/api/auth/register', { email, password: 'a-long-password' });
  assert.equal(res.status, 201);
  return user;
}

async function addProperty(user, overrides = {}) {
  const res = await user.request('POST', '/api/properties', {
    address: '12 Example Road',
    postcode: 'e1 6an',
    borough: 'Tower Hamlets',
    has_gas: true,
    is_hmo: false,
    ...overrides,
  });
  assert.equal(res.status, 201);
  return res.data.id;
}

const pdfBase64 = Buffer.from('%PDF-1.4\n% test certificate\n').toString('base64');
const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString('base64');

// ---- Accounts and sessions -------------------------------------------------

test('register, log out and log back in', async (t) => {
  const { base } = await startServer(t);
  const user = client(base);

  let res = await user.request('POST', '/api/auth/register', { email: ' Amar@Example.com ', password: 'correct horse' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.email, 'amar@example.com');
  assert.equal(res.data.user.email_reminders, true);

  res = await user.request('GET', '/api/me');
  assert.equal(res.status, 200);

  res = await user.request('POST', '/api/auth/register', { email: 'amar@example.com', password: 'another-password' });
  assert.equal(res.status, 409);

  await user.request('POST', '/api/auth/logout', {});
  res = await user.request('GET', '/api/me');
  assert.equal(res.status, 401);

  res = await user.request('POST', '/api/auth/login', { email: 'amar@example.com', password: 'wrong-password' });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'Email or password is incorrect.');

  res = await user.request('POST', '/api/auth/login', { email: 'amar@example.com', password: 'correct horse' });
  assert.equal(res.status, 200);
});

test('short passwords, long passwords and invalid emails are rejected', async (t) => {
  const { base } = await startServer(t);
  const user = client(base);
  assert.equal((await user.request('POST', '/api/auth/register', { email: 'a@example.com', password: 'short' })).status, 400);
  assert.equal((await user.request('POST', '/api/auth/register', { email: 'a@example.com', password: 'x'.repeat(201) })).status, 400);
  assert.equal((await user.request('POST', '/api/auth/register', { email: 'not-an-email', password: 'long-enough' })).status, 400);
  assert.equal((await user.request('POST', '/api/auth/register', { email: 'a\n@example.com', password: 'long-enough' })).status, 400);
});

test('a session cookie is HttpOnly and SameSite, and expires after 30 days', async (t) => {
  const { base, clock } = await startServer(t);
  const user = client(base);
  const res = await user.request('POST', '/api/auth/register', { email: 'sess@example.com', password: 'long-enough-pw' });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);

  assert.equal((await user.request('GET', '/api/me')).status, 200);
  clock.now += 31 * DAY;
  assert.equal((await user.request('GET', '/api/me')).status, 401);
});

test('the session token is stored only as a hash', async (t) => {
  const { base, db } = await startServer(t);
  const user = client(base);
  await user.request('POST', '/api/auth/register', { email: 'hash@example.com', password: 'long-enough-pw' });
  const rawToken = user.cookie.split('=')[1];
  const stored = db.prepare('SELECT token_hash FROM sessions').all().map((row) => row.token_hash);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0], rawToken);
  assert.ok(!stored.includes(rawToken));
});

test('login is rate limited per email and reports when to try again', async (t) => {
  const { base } = await startServer(t, { limits: { loginByEmail: { limit: 3, windowMs: 60 * 1000 } } });
  const user = await signedIn(base, 'limited@example.com');
  await user.request('POST', '/api/auth/logout', {});

  const attacker = client(base);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await attacker.request('POST', '/api/auth/login', { email: 'limited@example.com', password: 'guess-guess-1' });
    assert.equal(res.status, 401);
  }
  // Even the correct password is refused while the email is locked out.
  const blocked = await attacker.request('POST', '/api/auth/login', { email: 'limited@example.com', password: 'a-long-password' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  // Other emails from the same client are not affected.
  const unaffected = await attacker.request('POST', '/api/auth/login', { email: 'other@example.com', password: 'guess-guess-1' });
  assert.equal(unaffected.status, 401);
});

test('forgotten passwords: unknown emails get the same reply, and the reset link works once', async (t) => {
  const { base, db, clock } = await startServer(t);
  const owner = await signedIn(base, 'reset@example.com');
  const visitor = client(base);

  const unknown = await visitor.request('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM outbox').get().total, 0);

  const known = await visitor.request('POST', '/api/auth/forgot', { email: 'reset@example.com' });
  assert.equal(known.status, 200);
  assert.equal(known.data.message, unknown.data.message);
  const mail = db.prepare('SELECT to_address, body FROM outbox').get();
  assert.equal(mail.to_address, 'reset@example.com');
  const token = mail.body.match(/token=([A-Za-z0-9_-]+)/)[1];
  assert.match(mail.body, /https:\/\/letready\.example\/#\/reset\?token=/);

  assert.equal((await visitor.request('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await visitor.request('POST', '/api/auth/reset', { token, password: 'brand-new-password' })).status, 200);
  assert.equal((await visitor.request('POST', '/api/auth/reset', { token, password: 'another-new-one' })).status, 400);

  assert.equal((await visitor.request('POST', '/api/auth/login', { email: 'reset@example.com', password: 'a-long-password' })).status, 401);
  assert.equal((await visitor.request('POST', '/api/auth/login', { email: 'reset@example.com', password: 'brand-new-password' })).status, 200);

  // Resetting the password signs out every existing session.
  assert.equal((await owner.request('GET', '/api/me')).status, 401);

  // A reset link that is more than an hour old is rejected.
  await visitor.request('POST', '/api/auth/forgot', { email: 'reset@example.com' });
  const expiredMail = db.prepare('SELECT body FROM outbox ORDER BY id DESC LIMIT 1').get();
  const expiredToken = expiredMail.body.match(/token=([A-Za-z0-9_-]+)/)[1];
  clock.now += 61 * 60 * 1000;
  assert.equal((await visitor.request('POST', '/api/auth/reset', { token: expiredToken, password: 'late-but-valid' })).status, 400);
});

test('forgot-password requests are rate limited per email', async (t) => {
  const { base } = await startServer(t, { limits: { forgotByEmail: { limit: 2, windowMs: 60 * 60 * 1000 } } });
  const visitor = client(base);
  assert.equal((await visitor.request('POST', '/api/auth/forgot', { email: 'spam@example.com' })).status, 200);
  assert.equal((await visitor.request('POST', '/api/auth/forgot', { email: 'spam@example.com' })).status, 200);
  assert.equal((await visitor.request('POST', '/api/auth/forgot', { email: 'spam@example.com' })).status, 429);
});

test('account deletion needs the current password and removes all data', async (t) => {
  const { base, db } = await startServer(t);
  const owner = await signedIn(base, 'gone@example.com');
  await addProperty(owner);

  assert.equal((await owner.request('DELETE', '/api/me', { password: 'wrong-password' })).status, 400);
  assert.equal((await owner.request('DELETE', '/api/me', { password: 'a-long-password' })).status, 200);

  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM properties').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM users').get().total, 0);
  assert.equal((await owner.request('GET', '/api/me')).status, 401);
});

test('reminder preference can be switched off and on', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base, 'prefs@example.com');
  assert.equal((await owner.request('PUT', '/api/me/preferences', { email_reminders: false })).status, 200);
  assert.equal((await owner.request('GET', '/api/me')).data.user.email_reminders, false);
  assert.equal((await owner.request('PUT', '/api/me/preferences', { email_reminders: 'yes' })).status, 400);
  assert.equal((await owner.request('PUT', '/api/me/preferences', { email_reminders: true })).data.email_reminders, true);
});

// ---- Properties and checklist items ---------------------------------------

test('properties and compliance items are saved and evaluated', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);

  let detail = await owner.request('GET', `/api/properties/${id}`);
  assert.equal(detail.data.property.postcode, 'E1 6AN');
  assert.equal(detail.data.summary.compliant, 0);
  assert.equal(detail.data.summary.total, 5);

  // Gas certificate from June 2026 expires June 2027.
  let saved = await owner.request('PUT', `/api/properties/${id}/items/gas_safety`, {
    completed_on: '2026-06-01',
    expires_on: '',
    reference: 'CP12-123',
    notes: '',
  });
  assert.equal(saved.status, 200);
  const gas = saved.data.items.find((item) => item.type === 'gas_safety');
  assert.equal(gas.status, 'valid');
  assert.equal(gas.expires_on, '2027-06-01');
  assert.equal(gas.record.reference, 'CP12-123');

  // EICR from November 2021 expires November 2026, inside the 60-day window.
  saved = await owner.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: '2021-11-01' });
  assert.equal(saved.data.items.find((item) => item.type === 'eicr').status, 'due_soon');
  assert.deepEqual(saved.data.summary, { compliant: 2, total: 5, score: 40 });

  saved = await owner.request('PUT', `/api/properties/${id}/items/rra_information_sheet`, { completed_on: '2026-09-01' });
  assert.deepEqual(saved.data.summary, { compliant: 3, total: 5, score: 60 });

  const dashboard = await owner.request('GET', '/api/dashboard');
  // EPC and PRS are missing and the EICR is due soon.
  assert.equal(dashboard.data.properties[0].attention_count, 3);
  assert.equal(dashboard.data.attention[0].status, 'missing');
  assert.ok(dashboard.data.attention.some((item) => item.key === 'eicr' && item.status === 'due_soon'));

  saved = await owner.request('DELETE', `/api/properties/${id}/items/gas_safety`, {});
  assert.equal(saved.data.items.find((item) => item.type === 'gas_safety').status, 'missing');
});

test('invalid compliance entries are rejected with a clear message', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner, { has_gas: false });

  let res = await owner.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: '2026-02-30' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /real date/);

  res = await owner.request('PUT', `/api/properties/${id}/items/epc`, { completed_on: '2026-01-01', expires_on: '2025-01-01' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /after the date completed/);

  res = await owner.request('PUT', `/api/properties/${id}/items/gas_safety`, { completed_on: '2026-01-01' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /does not apply/);

  res = await owner.request('PUT', `/api/properties/${id}/items/not_a_real_item`, { completed_on: '2026-01-01' });
  assert.equal(res.status, 404);

  res = await owner.request('PUT', `/api/properties/${id}/items/hmo_licence`, {});
  assert.equal(res.status, 400);

  res = await owner.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: '2026-01-01', notes: 'bad\u0000byte' });
  assert.equal(res.status, 400);
});

test('an HMO licence is stored from its expiry date alone', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner, { is_hmo: true });
  const res = await owner.request('PUT', `/api/properties/${id}/items/hmo_licence`, { expires_on: '2027-03-01' });
  assert.equal(res.status, 200);
  assert.equal(res.data.items.find((item) => item.type === 'hmo_licence').status, 'valid');
});

test('marking a property as having no gas hides the gas item', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const res = await owner.request('PUT', `/api/properties/${id}`, {
    address: '12 Example Road',
    postcode: 'E1 6AN',
    borough: 'Tower Hamlets',
    has_gas: false,
    is_hmo: false,
  });
  assert.equal(res.status, 200);
  assert.ok(!res.data.items.some((item) => item.type === 'gas_safety'));
  assert.ok(res.data.not_applicable.some((item) => item.type === 'gas_safety'));
});

test('property details are validated, including postcodes', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  let res = await owner.request('POST', '/api/properties', { address: '1 Road', postcode: 'NOTAPOSTCODE' });
  assert.equal(res.status, 400);
  res = await owner.request('POST', '/api/properties', { address: '   ', postcode: 'E1 6AN' });
  assert.equal(res.status, 400);
  res = await owner.request('POST', '/api/properties', { address: '1 Road', postcode: 'SW1A 1AA', has_gas: 'yes' });
  assert.equal(res.status, 400);
  res = await owner.request('POST', '/api/properties', { address: '1 Road', postcode: 'sw1a1aa' });
  assert.equal(res.status, 201);
  const detail = await owner.request('GET', `/api/properties/${res.data.id}`);
  assert.equal(detail.data.property.postcode, 'SW1A 1AA');
});

test("users cannot see or change each other's properties", async (t) => {
  const { base } = await startServer(t);
  const alice = await signedIn(base, 'alice@example.com');
  const bob = await signedIn(base, 'bob@example.com');
  const id = await addProperty(alice);

  assert.equal((await bob.request('GET', `/api/properties/${id}`)).status, 404);
  assert.equal((await bob.request('PUT', `/api/properties/${id}`, { address: 'x', postcode: 'E1 6AN' })).status, 404);
  assert.equal((await bob.request('DELETE', `/api/properties/${id}`, {})).status, 404);
  assert.equal((await bob.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: '2026-01-01' })).status, 404);
  assert.equal((await bob.request('GET', `/api/properties/${id}/export.csv`)).status, 404);
  assert.equal((await bob.request('POST', `/api/properties/${id}/tenancies`, { tenant_name: 'x', start_date: '2026-01-01' })).status, 404);

  const bobDashboard = await bob.request('GET', '/api/dashboard');
  assert.equal(bobDashboard.data.properties.length, 0);
  assert.equal(bobDashboard.data.summary.score, null);
});

test('malformed ids are treated as not found', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  for (const id of ['abc', '0', '-1', '1.5', '01', '99999999999999999999']) {
    const res = await owner.request('GET', `/api/properties/${id}`);
    assert.equal(res.status, 404, `id ${id}`);
  }
});

test('a deleted property takes its records with it', async (t) => {
  const { base, db } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  await owner.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: '2026-01-01' });
  assert.equal((await owner.request('DELETE', `/api/properties/${id}`, {})).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM compliance_records').get().total, 0);
  assert.equal((await owner.request('GET', `/api/properties/${id}`)).status, 404);
});

test('concurrent writes to the same item leave exactly one record', async (t) => {
  const { base, db } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const writes = Array.from({ length: 20 }, (_, index) =>
    owner.request('PUT', `/api/properties/${id}/items/eicr`, { completed_on: `2026-01-${String(index + 1).padStart(2, '0')}` }),
  );
  const results = await Promise.all(writes);
  assert.ok(results.every((res) => res.status === 200));
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM compliance_records WHERE property_id = ?').get(id).total, 1);
});

// ---- Tenancies and deposits -----------------------------------------------

test('tenancy deposit deadlines are tracked and show on the dashboard', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);

  let res = await owner.request('POST', `/api/properties/${id}/tenancies`, {
    tenant_name: 'Jo Bloggs',
    start_date: '2026-09-01',
    deposit_amount_pence: 120000,
    deposit_received_on: '2026-09-01',
    deposit_protected_on: null,
    prescribed_info_given_on: null,
    notes: 'Flat 2',
  });
  assert.equal(res.status, 201);
  const tenancyId = res.data.id;
  const tenancy = res.data.tenancies.find((entry) => entry.id === tenancyId);
  assert.equal(tenancy.checks[0].deadline, '2026-10-01');
  assert.equal(tenancy.checks[0].status, 'expired');
  assert.equal(tenancy.checks[1].status, 'expired');

  const dashboard = await owner.request('GET', '/api/dashboard');
  assert.ok(dashboard.data.attention.some((entry) => entry.key === `tenancy:${tenancyId}:deposit_protection`));

  res = await owner.request('PUT', `/api/properties/${id}/tenancies/${tenancyId}`, {
    tenant_name: 'Jo Bloggs',
    start_date: '2026-09-01',
    deposit_amount_pence: 120000,
    deposit_received_on: '2026-09-01',
    deposit_protected_on: '2026-09-20',
    prescribed_info_given_on: '2026-09-20',
  });
  assert.equal(res.status, 200);
  const updated = res.data.tenancies.find((entry) => entry.id === tenancyId);
  assert.equal(updated.checks[0].status, 'complete');
  assert.equal(updated.checks[1].status, 'complete');
  assert.equal(res.data.summary.total, 5, 'deposit checks do not change the property checklist score');

  res = await owner.request('DELETE', `/api/properties/${id}/tenancies/${tenancyId}`);
  assert.equal(res.data.tenancies.length, 0);
});

test('tenancy validation catches impossible deposit records', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const path = `/api/properties/${id}/tenancies`;

  let res = await owner.request('POST', path, { tenant_name: 'A', start_date: '2026-09-01', deposit_protected_on: '2026-09-02' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /received/);

  res = await owner.request('POST', path, {
    tenant_name: 'A',
    start_date: '2026-09-01',
    deposit_received_on: '2026-09-10',
    deposit_protected_on: '2026-09-05',
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /before it was received/);

  res = await owner.request('POST', path, { tenant_name: 'A', start_date: '2026-09-01', deposit_amount_pence: 12.5 });
  assert.equal(res.status, 400);

  res = await owner.request('POST', path, { tenant_name: 'A', start_date: '2026-09-01', deposit_amount_pence: -100 });
  assert.equal(res.status, 400);

  res = await owner.request('POST', path, { tenant_name: '', start_date: '2026-09-01' });
  assert.equal(res.status, 400);

  res = await owner.request('POST', path, { tenant_name: 'A', start_date: '2026-02-30' });
  assert.equal(res.status, 400);

  res = await owner.request('POST', path, { tenant_name: 'A', start_date: '1800-01-01' });
  assert.equal(res.status, 400);
});

test('a tenancy belongs to one property and cannot be edited through another', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const first = await addProperty(owner, { address: 'First' });
  const second = await addProperty(owner, { address: 'Second' });
  const created = await owner.request('POST', `/api/properties/${first}/tenancies`, { tenant_name: 'A', start_date: '2026-01-01' });
  const tenancyId = created.data.tenancies[0].id;
  const res = await owner.request('PUT', `/api/properties/${second}/tenancies/${tenancyId}`, { tenant_name: 'B', start_date: '2026-01-01' });
  assert.equal(res.status, 404);
});

// ---- Certificate uploads ---------------------------------------------------

test('certificates upload, download and delete, and only for their owner', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const other = await signedIn(base, 'other@example.com');
  const id = await addProperty(owner);
  const path = `/api/properties/${id}/items/gas_safety/documents`;

  let res = await owner.request('POST', path, { filename: '../../evil<script>.pdf', content_type: 'application/pdf', data: pdfBase64 });
  assert.equal(res.status, 201);
  assert.equal(res.data.filename, 'evilscript.pdf');
  const docId = res.data.id;

  const download = await owner.request('GET', `/api/documents/${docId}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.buffer.toString('utf8'), '%PDF-1.4\n% test certificate\n');

  assert.equal((await other.request('GET', `/api/documents/${docId}`)).status, 404);
  assert.equal((await other.request('DELETE', `/api/documents/${docId}`)).status, 404);

  const detail = await owner.request('GET', `/api/properties/${id}`);
  const gas = detail.data.items.find((item) => item.type === 'gas_safety');
  assert.equal(gas.documents.length, 1);
  assert.equal(gas.documents[0].filename, 'evilscript.pdf');
  assert.equal(gas.documents[0].data, undefined, 'document contents are not sent in the property view');

  assert.equal((await owner.request('DELETE', `/api/documents/${docId}`)).status, 200);
  assert.equal((await owner.request('GET', `/api/documents/${docId}`)).status, 404);
});

test('uploads are checked against their declared type by file signature', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const path = `/api/properties/${id}/items/eicr/documents`;

  // A PDF renamed to PNG is rejected.
  let res = await owner.request('POST', path, { filename: 'fake.png', content_type: 'image/png', data: pdfBase64 });
  assert.equal(res.status, 400);
  // A JPEG declared as a PDF is rejected.
  res = await owner.request('POST', path, { filename: 'fake.pdf', content_type: 'application/pdf', data: jpegBase64 });
  assert.equal(res.status, 400);
  // Real PNG and JPEG files are accepted.
  assert.equal((await owner.request('POST', path, { filename: 'ok.png', content_type: 'image/png', data: pngBase64 })).status, 201);
  assert.equal((await owner.request('POST', path, { filename: 'ok.jpg', content_type: 'image/jpeg', data: jpegBase64 })).status, 201);
  // Other types are refused outright.
  res = await owner.request('POST', path, { filename: 'page.html', content_type: 'text/html', data: Buffer.from('<h1>x</h1>').toString('base64') });
  assert.equal(res.status, 400);
  res = await owner.request('POST', path, { filename: 'x.svg', content_type: 'image/svg+xml', data: pdfBase64 });
  assert.equal(res.status, 400);
});

test('upload data must be valid base64 and not empty, and files have a size limit', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const path = `/api/properties/${id}/items/eicr/documents`;

  let res = await owner.request('POST', path, { filename: 'a.pdf', content_type: 'application/pdf', data: 'not base64!' });
  assert.equal(res.status, 400);
  res = await owner.request('POST', path, { filename: 'a.pdf', content_type: 'application/pdf', data: '' });
  assert.equal(res.status, 400);
  res = await owner.request('POST', path, { filename: 'a.pdf', content_type: 'application/pdf', data: 12345 });
  assert.equal(res.status, 400);

  // Just over 5 MB decoded: the size check runs before any decoding.
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x25).toString('base64');
  res = await owner.request('POST', path, { filename: 'big.pdf', content_type: 'application/pdf', data: oversized });
  assert.equal(res.status, 413);
});

test('each item can hold at most ten certificates', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner);
  const path = `/api/properties/${id}/items/epc/documents`;
  for (let index = 0; index < 10; index += 1) {
    const res = await owner.request('POST', path, { filename: `c${index}.pdf`, content_type: 'application/pdf', data: pdfBase64 });
    assert.equal(res.status, 201);
  }
  const eleventh = await owner.request('POST', path, { filename: 'c10.pdf', content_type: 'application/pdf', data: pdfBase64 });
  assert.equal(eleventh.status, 400);
  assert.match(eleventh.data.error, /up to 10 files/);
});

test('uploads are refused for items that do not apply to the property', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner, { has_gas: false });
  const res = await owner.request('POST', `/api/properties/${id}/items/gas_safety/documents`, {
    filename: 'gas.pdf',
    content_type: 'application/pdf',
    data: pdfBase64,
  });
  assert.equal(res.status, 400);
});

// ---- Exports ---------------------------------------------------------------

test('the property CSV is a checklist with formula-injection protection', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const id = await addProperty(owner, { address: 'Cell, "quoted" road' });
  await owner.request('PUT', `/api/properties/${id}/items/gas_safety`, {
    completed_on: '2026-06-01',
    reference: '=HYPERLINK("https://evil.example","click")',
  });
  const res = await owner.request('GET', `/api/properties/${id}/export.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const lines = res.data.split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Check,Status,Date completed or deadline,Expires or due,Reference,Notes,Documents attached');
  assert.ok(lines.some((line) => line.startsWith('Gas safety certificate (CP12),valid,2026-06-01,2027-06-01')));
  assert.ok(res.data.includes(`'=HYPERLINK(""https://evil.example"",""click"")`), 'formula is neutralised and quotes are doubled');
});

test('the account export includes data but never password hashes or document contents', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base, 'export@example.com');
  const id = await addProperty(owner);
  await owner.request('POST', `/api/properties/${id}/items/gas_safety/documents`, {
    filename: 'cert.pdf',
    content_type: 'application/pdf',
    data: pdfBase64,
  });
  await owner.request('POST', `/api/properties/${id}/tenancies`, { tenant_name: 'Tenant', start_date: '2026-09-01' });

  const res = await owner.request('GET', '/api/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /let-ready-export\.json/);
  assert.equal(res.data.account.email, 'export@example.com');
  assert.equal(res.data.properties.length, 1);
  assert.equal(res.data.properties[0].tenancies[0].tenant_name, 'Tenant');
  assert.equal(res.data.properties[0].documents[0].filename, 'cert.pdf');
  const text = res.buffer.toString('utf8');
  assert.ok(!text.includes('password'), 'no password fields');
  assert.ok(!text.includes(pdfBase64), 'no document contents');
});

// ---- Requests, routing and input handling ----------------------------------

test('API responses carry security headers and are never cached', async (t) => {
  const { base } = await startServer(t);
  const res = await client(base).request('GET', '/api/me');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
});

test('protected endpoints need a session, and writes must be JSON', async (t) => {
  const { base } = await startServer(t);
  const anonymous = client(base);
  assert.equal((await anonymous.request('GET', '/api/dashboard')).status, 401);
  assert.equal((await anonymous.request('GET', '/api/export')).status, 401);

  const owner = await signedIn(base);
  const res = await owner.request('POST', '/api/properties', null, {
    rawBody: '{"address":"1 Road","postcode":"E1 6AN"}',
    contentType: 'text/plain',
  });
  assert.equal(res.status, 415);
});

test('oversized, malformed and wrongly shaped bodies get clear errors', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);

  let res = await owner.request('POST', '/api/properties', null, { rawBody: '{"address":' });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, 'Invalid JSON.');

  res = await owner.request('POST', '/api/properties', null, { rawBody: '[1,2,3]' });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, 'Expected a JSON object.');

  res = await owner.request('POST', '/api/properties', null, { rawBody: '"just a string"' });
  assert.equal(res.status, 400);

  res = await owner.request('POST', '/api/properties', null, { rawBody: '' });
  assert.equal(res.status, 400);

  const big = JSON.stringify({ address: 'x'.repeat(70 * 1024) });
  res = await owner.request('POST', '/api/properties', null, { rawBody: big });
  assert.equal(res.status, 413);
});

test('unknown routes return 404 and wrong methods return 405', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  assert.equal((await owner.request('GET', '/api/nothing-here')).status, 404);
  assert.equal((await owner.request('PATCH', '/api/me', {})).status, 405);
  assert.equal((await owner.request('POST', '/api/dashboard', {})).status, 405);
});

test('the front end is served with a restrictive content security policy', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await res.text();
  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="status"/);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/..%5Cpackage.json')).status, 404);
  assert.equal((await fetch(base + '/app.js')).status, 200);
});

test('a session that is logged out cannot be reused', async (t) => {
  const { base } = await startServer(t);
  const owner = await signedIn(base);
  const sessionCookie = owner.cookie;
  await owner.request('POST', '/api/auth/logout', {});
  const replay = await fetch(`${base}/api/me`, { headers: { Cookie: sessionCookie } });
  assert.equal(replay.status, 401);
});
