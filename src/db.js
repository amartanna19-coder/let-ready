'use strict';

const { DatabaseSync } = require('node:sqlite');

// Each entry is one schema version. Versions are applied in order, once, and
// recorded in PRAGMA user_version, so an existing database upgrades safely.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE properties (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    postcode TEXT NOT NULL,
    borough TEXT,
    has_gas INTEGER NOT NULL DEFAULT 1,
    is_hmo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE compliance_records (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    completed_on TEXT,
    expires_on TEXT,
    reference TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (property_id, item_type)
  );
  `,
  `
  ALTER TABLE users ADD COLUMN email_reminders INTEGER NOT NULL DEFAULT 1;
  `,
  `
  CREATE TABLE tenancies (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    tenant_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    deposit_amount_pence INTEGER,
    deposit_received_on TEXT,
    deposit_protected_on TEXT,
    prescribed_info_given_on TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX tenancies_property ON tenancies(property_id);
  `,
  `
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX documents_property_item ON documents(property_id, item_type);
  `,
  `
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

  CREATE TABLE reminders_sent (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    due_on TEXT NOT NULL,
    bucket TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (property_id, item_key, due_on, bucket)
  );
  `,
];

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this app supports (${MIGRATIONS.length}).`);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// Runs fn inside a transaction, rolling back if it throws.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { openDatabase, transaction, MIGRATIONS };
