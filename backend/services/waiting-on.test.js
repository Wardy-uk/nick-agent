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
// Storage is the waiting_on table since 15 Aug, not the agent_state KV blob.
test.beforeEach(() => { db.run('DELETE FROM waiting_on', []); });

/** Age an item by hand — the only way to test the sort and the stale flag
 *  without waiting three days. */
function ageByDays(text, days) {
  db.run('UPDATE waiting_on SET first_seen = ? WHERE text = ?',
    [new Date(Date.now() - days * 86400000).toISOString(), text]);
}

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

  ageByDays('Something ancient', 9);

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

  ageByDays('First thing', 12);

  const groups = waitingOn.byPerson();
  assert.equal(groups[0].person, 'Abdi');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].oldestDays, 12);
});

test('chasing queues for approval and sends nothing', async () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures' });
  const key = waitingOn.list()[0].key;

  const result = await waitingOn.queueChase(key);
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.ok(result.queuedActionId);

  const pending = db.getPendingSaraActions(50);
  const queued = pending.find(a => a.id === result.queuedActionId);
  assert.ok(queued && queued.type === 'chase_commitment');
  // The words AND the address are stored at queue time, so the approval screen
  // shows what will actually be sent and to whom rather than reconstructing it.
  assert.match(queued.payload.body, /Send the SLA figures/);
  assert.ok(queued.payload.to, 'the recipient is resolved and recorded up front');
});

test('a resolved item cannot be chased', async () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures' });
  const key = waitingOn.list()[0].key;
  waitingOn.resolve(key, 'done');
  assert.equal((await waitingOn.queueChase(key)).ok, false);
});

test('the recipient can be retargeted before approval, and only before', async () => {
  waitingOn.record({ person: 'Abdi', text: 'Send the SLA figures' });
  const { queuedActionId: id } = await waitingOn.queueChase(waitingOn.list()[0].key);

  assert.equal(waitingOn.setChaseRecipient(id, 'not-an-address').ok, false);

  const ok = waitingOn.setChaseRecipient(id, ' nickw@nurtur.tech ');
  assert.equal(ok.ok, true);
  assert.equal(ok.to.email, 'nickw@nurtur.tech');
  // `manual` is what tells the executor this was chosen, not guessed — a guess
  // has to clear the `resolved` gate, a choice does not.
  assert.equal(ok.to.source, 'manual');
  assert.equal(db.getSaraAction(id).payload.to.email, 'nickw@nurtur.tech');

  db.updateSaraActionStatus(id, 'executed');
  assert.equal(waitingOn.setChaseRecipient(id, 'someone@nurtur.tech').ok, false);
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


test('snooze hides an item without resolving it, and clears again', () => {
  waitingOn.record({ person: 'Naomi', text: 'Confirm the rota' });
  const key = waitingOn.list()[0].key;

  const soon = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0];
  const snoozed = waitingOn.snooze(key, soon);
  assert.ok(snoozed.snoozedUntil);

  // Still open and still ageing — snoozing is not a decision, only a delay.
  const item = waitingOn.list({ status: 'open' })[0];
  assert.equal(item.status, 'open');
  assert.equal(item.snoozed, true);

  assert.equal(waitingOn.snooze(key, null).snoozedUntil, null);
  assert.equal(waitingOn.list()[0].snoozed, false);

  assert.throws(() => waitingOn.snooze(key, '19/08/2026'), /YYYY-MM-DD/);
});

test('a past snooze date is no longer snoozed', () => {
  waitingOn.record({ person: 'Naomi', text: 'Something else' });
  const key = waitingOn.list()[0].key;
  waitingOn.snooze(key, '2020-01-01');
  assert.equal(waitingOn.list()[0].snoozed, false, 'an expired snooze must resurface');
});

test('resurfacing in a new note clears a snooze and reopens', () => {
  waitingOn.record({ person: 'Abdi', text: 'The thing', sourcePath: 'may.md' });
  const key = waitingOn.list()[0].key;
  waitingOn.resolve(key, 'done');
  waitingOn.snooze(key, '2030-01-01');

  waitingOn.record({ person: 'Abdi', text: 'The thing', sourcePath: 'june.md' });
  const item = waitingOn.list({ status: 'open' })[0];
  assert.equal(item.status, 'open');
  assert.equal(item.snoozedUntil, null, 'a commitment that is back is not still snoozed');
  assert.equal(item.resolvedAt, null);
});

test('migrateFromState lifts the KV blob in once and leaves it behind', () => {
  db.run('DELETE FROM waiting_on', []);
  db.setState('waiting_on_items', JSON.stringify([{
    key: 'heidi::old thing', person: 'Heidi', text: 'Old thing',
    status: 'open', firstSeen: '2026-05-01T09:00:00.000Z',
    lastSeen: '2026-05-01T09:00:00.000Z', sightings: 2,
  }]));

  assert.equal(waitingOn.migrateFromState().migrated, 1);
  assert.equal(waitingOn.list()[0].text, 'Old thing');
  assert.equal(waitingOn.list()[0].sightings, 2);

  // Idempotent: a second run must not double the rows.
  assert.equal(waitingOn.migrateFromState().migrated, 0);
  assert.equal(waitingOn.list().length, 1);

  // The KV copy survives as the rollback path.
  assert.ok(db.getState('waiting_on_items'));
});
