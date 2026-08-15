'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-waiting-'));
process.env.NEURO_DB_PATH = path.join(root, 'waiting.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const waitingOn = require('./waiting-on');

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.setState('waiting_on_items', '[]'); });

test('age is measured from the meeting, not from when the row was written', () => {
  // A backfill over months of notes otherwise stamps everything with today and
  // reports a June commitment as nought days old, breaking both the sort and
  // the stale flag — the only two things this list is read by.
  waitingOn.record({
    person: 'Abdi',
    text: 'Send the SLA figures',
    sourcePath: 'Meetings/2026/06/2026-06-30 – Ops.md',
    sourceDate: '2026-06-30',
  });
  const item = waitingOn.list()[0];
  assert.ok(item.ageDays > 30, `expected a real age, got ${item.ageDays}`);
  assert.equal(item.stale, true);
});

test('a future-dated note does not become a negative age', () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  waitingOn.record({ person: 'Abdi', text: 'Something', sourceDate: future });
  assert.ok(waitingOn.list()[0].ageDays >= 0);
});

test('the same person named two ways is one person', () => {
  // Notes say both "Chris to confirm" and "Chris Middleton to confirm", which
  // produced two entries and so two answers to "what am I waiting on from Chris?"
  waitingOn.record({ person: 'Chris', text: 'Confirm the budget' });
  waitingOn.record({ person: 'Chris Middleton', text: 'Sign off the plan' });

  const groups = waitingOn.byPerson();
  assert.equal(groups.length, 1, 'Chris and Chris Middleton must group together');
  assert.equal(groups[0].person, 'Chris');
  assert.equal(groups[0].count, 2);
});

test('a commitment someone else made is recorded with who owes it', () => {
  const item = waitingOn.record({
    person: 'Abdi',
    text: 'Abdi to send the SLA figures for June',
    sourcePath: 'Meetings/2026/06/2026-06-30 – Ops catch-up.md',
    sourceDate: '2026-06-30',
  });
  assert.equal(item.person, 'Abdi');
  assert.equal(item.status, 'open');
  assert.equal(waitingOn.list().length, 1);
});

test('the same commitment seen twice folds instead of duplicating', () => {
  const args = { person: 'Abdi', text: 'Abdi to send the SLA figures', sourcePath: 'a.md' };
  waitingOn.record(args);
  waitingOn.record(args);
  const items = waitingOn.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].sightings, 2);
});

test('resolved work that reappears in a NEW note re-opens — it evidently is not done', () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures', sourcePath: 'june.md' });
  const key = waitingOn.list()[0].key;
  waitingOn.resolve(key, 'done');
  assert.equal(waitingOn.list({ status: 'open' }).length, 0);

  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures', sourcePath: 'july.md' });
  assert.equal(waitingOn.list({ status: 'open' }).length, 1, 'a later note means it is still outstanding');
});

test('the same text from the same note does NOT re-open something resolved', () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures', sourcePath: 'june.md' });
  const key = waitingOn.list()[0].key;
  waitingOn.resolve(key, 'dropped');
  // A re-scan of the same note must not undo the decision.
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures', sourcePath: 'june.md' });
  assert.equal(waitingOn.list({ status: 'open' }).length, 0);
});

test('oldest first, and 3+ days is flagged stale to match the standup rule', () => {
  waitingOn.record({ person: 'Recent', text: 'Something new' });
  waitingOn.record({ person: 'Old', text: 'Something ancient' });

  // Age the second one by hand.
  const items = JSON.parse(db.getState('waiting_on_items'));
  const old = items.find(i => i.person === 'Old');
  old.firstSeen = new Date(Date.now() - 9 * 86400000).toISOString();
  db.setState('waiting_on_items', JSON.stringify(items));

  const listed = waitingOn.list();
  assert.equal(listed[0].person, 'Old', 'longest wait first');
  assert.equal(listed[0].ageDays, 9);
  assert.equal(listed[0].stale, true);
  assert.equal(listed[1].stale, false);
});

test('grouping by person is ordered by who has kept you waiting longest', () => {
  waitingOn.record({ person: 'Heidi', text: 'One thing' });
  waitingOn.record({ person: 'Abdi', text: 'First thing' });
  waitingOn.record({ person: 'Abdi', text: 'Second thing' });

  const items = JSON.parse(db.getState('waiting_on_items'));
  items.find(i => i.text === 'First thing').firstSeen = new Date(Date.now() - 12 * 86400000).toISOString();
  db.setState('waiting_on_items', JSON.stringify(items));

  const groups = waitingOn.byPerson();
  assert.equal(groups[0].person, 'Abdi');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].oldestDays, 12);
});

test('chasing queues for approval and sends nothing', () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures' });
  const key = waitingOn.list()[0].key;

  const result = waitingOn.queueChase(key);
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.ok(result.queuedActionId);

  const pending = db.getPendingSaraActions(50);
  assert.ok(pending.some(a => a.id === result.queuedActionId && a.type === 'chase_commitment'));
});

test('a resolved item cannot be chased', () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures' });
  const key = waitingOn.list()[0].key;
  waitingOn.resolve(key, 'done');
  assert.equal(waitingOn.queueChase(key).ok, false);
});

test('the chase asks where something got to, and never implies they failed', () => {
  const item = { person: 'Heidi Power', text: 'Send the training matrix', sourceDate: '2026-08-01' };
  const msg = waitingOn.buildChaseMessage(item);

  assert.match(msg, /Hi Heidi,/);
  assert.match(msg, /where has that got to/i);
  // Same tone rule as the nudges and the agenda chaser — it goes to someone who
  // works for him, so it must not read as an accusation.
  assert.match(msg, /no rush/i);
  assert.doesNotMatch(msg, /you (still )?(haven't|have not|failed|promised)|chasing you|overdue|as agreed/i);
});
