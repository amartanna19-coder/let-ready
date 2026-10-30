'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../src/auth');
const { csvCell, toCsv } = require('../src/csv');
const files = require('../src/files');
const { RateLimiter } = require('../src/rate-limit');

// ---- CSV -------------------------------------------------------------------

test('CSV cells are quoted and spreadsheet formulas are neutralised', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCell('2026-10-30'), '2026-10-30');
});

test('CSV rows use CRLF line endings and end with one', () => {
  assert.equal(toCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d\r\n');
});

// ---- Uploads ---------------------------------------------------------------

test('filenames are reduced to a safe basename', () => {
  assert.equal(files.sanitizeFilename('certificate.pdf'), 'certificate.pdf');
  assert.equal(files.sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(files.sanitizeFilename('C:\\Users\\me\\gas.pdf'), 'gas.pdf');
  assert.equal(files.sanitizeFilename('evil<script>.pdf'), 'evilscript.pdf');
  assert.equal(files.sanitizeFilename('quote"and:colon.pdf'), 'quoteandcolon.pdf');
  assert.equal(files.sanitizeFilename('tab\tand\nnewline.pdf'), 'tabandnewline.pdf', 'control characters are removed');
  assert.equal(files.sanitizeFilename('   '), 'document');
  assert.equal(files.sanitizeFilename(undefined), 'document');
  assert.equal(files.sanitizeFilename('x'.repeat(300)).length, 120);
});

test('file contents must match the declared type by signature', () => {
  const pdf = Buffer.from('%PDF-1.7 rest of file');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
  assert.equal(files.matchesDeclaredType(pdf, 'application/pdf'), true);
  assert.equal(files.matchesDeclaredType(png, 'image/png'), true);
  assert.equal(files.matchesDeclaredType(jpeg, 'image/jpeg'), true);
  assert.equal(files.matchesDeclaredType(pdf, 'image/png'), false);
  assert.equal(files.matchesDeclaredType(Buffer.from('%PD'), 'application/pdf'), false, 'shorter than the signature');
  assert.equal(files.matchesDeclaredType(pdf, 'text/html'), false, 'undeclared types are never accepted');
  assert.equal(files.matchesDeclaredType(Buffer.alloc(0), 'image/jpeg'), false);
});

test('download names are safe in headers, including non-ASCII names', () => {
  const header = files.contentDisposition('Gas “certificate”.pdf');
  assert.match(header, /^attachment; filename="Gas _certificate_\.pdf"; filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(header));
  assert.ok(files.contentDisposition('a"b.pdf').includes('filename="ab.pdf"'));
});

// ---- Rate limiting ---------------------------------------------------------

test('the rate limiter allows the limit, blocks the next attempt, and resets after the window', () => {
  const clock = { now: 1000 };
  const limiter = new RateLimiter({ limit: 3, windowMs: 60000, now: () => clock.now });
  assert.equal(limiter.hit('ip').allowed, true);
  assert.equal(limiter.hit('ip').allowed, true);
  assert.equal(limiter.hit('ip').allowed, true);
  const blocked = limiter.hit('ip');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);

  clock.now += 30000;
  const stillBlocked = limiter.hit('ip');
  assert.equal(stillBlocked.allowed, false);
  assert.equal(stillBlocked.retryAfterSeconds, 30, 'the reply says how long is left in the window');

  clock.now += 31000;
  assert.equal(limiter.hit('ip').allowed, true, 'a new window has started');
});

test('rate limit keys are independent, and reset clears one key', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 60000 });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, false);
  assert.equal(limiter.hit('b').allowed, true);
  limiter.reset('a');
  assert.equal(limiter.hit('a').allowed, true);
});

test('the limiter drops expired keys so memory does not grow without bound', () => {
  const clock = { now: 0 };
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: () => clock.now, maxKeys: 5 });
  for (let index = 0; index < 5; index += 1) limiter.hit(`key${index}`);
  clock.now += 2000;
  limiter.hit('fresh');
  assert.equal(limiter.buckets.size, 1);
});

// ---- Passwords, tokens and cookies ----------------------------------------

test('passwords are salted and verified without storing the password', () => {
  const stored = auth.hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(auth.hashPassword('correct horse battery'), stored, 'each hash has its own salt');
  assert.equal(auth.verifyPassword('correct horse battery', stored), true);
  assert.equal(auth.verifyPassword('correct horse batterY', stored), false);
  assert.equal(auth.verifyPassword('', stored), false);
});

test('malformed stored password values never verify', () => {
  assert.equal(auth.verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(auth.verifyPassword('anything', 'md5$abc$def'), false);
  assert.equal(auth.verifyPassword('anything', ''), false);
});

test('session cookies are HttpOnly, SameSite and Secure only when asked', () => {
  const expires = Date.UTC(2026, 11, 1);
  const plain = auth.sessionCookie('tok', expires, false);
  assert.match(plain, /^letready_session=tok; Path=\/; HttpOnly; SameSite=Lax; Expires=/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(auth.sessionCookie('tok', expires, true), /; Secure$/);
  const cleared = auth.clearedSessionCookie(true);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Secure/);
});

test('the session cookie is read even when other cookies are present', () => {
  const req = { headers: { cookie: 'theme=dark; letready_session=abc123; other=1' } };
  assert.equal(auth.readSessionToken(req), 'abc123');
  assert.equal(auth.readSessionToken({ headers: {} }), null);
  assert.equal(auth.readSessionToken({ headers: { cookie: 'letready_session_old=zzz' } }), null);
});

// ---- Accessibility of the palette -----------------------------------------

function parseBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `selector ${selector} not found`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const values = {};
  for (const match of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    values[match[1]] = match[2];
  }
  return values;
}

function luminance(hex) {
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test('text and status colours meet WCAG AA contrast (4.5:1) in light and dark themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const light = parseBlock(css, ':root {');
  const dark = parseBlock(css, ':root:not([data-theme="light"])');

  const pairs = [
    ['text', 'bg'],
    ['text', 'surface'],
    ['muted', 'bg'],
    ['muted', 'surface'],
    ['accent', 'surface'],
    ['accent-text', 'accent'],
    ['ok', 'ok-bg'],
    ['warn', 'warn-bg'],
    ['danger', 'danger-bg'],
    ['danger', 'surface'],
  ];

  for (const [theme, label] of [
    [light, 'light'],
    [dark, 'dark'],
  ]) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(theme[foreground], theme[background]);
      assert.ok(
        ratio >= 4.5,
        `${label}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
});
