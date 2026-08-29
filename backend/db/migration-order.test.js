'use strict';

/**
 * The migration path, exercised against a database that predates the columns.
 *
 * ⚠ THIS IS THE TEST THAT WAS MISSING, and its absence nearly took the backend
 * down on the next deploy. `calendar_cache.source` was added to schema.sql
 * together with an index naming it — which is correct for a FRESH database and
 * fatal for an existing one, because schema.sql is executed by an unguarded
 * db.exec() BEFORE any ALTER runs, and `CREATE TABLE IF NOT EXISTS` is a no-op
 * against a table that is already there. So on the live Pi the index referenced
 * a column that did not exist yet, db.init() threw, and the backend would not
 * have started at all.
 *
 * Every other test in this repo builds a fresh scratch database, where the
 * column arrives with CREATE TABLE and the migration branch never fires. A green
 * suite therefore said nothing whatsoever about the path that actually runs in
 * production — the same species as a test written over an invented metric name.
 *
 * This builds an OLD-SHAPED database first, then initialises over it.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-migrate-')), 'legacy.db',
);

/**
 * The tables as they existed BEFORE the columns under test — deliberately
 * hand-written rather than taken from schema.sql, because the whole point is to
 * reproduce a database that schema.sql has moved on from.
 */
function buildLegacyDatabase() {
  const legacy = new Database(DB_PATH);
  legacy.exec(`
    CREATE TABLE calendar_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      subject TEXT,
      start_time TEXT,
      end_time TEXT,
      is_all_day INTEGER DEFAULT 0,
      location TEXT,
      organizer TEXT,
      show_as TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      moscow TEXT,
      priority INTEGER,
      due_date TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      origin_path TEXT,
      origin_line INTEGER,
      context TEXT,
      notes TEXT,
      ms_id TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy.prepare(
    "INSERT INTO calendar_cache (event_id, subject, start_time, end_time, show_as) VALUES (?,?,?,?,?)"
  ).run('graph-legacy', 'Existing meeting', '2026-09-01T09:00:00', '2026-09-01T10:00:00', 'busy');
  legacy.prepare(
    'INSERT INTO tasks (text, dedupe_key) VALUES (?, ?)'
  ).run('A task from before domains existed', 'a task from before domains existed');
  legacy.close();
}

buildLegacyDatabase();
process.env.NEURO_DB_PATH = DB_PATH;
const db = require('./database');

test('db.init() survives a database that predates the new columns', async () => {
  // The assertion IS that this does not throw. Before the fix it threw on
  // `CREATE INDEX ... ON calendar_cache(source, ...)` and the backend would not
  // have started on the next deploy.
  await assert.doesNotReject(() => db.init());
});

test('the migration adds calendar_cache.source and stamps existing rows graph', () => {
  const row = db.get('SELECT source FROM calendar_cache WHERE event_id = ?', ['graph-legacy']);
  assert.equal(row.source, 'graph');
});

test('the source index exists after migrating, not only on a fresh database', () => {
  // It is created unconditionally after the ALTER rather than inside the
  // "column is missing" branch — on a fresh database that branch never fires,
  // so an index created only there would never exist on a new install.
  const idx = db.get(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_calendar_source'"
  );
  assert.ok(idx, 'idx_calendar_source should exist on a migrated database');
});

test('the migration adds tasks.domain and stamps existing rows work', () => {
  // Nick's own statement: everything captured before the split was work. That
  // is what makes the DEFAULT a fact rather than a guess, and it is why no
  // separate backfill pass is needed.
  const row = db.get('SELECT domain FROM tasks WHERE dedupe_key = ?', ['a task from before domains existed']);
  assert.equal(row.domain, 'work');
});

test('initialising twice is safe', async () => {
  // The backend restarts several times a day on deploys, so every migration
  // runs far more often than it does anything. A second init over an
  // already-migrated database must be a no-op, not a second ALTER.
  await assert.doesNotReject(() => db.init());
  assert.equal(
    db.get('SELECT source FROM calendar_cache WHERE event_id = ?', ['graph-legacy']).source,
    'graph',
  );
});
