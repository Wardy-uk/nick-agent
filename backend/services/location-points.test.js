'use strict';

/**
 * The device-pushed position wire contract.
 *
 * Validation and freshness are both pure — no DB, no clock, no phone — so what
 * the iOS app is allowed to send pins here without any of them. The storage
 * half and the source ladder are `location-points-store.test.js`.
 *
 * ⚠ Every negative assertion below is PAIRED with a positive one. The rule cost
 * a day on 31 Aug: VESTA's task path had never worked, behind a green suite,
 * because the only assertion was `assert.ok(Array.isArray(json.tasks))` — true
 * of the `[]` the broken path returned. A test that only proves bad input is
 * refused passes just as happily on a validator that refuses everything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const lp = require('./location-points');

// A plausible fix in Derby, and a clock to judge it against.
const NOW = 1788000000; // unix seconds
const GOOD = { lat: 52.9225, lon: -1.4746, tst: NOW - 60, acc: 12 };

test('a well-formed point is accepted and normalised', () => {
  const r = lp.validatePoint(GOOD, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.point, { lat: 52.9225, lon: -1.4746, tst: NOW - 60, accuracy: 12 });
});

test('lng is accepted as a spelling of lon', () => {
  // `location_visits` calls it lng, OwnTracks calls it lon, and both spellings
  // are already live in this codebase. A client should not have to know which
  // side of that fence it is on — but the OUTPUT is always `lon`, because that
  // is what clusterPoints() reads.
  const r = lp.validatePoint({ lat: 52.9, lng: -1.4, tst: NOW }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.point.lon, -1.4);
  // Paired positive: the canonical spelling still works and means the same.
  const c = lp.validatePoint({ lat: 52.9, lon: -1.4, tst: NOW }, NOW);
  assert.deepEqual(c.point, r.point);
});

test('a millisecond timestamp is refused by name, never divided', () => {
  // THE damaging one, and it is silent: stored as seconds, every duration
  // computed from it is ~1000x too large, so a 40-second drive past a shop
  // clears the 20-minute dwell floor and is recorded as a visit.
  const ms = lp.validatePoint({ ...GOOD, tst: NOW * 1000 }, NOW);
  assert.equal(ms.ok, false);
  assert.match(ms.reason, /milliseconds/);
  // Paired positive: the same instant in SECONDS is fine, so this rejects the
  // unit and not the moment.
  assert.equal(lp.validatePoint({ ...GOOD, tst: NOW }, NOW).ok, true);
});

test('a future timestamp is refused, but ordinary clock skew is not', () => {
  const future = lp.validatePoint({ ...GOOD, tst: NOW + 3600 }, NOW);
  assert.equal(future.ok, false);
  assert.match(future.reason, /future/);
  // Paired positive: a phone a minute ahead is normal and must still be taken —
  // a batch is stamped when it was RECORDED, not when it was sent.
  assert.equal(lp.validatePoint({ ...GOOD, tst: NOW + 60 }, NOW).ok, true);
});

test('an OLD timestamp is accepted — that is the offline queue working', () => {
  // Nothing rejects age. The phone spends hours off the tailnet and drains its
  // queue later; a batch three days late is the feature, not a fault.
  const old = lp.validatePoint({ ...GOOD, tst: NOW - 3 * 86400 }, NOW);
  assert.equal(old.ok, true);
  assert.equal(old.point.tst, NOW - 3 * 86400);
});

test('a coarse fix is refused, an ABSENT accuracy is not', () => {
  // Matches the gate services/ha.js already applies (gps_accuracy > 500), so
  // the two feeds cannot disagree about what counts as a fix.
  const coarse = lp.validatePoint({ ...GOOD, acc: 2000 }, NOW);
  assert.equal(coarse.ok, false);
  assert.match(coarse.reason, /ceiling/);
  // Paired positive, and the distinction that matters: "no accuracy reported"
  // is a different fact from "reported, and too coarse". The OwnTracks feed
  // does not always carry one either, so absent must not be treated as bad.
  const absent = lp.validatePoint({ lat: 52.9, lon: -1.4, tst: NOW }, NOW);
  assert.equal(absent.ok, true);
  assert.equal(absent.point.accuracy, null);
  // And the boundary itself is inclusive.
  assert.equal(lp.validatePoint({ ...GOOD, acc: lp.ACCURACY_CEILING_M }, NOW).ok, true);
});

test('null island is refused', () => {
  // 0,0 is the shape of a fix that failed — a half-initialised struct, or
  // CoreLocation before it has one. It clusters happily into a "visit" in the
  // Gulf of Guinea.
  assert.equal(lp.validatePoint({ lat: 0, lon: 0, tst: NOW }, NOW).ok, false);
  // Paired positive: a genuine zero on ONE axis is a real place (the Greenwich
  // meridian runs through England) and must survive.
  assert.equal(lp.validatePoint({ lat: 52.9, lon: 0, tst: NOW }, NOW).ok, true);
});

test('coordinates outside the globe are refused', () => {
  assert.equal(lp.validatePoint({ lat: 91, lon: 0, tst: NOW }, NOW).ok, false);
  assert.equal(lp.validatePoint({ lat: 0, lon: 181, tst: NOW }, NOW).ok, false);
  assert.equal(lp.validatePoint({ lat: 'derby', lon: -1.4, tst: NOW }, NOW).ok, false);
  // Paired positive: the extremes themselves are valid coordinates.
  assert.equal(lp.validatePoint({ lat: 90, lon: 180, tst: NOW }, NOW).ok, true);
});

test('one bad point does not fail the batch, and rejections are named', () => {
  // The phone cannot repair a fix it has already taken. Refusing all 200
  // because one was coarse means the queue never drains and the day has no
  // position at all.
  const r = lp.validateBatch({
    deviceId: 'iphone-15',
    nowSeconds: NOW,
    points: [
      GOOD,
      { ...GOOD, tst: NOW - 120, acc: 9000 },   // too coarse
      { ...GOOD, tst: NOW * 1000 },             // milliseconds
      { ...GOOD, tst: NOW - 180 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.received, 4);
  assert.equal(r.accepted.length, 2);           // positive: the good ones survived
  assert.equal(r.rejected, 2);
  // Named, not just counted — a client that cannot see WHY cannot be fixed.
  assert.equal(Object.values(r.rejectedReasons).reduce((a, b) => a + b, 0), 2);
  assert.ok(Object.keys(r.rejectedReasons).some((k) => /ceiling/.test(k)));
  assert.ok(Object.keys(r.rejectedReasons).some((k) => /milliseconds/.test(k)));
});

test('a malformed batch envelope is refused outright', () => {
  assert.equal(lp.validateBatch({ points: [GOOD] }).ok, false);              // no deviceId
  assert.equal(lp.validateBatch({ deviceId: '  ', points: [GOOD] }).ok, false);
  assert.equal(lp.validateBatch({ deviceId: 'x', points: 'nope' }).ok, false);
  const tooMany = lp.validateBatch({
    deviceId: 'x',
    points: new Array(lp.MAX_POINTS_PER_REQUEST + 1).fill(GOOD),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /too many/);
  // Paired positive: the envelope this suite keeps refusing is accepted when it
  // is well-formed, and an EMPTY batch is legitimate (a queue with nothing in
  // it is not an error).
  const empty = lp.validateBatch({ deviceId: 'iphone-15', points: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.accepted.length, 0);
});

// ── Freshness — the 7-day expiry alarm ───────────────────────────────────────

test('never having received a point is not the same as being stale', () => {
  // On free provisioning the signature lapses weekly, iOS stops launching the
  // app, and the feed goes quiet with no error. "Never started" and "worked and
  // stopped" need different fixes, so they are different states.
  const f = lp.assessFreshness(null);
  assert.equal(f.known, false);
  assert.equal(f.stale, null);
  // ⚠ And it reports NO AGE. Rendering "nothing has ever arrived" as 0 minutes
  // would read as perfectly fresh — the exact false all-clear this guards.
  assert.equal(f.ageMinutes, null);
  assert.equal(f.lastAt, null);
  assert.match(f.why, /ever been received/);
});

test('a quiet feed goes stale, a live one does not', () => {
  const now = new Date(NOW * 1000);
  const live = lp.assessFreshness({ tst: NOW - 600, device_id: 'iphone-15' }, now);
  assert.equal(live.known, true);
  assert.equal(live.stale, false);
  assert.equal(live.ageMinutes, 10);
  assert.equal(live.deviceId, 'iphone-15');
  assert.equal(live.why, null);

  // A week of silence is the signature having expired.
  const dead = lp.assessFreshness({ tst: NOW - 7 * 86400, device_id: 'iphone-15' }, now);
  assert.equal(dead.known, true);
  assert.equal(dead.stale, true);
  assert.equal(dead.ageMinutes, 7 * 1440);
  assert.match(dead.why, /stopped reporting/);
});

test('the stale window is a boundary, not a vibe', () => {
  const now = new Date(NOW * 1000);
  const w = lp.STALE_AFTER_MINUTES;
  // Exactly at the window is still live — significant-change reporting is
  // legitimately quiet through a still evening at home.
  assert.equal(lp.assessFreshness({ tst: NOW - w * 60 }, now).stale, false);
  assert.equal(lp.assessFreshness({ tst: NOW - (w + 1) * 60 }, now).stale, true);
});

test('a point from the near future does not render as a negative age', () => {
  // The skew rule refuses anything meaningful, but a second of drift should not
  // produce "-0 minutes ago".
  const f = lp.assessFreshness({ tst: NOW + 30 }, new Date(NOW * 1000));
  assert.equal(f.ageMinutes, 0);
  assert.equal(f.stale, false);
});
