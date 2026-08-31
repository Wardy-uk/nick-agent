'use strict';

/**
 * The canonical action semantics — the contract the desktop was migrated onto.
 *
 * Each of these is a bug that shipped. `BriefingPanel` POSTed
 * `/api/focus/action-done` when the user pressed "Do it", which logs a completed
 * outcome AND dismisses the item, so the button that merely OPENED a thing
 * recorded it as finished. `FocusPanel`'s "Done" did the same and never closed
 * the task, and its "Defer" POSTed `/api/focus/dismiss`, so "not now" and "not
 * mine" were one gesture.
 *
 * The rules under test:
 *   * starting changes NO state;
 *   * only an explicit completion resolves;
 *   * a completion closes the underlying task only where one is genuinely
 *     resolvable, and SAYS which happened;
 *   * a deferral needs a real duration and records its reason;
 *   * navigating is not an action at all — there is no route for it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attact-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const lifecycle = require('./attention-lifecycle');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

let seq = 0;
function card(title, overrides = {}) {
  seq += 1;
  return {
    kind: 'item',
    id: `todo-overdue-top-${seq}`,
    type: 'todo',
    title,
    urgency: 'medium',
    tier: 2,
    source: 'vault',
    meta: { dueDate: '2026-08-29', overdueCount: 1 },
    ...overrides,
  };
}

function seed(c) {
  const [rec] = lifecycle.reconcile([c], { now: new Date() });
  return rec;
}

test('the permitted action set is bounded, and start is offered only where a session means something', () => {
  assert.ok(lifecycle.actionsFor(card('Write the risk assessment')).includes('start'));
  // A focus session about "you have a meeting in 10 minutes" is not a session.
  assert.ok(!lifecycle.actionsFor({ type: 'meeting', title: 'Standup' }).includes('start'));
  // "Done" always exists — whether it ALSO closes a task is a separate question.
  assert.ok(lifecycle.actionsFor({ type: 'meeting', title: 'Standup' }).includes('complete'));
});

test('a deferred card is taken OFF the surface, and comes back when the window passes', () => {
  // THE bug, reported from the Now page on 31 Aug 2026: a deferral recorded a
  // deferral and changed nothing anybody could see, because the pool is
  // recomputed every poll and the record was only stamped onto the result. On
  // an unsuppressable card, where `dismiss` is deliberately withheld, that left
  // no action on the card capable of clearing it.
  const now = new Date('2026-08-31T09:00:00Z');
  const meeting = {
    kind: 'item', id: 'cal-abc123', type: 'meeting', title: 'Take a break',
    urgency: 'critical', tier: 1, unsuppressable: true,
    meta: { start: '2026-08-31T09:01:00Z' },
  };
  const [rec] = lifecycle.reconcile([meeting], { now });
  const key = lifecycle.dedupeKeyFor(meeting);

  assert.ok(!lifecycle.actionsFor(meeting).includes('dismiss'),
    'an imminent meeting cannot be dismissed — which is exactly why defer has to work');
  assert.ok(!lifecycle.deferredKeys(now).has(key), 'nothing is hidden before he says so');

  lifecycle.act(rec.id, 'defer', { minutes: 120, reason: 'not-now', now });
  const hidden = lifecycle.deferredKeys(now);
  assert.ok(hidden.has(key), 'a deferred card is hidden from the surface');
  assert.equal(hidden.get(key).reason, 'not-now', 'and the reason travels with it');

  // ⚠ Not hidden a moment longer than Nick asked for. `deferredKeys` reads the
  // window itself rather than trusting the sweep to have run first.
  const later = new Date(now.getTime() + 121 * 60000);
  assert.ok(!lifecycle.deferredKeys(later).has(key), 'the window ends on its own');
});

test('starting a focus session does NOT resolve, dismiss, defer or acknowledge the record', () => {
  const rec = seed(card('Draft the succession plan'));
  assert.equal(rec.state, 'active');

  const result = lifecycle.act(rec.id, 'start');
  assert.equal(result.ok, true);

  const after = db.getAttentionRecord(rec.id);
  // THE regression. Picking work up is not finishing it.
  assert.equal(after.state, 'active', 'start must leave the record active');
  assert.equal(after.resolution, null);
  assert.equal(after.defer_until, null);

  // It is still recorded — the friction read is built on this evidence — but as
  // a `started` event, never as an outcome.
  const events = db.getAttentionHistory(50).filter((e) => e.record_id === rec.id);
  assert.ok(events.some((e) => e.event === 'started'));
  assert.ok(!events.some((e) => e.event === 'resolved'));
});

test('explicit completion is the ONLY path that resolves a record', () => {
  const rec = seed(card('Book the venue'));
  for (const action of ['start', 'acknowledge']) {
    lifecycle.act(rec.id, action);
    assert.notEqual(db.getAttentionRecord(rec.id).state, 'resolved', `${action} must not resolve`);
  }
  const done = lifecycle.act(rec.id, 'complete');
  assert.equal(done.ok, true);
  assert.equal(db.getAttentionRecord(rec.id).state, 'resolved');
});

test('completing a card closes the underlying task, and says so', () => {
  const text = 'Send the quarterly summary to Chris';
  const { id: taskId } = taskStore.createTask({ text, source: 'test' });
  const rec = seed(card(text));

  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.taskCompleted, true);
  assert.match(result.taskWhy, /completed/);
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('a card with no matching task still resolves, and does NOT claim a completion', () => {
  const rec = seed(card('Something that was never a task row at all'));
  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.taskCompleted, false);
  // The distinction is the product: "done, and I closed the task" and "done,
  // there was no task to close" must not read identically.
  assert.match(result.taskWhy, /no matching task/);
  assert.equal(db.getAttentionRecord(rec.id).state, 'resolved');
});

test('resolving a non-todo card completes nothing — a meeting has no task to close', () => {
  const rec = seed({
    kind: 'item', id: 'cal-abc', type: 'meeting', title: '1-2-1 with Hope',
    urgency: 'high', meta: { start: new Date(Date.now() + 6e5).toISOString() },
  });
  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.taskCompleted, false);
  assert.equal(lifecycle.completionTargetFor({ type: 'meeting', title: '1-2-1 with Hope' }), null);
});

test('a deferral needs a real duration and records the reason it was given', () => {
  const rec = seed(card('Rewrite the onboarding doc'));

  // No duration is refused with the reason in words, not accepted as a default.
  assert.equal(lifecycle.act(rec.id, 'defer', {}).ok, false);
  assert.equal(lifecycle.act(rec.id, 'defer', { minutes: 0 }).ok, false);

  lifecycle.act(rec.id, 'defer', { minutes: 120, reason: 'waiting-on-someone' });
  const after = db.getAttentionRecord(rec.id);
  assert.equal(after.state, 'deferred');
  assert.equal(after.defer_reason, 'waiting-on-someone');
  assert.ok(after.defer_until);

  // An unrecognised reason becomes `unspecified` rather than being stored as
  // free text — the friction read groups on these, and a client-supplied string
  // would become a category nobody chose.
  const other = seed(card('Another thing entirely'));
  lifecycle.act(other.id, 'defer', { minutes: 30, reason: 'because-i-say-so' });
  assert.equal(db.getAttentionRecord(other.id).defer_reason, 'unspecified');
});

test('a deferred record comes back on its own once the window passes', () => {
  const rec = seed(card('Chase the invoice'));
  lifecycle.act(rec.id, 'defer', { minutes: 30, reason: 'not-now' });
  assert.equal(db.getAttentionRecord(rec.id).state, 'deferred');

  // Still deferred a minute later.
  lifecycle.releaseDeferrals(new Date(Date.now() + 60 * 1000));
  assert.equal(db.getAttentionRecord(rec.id).state, 'deferred');

  lifecycle.releaseDeferrals(new Date(Date.now() + 31 * 60 * 1000));
  assert.equal(db.getAttentionRecord(rec.id).state, 'active');
});

test('dismissing a card touches no work — the task it was about stays open', () => {
  const text = 'A task NEURO is merely wrong about surfacing';
  const { id: taskId } = taskStore.createTask({ text, source: 'test' });
  const rec = seed(card(text));

  lifecycle.act(rec.id, 'dismiss');
  assert.equal(db.getAttentionRecord(rec.id).state, 'suppressed');
  // Disagreeing with NEURO's opinion about what deserves attention is not doing
  // the job.
  assert.equal(db.getTaskRow(taskId).status, 'open');
});

test('a re-sighting never resets a deferral — a snooze must survive the next poll', () => {
  const c = card('Something the ambient surface polls every minute');
  const rec = seed(c);
  lifecycle.act(rec.id, 'defer', { minutes: 240, reason: 'too-big' });

  lifecycle.reconcile([c], { now: new Date() });

  const after = db.getAttentionRecord(rec.id);
  assert.equal(after.state, 'deferred', 'a fresh sighting is evidence the thing exists, not a change of mind');
  assert.equal(after.defer_reason, 'too-big');
});
