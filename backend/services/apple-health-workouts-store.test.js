'use strict';

/**
 * Workouts landing in a real database.
 *
 * The parser test proves the wire rules; this proves a workout is actually
 * stored, folds on replay, and comes back with the numbers Strava's consumers
 * need. Without it, `insertWorkouts` could be silently writing nulls and every
 * assertion in the pure test would still pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-workouts-'));
process.env.NEURO_DB_PATH = path.join(root, 'workouts.db');

const db = require('../db/database');
const ah = require('./apple-health');

const RUN = {
  id: 'uuid-run-1',
  name: 'Outdoor Run',
  start: '2026-08-16 07:00:00 +0100',
  end: '2026-08-16 07:45:00 +0100',
  duration: 2700,
  distance: { qty: 8.2, units: 'km' },
  activeEnergyBurned: { qty: 520, units: 'kcal' },
  elevationUp: { qty: 120, units: 'm' },
  avgHeartRate: { qty: 152, units: 'bpm' },
};

function parsed(workouts) {
  return ah.parsePayload({ data: { metrics: [], workouts } }).workouts;
}

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM health_workouts', []); });

test('a workout round-trips with the numbers Strava consumers read', () => {
  assert.equal(db.insertWorkouts(parsed([RUN])), 1);

  const rows = db.getWorkoutsBetween('2026-08-16 00:00:00', '2026-08-16 23:59:59');
  assert.equal(rows.length, 1);
  const w = rows[0];
  assert.equal(w.activity_type, 'Outdoor Run');
  assert.equal(w.started_at, '2026-08-16 06:00:00');
  assert.equal(w.duration_seconds, 2700);
  // ⚠ The paired POSITIVE that matters: these are the columns most likely to be
  // silently null if the insert bound the wrong names, and every "it did not
  // crash" assertion passes on a row of nulls.
  assert.equal(w.distance_m, 8200);
  assert.equal(w.active_energy_kcal, 520);
  assert.equal(w.elevation_m, 120);
  assert.equal(w.avg_heart_rate, 152);
  assert.equal(w.source, 'apple-health');
});

test('a re-sent workout folds instead of duplicating', () => {
  // A backfill overlapping a daily sync sends the same workout twice.
  assert.equal(db.insertWorkouts(parsed([RUN])), 1);
  assert.equal(db.insertWorkouts(parsed([RUN])), 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM health_workouts').n, 1);
});

test('two different workouts both survive', () => {
  const walk = { ...RUN, id: 'uuid-walk-1', name: 'Walk', start: '2026-08-16 12:00:00 +0100', end: '2026-08-16 12:30:00 +0100' };
  assert.equal(db.insertWorkouts(parsed([RUN, walk])), 2);
  const rows = db.getWorkoutsBetween('2026-08-16 00:00:00', '2026-08-16 23:59:59');
  assert.deepEqual(rows.map((r) => r.activity_type), ['Outdoor Run', 'Walk']);
});

test('a workout outside the window is not returned', () => {
  const yesterday = { ...RUN, id: 'u-y', start: '2026-08-15 07:00:00 +0100', end: '2026-08-15 07:30:00 +0100' };
  db.insertWorkouts(parsed([RUN, yesterday]));
  const rows = db.getWorkoutsBetween('2026-08-16 00:00:00', '2026-08-16 23:59:59');
  assert.equal(rows.length, 1);                       // negative: yesterday excluded
  assert.equal(rows[0].source_uuid, 'uuid-run-1');    // positive: today included
});

test('an unmodelled field survives to the database', () => {
  db.insertWorkouts(parsed([{ ...RUN, humidity: 72 }]));
  const row = db.getLatestWorkout();
  assert.equal(JSON.parse(row.payload).humidity, 72);
});

test('a workout with optional measurements absent stores nulls, not zeroes', () => {
  // A yoga session has no distance. Zero would read as "he went nowhere", which
  // is a claim; null is the absence of one.
  db.insertWorkouts(parsed([{ id: 'u-yoga', name: 'Yoga', start: RUN.start, end: RUN.end }]));
  const row = db.getLatestWorkout();
  assert.equal(row.distance_m, null);
  assert.notEqual(row.distance_m, 0);
  assert.equal(row.activity_type, 'Yoga');            // paired positive
});
