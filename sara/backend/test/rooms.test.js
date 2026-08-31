// Room arbitration + the three display states. Zero deps — Node's built-in runner.
//   run: npm test   (from sara/backend)
//
// Both functions are pure, so the rules pin without a sensor, a live Home
// Assistant, or a wall to stand in front of. The tests that matter most are the
// NEGATIVE ones: nothing unreadable is ever counted as an empty room, and
// nothing uncertain ever locks a screen Nick may be standing in front of.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRoom, displayState } = require('../src/presence/rooms');

const NOW = new Date('2026-08-31T13:00:00.000Z');

function report(over = {}) {
  return {
    status: 'present',
    healthy: true,
    rate: 2.2,
    rssiMedian: -64,
    why: null,
    at: NOW.toISOString(),
    ...over,
  };
}

// ── Arbitration ─────────────────────────────────────────────────────────────

test('the loudest room wins when both hear the watch', () => {
  const r = resolveRoom({
    'living-room': report({ rssiMedian: -64 }),
    kitchen: report({ rssiMedian: -70 }),
  }, NOW);
  assert.equal(r.status, 'present');
  assert.equal(r.room, 'living-room', '-64 is closer than -70');
});

test('rate breaks a tie, because RSSI alone cannot', () => {
  const r = resolveRoom({
    kitchen: report({ rssiMedian: -66, rate: 1.1 }),
    'living-room': report({ rssiMedian: -66, rate: 2.6 }),
  }, NOW);
  assert.equal(r.room, 'living-room');
});

// ── Hysteresis ──────────────────────────────────────────────────────────────
// Measured live: with Nick sat still in the living room the two rooms sit 1-5 dB
// apart and the raw winner FLIPPED to the kitchen. Walking to the kitchen is
// worth 17 dB. Six sits in that gap.

test('a challenger within the noise does NOT take the room', () => {
  const r = resolveRoom({
    'living-room': report({ rssiMedian: -74 }),
    kitchen: report({ rssiMedian: -75 }),
  }, NOW, { previousRoom: 'living-room' });
  assert.equal(r.room, 'living-room');

  // The exact flip seen live: kitchen a single dB louder.
  const flipped = resolveRoom({
    'living-room': report({ rssiMedian: -75 }),
    kitchen: report({ rssiMedian: -74 }),
  }, NOW, { previousRoom: 'living-room' });
  assert.equal(flipped.room, 'living-room', 'one dB is a coin toss, not a move');
  assert.equal(flipped.held, true);
});

test('actually walking to the other room DOES take it', () => {
  const r = resolveRoom({
    'living-room': report({ rssiMedian: -83 }),
    kitchen: report({ rssiMedian: -66 }),
  }, NOW, { previousRoom: 'living-room' });
  assert.equal(r.room, 'kitchen', '17 dB is a move, not noise');
  assert.equal(r.held, false);
});

// ⚠ Hysteresis must never pin the answer to a room he has left.
test('the incumbent loses the room the moment it cannot hear him', () => {
  const r = resolveRoom({
    'living-room': report({ status: 'absent', rssiMedian: null }),
    kitchen: report({ rssiMedian: -70 }),
  }, NOW, { previousRoom: 'living-room' });
  assert.equal(r.room, 'kitchen');
});

test('with no incumbent the loudest simply wins', () => {
  const r = resolveRoom({
    'living-room': report({ rssiMedian: -75 }),
    kitchen: report({ rssiMedian: -74 }),
  }, NOW, { previousRoom: null });
  assert.equal(r.room, 'kitchen');
});

test('nothing present anywhere is `absent`, and it says WHICH rooms it checked', () => {
  const r = resolveRoom({
    'living-room': report({ status: 'absent', rssiMedian: null, rate: 0 }),
    kitchen: report({ status: 'absent', rssiMedian: null, rate: 0 }),
  }, NOW);
  assert.equal(r.status, 'absent');
  assert.equal(r.room, null);
  // Honest scope. He is not in the rooms that ANSWERED — not "not at home".
  assert.match(r.why, /living-room/);
  assert.match(r.why, /kitchen/);
});

// ⚠ The fifteen-day bug, as a test. A deaf sensor reported `away` continuously
// and nothing could tell it from an empty house.
test('a DEAF sensor is unreadable, never absent', () => {
  const r = resolveRoom({
    kitchen: report({ status: 'unknown', healthy: false, why: 'the radio is deaf' }),
  }, NOW);
  assert.equal(r.status, 'unknown', 'deaf must never read as "he is not there"');
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].room, 'kitchen');
  assert.match(r.unreadable[0].why, /deaf/);
});

test('a STALE report is unreadable and is named, never counted as empty', () => {
  const old = new Date(NOW.getTime() - 120_000).toISOString();
  const r = resolveRoom({ kitchen: report({ at: old }) }, NOW);
  assert.equal(r.status, 'unknown');
  assert.match(r.unreadable[0].why, /gone quiet/);
});

test('one live room still answers while another is stale', () => {
  const old = new Date(NOW.getTime() - 120_000).toISOString();
  const r = resolveRoom({
    'living-room': report({ rssiMedian: -64 }),
    kitchen: report({ at: old, rssiMedian: -50 }),
  }, NOW);
  assert.equal(r.room, 'living-room', 'a stale louder room must not win');
  assert.equal(r.unreadable.length, 1, 'and the stale one is still reported');
});

test('no sensors at all is unknown, not absent', () => {
  const r = resolveRoom({}, NOW);
  assert.equal(r.status, 'unknown');
  assert.match(r.why, /no sensors/);
});

test('every room unreadable says so, and says it is not an all-clear', () => {
  const r = resolveRoom({
    kitchen: report({ status: 'unknown', healthy: false }),
    'living-room': report({ at: new Date(NOW.getTime() - 90_000).toISOString() }),
  }, NOW);
  assert.equal(r.status, 'unknown');
  assert.match(r.why, /not an all-clear/);
});

test('a report with no timestamp is unreadable rather than trusted', () => {
  const r = resolveRoom({ kitchen: report({ at: undefined }) }, NOW);
  assert.equal(r.status, 'unknown');
});

// ── Display state ───────────────────────────────────────────────────────────

test('watch in this room shows everything', () => {
  const arb = resolveRoom({ 'living-room': report() }, NOW);
  assert.equal(displayState('living-room', arb, { away: false }).state, 'full');
});

test('watch in another room shows the clock, and names the room', () => {
  const arb = resolveRoom({
    'living-room': report({ rssiMedian: -80 }),
    kitchen: report({ rssiMedian: -55 }),
  }, NOW);
  const d = displayState('living-room', arb, { away: false });
  assert.equal(d.state, 'clock');
  assert.equal(d.reason, 'watch-in-another-room');
  assert.match(d.say, /kitchen/);
});

test('away from home locks when the watch cannot be heard', () => {
  const arb = resolveRoom({ 'living-room': report({ status: 'absent' }) }, NOW);
  assert.equal(displayState('living-room', arb, { away: true }).state, 'locked');
});

// ⚠ The live bug, as a test. zone.home is a 100m circle centred 90m from where
// Nick sits, so HA said not_home while he was at home with both sensors hearing
// the watch. Locking there reproduces the original complaint via GPS.
test('a watch that IS audible refuses the lock, and says so out loud', () => {
  const arb = resolveRoom({
    'living-room': report({ rssiMedian: -68 }),
    kitchen: report({ rssiMedian: -75 }),
  }, NOW);
  const d = displayState('living-room', arb, { away: true, zone: 'not_home' });
  assert.equal(d.state, 'full', 'he is audible in this very room');
  assert.equal(d.reason, 'home-contradicted');
  assert.match(d.contradiction, /Trusting the watch/);
});

test('a contradicted lock still respects WHICH room he is in', () => {
  const arb = resolveRoom({
    'living-room': report({ rssiMedian: -80 }),
    kitchen: report({ rssiMedian: -55 }),
  }, NOW);
  const d = displayState('living-room', arb, { away: true });
  assert.equal(d.state, 'clock', 'audible, but in the kitchen');
  assert.match(d.say, /kitchen/);
});

// The other half: the rule must not become a way to never lock at all.
test('deaf sensors do NOT rescue the lock — absence of evidence is not evidence', () => {
  const arb = resolveRoom({
    'living-room': report({ status: 'unknown', healthy: false }),
    kitchen: report({ at: new Date(NOW.getTime() - 90_000).toISOString() }),
  }, NOW);
  assert.equal(displayState('living-room', arb, { away: true }).state, 'locked',
    'not_home is a positive statement; a deaf sensor is only the absence of one');
});

// ⚠ The rule the old design got wrong. Losing the watch cost Nick his display.
test('an unreadable watch shows the CLOCK, never the lock', () => {
  const arb = resolveRoom({ kitchen: report({ status: 'unknown', healthy: false }) }, NOW);
  const d = displayState('living-room', arb, { away: false });
  assert.equal(d.state, 'clock');
  assert.equal(d.reason, 'watch-unreadable');
});

test('unknown home presence NEVER locks', () => {
  const arb = resolveRoom({ 'living-room': report({ status: 'absent' }) }, NOW);
  for (const home of [{ away: null }, null, undefined, {}]) {
    assert.equal(displayState('living-room', arb, home).state, 'clock',
      'only a confident "not home" may blank a screen Nick might be standing at');
  }
});

test('the three clock reasons stay distinct', () => {
  const elsewhere = resolveRoom({
    'living-room': report({ rssiMedian: -80 }),
    kitchen: report({ rssiMedian: -55 }),
  }, NOW);
  const nowhere = resolveRoom({ 'living-room': report({ status: 'absent' }) }, NOW);
  const blind = resolveRoom({ 'living-room': report({ status: 'unknown', healthy: false }) }, NOW);

  const reasons = [elsewhere, nowhere, blind]
    .map(a => displayState('living-room', a, { away: false }).reason);
  assert.deepEqual(new Set(reasons).size, 3,
    'elsewhere / not-here / could-not-look draw the same screen but are different facts');
});
