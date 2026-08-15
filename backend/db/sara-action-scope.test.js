'use strict';

/**
 * The scoped sara_action reads, pinned against the bug that produced them.
 *
 * Three callers asked "have I already actioned this?" by pulling
 * `getRecentSaraActions(N)` and filtering the result. That is a GLOBAL recency
 * window, not a scoped query. The table churns thousands of rows a day, so by
 * 15 Aug the newest 500 covered about 21 hours — last night's actions for a
 * note were already outside it, the nightly vault scan found no prior action,
 * and it re-queued every candidate it had queued the night before. 926 pending
 * capture_todos, 442 of them distinct.
 *
 * The property that matters is simple and is the one these tests hold: a
 * scoped read must find a row NO MATTER HOW MANY newer rows exist. So each
 * test buries the row under more noise than any window would survive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-actions-'));
process.env.NEURO_DB_PATH = path.join(root, 'actions.db');

const db = require('./database');

const NOTE = 'Meetings/2026/06/2026-06-01 – ProCo Integration.md';
const NOISE = 1200;   // comfortably past every window the old code used (200, 500)

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM sara_actions', []); });

/** Bury a row under `n` newer rows of unrelated churn — open_task is what the
 *  real table is mostly made of. */
function bury(n) {
  for (let i = 0; i < n; i++) {
    db.createSaraAction('open_task', { navigate: 'todos', i }, 0.5, 'noise', `noise-${i}`);
  }
}

/** Age a row by hand. Every insert in a test lands in the same second, so
 *  without this `ORDER BY created_at DESC` has nothing to order by and the
 *  recency window appears to work — the real rows were a night apart. */
function backdate(id, days) {
  db.run(`UPDATE sara_actions SET created_at = datetime('now', ?) WHERE id = ?`,
    [`-${days} days`, id]);
}

test('a note\'s prior action is found however much newer churn is on top of it', () => {
  const id = db.createSaraAction(
    'capture_todo',
    { text: 'Confirm the field mapping', sourcePath: NOTE, sourceLine: 53 },
    0.8, 'You were named', 'note-action:proco:abc'
  );
  backdate(id, 1);          // queued last night, like the real ones
  bury(NOISE);

  // What the old code did, kept here as the counter-example: it genuinely
  // cannot see the row, which is exactly why the duplicate got created.
  const viaWindow = db.getRecentSaraActions(500)
    .filter(a => a.type === 'capture_todo' && a.payload?.sourcePath === NOTE);
  assert.equal(viaWindow.length, 0, 'precondition: a recency window loses the row');

  const scoped = db.getSaraActionsBySource(NOTE, 'capture_todo');
  assert.equal(scoped.length, 1, 'the scoped read must still find it');
  assert.equal(scoped[0].id, id);
  assert.equal(scoped[0].payload.sourceLine, 53, 'payload comes back parsed');
});

test('getSaraActionsBySource does not leak other notes or other types', () => {
  db.createSaraAction('capture_todo', { text: 'a', sourcePath: NOTE }, 0.8, 'r', 'f1');
  db.createSaraAction('capture_todo', { text: 'b', sourcePath: 'Meetings/other.md' }, 0.8, 'r', 'f2');
  db.createSaraAction('draft_reply', { emailId: 'x', sourcePath: NOTE }, 0.8, 'r', 'f3');

  const scoped = db.getSaraActionsBySource(NOTE, 'capture_todo');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].payload.text, 'a');

  const anyType = db.getSaraActionsBySource(NOTE);
  assert.equal(anyType.length, 2, 'no type filter means every type for that note');
});

test('a chase_agenda already sent is still seen after a day of churn', () => {
  // This one guards an outbound email: the set exists so a second chaser does
  // not go to the same organiser about the same meeting.
  const sent = db.createSaraAction('chase_agenda', { eventId: 'EVT-1' }, 0.8, 'Ask the organiser', null);
  backdate(sent, 1);
  bury(NOISE);

  const seen = new Set(
    db.getSaraActionsByType('chase_agenda')
      .filter(a => a.status !== 'rejected')
      .map(a => a.payload?.eventId)
  );
  assert.ok(seen.has('EVT-1'), 'the organiser would otherwise be emailed twice');
});

test('the status tally counts the whole period, not the newest N rows', () => {
  bury(NOISE);                                   // 1200 pending open_tasks
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(db.createSaraAction('capture_todo', { text: `t${i}` }, 0.8, 'r', `x-${i}`));
  }
  for (const id of ids) db.updateSaraActionStatus(id, 'rejected');

  const tally = db.countSaraActionsSince('2000-01-01');
  assert.equal(tally.rejected, 5);
  assert.equal(tally.pending, NOISE);

  // The old approach: newest 200 filtered by date. It sees 200 of 1205, so the
  // approval rate it reports is wrong in the flattering direction.
  const windowed = db.getRecentSaraActions(200).filter(a => a.status === 'pending').length;
  assert.ok(windowed < tally.pending, 'precondition: the window undercounts');
});
