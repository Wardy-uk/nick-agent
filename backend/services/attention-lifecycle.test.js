'use strict';

/**
 * The attention lifecycle. Contract: docs/attention-contract.md.
 *
 * The pure half pins without a database. The stateful half runs against a
 * SCRATCH database (`NEURO_DB_PATH`), never the real one — `database.js` honours
 * that variable precisely so a test can never reach the live agent.db.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attention-'));
process.env.NEURO_DB_PATH = path.join(root, 'attention.db');

const db = require('../db/database');
const lifecycle = require('./attention-lifecycle');
const settings = require('./attention-settings');

test.before(async () => { await db.init(); });

const NOW = new Date('2026-09-01T10:00:00Z');

function todoCard(title = 'Write the risk assessment', over = 3) {
  return {
    kind: 'item', id: over === 1 ? 'todo-overdue-top' : 'todo-overdue-summary',
    type: 'todo', title, reason: 'Overdue', say: "It's 2 days over.",
    urgency: 'medium', tier: 2, score: 65, source: 'vault',
    meta: { dueDate: '2026-08-29', overdueCount: over },
  };
}

// ── Identity ─────────────────────────────────────────────────────────────────

test('the dedupe key names the THING, so a growing pile keeps one identity', () => {
  // The bug this exists for: the engine emits `todo-overdue-top` for one overdue
  // task and `todo-overdue-summary` for two, so a dismissal recorded against the
  // first silently stopped applying the moment a second task went overdue.
  const one = lifecycle.dedupeKeyFor(todoCard('Write the risk assessment', 1));
  const many = lifecycle.dedupeKeyFor(todoCard('Write the risk assessment', 9));
  assert.equal(one, many);
  assert.equal(one, 'todo:write-the-risk-assessment');
});

test('a nudge is keyed on its TYPE, not the row id that is recreated daily', () => {
  const monday = lifecycle.dedupeKeyFor({ type: 'nudge', id: 'nudge-41', meta: { type: 'standup' } });
  const tuesday = lifecycle.dedupeKeyFor({ type: 'nudge', id: 'nudge-58', meta: { type: 'standup' } });
  assert.equal(monday, tuesday);
});

test('a meeting is keyed on the event, an escalation on the ticket', () => {
  assert.equal(lifecycle.dedupeKeyFor({ type: 'meeting', id: 'cal-AAMk123' }), 'meeting:AAMk123');
  assert.equal(
    lifecycle.dedupeKeyFor({ type: 'escalation', id: 'escalations-unseen', meta: { ticket_key: 'NT-9' } }),
    'escalation:NT-9'
  );
  // Several escalations are ONE thing — the pile — and keep one key, or every
  // arrival and reply would churn the identity.
  assert.equal(lifecycle.dedupeKeyFor({ type: 'escalation', id: 'escalations-unseen', meta: {} }), 'escalation:group');
});

test('an explicit dedupeKey wins, which is how a push names a pool item', () => {
  assert.equal(lifecycle.dedupeKeyFor({ type: 'todo', title: 'x', dedupeKey: 'nudge:standup' }), 'nudge:standup');
});

test('a push about a nudge shares the pool card key; an ops alert does not', () => {
  assert.equal(lifecycle.dedupeKeyForPush('standup', 'SARA'), 'nudge:standup');
  // An operational alert lands in its own namespace, so it can NEVER collide
  // with a real card — `{type:'todo'}` from a nudge push must not land on a
  // todo card's record by accident.
  assert.equal(lifecycle.dedupeKeyForPush('system_alert', 'disk:full'), 'operational:system_alert:disk-full');
  assert.match(lifecycle.dedupeKeyForPush('system_alert', 'Backup failed'), /^operational:system_alert:/);
});

// ── Evidence ─────────────────────────────────────────────────────────────────

test('evidence is cited from structured data and never invented', () => {
  const ev = lifecycle.evidenceFor(todoCard(), NOW);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, 'vault');
  assert.equal(ev[0].observedAt, '2026-08-29');
  // Nothing citable → an empty array, NOT a fabricated line.
  assert.deepEqual(lifecycle.evidenceFor({ type: 'imports', title: '3 files' }, NOW), []);
});

test('each escalation in the pile is cited separately', () => {
  const ev = lifecycle.evidenceFor({
    type: 'escalation',
    meta: { escalations: [{ key: 'NT-1', summary: 'a', created: '2026-08-01' }, { key: 'NT-2', summary: 'b' }] },
  }, NOW);
  assert.deepEqual(ev.map((e) => e.ref), ['NT-1', 'NT-2']);
});

// ── The bounded action set ───────────────────────────────────────────────────

test('an unsuppressable item is not offered a dismiss button it cannot honour', () => {
  assert.deepEqual(lifecycle.actionsFor({ unsuppressable: true }), ['acknowledge', 'defer', 'open']);
  assert.ok(lifecycle.actionsFor({ unsuppressable: false }).includes('dismiss'));
});

// ── The notification gate (pure) ─────────────────────────────────────────────

const OPEN = {
  id: 'r1', state: 'active', urgency: 'high', tier: 1, operational: 0,
  evidence: JSON.stringify([{ source: 'jira', ref: 'NT-1' }]),
  notified_at: null, notify_signature: null, domain: 'work',
};
const LOUD = { enabled: true, quietHours: 'off', interruptionLevel: 'normal', pausedUntil: null, domains: { work: true, personal: true } };

test('an active, evidenced record may interrupt', () => {
  assert.equal(lifecycle.shouldNotify(OPEN, LOUD, { now: NOW }).allowed, true);
});

test('a countdown is not a state change — the same record notifies once', () => {
  // THE bug this layer exists for. The governor fingerprinted the TEXT, so a
  // meeting alert re-rendering "in 25 min" → "in 10 min" produced a fresh
  // fingerprint each pass and every one of them went out.
  const notified = { ...OPEN, notified_at: NOW.toISOString(), notify_signature: 'high|1' };
  const verdict = lifecycle.shouldNotify(notified, LOUD, { now: NOW });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /already notified/);

  // But a genuine escalation in urgency gets through exactly once more.
  const escalated = { ...notified, urgency: 'critical' };
  assert.equal(lifecycle.shouldNotify(escalated, LOUD, { now: NOW }).allowed, true);
});

test('acknowledged and deferred records never interrupt, and say why', () => {
  for (const state of ['acknowledged', 'deferred', 'suppressed', 'resolved', 'expired']) {
    const v = lifecycle.shouldNotify({ ...OPEN, state }, LOUD, { now: NOW });
    assert.equal(v.allowed, false, state);
    assert.match(v.reason, new RegExp(state));
  }
});

test('no evidence, no interruption — but operational alerts are exempt', () => {
  const bare = { ...OPEN, evidence: '[]' };
  assert.match(lifecycle.shouldNotify(bare, LOUD, { now: NOW }).reason, /no evidence/);
  // Refusing to tell Nick the disk is full because the alert has no Jira key
  // would be the rule eating the thing it exists to protect.
  assert.equal(lifecycle.shouldNotify({ ...bare, operational: 1 }, LOUD, { now: NOW }).allowed, true);
});

test('the controls hold, and each refusal names itself', () => {
  const cases = [
    [{ ...LOUD, enabled: false }, /notifications are off/],
    [{ ...LOUD, quietHours: '09:00-18:00' }, /quiet hours/],
    [{ ...LOUD, interruptionLevel: 'critical-only' }, /critical-only/],
    [{ ...LOUD, pausedUntil: new Date(NOW.getTime() + 3600e3).toISOString() }, /paused/],
    [{ ...LOUD, domains: { work: false, personal: true } }, /work notifications are off/],
  ];
  for (const [s, pattern] of cases) {
    const v = lifecycle.shouldNotify(OPEN, s, { now: NOW });
    assert.equal(v.allowed, false, String(pattern));
    assert.match(v.reason, pattern);
  }
});

test('critical bypasses the controls but NEVER the dedupe', () => {
  const asleep = { ...LOUD, quietHours: '09:00-18:00', enabled: false };
  assert.equal(lifecycle.shouldNotify(OPEN, asleep, { now: NOW, critical: true }).allowed, true);
  // The same escalation arriving twice is still one escalation — the invariant
  // the old text fingerprint was reaching for and missing.
  const notified = { ...OPEN, notified_at: NOW.toISOString(), notify_signature: 'high|1' };
  assert.equal(lifecycle.shouldNotify(notified, asleep, { now: NOW, critical: true }).allowed, false);
});

test('an unparseable pause cannot silence NEURO for ever', () => {
  assert.equal(settings.isPaused({ pausedUntil: 'not-a-date' }, NOW), false);
});

// ── Stateful ─────────────────────────────────────────────────────────────────

test('GATE 1 DEMO: generated → displayed → deferred → re-surfaced → resolved', () => {
  const card = todoCard('Gate one demonstration task');
  const t0 = new Date('2026-09-01T09:00:00Z');

  // generated + displayed
  const [rec] = lifecycle.reconcile([card], { now: t0, confidence: { level: 'high' } });
  assert.equal(rec.state, 'active');
  assert.ok(rec.surfaced_at, 'reaching a screen is recorded');

  // deferred, with a reason
  const deferred = lifecycle.act(rec.id, 'defer', { minutes: 30, reason: 'no-context', now: t0 });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.record.state, 'deferred');
  assert.equal(deferred.record.defer_reason, 'no-context');

  // a deferred record does not interrupt, and a fresh sighting does NOT revive
  // it — otherwise "snooze" would mean "snooze until the next poll", which at a
  // 60-second ambient refresh is no snooze at all.
  lifecycle.reconcile([card], { now: new Date(t0.getTime() + 60000) });
  assert.equal(db.getAttentionRecord(rec.id).state, 'deferred');

  // re-surfaced when the window passes, by itself
  const released = lifecycle.releaseDeferrals(new Date(t0.getTime() + 31 * 60000));
  assert.ok(released >= 1);
  assert.equal(db.getAttentionRecord(rec.id).state, 'active');

  // resolved
  const done = lifecycle.act(rec.id, 'resolve', { now: t0, note: 'done it' });
  assert.equal(done.record.state, 'resolved');

  // and the history can say what happened, in order
  const events = db.getAttentionHistory(50).filter((e) => e.record_id === rec.id).map((e) => e.event);
  for (const expected of ['opened', 'surfaced', 'deferred', 'resolved']) {
    assert.ok(events.includes(expected), `history is missing ${expected}`);
  }
});

test('a terminal record never re-matches — today\'s standup is not yesterday\'s', () => {
  const card = { kind: 'item', id: 'nudge-1', type: 'nudge', title: 'Do your standup', meta: { type: 'standup' } };
  const [monday] = lifecycle.reconcile([card], { now: new Date('2026-09-01T08:00:00Z') });
  lifecycle.act(monday.id, 'dismiss', { now: new Date('2026-09-01T08:05:00Z') });

  const [tuesday] = lifecycle.reconcile([{ ...card, id: 'nudge-2' }], { now: new Date('2026-09-02T08:00:00Z') });
  assert.notEqual(tuesday.id, monday.id, 'a dismissed record must not be revived');
  assert.equal(tuesday.state, 'active');
  assert.equal(tuesday.dedupe_key, monday.dedupe_key, 'but it is still the same KIND of thing');
});

test('dismissing an unsuppressable item is refused rather than silently ignored', () => {
  const card = {
    kind: 'item', id: 'escalations-unseen', type: 'escalation', title: 'NT-77 — broke',
    unsuppressable: true, urgency: 'critical', tier: 1,
    meta: { ticket_key: 'NT-77', escalations: [{ key: 'NT-77', summary: 'broke' }] },
  };
  const [rec] = lifecycle.reconcile([card], { now: NOW });
  const result = lifecycle.act(rec.id, 'dismiss', { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be dismissed/);
});

test('held items keep their identity but are NOT recorded as having been seen', () => {
  // The gate drops work in a meeting. A dropped item is held, not gone: without
  // refreshing its sighting a three-hour meeting would age the whole board out.
  const card = todoCard('A task held during a meeting');
  lifecycle.reconcile([], { now: NOW, held: [card] });
  const row = db.getOpenAttentionRecord(lifecycle.dedupeKeyFor(card));
  assert.ok(row, 'a held item still has a record');
  assert.equal(row.surfaced_at, null, 'it never reached a screen, so nothing may claim it did');
});

test('the sweep NEVER ages records out while the pool is unreadable', () => {
  const card = todoCard('A task from before an outage');
  const long_ago = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
  const [rec] = lifecycle.reconcile([card], { now: long_ago });

  // Expiring during an outage would clear the board on the strength of not
  // having looked — the exact false all-clear this layer exists to prevent.
  const skipped = lifecycle.sweep({ now: NOW, poolAvailable: false });
  assert.equal(skipped.expired, 0);
  assert.equal(db.getAttentionRecord(rec.id).state, 'active');

  const swept = lifecycle.sweep({ now: NOW, poolAvailable: true });
  assert.ok(swept.expired >= 1);
  const after = db.getAttentionRecord(rec.id);
  // EXPIRED, not resolved: Nick decided nothing, and a record of what he chose
  // must not be padded with things that merely timed out.
  assert.equal(after.state, 'expired');
  assert.equal(after.resolution, 'aged-out');
});

test('an operational sighting never flattens a pool record it happens to share', () => {
  const nudge = {
    kind: 'item', id: 'nudge-9', type: 'nudge', title: 'Do your standup',
    urgency: 'high', tier: 1, meta: { type: 'standup', nagCount: 4 },
  };
  const [rec] = lifecycle.reconcile([nudge], { now: new Date('2026-09-03T08:00:00Z') });
  assert.equal(rec.urgency, 'high');

  // The push path carries only what its caller passed. Touching the record here
  // would reset the escalation the nag tone is built on.
  lifecycle.upsert(
    { dedupeKey: 'nudge:standup', id: 'push:standup', type: 'standup', title: 'SARA', urgency: 'medium', tier: 2 },
    { operational: true, now: new Date('2026-09-03T08:30:00Z') }
  );
  assert.equal(db.getAttentionRecord(rec.id).urgency, 'high');
});

test('settings round-trip, and a pause is stored as an instant not a duration', () => {
  const updated = settings.update({ interruptionLevel: 'critical-only', pauseMinutes: 60 });
  assert.equal(updated.interruptionLevel, 'critical-only');
  assert.ok(settings.isPaused(updated, new Date()));
  // A stored duration would be wrong the moment it was read back.
  assert.match(updated.pausedUntil, /^\d{4}-/);

  const cleared = settings.update({ pausedUntil: null, interruptionLevel: 'normal' });
  assert.equal(cleared.pausedUntil, null);
  assert.equal(settings.isPaused(cleared, new Date()), false);

  // An unknown key is ignored rather than stored — this blob is read on every
  // push, and a typo becoming a permanent silent setting is unfindable.
  const noisy = settings.update({ enabledd: false, interruptionLevel: 'nonsense' });
  assert.equal(noisy.enabled, true);
  assert.equal(noisy.interruptionLevel, 'normal');
});

test('quiet hours fall back to the server setting rather than a second guess', () => {
  // Until Nick sets one, the window is inherited and SAYS so — showing him a
  // value he never chose as though he had is how a control surface starts lying.
  assert.equal(settings.read().quietHoursSource, 'server');

  const chosen = settings.update({ quietHours: '23:00-06:00' });
  assert.equal(chosen.quietHoursSource, 'setting');
  assert.equal(chosen.quietHours, '23:00-06:00');

  // NEURO already had exactly one considered statement about when to leave Nick
  // alone. A second, narrower one is how two parts of a system disagree about
  // the same evening — so clearing the setting returns to the server's.
  const fresh = settings.update({ quietHours: null });
  assert.equal(fresh.quietHoursSource, 'server');
  assert.equal(fresh.quietHours, process.env.PUSH_QUIET_HOURS || '22:00-07:00');
});

// ── Gate 2: the notification names its own record ────────────────────────────

test('a notification carries its record id and a resolved destination', () => {
  const webpush = require('./webpush');
  const record = { id: 'att_x1', tab: 'tasks' };

  const enriched = webpush._enrichData({ type: 'todo', url: '/todos' }, record);
  assert.equal(enriched.attentionRecordId, 'att_x1');
  // Without this the tap lands on a tab and Nick has to find the thing again —
  // "every notification opens Neuro Mobile directly to the relevant item".
  assert.equal(enriched.tab, 'tasks');
  assert.equal(enriched.type, 'todo', 'the caller\'s own data survives');
});

test('a caller\'s explicit tab is never overridden, and no record stamps nothing', () => {
  const webpush = require('./webpush');
  const pinned = webpush._enrichData({ type: 'todo', tab: 'capture' }, { id: 'att_x2', tab: 'tasks' });
  assert.equal(pinned.tab, 'capture');

  // The fail-open path: rather than stamping a null id a client might try to
  // POST against, the data passes through untouched.
  const bare = webpush._enrichData({ type: 'todo' }, null);
  assert.equal(bare.attentionRecordId, undefined);
  assert.equal(bare.tab, undefined);
});

test('a record with no tab falls back to the SHARED resolver, not a guess', () => {
  const webpush = require('./webpush');
  const { resolveSaraLiteTab } = require('../../shared/action-surfaces.cjs');
  // An operational record may carry no tab. The fallback must agree with the one
  // resolver every other surface uses, or a card and its notification land on
  // different screens — the invariant that rule exists to protect.
  const out = webpush._enrichData({ type: 'standup' }, { id: 'att_x3', tab: null });
  assert.equal(out.tab, resolveSaraLiteTab({ type: 'standup' }));
  assert.equal(out.tab, 'standup');
});
