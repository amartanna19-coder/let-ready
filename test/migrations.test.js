'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, MIGRATIONS } = require('../src/db');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letready-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'test.db');
}

function version(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

test('a new database is created at the latest schema version', () => {
  const db = openDatabase(':memory:');
  assert.equal(version(db), MIGRATIONS.length);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of ['users', 'sessions', 'properties', 'compliance_records', 'tenancies', 'documents', 'password_resets', 'outbox', 'reminders_sent']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
});

test('reopening a database does not run migrations again or lose data', (t) => {
  const file = tempFile(t);
  const first = openDatabase(file);
  first.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('keep@example.com', 'scrypt$00$00');
  first.close();

  const second = openDatabase(file);
  assert.equal(version(second), MIGRATIONS.length);
  assert.equal(second.prepare('SELECT COUNT(*) AS total FROM users').get().total, 1);
  second.close();
});

test('an old version 1 database upgrades in place and keeps its data', (t) => {
  const file = tempFile(t);
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON;');
  old.exec(MIGRATIONS[0]);
  old.exec('PRAGMA user_version = 1');
  old.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('legacy@example.com', 'scrypt$00$00');
  old.prepare('INSERT INTO properties (user_id, address, postcode) VALUES (1, ?, ?)').run('1 Old Street', 'N1 1AA');
  old.close();

  const upgraded = openDatabase(file);
  assert.equal(version(upgraded), MIGRATIONS.length);
  const property = upgraded.prepare('SELECT address, has_gas FROM properties').get();
  assert.equal(property.address, '1 Old Street');
  assert.equal(property.has_gas, 1, 'columns added later get their defaults');
  assert.equal(upgraded.prepare('SELECT email_reminders FROM users').get().email_reminders, 1);
  upgraded.close();
});

test('a database from a newer app version is refused rather than damaged', (t) => {
  const file = tempFile(t);
  const newer = new DatabaseSync(file);
  newer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  newer.close();
  assert.throws(() => openDatabase(file), /newer than this app supports/);
});

test('a failing migration rolls back completely', (t) => {
  // Simulate a broken migration by pointing user_version at an unmigrated database
  // that already has a conflicting table, so migration 1 fails partway through.
  const file = tempFile(t);
  const broken = new DatabaseSync(file);
  broken.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, conflicting TEXT)');
  broken.close();

  assert.throws(() => openDatabase(file));
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.deepEqual(tables, ['users'], 'no partial tables were left behind');
  check.close();
});

test('foreign keys are enforced, so orphan rows are refused', () => {
  const db = openDatabase(':memory:');
  assert.throws(() =>
    db.prepare('INSERT INTO properties (user_id, address, postcode) VALUES (999, ?, ?)').run('x', 'E1 6AN'),
  );
});
