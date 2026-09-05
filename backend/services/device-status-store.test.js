'use strict';

/**
 * The device self-report against a real database.
 *
 * The pure test proves the RULES; this proves a report actually lands, comes
 * back, and — the one that matters — that a LATE report cannot rewind the
 * phone's state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-devstatus-'));
process.env.NEURO_DB_PATH = path.join(root, 'device.db');

const db = require('../db/database');
const ds = require('./device-status');

const DEVICE = 'nick-iphone';

function report(reportedAt, extra = {}) {
  const v = ds.validate({ deviceId: DEVICE, reportedAt, ...extra });
  assert.equal(v.ok, true, v.reason);
  return v.status;
}

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM device_status', []); });

test('a report lands and comes back in the shape consumers speak', () => {
  const r = ds.store(report('2026-09-05T13:59:30Z', {
    batteryLevel: 0.42, batteryState: 'discharging', activity: 'walking',
    steps: 4200, distanceM: 3100.5, floorsAscended: 3, focusMode: true,
    connectionType: 'wifi', geocodedLocation: 'Little Eaton',
  }));
  assert.equal(r.stored, true);

  const back = ds.latest();
  assert.equal(back.deviceId, DEVICE);
  assert.equal(back.batteryLevel, 42);        // converted on the way in, stored converted
  assert.equal(back.activity, 'Walking');
  assert.equal(back.steps, 4200);
  assert.equal(back.floorsAscended, 3);
  // ⚠ SQLite has no boolean. Stored as 1, and it must come back as `true`, not
  // as the integer — a consumer doing `=== true` would silently never match.
  assert.equal(back.focusMode, true);
  assert.equal(back.geocodedLocation, 'Little Eaton');
});

test('a LATE report does not rewind the phone', () => {
  // THE bug this guard exists for. The phone queues reports while off the
  // tailnet and drains them in whatever order it manages. A plain upsert lets
  // one observed at 09:00 but delivered at 14:05 overwrite one observed at
  // 14:00 — the phone would then show `Walking` and 42% hours after it went
  // still and started charging, with nothing anywhere saying so.
  assert.equal(ds.store(report('2026-09-05T14:00:00Z', {
    activity: 'still', batteryLevel: 0.95, batteryState: 'charging',
  })).stored, true);

  const late = ds.store(report('2026-09-05T09:00:00Z', {
    activity: 'walking', batteryLevel: 0.42, batteryState: 'discharging',
  }));
  assert.equal(late.stored, false);           // correctly ignored, and it SAYS so

  const now = ds.latest();
  assert.equal(now.activity, 'Still');        // paired positive: the newer state survived
  assert.equal(now.batteryLevel, 95);
  assert.equal(now.reportedAt, '2026-09-05T14:00:00.000Z');
});

test('a newer report does supersede an older one', () => {
  // Paired with the above: the guard must not wedge the row permanently.
  assert.equal(ds.store(report('2026-09-05T09:00:00Z', { activity: 'walking' })).stored, true);
  assert.equal(ds.store(report('2026-09-05T14:00:00Z', { activity: 'automotive' })).stored, true);
  assert.equal(ds.latest().activity, 'Automotive');
});

test('an identical timestamp is not stored twice', () => {
  // A retried POST is the same observation, not a new one.
  assert.equal(ds.store(report('2026-09-05T14:00:00Z', { steps: 10 })).stored, true);
  assert.equal(ds.store(report('2026-09-05T14:00:00Z', { steps: 10 })).stored, false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM device_status').n, 1);
});

test('two devices each keep their own row', () => {
  ds.store(report('2026-09-05T14:00:00Z', { activity: 'still' }));
  const watch = ds.validate({ deviceId: 'nick-watch', reportedAt: '2026-09-05T14:00:05Z', activity: 'walking' });
  ds.store(watch.status);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM device_status').n, 2);
  assert.equal(ds.latest().deviceId, 'nick-watch');   // newest OBSERVED wins across devices
  assert.equal(db.getDeviceStatusFor(DEVICE).activity, 'Still');
});

test('an empty store is readable and empty, not unreadable', () => {
  const cold = ds.freshness();
  assert.equal(cold.readable, true);    // the table answered...
  assert.equal(cold.known, false);      // ...it is simply empty
  assert.equal(cold.ageMinutes, null);
  // Paired positive: one report flips it, with a real age.
  ds.store(report(new Date(Date.now() - 120000).toISOString(), { activity: 'still' }));
  const warm = ds.freshness();
  assert.equal(warm.known, true);
  assert.equal(warm.stale, false);
  assert.equal(warm.ageMinutes, 2);
  assert.equal(warm.deviceId, DEVICE);
});

test('a phone that stopped reporting goes stale', () => {
  ds.store(report(new Date(Date.now() - 3 * 86400000).toISOString(), { activity: 'walking' }));
  const f = ds.freshness();
  assert.equal(f.known, true);
  assert.equal(f.stale, true);
  assert.match(f.why, /has not reported/);
});

test('an unmodelled sensor survives the round trip', () => {
  ds.store(report('2026-09-05T14:00:00Z', { wristTemperature: 33.1 }));
  const row = db.getDeviceStatusFor(DEVICE);
  assert.equal(JSON.parse(row.payload).wristTemperature, 33.1);
});
