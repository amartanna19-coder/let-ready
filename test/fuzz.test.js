'use strict';

// Randomised robustness test. A fixed seed keeps every run identical, so any
// failure can be reproduced exactly. The rule under test: no input may cause a
// 500 response, and every API response must be JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createServer } = require('../src/server');

const ITERATIONS = 400;
const SEED = 20261030;

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeGenerator(random) {
  const pick = (items) => items[Math.floor(random() * items.length)];
  const strings = [
    '',
    ' ',
    'E1 6AN',
    'sw1a1aa',
    '2026-10-30',
    '2026-02-30',
    '0000-01-01',
    '9999-12-31',
    '2026-10-30T00:00:00Z',
    '\u0000',
    'line\nbreak',
    '=HYPERLINK("x")',
    "'; DROP TABLE users; --",
    '<script>alert(1)</script>',
    '../../etc/passwd',
    'é'.repeat(300),
    'x'.repeat(5000),
    '%PDF-1.4',
    'AAAA',
    '😀 emoji',
    'not-an-email',
    'a@b.co',
  ];
  const keys = [
    'address', 'postcode', 'borough', 'has_gas', 'is_hmo', 'completed_on', 'expires_on', 'reference',
    'notes', 'tenant_name', 'start_date', 'deposit_amount_pence', 'deposit_received_on',
    'deposit_protected_on', 'prescribed_info_given_on', 'filename', 'content_type', 'data',
    'email_reminders', 'password', 'token', 'email', 'id', '__proto__', 'constructor',
  ];

  function value(depth = 0) {
    const kind = random();
    if (kind < 0.25) return pick(strings);
    if (kind < 0.35) return pick([0, 1, -1, 2.5, 1e308, -0, 2 ** 53, 12345678901234567890]);
    if (kind < 0.45) return pick([true, false, null]);
    if (depth < 2 && kind < 0.55) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    if (depth < 2 && kind < 0.65) return object(depth + 1);
    return pick(strings);
  }

  function object(depth = 0) {
    const result = {};
    const count = Math.floor(random() * 8);
    for (let index = 0; index < count; index += 1) {
      result[pick(keys)] = value(depth);
    }
    return result;
  }

  return { value, object, pick };
}

test('no random input causes a server error, and every API response is JSON', async (t) => {
  const random = prng(SEED);
  const gen = makeGenerator(random);
  const db = openDatabase(':memory:');
  const server = createServer({
    db,
    config: { appUrl: 'https://letready.example' },
    today: () => '2026-10-30',
    now: () => Date.parse('2026-10-30T12:00:00Z'),
    limits: {
      loginByEmail: { limit: 1e9, windowMs: 1000 },
      loginByIp: { limit: 1e9, windowMs: 1000 },
      register: { limit: 1e9, windowMs: 1000 },
      forgotByEmail: { limit: 1e9, windowMs: 1000 },
      forgotByIp: { limit: 1e9, windowMs: 1000 },
      resetByIp: { limit: 1e9, windowMs: 1000 },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Set up one real account so most requests reach real code, not the 401 guard.
  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fuzz@example.com', password: 'fuzz-password-1' }),
  });
  const cookie = register.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${base}/api/properties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ address: 'Fuzz House', postcode: 'E1 6AN', has_gas: true, is_hmo: true }),
  });
  const propertyId = (await created.json()).id;
  const types = ['gas_safety', 'eicr', 'epc', 'hmo_licence', 'rra_information_sheet', 'prs_database', 'nonsense', '..'];

  const endpoints = [
    () => ['POST', '/api/properties', gen.object(), true],
    () => ['PUT', `/api/properties/${propertyId}`, gen.object(), true],
    () => ['PUT', `/api/properties/${gen.pick([propertyId, 0, 99999, 'abc'])}/items/${gen.pick(types)}`, gen.object(), true],
    () => ['DELETE', `/api/properties/${propertyId}/items/${gen.pick(types)}`, {}, true],
    () => ['POST', `/api/properties/${propertyId}/tenancies`, gen.object(), true],
    () => ['PUT', `/api/properties/${propertyId}/tenancies/${gen.pick([1, 2, 'x', 0])}`, gen.object(), true],
    () => ['DELETE', `/api/properties/${propertyId}/tenancies/${gen.pick([1, 2, 'x'])}`, {}, true],
    () => ['POST', `/api/properties/${propertyId}/items/${gen.pick(types)}/documents`, gen.object(), true],
    () => ['GET', `/api/documents/${gen.pick([1, 2, 'z'])}`, null, true],
    () => ['DELETE', `/api/documents/${gen.pick([1, 2, 'z'])}`, {}, true],
    () => ['GET', `/api/properties/${propertyId}/export.csv`, null, true],
    () => ['PUT', '/api/me/preferences', gen.object(), true],
    () => ['GET', '/api/dashboard', null, true],
    () => ['GET', '/api/export', null, true],
    () => ['POST', '/api/auth/login', gen.object(), false],
    () => ['POST', '/api/auth/forgot', gen.object(), false],
    () => ['POST', '/api/auth/reset', gen.object(), false],
    () => ['POST', '/api/auth/register', gen.object(), false],
  ];

  const problems = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const [method, path, body, authenticated] = gen.pick(endpoints)();
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) headers.Cookie = cookie;
    const payload = method === 'GET' || body === null ? undefined : JSON.stringify(body);

    let response;
    try {
      response = await fetch(base + path, { method, headers, body: payload });
    } catch (error) {
      problems.push(`${method} ${path}: network error ${error.message}`);
      continue;
    }
    const type = response.headers.get('content-type') || '';
    const text = await response.text();

    if (response.status >= 500) problems.push(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
    if (type.includes('application/json')) {
      try {
        JSON.parse(text);
      } catch {
        problems.push(`${method} ${path} returned invalid JSON`);
      }
    }
  }

  assert.deepEqual(problems, [], `unexpected responses:\n${problems.join('\n')}`);
});
