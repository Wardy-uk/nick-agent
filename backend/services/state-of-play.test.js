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

// ── The Jira queue card ─────────────────────────────────────────────────────
//
// Removed 27 Aug 2026 along with the cache it described. This panel was built to
// catch exactly that bug — a cache with no writer, quietly serving twelve rows
// frozen on 3 July to every screen that read it — and it did its job: the card
// is what surfaced the decision. Both halves are now closed, so there is nothing
// left for it to report.
//
// The general rule it taught survives in the job checks below: a stale source is
// worse than a big number, because a big number is at least true.
//
// Escalations were never part of this card and are live via their own path.

test('nothing in the snapshot mentions the Jira queue any more', () => {
  const issues = assess(clean({ tasks: { ...clean().tasks, overdue: 16 } }));
  assert.equal(issues.filter(i => /Jira|queue cache/i.test(i.title)).length, 0);
});

// ── Never-ran is not the same as long-ago ───────────────────────────────────

test('a job that stopped is critical; one never yet stamped is only info', () => {
  const stopped = assess(clean({
    jobs: [{ name: 'nightly-sweep', cadence: 'daily', lastRun: '2026-08-01', ageDays: 14, state: 'stale' }],
  }));
  assert.equal(stopped[0].severity, 'critical');
  assert.match(stopped[0].title, /nightly-sweep has stopped/);

  // Unknown is not broken. Run-tracking shipped after these jobs existed, so on
  // day one embeddings-rebuild had no stamp while it was actively rebuilding —
  // reporting that as a fault put two false warnings at the top of the board.
  const never = assess(clean({
    jobs: [{ name: 'nightly-rollup', cadence: 'daily', lastRun: null, ageDays: null, state: 'never' }],
  }));
  assert.equal(never[0].severity, 'info');
  assert.match(never[0].title, /no last-run stamp yet/);
});

// ── Outbound changes the severity, not just the wording ─────────────────────

test('pending approvals escalate only when something really sends', () => {
  const internal = assess(clean({ approvals: { pending: 3, outbound: 0, pendingByType: { capture_todo: 3 }, pendingByKind: { write: 3 }, lifetime: {}, recent: [] } }));
  assert.equal(internal[0].severity, 'info');
  assert.match(internal[0].detail, /All internal/);

  const outbound = assess(clean({ approvals: { pending: 3, outbound: 1, pendingByType: { chase_commitment: 1, capture_todo: 2 }, pendingByKind: { outbound: 1, write: 2 }, lifetime: {}, recent: [] } }));
  assert.equal(outbound[0].severity, 'warn');
  assert.match(outbound[0].detail, /1 would send something to a real person/);
});

// The regression this replaced. draft_reply reads as outbound by its name and is
// classified `write`, because approving it sends NOTHING — it drafts the words
// and queues a separate reply_email for a second approval. Counting it as
// outbound made the panel disagree with the Actions queue and with the guard in
// bulk-reject, all three of which must mean the same thing by "leaves the
// building". The count now comes from action-presenter, so this asserts that the
// severity follows the presenter's verdict rather than a list of type names.
test('draft_reply alone does not count as outbound', () => {
  const presenter = require('./action-presenter');
  const kind = presenter.describe({ type: 'draft_reply', payload: { from: 'a@b.c', subject: 'x', emailId: '1' } }).kind;
  assert.equal(kind, 'write', 'draft_reply must stay a write — gate 1 of 2 sends nothing');

  const issues = assess(clean({
    approvals: { pending: 1, outbound: 0, pendingByType: { draft_reply: 1 }, pendingByKind: { write: 1 }, lifetime: {}, recent: [] },
  }));
  assert.equal(issues[0].severity, 'info');
  assert.match(issues[0].detail, /All internal/);
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
