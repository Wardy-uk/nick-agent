'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-outcomes-'));
process.env.NEURO_DB_PATH = path.join(root, 'outcomes.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const outcomes = require('./outcomes');
const report = require('./outcomes-report');

// Wednesday 2026-08-12. Its week runs Mon 10th to Sun 16th.
const WED = new Date(2026, 7, 12, 10, 0);

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.getDb().prepare('DELETE FROM activity_log').run(); });

test('weeks run Monday to Sunday, whichever day you ask on', () => {
  for (const d of [new Date(2026, 7, 10), WED, new Date(2026, 7, 16, 23, 0)]) {
    assert.equal(outcomes.weekStart(d).getDay(), 1, 'week must start on Monday');
    assert.equal(outcomes.weekKey(d), outcomes.weekKey(WED), 'same week, same key');
  }
  // Sunday belongs to the week that just ended, not the one starting tomorrow.
  const sunday = new Date(2026, 7, 16, 12, 0);
  assert.equal(outcomes.weekStart(sunday).getDate(), 10);
});

test('finished counts real work and ignores mere input', () => {
  db.logActivity('task_done', { text: 'a' }, '2026-08-10');
  db.logActivity('standup_done', {}, '2026-08-11');
  db.logActivity('one_two_one_done', { personName: 'Heidi' }, '2026-08-12');
  // Input, not progress.
  db.logActivity('capture', { type: 'note' }, '2026-08-12');
  db.logActivity('chat_message', { topics: ['x'] }, '2026-08-12');

  const w = outcomes.computeWeek(WED);
  assert.equal(w.finished.total, 3);
  assert.equal(w.finished.activeDays, 3);
  assert.equal(w.captures, 1);
});

test('work outside the week is not counted', () => {
  db.logActivity('task_done', { text: 'last week' }, '2026-08-07');
  db.logActivity('task_done', { text: 'next week' }, '2026-08-18');
  db.logActivity('task_done', { text: 'this week' }, '2026-08-12');

  const w = outcomes.computeWeek(WED);
  assert.equal(w.finished.total, 1);
  assert.equal(w.from, '2026-08-10');
  assert.equal(w.to, '2026-08-16');
});

test('nag pressure counts both snoozes and dismissals', () => {
  db.logActivity('nudge_snoozed', { type: 'standup' }, '2026-08-11');
  db.logActivity('nudge_snoozed', { type: 'todo' }, '2026-08-11');
  db.logActivity('nudge_dismissed', { type: 'todo' }, '2026-08-12');

  const w = outcomes.computeWeek(WED);
  assert.deepEqual(
    { snoozed: w.nagPressure.snoozed, dismissed: w.nagPressure.dismissed, total: w.nagPressure.total },
    { snoozed: 2, dismissed: 1, total: 3 },
  );
});

test('a week with no data returns zeroes, not a crash or a hole', () => {
  const w = outcomes.computeWeek(WED);
  assert.equal(w.finished.total, 0);
  assert.equal(w.nagPressure.total, 0);
  assert.equal(w.suggestions.approvalRate, null, 'no actions means no rate, not 0%');
});

test('a snapshot is stored per week and read back rather than recomputed', () => {
  db.logActivity('task_done', { text: 'a' }, '2026-08-12');
  const saved = outcomes.snapshot(WED);
  assert.equal(saved.finished.total, 1);

  // Change history after the fact — the stored snapshot must not move.
  db.logActivity('task_done', { text: 'b' }, '2026-08-12');
  const raw = JSON.parse(db.getState(`outcomes_${outcomes.weekKey(WED)}`));
  assert.equal(raw.finished.total, 1, 'a stored week must not be rewritten by later data');
});

test('weeks with no snapshot are reported missing, not back-filled', () => {
  const weeks = outcomes.recent(4);
  assert.equal(weeks.length, 4);
  // The current week is always computed live so the view is never a week behind.
  assert.equal(weeks[weeks.length - 1].missing, undefined);
  assert.ok(weeks.slice(0, -1).every(w => w.missing), 'past weeks without a snapshot must say so');
});

test('the trend refuses to draw a line through a single point', () => {
  const t = outcomes.trend(5);
  assert.equal(t.enough, false);
});

test('the report states facts without passing judgement on Nick', () => {
  db.logActivity('task_done', { text: 'a' }, '2026-08-12');
  db.logActivity('nudge_snoozed', { type: 'todo' }, '2026-08-12');

  const section = report.buildSection(WED);
  assert.match(section, /^## Did the system help\?$/m);
  assert.match(section, /\*\*Finished:\*\* 1 thing/);
  assert.match(section, /\*\*Nudges pushed back:\*\* 1/);
  // Same tone rule as the nudges: never a verdict about the person.
  assert.doesNotMatch(section, /you (ignored|failed|didn't|avoided)/i);
  assert.doesNotMatch(section, /disappointing|poor|bad week/i);
});
