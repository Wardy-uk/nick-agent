'use strict';

/**
 * The Jira row on "Her senses", and the switch that sits beside it.
 *
 * The row exists because there was no honest answer to "can NEURO still see my
 * tickets" anywhere on a screen. What there WAS is worse than nothing: three
 * `agent_state` keys — `jira_status`, `jira_last_sync`, `jira_last_error` — read
 * by `/api/status` and rendered by the Admin page as "connected · Last sync
 * 19:11", whose writer was deleted with the queue feature on 3 July 2026. They
 * had been frozen for two months while reporting `ok`.
 *
 * So the thing most worth pinning is NEGATIVE: this row must not be built on the
 * dead key. A future tidy-up reaching for the obvious `jira_last_sync` would
 * reintroduce a permanently-stale light for a feature that works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sig-jira-')), 'a.db');
// The registry must decide the switch, so the env must not pin it here.
delete process.env.JIRA_ASSIGNED_SYNC_ENABLED;

const db = require('../db/database');
const jira = require('./jira');
const flags = require('./feature-flags');
const signals = require('./signals');

test.before(async () => { await db.init(); });

const NOW = new Date('2026-09-03T10:00:00Z');
const jiraRow = (now = NOW) => signals.snapshot(now).signals.find((s) => s.id === 'jira');

function withJira(configured, fn) {
  const real = jira.isConfigured;
  jira.isConfigured = () => configured;
  try { return fn(); } finally { jira.isConfigured = real; }
}

function withFlag(on, fn) {
  const real = flags.isEnabled;
  flags.isEnabled = (key) => (key === 'jira_assigned_sync' ? on : real(key));
  try { return fn(); } finally { flags.isEnabled = real; }
}

test('no credentials is OFF — a choice, never a fault', () => {
  const row = withJira(false, () => jiraRow());
  assert.equal(row.state, 'off');
  assert.match(row.why, /no Jira credentials/);
});

test('a poll inside its cadence is live, and names the open escalations', () => {
  db.setState('escalation_last_sync', '2026-09-03T09:57:00Z');
  db.setState('escalation_count', '1');
  const row = withJira(true, () => withFlag(false, () => jiraRow()));
  assert.equal(row.state, 'live');
  assert.equal(row.ageMinutes, 3);
  assert.match(row.detail, /1 open escalation/);
});

test('a poll that has stopped is STALE and says so', () => {
  // Every 300s, so half an hour of silence is three missed passes, not a hiccup.
  db.setState('escalation_last_sync', '2026-09-03T09:25:00Z');
  const row = withJira(true, () => withFlag(false, () => jiraRow()));
  assert.equal(row.state, 'stale');
  assert.match(row.why, /stopped answering/);
});

test('a poll that has never completed is NEVER, not stale', () => {
  db.setState('escalation_last_sync', '');
  const row = withJira(true, () => withFlag(false, () => jiraRow()));
  assert.equal(row.state, 'never');
  assert.match(row.why, /has not completed/);
});

test('the assigned-sync switch is reported on the row in BOTH positions', () => {
  // An off switch is a decision and belongs beside the light. Reporting it only
  // when on would make "off" indistinguishable from "this row forgot to say".
  db.setState('escalation_last_sync', '2026-09-03T09:57:00Z');
  const off = withJira(true, () => withFlag(false, () => jiraRow()));
  assert.match(off.detail, /assigned-ticket sync off/);
  const on = withJira(true, () => withFlag(true, () => jiraRow()));
  assert.match(on.detail, /assigned-ticket sync on/);
});

test('the switch is still reported when the poll has never run', () => {
  db.setState('escalation_last_sync', '');
  const row = withJira(true, () => withFlag(true, () => jiraRow()));
  assert.equal(row.state, 'never');
  assert.match(row.detail, /assigned-ticket sync on/);
});

test('NEGATIVE: the row is not built on the dead jira_last_sync key', () => {
  // The bug this row exists to avoid reproducing. `jira_last_sync` has had no
  // writer since 3 July 2026; a row reading it would sit stale for ever while
  // the escalation poll ran perfectly every five minutes.
  db.setState('escalation_last_sync', '2026-09-03T09:57:00Z');
  db.setState('jira_last_sync', '2026-07-03T19:11:20.828Z');
  db.setState('jira_status', 'ok');
  const row = withJira(true, () => withFlag(false, () => jiraRow()));
  assert.equal(row.state, 'live', 'a fresh escalation poll must read live regardless of the dead key');

  const src = fs.readFileSync(path.join(__dirname, 'signals.js'), 'utf-8');
  const jiraBlock = src.slice(src.indexOf("guard('jira'"), src.indexOf("guard('vault'"));
  assert.ok(jiraBlock.length > 0, 'jira guard block not found — did the row move?');
  assert.doesNotMatch(jiraBlock, /getState\('jira_last_sync'\)/,
    'the Jira row must not read jira_last_sync — it has had no writer since 3 July 2026');
  assert.doesNotMatch(jiraBlock, /getState\('jira_status'\)/,
    'the Jira row must not read jira_status — it has had no writer since 3 July 2026');
});

test('NEGATIVE: /api/status no longer reads the dead keys either', () => {
  // Two surfaces answering "is Jira alive" must not disagree, and the older one
  // was the one that was wrong.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.doesNotMatch(src, /getState\('jira_last_sync'\)/);
  assert.doesNotMatch(src, /getState\('jira_status'\)/);
  assert.doesNotMatch(src, /getState\('jira_last_error'\)/);
  // Positive control: the block still exists and now reads the live key.
  assert.match(src, /escalation_last_sync/);
});
