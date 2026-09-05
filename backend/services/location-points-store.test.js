'use strict';

/**
 * The storage half of the device position feed, against a real database.
 *
 * ⚠ This file exists because the pure test is not enough on its own. On 31 Aug
 * VESTA's first feature was found to have never worked, behind a green suite,
 * because everything asserted was true of the empty array the broken path
 * returned. `location-points.test.js` proves the RULES; this proves the points
 * actually land, come back, and fold on replay — and that `getTodayPoints()`
 * really does prefer them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-locpoints-'));
process.env.NEURO_DB_PATH = path.join(root, 'points.db');

// ⚠ Make sure neither fallback rung is configured, or a failure of the device
// path could be masked by OwnTracks or Home Assistant answering instead.
delete process.env.OWNTRACKS_RECORDER_URL;

const db = require('../db/database');
const lp = require('./location-points');
const location = require('./location');

const DEVICE = 'iphone-15-test';

/** A point `secondsAgo` before now, on today's local date. */
function pointAgo(secondsAgo, lat = 52.9225, lon = -1.4746) {
  return { lat, lon, tst: Math.floor(Date.now() / 1000) - secondsAgo, acc: 10 };
}

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM location_points', []); });

test('a stored point comes back in the OwnTracks shape', () => {
  const p = pointAgo(300);
  const r = lp.store(DEVICE, [{ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc }]);
  assert.equal(r.stored, 1);
  assert.equal(r.duplicate, 0);

  const back = lp.pointsBetween(p.tst - 10, p.tst + 10);
  assert.equal(back.length, 1);
  // `lon`, not `lng` — clusterPoints() reads lon, and this module is the one
  // place that translates from the column name.
  assert.deepEqual(back[0], { lat: p.lat, lon: p.lon, tst: p.tst });
});

test('re-sending a batch folds instead of double-counting', () => {
  // The phone re-sends any batch it did not see acknowledged. Without
  // UNIQUE(device_id, tst) a flaky tailnet would multiply every dwell.
  const batch = [pointAgo(600), pointAgo(500), pointAgo(400)]
    .map((p) => ({ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc }));

  const first = lp.store(DEVICE, batch);
  assert.equal(first.stored, 3);
  assert.equal(first.duplicate, 0);

  const replay = lp.store(DEVICE, batch);
  assert.equal(replay.stored, 0);        // nothing new
  assert.equal(replay.duplicate, 3);     // and it SAYS so, so a stuck queue is visible
  assert.equal(db.get('SELECT COUNT(*) AS n FROM location_points').n, 3);
});

test('the same instant from a DIFFERENT device is not a duplicate', () => {
  // The uniqueness is (device, time), not time. A watch and a phone reporting
  // together are two observations, not one repeated.
  const p = pointAgo(300);
  const row = { lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc };
  assert.equal(lp.store('phone', [row]).stored, 1);
  assert.equal(lp.store('watch', [row]).stored, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM location_points').n, 2);
});

test('an empty feed is not the same as an unreadable one, and neither invents a fix', () => {
  // Negative: nothing stored yet.
  assert.equal(lp.hasAnyPoints(), false);
  const cold = lp.freshness();
  assert.equal(cold.readable, true);     // the table read fine...
  assert.equal(cold.known, false);       // ...it is simply empty
  assert.equal(cold.ageMinutes, null);

  // Paired positive: one point flips both, and the age is real.
  const p = pointAgo(120);
  lp.store(DEVICE, [{ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc }]);
  assert.equal(lp.hasAnyPoints(), true);
  const warm = lp.freshness();
  assert.equal(warm.known, true);
  assert.equal(warm.stale, false);
  assert.equal(warm.deviceId, DEVICE);
  assert.equal(warm.ageMinutes, 2);
});

test('freshness reads the NEWEST point, not the first one it finds', () => {
  const old = pointAgo(9 * 3600);
  const recent = pointAgo(60);
  lp.store(DEVICE, [old, recent].map((p) => ({ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc })));
  const f = lp.freshness();
  assert.equal(f.stale, false);          // a stale point exists, but it is not the latest
  assert.equal(f.ageMinutes, 1);
});

test('a feed that has gone quiet reports stale — the 7-day expiry alarm', () => {
  // What a lapsed free-provisioning signature looks like: the app stopped being
  // launchable, so the newest point is days old and nothing errored.
  const dead = pointAgo(8 * 86400);
  lp.store(DEVICE, [{ lat: dead.lat, lon: dead.lon, tst: dead.tst, accuracy: dead.acc }]);
  const f = lp.freshness();
  assert.equal(f.known, true);
  assert.equal(f.stale, true);
  assert.match(f.why, /stopped reporting/);
});

// ── The source ladder ────────────────────────────────────────────────────────

test('getTodayPoints prefers the device feed and says so', async () => {
  const p = pointAgo(1800);
  lp.store(DEVICE, [{ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc }]);

  const points = await location.getTodayPoints();
  assert.equal(points.length, 1);
  assert.equal(points[0].lon, p.lon);
  // The archive stamps every visit with which feed answered; hardcoding it was
  // a lie the moment a second source existed.
  assert.equal(location.lastSource(), 'ios');
});

test('a device that has pushed a point counts as configured', async () => {
  // Negative: no points, no recorder URL, no HA — nothing to read.
  assert.equal(location.isConfigured(), false);
  // Paired positive: evidence, not an env var. The old check read
  // `!!OWNTRACKS_RECORDER_URL` — the variable being SET, never the recorder
  // answering — and that kept 65 days of dwell caches empty.
  const p = pointAgo(300);
  lp.store(DEVICE, [{ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc }]);
  assert.equal(location.isConfigured(), true);
});

test("today's bounds come from local getters, not UTC", () => {
  // The scar: toISOString() names the wrong day for the hour before midnight
  // through BST, which is how a whole evening's points landed on tomorrow.
  const bst = new Date(2026, 6, 15, 23, 30, 0); // 15 Jul 2026, 23:30 local
  const { from, to } = location._todayBoundsSeconds(bst);
  const fromLocal = new Date(from * 1000);
  const toLocal = new Date(to * 1000);
  assert.equal(fromLocal.getDate(), 15);
  assert.equal(fromLocal.getHours(), 0);
  assert.equal(toLocal.getDate(), 15);   // still the 15th, not the 16th
  assert.equal(toLocal.getHours(), 23);
});

test("a point from yesterday is not in today's window", () => {
  const yesterday = pointAgo(30 * 3600);
  const today = pointAgo(600);
  lp.store(DEVICE, [yesterday, today].map((p) => ({ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc })));
  const { from, to } = location._todayBoundsSeconds();
  const points = lp.pointsBetween(from, to);
  assert.equal(points.length, 1);        // positive: today's point is there
  assert.equal(points[0].tst, today.tst);
});

test('pruning drops old raw points but keeps recent ones', () => {
  const ancient = pointAgo(200 * 86400);
  const recent = pointAgo(600);
  lp.store(DEVICE, [ancient, recent].map((p) => ({ lat: p.lat, lon: p.lon, tst: p.tst, accuracy: p.acc })));
  assert.equal(db.pruneLocationPoints(90), 1);
  const left = db.get('SELECT COUNT(*) AS n FROM location_points').n;
  assert.equal(left, 1);                 // paired positive: it kept the recent one
  assert.equal(lp.freshness().stale, false);
});
