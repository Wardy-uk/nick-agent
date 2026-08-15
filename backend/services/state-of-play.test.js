'use strict';

/**
 * State of play — the ranking is the product, so that is what is pinned here.
 *
 * `snapshot()` is just SELECTs and needs a database to say anything; `assess()`
 * is the judgement and is pure, so it takes a plain object. The properties worth
 * defending are all about a dashboard not lying: a stale cache must outrank a
 * merely large number, "never ran" must stay distinct from "ran a long time ago",
 * and an empty coverage field must be called out rather than rendered as a
 * confident zero.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sop-')), 'a.db');

const { assess, overall, _internals } = require('./state-of-play');

/** A snapshot with nothing wrong; each test spoils exactly one thing. */
const clean = (over = {}) => ({
  tasks: { open: 10, done: 2, moscow: {}, unprioritised: 0, estimated: 10, overdue: 0, dueToday: 0, noDueDate: 0, byContext: [], bySource: [] },
  commitments: { open: 0, people: 0, top: [] },
  approvals: { pending: 0, pendingByType: {}, lifetime: {}, recent: [] },
  queue: { cached: 5, atRisk: 0, byStatus: [], fetchedAt: '2026-08-15 09:00:00', staleDays: 0 },
  inbox: { open: 0, byUrgency: {} },
  rituals: { days: [], standupDays: 5, eodDays: 5, window: 21 },
  vault: { chunks: 100, files: 10, entities: 0, links: 0, lastEmbedAt: null, lastEmbedDays: null },
  jobs: [{ name: 'nightly-sweep', cadence: 'daily', lastRun: '2026-08-15', ageDays: 0, state: 'ok' }],
  calendar: { upcoming: [], cached: 0 },
  ...over,
});

test('a clean snapshot raises nothing and reads ok', () => {
  const issues = assess(clean());
  assert.equal(issues.length, 0);
  assert.equal(overall(issues), 'ok');
});

// ── Stale beats big ─────────────────────────────────────────────────────────
//
// The bug this panel was built to catch: the Jira cache had been stale since
// 3 July and every screen reading it looked fine. A stale cache is worse than a
// large backlog, because the backlog is at least true.

test('a stale Jira cache is critical and outranks everything else', () => {
  const issues = assess(clean({
    queue: { cached: 12, atRisk: 4, byStatus: [], fetchedAt: '2026-07-03 19:11:19', staleDays: 43 },
    tasks: { ...clean().tasks, overdue: 16 },
  }));
  assert.equal(issues[0].severity, 'critical');
  assert.match(issues[0].title, /Jira queue cache is stale/);
  assert.match(issues[0].detail, /43 days/);
  assert.equal(overall(issues), 'critical');
});

test('a fresh cache inside the threshold raises nothing', () => {
  const issues = assess(clean({ queue: { ...clean().queue, staleDays: 3 } }));
  assert.equal(issues.filter(i => /Jira/.test(i.title)).length, 0);
});

// ── Never-ran is not the same as long-ago ───────────────────────────────────

test('a job that stopped is critical; one that never ran is only a warning', () => {
  const stopped = assess(clean({
    jobs: [{ name: 'nightly-sweep', cadence: 'daily', lastRun: '2026-08-01', ageDays: 14, state: 'stale' }],
  }));
  assert.equal(stopped[0].severity, 'critical');
  assert.match(stopped[0].title, /nightly-sweep has stopped/);

  const never = assess(clean({
    jobs: [{ name: 'nightly-rollup', cadence: 'daily', lastRun: null, ageDays: null, state: 'never' }],
  }));
  assert.equal(never[0].severity, 'warn');
  assert.match(never[0].title, /has never run/);
});

// ── Outbound changes the severity, not just the wording ─────────────────────

test('pending approvals escalate when something would leave the building', () => {
  const internal = assess(clean({ approvals: { pending: 3, pendingByType: { capture_todo: 3 }, lifetime: {}, recent: [] } }));
  assert.equal(internal[0].severity, 'info');
  assert.match(internal[0].detail, /Nothing outbound/);

  const outbound = assess(clean({ approvals: { pending: 3, pendingByType: { draft_reply: 1, capture_todo: 2 }, lifetime: {}, recent: [] } }));
  assert.equal(outbound[0].severity, 'warn');
  assert.match(outbound[0].detail, /leave the building/);
});

// ── Coverage gaps are stated, never rendered as a confident zero ────────────

test('zero estimates is called out rather than shown as a clean zero', () => {
  const issues = assess(clean({ tasks: { ...clean().tasks, open: 147, estimated: 0 } }));
  const e = issues.find(i => /time estimate/.test(i.title));
  assert.ok(e, 'expected an estimate-coverage issue');
  assert.match(e.detail, /147/);
  assert.match(e.detail, /30 minutes/);
});

test('no estimate issue is raised when there are no open tasks at all', () => {
  const issues = assess(clean({ tasks: { ...clean().tasks, open: 0, estimated: 0 } }));
  assert.equal(issues.filter(i => /time estimate/.test(i.title)).length, 0);
});

test('the worst commitment offender is named with a real age', () => {
  const issues = assess(clean({
    commitments: { open: 287, people: 29, top: [{ person: 'Chris', count: 31, oldest: '2026-04-30', ageDays: 107 }] },
  }));
  const c = issues.find(i => /commitments owed/.test(i.title));
  assert.equal(c.severity, 'warn');           // >100 is a warning, not a shrug
  assert.match(c.detail, /Chris \(31, oldest 107 days\)/);
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('issues come back worst-first', () => {
  const issues = assess(clean({
    queue: { ...clean().queue, staleDays: 43 },
    tasks: { ...clean().tasks, open: 147, estimated: 0, overdue: 16 },
    commitments: { open: 287, people: 29, top: [{ person: 'Chris', count: 31, oldest: '2026-04-30', ageDays: 107 }] },
  }));
  const rank = { critical: 0, warn: 1, info: 2 };
  const seen = issues.map(i => rank[i.severity]);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'severities must be non-decreasing');
});

// ── Dates are local, not UTC ────────────────────────────────────────────────
//
// The Pi may run in UTC. A date built with toISOString() flips a day early every
// evening, which would make "due today" wrong for a third of the day.

test('todayLocal matches local wall-clock date, not the UTC one', () => {
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(_internals.todayLocal(), expected);
});

test('daysSince tolerates the space-separated timestamps SQLite writes', () => {
  const d = new Date(Date.now() - 5 * 86400000);
  const sqliteStyle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 12:00:00`;
  const got = _internals.daysSince(sqliteStyle);
  assert.ok(got === 4 || got === 5, `expected ~5 days, got ${got}`);
  assert.equal(_internals.daysSince(null), null);
  assert.equal(_internals.daysSince('not a date'), null);
});
