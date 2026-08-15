'use strict';

/**
 * Missed-run catch-up, pinned against what it was measured doing.
 *
 * `node-cron` is in-process with no catch-up. On the Pi the nightly sweep ran 9
 * times in 45 nights and the weekly hygiene pass 4 Fridays in 7, while the Pi
 * had 34 days of uptime — it was never downtime, it was the backend restarting
 * (49 restarts, mostly deploys) and each restart silently eating whatever was
 * due while it was gone.
 *
 * The two properties: a slot that has passed unrun is due, and a slot that has
 * already run is NOT — because a catch-up that re-runs is worse than one that
 * never fires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDailyDue, isWeeklyDue, _dateStr } = require('./scheduler');

const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);

// ── Daily ───────────────────────────────────────────────────────────────────

test('a 02:30 job missed by a restart is due when the backend comes back at 09:00', () => {
  const now = at(2026, 8, 15, 9, 0);
  assert.equal(isDailyDue('2026-08-14', 2, 30, now), true);
});

test('a job that already ran today is not due again', () => {
  // The whole point: a deploy at 10am must not re-run the sweep it did at 02:30.
  const now = at(2026, 8, 15, 10, 0);
  assert.equal(isDailyDue('2026-08-15', 2, 30, now), false);
});

test('a slot still ahead of us today is not due', () => {
  // 01:00 boot, sweep is at 02:30 — cron will handle it. Running now would be
  // an hour and a half early, every restart.
  const now = at(2026, 8, 15, 1, 0);
  assert.equal(isDailyDue('2026-08-14', 2, 30, now), false);
});

test('the minute boundary counts as passed', () => {
  assert.equal(isDailyDue(null, 2, 30, at(2026, 8, 15, 2, 30)), true);
  assert.equal(isDailyDue(null, 2, 30, at(2026, 8, 15, 2, 29)), false);
});

test('a job that has never run is due once its slot passes', () => {
  assert.equal(isDailyDue(null, 22, 0, at(2026, 8, 15, 23, 0)), true);
});

// ── Weekly ──────────────────────────────────────────────────────────────────

test("Friday's 16:35 hygiene pass, missed, is due on Saturday", () => {
  // 15 Aug 2026 is a Saturday; the slot was 14 Aug at 16:35.
  const sat = at(2026, 8, 15, 12, 0);
  assert.equal(isWeeklyDue('2026-08-07', 5, 16, 35, sat), true);
});

test('having run in the current week, it is not due again', () => {
  const sat = at(2026, 8, 15, 12, 0);
  assert.equal(isWeeklyDue('2026-08-14', 5, 16, 35, sat), false);
});

test('on Friday BEFORE the time, last Friday still counts as run', () => {
  // The subtle one: "today is the day" must not make the slot today when the
  // time has not arrived — otherwise every Friday-morning deploy fires it early.
  const friMorning = at(2026, 8, 14, 9, 0);
  assert.equal(isWeeklyDue('2026-08-07', 5, 16, 35, friMorning), false);
});

test('on Friday AFTER the time, a run from last week is stale', () => {
  const friEvening = at(2026, 8, 14, 17, 0);
  assert.equal(isWeeklyDue('2026-08-07', 5, 16, 35, friEvening), true);
});

test('a weekly job that has never run is due', () => {
  assert.equal(isWeeklyDue(null, 1, 8, 10, at(2026, 8, 15, 12, 0)), true);
});

// ── Date stamping ───────────────────────────────────────────────────────────

test('run dates are stamped in LOCAL time, not UTC', () => {
  // The Pi may run in UTC. A 02:30 job stamped from toISOString() rolls its date
  // over at the wrong moment, and the catch-up then disagrees with the clock the
  // cron expression is evaluated against.
  const justAfterMidnight = at(2026, 8, 15, 0, 30);
  assert.equal(_dateStr(justAfterMidnight), '2026-08-15');
  const lateEvening = at(2026, 8, 15, 23, 30);
  assert.equal(_dateStr(lateEvening), '2026-08-15');
});
