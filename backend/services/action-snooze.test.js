'use strict';

/**
 * "Not now" for an approval card. Pure, so the rules pin without a database.
 *
 * The negative tests are the point. A snooze can fail in two directions and
 * only one of them is visible: a card shown too early is an annoyance, a card
 * that never comes back is an approval that silently did not happen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const snooze = require('./action-snooze');

const NOW = new Date('2026-09-08T10:00:00Z');
const action = (over = {}) => ({ id: 1, type: 'draft_reply', status: 'pending', snoozed_until: null, ...over });

test('an action with no snooze is awake', () => {
  assert.equal(snooze.isSnoozed(action(), NOW), false);
});

test('an action snoozed into the future is asleep, and wakes on its own', () => {
  const a = action({ snoozed_until: '2026-09-08T11:00:00Z' });
  assert.equal(snooze.isSnoozed(a, NOW), true);
  // No sweep, no job, no status change — the clock passing IS the wake-up.
  assert.equal(snooze.isSnoozed(a, new Date('2026-09-08T11:00:01Z')), false);
});

// ⚠ The asymmetry: shown-too-early is recoverable, hidden-for-ever is not.
test('an unparseable snooze reads as AWAKE, never as hidden', () => {
  assert.equal(snooze.isSnoozed(action({ snoozed_until: 'later' }), NOW), false);
  assert.equal(snooze.isSnoozed(action({ snoozed_until: '' }), NOW), false);
  assert.equal(snooze.isSnoozed(action({ snoozed_until: undefined }), NOW), false);
});

test('what is asleep is reported, not swallowed', () => {
  const { awake, asleep } = snooze.partitionSnoozed([
    action({ id: 1 }),
    action({ id: 2, snoozed_until: '2026-09-09T09:00:00Z' }),
    action({ id: 3, snoozed_until: '2026-09-08T12:00:00Z' }),
  ], NOW);
  assert.deepEqual(awake.map(a => a.id), [1]);
  // Waking soonest first.
  assert.deepEqual(asleep.map(a => a.id), [3, 2], 'the next one back is the top of the list');
});

test('resolveSnooze turns minutes into a moment', () => {
  const out = snooze.resolveSnooze(60, { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.until, '2026-09-08T11:00:00.000Z');
  assert.equal(out.minutes, 60);
});

test('nonsense is refused rather than defaulted', () => {
  for (const bad of [0, -30, 'soon', null, undefined, NaN]) {
    assert.equal(snooze.resolveSnooze(bad, { now: NOW }).ok, false, String(bad));
  }
});

// Refused rather than clamped: silently giving a shorter sleep than asked for
// is the system disagreeing with Nick about his own diary.
test('past a week it is a rejection nobody recorded, and is refused', () => {
  const out = snooze.resolveSnooze(snooze.MAX_SNOOZE_MINUTES + 1, { now: NOW });
  assert.equal(out.ok, false);
  assert.match(out.reason, /reject it instead/);
  assert.equal(snooze.resolveSnooze(snooze.MAX_SNOOZE_MINUTES, { now: NOW }).ok, true, 'the boundary itself is fine');
});

// ⚠ THE ONE THAT MATTERS. "Remind me tomorrow" on a shortcut that is swept to
// `expired` overnight is a card Nick asked for later and never sees again.
test('a snooze may never outlive the action it is on', () => {
  const out = snooze.resolveSnooze(24 * 60, { now: NOW, expiresAt: new Date('2026-09-09T00:00:00Z') });
  assert.equal(out.ok, false);
  assert.match(out.reason, /never come back/);
  assert.equal(out.expiresAt, '2026-09-09T00:00:00.000Z', 'and it says when it dies, so a shorter one can be chosen');
});

test('a snooze that lands before the expiry is allowed', () => {
  const out = snooze.resolveSnooze(60, { now: NOW, expiresAt: new Date('2026-09-09T00:00:00Z') });
  assert.equal(out.ok, true);
});

test('an unreadable expiry never blocks a snooze', () => {
  // Not knowing when something dies is not a reason to refuse "not now" — the
  // sweep only ever retires navigation cards, and everything else has no expiry
  // at all, which arrives here as exactly this.
  assert.equal(snooze.resolveSnooze(60, { now: NOW, expiresAt: 'whenever' }).ok, true);
  assert.equal(snooze.resolveSnooze(60, { now: NOW, expiresAt: null }).ok, true);
});

test('the presets the panel offers are all ones the server accepts', () => {
  for (const p of snooze.PRESETS) {
    assert.equal(snooze.resolveSnooze(p.minutes, { now: NOW }).ok, true, p.label);
  }
});
