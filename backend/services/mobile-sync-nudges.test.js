'use strict';

/**
 * Acting on a nudge from the outbox.
 *
 * SARA's loop is that she comes to Nick; the answer has to survive being given
 * on a watch in a lift and replayed later. Two operations, and they fail in
 * opposite directions — a dismissal for a nudge that has gone is fine, and a
 * snooze that has expired must NOT be applied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-syncnudge-'));
process.env.NEURO_DB_PATH = path.join(root, 'sync.db');

const db = require('../db/database');
const sync = require('./mobile-sync');

const DEVICE = 'nick-iphone';
let seq = 0;
const opId = () => `op-${++seq}`;

function send(kind, payload, createdAt) {
  return sync.applyBatch({
    deviceId: DEVICE,
    operations: [{ operationId: opId(), kind, createdAt: createdAt || new Date().toISOString(), payload }],
  }).receipts[0];
}

test.before(async () => { await db.init(); });
test.beforeEach(() => {
  db.run('DELETE FROM mobile_sync_operations', []);
  db.run('DELETE FROM nudges', []);
  db.run("DELETE FROM agent_state WHERE key LIKE 'snooze_%'", []);
});

test('both nudge kinds are in the advertised contract', () => {
  // The device reads `supportedKinds` off /readiness to decide what it may
  // queue. A kind implemented but not advertised is one the phone never sends.
  assert.equal(sync.KNOWN_KINDS.has('nudge.complete'), true);
  assert.equal(sync.KNOWN_KINDS.has('nudge.snooze'), true);
  // Paired negative: the set stays closed.
  assert.equal(sync.KNOWN_KINDS.has('nudge.explode'), false);
});

test('dismissing a live nudge completes it', () => {
  db.run("INSERT INTO nudges (type, message, date_key) VALUES ('todo', 'Standup?', '2026-09-05')", []);
  const id = db.getActiveNudges()[0].id;

  const r = send('nudge.complete', { nudgeId: id });
  assert.equal(r.status, 'applied');
  assert.equal(r.canonicalId, `nudge:${id}`);
  assert.equal(JSON.parse(r.detail).alreadyGone, false);
  assert.equal(db.getActiveNudges().length, 0);   // paired positive: really gone
});

test('dismissing a nudge that already cleared is applied, not a conflict', () => {
  // ⚠ The opposite call from todo.complete, where a missing task IS a conflict.
  // Nudges auto-clear — clearStaleNudges sweeps them, and completing the
  // underlying thing clears them too — so a dismissal arriving for one that has
  // gone is the system working, not a device holding a phantom intent.
  const r = send('nudge.complete', { nudgeId: 4242 });
  assert.equal(r.status, 'applied');
  assert.notEqual(r.status, 'needs-attention');
  assert.equal(JSON.parse(r.detail).alreadyGone, true);
});

test('a snooze is measured from the TAP, not from arrival', () => {
  // The hazard this whole applier exists for: "30 minutes" tapped at 09:00 and
  // delivered at 13:00 must not mute the nudge until 13:30.
  const tappedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();  // 10 min ago
  const r = send('nudge.snooze', { type: 'todo', minutes: 30 }, tappedAt);
  assert.equal(r.status, 'applied');

  const detail = JSON.parse(r.detail);
  assert.equal(detail.spent, false);
  assert.equal(detail.measuredFrom, 'tap');
  // ~20 minutes left, not 30 — the ten already served are not given back.
  const remainingMin = (Date.parse(detail.until) - Date.now()) / 60000;
  assert.ok(remainingMin > 19 && remainingMin < 21, `expected ~20 min, got ${remainingMin}`);

  // And it is readable through the same state key nudges.js uses, or the snooze
  // would be written somewhere nothing consults.
  const until = Number(db.getState('snooze_todo'));
  assert.ok(until > Date.now());
});

test('an EXPIRED snooze is spent, and writes nothing', () => {
  // Queued on a train four hours ago for 30 minutes. That window is long gone;
  // applying it would be three and a half hours of silence he never asked for.
  const tappedAt = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const r = send('nudge.snooze', { type: 'todo', minutes: 30 }, tappedAt);
  assert.equal(r.status, 'applied');            // the operation settled...
  assert.equal(JSON.parse(r.detail).spent, true);  // ...as a no-op, and says so
  assert.equal(db.getState('snooze_todo'), null);  // paired negative: nothing written
});

test('a fresh snooze with no createdAt still applies', () => {
  // Without a tap time there is no way to tell fresh from stale, and treating
  // an unknown as expired would silently drop a snooze he just asked for.
  const r = sync.applyBatch({
    deviceId: DEVICE,
    operations: [{ operationId: opId(), kind: 'nudge.snooze', payload: { type: 'eod', minutes: 15 } }],
  }).receipts[0];
  assert.equal(r.status, 'applied');
  const detail = JSON.parse(r.detail);
  assert.equal(detail.spent, false);
  assert.equal(detail.measuredFrom, 'arrival');
  assert.ok(Number(db.getState('snooze_eod')) > Date.now());
});

test('an unknown nudge type is refused rather than written', () => {
  // It would create a `snooze_<junk>` key that mutes nothing and never expires,
  // and nothing would ever read it to notice.
  const r = send('nudge.snooze', { type: 'not-a-nudge', minutes: 30 });
  assert.equal(r.status, 'rejected');
  assert.match(r.detail, /must be one of/);
  assert.equal(db.getState('snooze_not-a-nudge'), null);
  // Paired positive: every real type is accepted.
  const nudges = require('./nudges');
  for (const t of nudges.NUDGE_TYPES) {
    assert.equal(send('nudge.snooze', { type: t, minutes: 5 }).status, 'applied', `${t} should snooze`);
  }
});

test('a malformed payload is refused by name', () => {
  assert.match(send('nudge.complete', {}).detail, /nudgeId is required/);
  assert.match(send('nudge.snooze', { type: 'todo', minutes: -5 }).detail, /must be positive/);
  // Paired positive: the well-formed versions apply.
  assert.equal(send('nudge.snooze', { type: 'todo' }).status, 'applied');   // minutes optional
});

test('re-sending a dismissal does not fire the side effect twice', () => {
  db.run("INSERT INTO nudges (type, message, date_key) VALUES ('todo', 'Standup?', '2026-09-05')", []);
  const id = db.getActiveNudges()[0].id;
  const operationId = opId();
  const op = { operationId, kind: 'nudge.complete', createdAt: new Date().toISOString(), payload: { nudgeId: id } };

  assert.equal(sync.applyBatch({ deviceId: DEVICE, operations: [op] }).receipts[0].status, 'applied');
  // The ledger stops the replay before the applier runs at all.
  assert.equal(sync.applyBatch({ deviceId: DEVICE, operations: [op] }).receipts[0].status, 'duplicate');
});
