'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-adhd-'));
process.env.NEURO_DB_PATH = path.join(root, 'adhd.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const adhd = require('./adhd-dashboard');

const today = new Date().toISOString().split('T')[0];
const dayKey = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

test.before(async () => { await db.init(); });

test.beforeEach(() => {
  db.getDb().prepare('DELETE FROM activity_log').run();
});

test('momentum counts finished work, not captured thoughts', () => {
  db.logActivity('task_done', { text: 'Sent the QA summary' }, today);
  db.logActivity('standup_done', { hour: 9 }, today);
  // Input, not progress — a day of pure capture must not read as productive.
  db.logActivity('capture', { type: 'note' }, today);
  db.logActivity('chat_message', { topics: ['queue'] }, today);

  const m = adhd._momentum(today);
  assert.equal(m.doneToday, 2);
  assert.equal(m.rituals.standup, true);
  assert.equal(m.rituals.eod, false);
});

test('the 7-day trend always has 7 days, including the empty ones', () => {
  db.logActivity('task_done', { text: 'a' }, dayKey(3));
  const m = adhd._momentum(today);
  assert.equal(m.last7.length, 7);
  assert.equal(m.last7[m.last7.length - 1].date, today);
  assert.equal(m.last7.find(d => d.date === dayKey(3)).done, 1);
  assert.equal(m.best7, 1);
});

test('an empty today does not break yesterday\'s streak', () => {
  // Nothing logged today at all — the day is in progress, not failed.
  for (let i = 1; i <= 3; i++) {
    const key = dayKey(i);
    const day = new Date(key).getDay();
    if (day === 0 || day === 6) continue;
    db.logActivity('task_done', { text: `day-${i}` }, key);
  }
  const m = adhd._momentum(today);
  assert.ok(m.streakDays >= 1, 'a quiet morning should not read as a broken streak');
  assert.equal(m.doneToday, 0);
});

test('wins read back as things you did, newest first', () => {
  db.logActivity('task_done', { text: 'Sent the QA summary' }, today);
  db.logActivity('one_two_one_done', { personName: 'Heidi' }, today);

  const wins = adhd._winsToday(today);
  assert.equal(wins.length, 2);
  assert.match(wins[0].text, /Heidi/);
  assert.match(wins[1].text, /QA summary/);
});

test('avoidance needs a pattern — once or twice is just a busy day', () => {
  db.logActivity('nudge_snoozed', { type: 'standup' }, today);
  db.logActivity('nudge_snoozed', { type: 'standup' }, today);
  assert.equal(adhd._avoidance(today).signals.filter(s => s.kind === 'nudge').length, 0);

  db.logActivity('nudge_dismissed', { type: 'standup' }, today);
  const signals = adhd._avoidance(today).signals.filter(s => s.kind === 'nudge');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].count, 3);
  // Fact, not verdict.
  assert.match(signals[0].detail, /pushed back 3 times/);
  assert.doesNotMatch(signals[0].detail, /avoid|should|fail/i);
});

test('quick wins are short action verbs, never projects or overdue work', () => {
  const wins = adhd._quickWins([
    { text: 'Reply to Kayleigh about the brand pack' },
    { text: 'Design the tiered support model rollout' },              // project word
    { text: 'Approve Heidi leave request' },
    { text: 'Write up the full QA framework proposal for SMT review' }, // too long + project
    { text: 'Chase the Engineering handover', due_date: '2020-01-01' }, // overdue
    { text: 'The printer is broken' },                                  // no action verb
  ], today);

  const texts = wins.map(w => w.text);
  assert.ok(texts.includes('Reply to Kayleigh about the brand pack'));
  assert.ok(texts.includes('Approve Heidi leave request'));
  assert.equal(texts.length, 2);
});

test('quick wins carry the ids needed to actually complete them', () => {
  const wins = adhd._quickWins([
    { text: 'Approve Heidi leave request', task_id: 42, ms_id: null, filePath: null, lineNumber: null },
  ], today);
  assert.equal(wins[0].task_id, 42);
});

test('the day shape changes with the clock and never nags at the weekend', () => {
  assert.equal(adhd._shape(10, false).mode, 'morning');
  assert.equal(adhd._shape(17, false).mode, 'lateday');
  assert.equal(adhd._shape(10, true).mode, 'weekend');
  assert.match(adhd._shape(10, true).line, /rest is strategy/i);
});

test('build returns every panel even with an empty database', async () => {
  const payload = await adhd.build();
  for (const key of ['shape', 'rightNow', 'momentum', 'winsToday', 'avoidance', 'quickWins']) {
    assert.ok(payload[key] !== undefined, `${key} missing`);
  }
  assert.equal(payload.momentum.doneToday, 0);
  assert.deepEqual(payload.winsToday, []);
});
