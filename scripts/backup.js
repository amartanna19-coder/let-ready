#!/usr/bin/env node
'use strict';

// Usage: node scripts/backup.js <path-to-letready.db> <path-for-backup.db>
// Creates a consistent copy even while the app is running (SQLite VACUUM INTO),
// then checks the copy before reporting success.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function backup(sourceFile, destFile) {
  if (!fs.existsSync(sourceFile)) throw new Error(`Database not found: ${sourceFile}`);
  if (fs.existsSync(destFile)) throw new Error(`Refusing to overwrite existing file: ${destFile}`);
  fs.mkdirSync(path.dirname(path.resolve(destFile)), { recursive: true });

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    // VACUUM INTO does not accept a bound parameter, so the path is quoted by hand.
    source.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(destFile, { readOnly: true });
  try {
    const { integrity_check: check } = copy.prepare('PRAGMA integrity_check').get();
    if (check !== 'ok') throw new Error(`Backup failed integrity check: ${check}`);
  } finally {
    copy.close();
  }
  return destFile;
}

if (require.main === module) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) {
    console.error('Usage: node scripts/backup.js <path-to-letready.db> <path-for-backup.db>');
    process.exit(2);
  }
  try {
    console.log(`Backup written and verified: ${backup(source, destination)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { backup };
