'use strict';

/**
 * The desktop rollup.
 *
 * Two things are worth more than the rest of this file put together:
 *
 *  - a GAP is not time at the desk, and
 *  - a thinner row must never overwrite a fuller one.
 *
 * Both fail silently in production. The first turns a lunch break into part of a
 * four-hour run; the second turns an eight-hour day into a two-hour one the next
 * time the backend restarts, which is several times a day. Neither raises an
 * error and both leave a plausible number on the screen — which is exactly how
 * RescueTime reported 0.16h against a measured 8.21h day and nobody noticed for
 * three months.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-deskday-')), 'a.db');

const db = require('../db/database');
const desk = require('./desktop-activity');
const daily = require('./desktop-daily');

test.before(async () => { await db.init(); });

/** Samples every 2 minutes, ascending from a local wall-clock start. */
function stream(startLocal, count, app, { idleSeconds = 5, locked = false, stepMin = 2 } = {}) {
  const t0 = startLocal.getTime();
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(t0 + i * stepMin * 60000).toISOString(),
    app, idleSeconds, locked,
  }));
}

const local = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);

/**
 * Stateful tests share one scratch database, and the overwrite guard means a row
 * left behind by an earlier test legitimately REFUSES a later one's write — the
 * code being right and the test being wrong. Reset both halves.
 */
function reset() {
  db.setState(desk.STATE_KEY, '');
  db.run('DELETE FROM desktop_daily');
}

// ── The day key ──────────────────────────────────────────────────────────────

test('the day key is LOCAL, never toISOString', () => {
  // Built from local parts, so this holds in every timezone.
  assert.equal(daily.dayKey(local(2026, 6, 15, 0, 30)), '2026-06-15');
  assert.equal(daily.dayKey(local(2026, 6, 15, 23, 45)), '2026-06-15');

  // Where the machine is not on UTC, the two genuinely disagree — and that is
  // the bug this guards. On a UTC host (the Pi may be one) there is nothing to
  // catch, so the assertion is made only where it means something.
  const d = local(2026, 6, 15, 0, 30);
  if (d.getTimezoneOffset() !== 0) {
    assert.notEqual(daily.dayKey(d), d.toISOString().slice(0, 10),
      'the local key must differ from the UTC one at this hour');
  }
});

// ── Attribution ──────────────────────────────────────────────────────────────

test('present time is active + idle + locked, exactly', () => {
  const samples = [
    ...stream(local(2026, 6, 15, 9, 0), 15, 'Code'),
    ...stream(local(2026, 6, 15, 9, 30), 10, 'Code', { idleSeconds: 1200 }),
    ...stream(local(2026, 6, 15, 9, 50), 10, null, { locked: true }),
    ...stream(local(2026, 6, 15, 10, 10), 5, 'Code'),
  ];
  const day = daily.rollup(samples)['2026-06-15'];
  assert.ok(day, 'the day is rolled up');
  const sum = day.activeMinutes + day.idleMinutes + day.lockedMinutes;
  assert.equal(Math.round(sum * 10) / 10, day.presentMinutes,
    'present must be the sum of its parts, or one of them is being counted twice');
});

test('a GAP is not time at the desk', () => {
  // Two half-hours of work with three hours of nothing in between: the laptop
  // was asleep. Bridging the hole would report four hours at the desk.
  const samples = [
    ...stream(local(2026, 6, 15, 9, 0), 15, 'Code'),   // 28 min of intervals
    ...stream(local(2026, 6, 15, 12, 30), 15, 'Code'), // another 28
  ];
  const day = daily.rollup(samples)['2026-06-15'];
  assert.equal(day.presentMinutes, 56, 'only the covered intervals count');
  assert.ok(day.presentMinutes < 60, 'the three-hour hole must not be counted');
});

test('a locked stretch records no app at all', () => {
  const samples = stream(local(2026, 6, 15, 9, 0), 10, 'Code', { locked: true });
  const day = daily.rollup(samples)['2026-06-15'];
  assert.equal(day.activeMinutes, 0);
  assert.ok(day.lockedMinutes > 0);
  assert.deepEqual(day.apps, {}, 'what was open behind the lock screen is not kept');
  assert.equal(day.topApp, null);
});

test('idle time is present but not active', () => {
  const samples = stream(local(2026, 6, 15, 9, 0), 10, 'Code', { idleSeconds: 3600 });
  const day = daily.rollup(samples)['2026-06-15'];
  assert.equal(day.activeMinutes, 0, 'reading email in another room is not working');
  assert.ok(day.idleMinutes > 0);
  assert.ok(day.presentMinutes > 0);
});

test('an interval is attributed to the day it STARTED in', () => {
  const days = daily.rollup([
    ...stream(local(2026, 6, 15, 23, 50), 5, 'Code'),  // crosses midnight
    ...stream(local(2026, 6, 16, 0, 2), 5, 'Code'),
  ]);
  assert.ok(days['2026-06-15'], 'the evening is its own day');
  assert.ok(days['2026-06-16'], 'and so is the small hours');
  assert.ok(days['2026-06-15'].sampleCount >= 5);
});

test('a day with a single sample still reports that sample', () => {
  // It contributes no interval, so a naive implementation reports sample_count 0
  // and the day reads as "the agent never ran" — which is a different fact.
  const day = daily.rollup(stream(local(2026, 6, 15, 9, 0), 1, 'Code'))['2026-06-15'];
  assert.equal(day.sampleCount, 1);
  assert.equal(day.presentMinutes, 0);
});

// ── The longest run ──────────────────────────────────────────────────────────

test('the longest unbroken run in one app is measured', () => {
  // ⚠ The run ends at the first sample naming a DIFFERENT app, not at the last
  // one naming this app — the interval between them belongs to the earlier
  // sample's state, which is the same convention that makes present = active +
  // idle + locked hold. So 9:00 to 10:00 in Code, with chrome first seen at
  // 10:02, is 62 minutes and not 60. The alternative splits the boundary
  // interval out of every total and makes the invariant above stop being true.
  const samples = [
    ...stream(local(2026, 6, 15, 9, 0), 31, 'Code'),    // 9:00 - 10:00
    ...stream(local(2026, 6, 15, 10, 2), 11, 'chrome'), // 10:02 - 10:22
  ];
  const day = daily.rollup(samples)['2026-06-15'];
  assert.equal(day.longestRunMinutes, 62);
  assert.equal(day.topApp, 'Code');
});

test('a run is broken by an app switch, by idle and by a gap', () => {
  const switched = daily.rollup([
    ...stream(local(2026, 6, 15, 9, 0), 16, 'Code'),    // 9:00 - 9:30
    ...stream(local(2026, 6, 15, 9, 32), 16, 'chrome'), // 9:32 - 10:02
    ...stream(local(2026, 6, 15, 10, 4), 16, 'Code'),   // 10:04 - 10:34
  ])['2026-06-15'];
  // Three half-hour stretches, not ninety minutes. 32 rather than 30 for the
  // boundary reason above; the point is that it is nowhere near 94.
  assert.equal(switched.longestRunMinutes, 32, 'three half-hours, not ninety minutes');

  const idled = daily.rollup([
    ...stream(local(2026, 6, 15, 9, 0), 16, 'Code'),
    ...stream(local(2026, 6, 15, 9, 32), 5, 'Code', { idleSeconds: 3600 }),
    ...stream(local(2026, 6, 15, 9, 44), 16, 'Code'),
  ])['2026-06-15'];
  assert.ok(idled.longestRunMinutes <= 32, 'going idle ends the run');

  const gapped = daily.rollup([
    ...stream(local(2026, 6, 15, 9, 0), 16, 'Code'),
    ...stream(local(2026, 6, 15, 13, 0), 16, 'Code'),
  ])['2026-06-15'];
  assert.equal(gapped.longestRunMinutes, 30, 'lunch is not part of the run');
});

// ── The overwrite guard ──────────────────────────────────────────────────────

test('a thinner row may NEVER overwrite a fuller one', () => {
  const stored = { sample_count: 300 };
  const partial = { sampleCount: 40 };
  const verdict = daily.shouldReplace(stored, partial);
  assert.equal(verdict.write, false, 'half a day of buffer must not replace a whole day of row');
  assert.match(verdict.why, /300/, 'and it has to say why, or the refusal is invisible');
});

test('an equal or fuller row is written', () => {
  assert.equal(daily.shouldReplace(null, { sampleCount: 1 }).write, true);
  assert.equal(daily.shouldReplace({ sample_count: 40 }, { sampleCount: 40 }).write, true);
  assert.equal(daily.shouldReplace({ sample_count: 40 }, { sampleCount: 400 }).write, true);
});

// ── sync(), against a real database ──────────────────────────────────────────

test('sync writes one row per machine per day and keeps them apart', () => {
  reset();
  const now = local(2026, 6, 16, 12, 0);
  for (const s of stream(local(2026, 6, 16, 9, 0), 20, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  for (const s of stream(local(2026, 6, 16, 9, 0), 20, 'chrome')) desk.record({ ...s, host: 'DESK' });

  const out = daily.sync({ now });
  assert.equal(out.gaps.length, 0);
  assert.equal(out.written, 2, 'two machines, one day, two rows');

  const rows = daily.getDay('2026-06-16');
  assert.equal(rows.length, 2);
  const laptop = rows.find(r => r.host === 'LAPTOP');
  const deskRow = rows.find(r => r.host === 'DESK');
  assert.equal(laptop.top_app, 'Code');
  assert.equal(deskRow.top_app, 'chrome');
  // ⚠ If the two hosts had shared a ring, each would have swallowed the other's
  // samples mid-run and both run lengths would read short.
  assert.ok(laptop.longest_run_minutes >= 38, `run was ${laptop.longest_run_minutes}`);
  assert.deepEqual(laptop.apps, { Code: laptop.apps.Code });
});

test('today is incomplete and a finished day is complete', () => {
  reset();
  const now = local(2026, 6, 17, 11, 0);
  for (const s of stream(local(2026, 6, 16, 9, 0), 10, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  for (const s of stream(local(2026, 6, 17, 9, 0), 10, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  daily.sync({ now });

  assert.equal(daily.getDay('2026-06-16', 'LAPTOP').complete, true);
  assert.equal(daily.getDay('2026-06-17', 'LAPTOP').complete, false,
    'a day still running must never be averaged in as if it were finished');
});

test('a partial buffer does not clobber a full day already stored', () => {
  reset();
  const now = local(2026, 6, 17, 11, 0);
  for (const s of stream(local(2026, 6, 16, 9, 0), 200, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  daily.sync({ now });
  const full = daily.getDay('2026-06-16', 'LAPTOP');
  assert.equal(full.sample_count, 200);

  // The backend restarts; hours pass; the ring now holds only the tail of that
  // day. This is the ordinary case, not a contrived one.
  //
  // ⚠ Only the BUFFER is cleared here, never the stored row — the stored row is
  // the thing under test.
  db.setState(desk.STATE_KEY, '');
  for (const s of stream(local(2026, 6, 16, 16, 0), 12, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  const out = daily.sync({ now });

  const after = daily.getDay('2026-06-16', 'LAPTOP');
  assert.equal(after.sample_count, 200, 'the fuller row stands');
  assert.equal(after.present_minutes, full.present_minutes);
  assert.equal(out.skipped.length, 1, 'and the refusal is reported, not silent');
  assert.equal(out.skipped[0].day, '2026-06-16');
});

test('an empty buffer reports a GAP rather than a quiet day', () => {
  reset();
  const out = daily.sync({ now: local(2026, 6, 17, 11, 0) });
  assert.equal(out.written, 0);
  assert.equal(out.gaps.length, 1, 'nothing reporting is a fact to state, not zero hours worked');
  assert.match(out.gaps[0].why, /ever reported/);
});

test('sync is idempotent', () => {
  reset();
  const now = local(2026, 6, 17, 11, 0);
  for (const s of stream(local(2026, 6, 17, 9, 0), 30, 'Code')) desk.record({ ...s, host: 'LAPTOP' });
  daily.sync({ now });
  const first = daily.getDay('2026-06-17', 'LAPTOP');
  daily.sync({ now });
  daily.sync({ now });
  const third = daily.getDay('2026-06-17', 'LAPTOP');
  assert.equal(third.present_minutes, first.present_minutes);
  assert.equal(third.sample_count, first.sample_count);
});

test('recentDays bounds DAYS, not rows', () => {
  reset();
  const now = local(2026, 6, 17, 23, 0);
  for (const day of [15, 16, 17]) {
    for (const host of ['LAPTOP', 'DESK']) {
      for (const s of stream(local(2026, 6, day, 9, 0), 6, 'Code')) desk.record({ ...s, host });
    }
  }
  daily.sync({ now, days: 5 });
  const two = daily.recentDays(2);
  const days = [...new Set(two.map(r => r.day))];
  assert.equal(days.length, 2, 'two days asked for, two days returned');
  assert.equal(two.length, 4, 'both machines for each of them — a plain LIMIT would cut this to two rows');
});
