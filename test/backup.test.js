'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../src/db');
const { backup } = require('../scripts/backup');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letready-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a backup is a consistent, verified copy of the live database', (t) => {
  const dir = workspace(t);
  const source = path.join(dir, 'letready.db');
  const live = openDatabase(source);
  live.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('backup@example.com', 'scrypt$00$00');
  live.prepare('INSERT INTO properties (user_id, address, postcode) VALUES (1, ?, ?)').run('1 Backup Lane', 'E1 6AN');

  const destination = path.join(dir, 'backups', 'copy.db');
  assert.equal(backup(source, destination), destination);

  const copy = new DatabaseSync(destination);
  assert.equal(copy.prepare('SELECT address FROM properties').get().address, '1 Backup Lane');
  copy.close();

  // Writes made after the backup do not appear in it.
  live.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('later@example.com', 'scrypt$00$00');
  const after = new DatabaseSync(destination);
  assert.equal(after.prepare('SELECT COUNT(*) AS total FROM users').get().total, 1);
  after.close();
  live.close();
});

test('an existing backup file is never overwritten', (t) => {
  const dir = workspace(t);
  const source = path.join(dir, 'letready.db');
  openDatabase(source).close();
  const destination = path.join(dir, 'keep.db');
  fs.writeFileSync(destination, 'important');
  assert.throws(() => backup(source, destination), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'important');
});

test('a missing source database is reported clearly', (t) => {
  const dir = workspace(t);
  assert.throws(() => backup(path.join(dir, 'missing.db'), path.join(dir, 'out.db')), /Database not found/);
});

test('destination paths containing quotes are handled safely', (t) => {
  const dir = workspace(t);
  const source = path.join(dir, 'letready.db');
  openDatabase(source).close();
  const destination = path.join(dir, "o'brien's backup.db");
  backup(source, destination);
  assert.ok(fs.existsSync(destination));
});
