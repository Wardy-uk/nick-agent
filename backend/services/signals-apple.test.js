'use strict';

/**
 * The Apple Reminders row on "Her senses" (item 19).
 *
 * It is a PUSH source with no server-side schedule: nothing runs on a timer, so
 * when the Shortcut on the phone stops firing there is no failed job, no error
 * and no empty result anywhere. A phone that has stopped pushing looks exactly
 * like a man with no reminders. Measured 3 Sep 2026 — last push 29 August, 111
 * hours earlier, one task ever created from it, and nothing in NEURO said so.
 *
 * What is pinned is that the three answers stay apart: never pushed, pushing,
 * and stopped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-signals-')), 'a.db');

const db = require('../db/database');
const appleIngest = require('../services/apple-ingest');
const signals = require('./signals');

test.before(async () => { await db.init(); });

const NOW = new Date('2026-09-03T10:00:00Z');
const appleRow = (now = NOW) => signals.snapshot(now).signals.find((s) => s.id === 'apple');

function withStatus(status, fn) {
  const real = appleIngest.status;
  appleIngest.status = () => status;
  try { return fn(); } finally { appleIngest.status = real; }
}

test('a phone that has never pushed is NEVER, not stale', () => {
  // "It has never done this" and "it used to and has stopped" are different
  // facts and need different fixes. The Shortcut may simply not be installed.
  const row = withStatus({ known: true, events: 0, lastPushAt: null, ageHours: null, stale: true }, appleRow);
  assert.equal(row.state, 'never');
  assert.match(row.why, /never pushed/);
});

test('a phone pushing inside its cadence is live', () => {
  const row = withStatus({ known: true, events: 12, lastPushAt: '2026-09-03 08:00:00', ageHours: 2, stale: false }, appleRow);
  assert.equal(row.state, 'live');
  assert.equal(row.ageMinutes, 120);
  assert.match(row.detail, /12 event/);
});

test('a phone that has stopped is STALE and says what stopped', () => {
  // The live case on the day this was written: 111 hours, invisible everywhere.
  const row = withStatus({ known: true, events: 40, lastPushAt: '2026-08-29 17:00:37', ageHours: 111.4, stale: true }, appleRow);
  assert.equal(row.state, 'stale');
  assert.match(row.why, /stopped pushing/);
  assert.equal(row.ageMinutes, Math.round(111.4 * 60));
});

test('the staleness verdict is the ingest\'s own, not a second threshold', () => {
  // Two places deciding what "stale" means for one source is how a panel comes
  // to disagree with the endpoint it renders. Here the ingest says NOT stale at
  // an age this row would otherwise call stale, and the row follows it.
  const row = withStatus({ known: true, events: 1, lastPushAt: '2026-09-01 09:00:00', ageHours: 49, stale: false }, appleRow);
  assert.equal(row.state, 'live');
});

test('an unreadable ingest is an error, never a quiet all-clear', () => {
  const row = withStatus({ known: false, why: 'no such table' }, appleRow);
  assert.equal(row.state, 'error');
  assert.match(row.why, /no such table/);
});

test('a stale phone reaches the page headline', () => {
  // A row nobody can see from the top of the page is one nobody reads.
  const snap = withStatus(
    { known: true, events: 40, lastPushAt: '2026-08-29 17:00:37', ageHours: 111.4, stale: true },
    () => signals.snapshot(NOW),
  );
  assert.equal(snap.signals.some((s) => s.id === 'apple'), true);
  assert.ok(['stale', 'error'].includes(snap.overall), `overall was ${snap.overall}`);
});
