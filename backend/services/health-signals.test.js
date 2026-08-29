'use strict';

/**
 * Pins the trend rules and, more importantly, the refusals.
 *
 * The negative tests are the point. Every threshold here was set against Nick's
 * measured 90-day range, and the failure mode of a health alert is not missing
 * one — it is firing on a normal week until he stops reading them, which also
 * costs him the real one.
 */

const test = require('node:test');
const assert = require('node:assert');

const signals = require('./health-signals');

const NOW = new Date('2026-08-29T09:00:00Z');

// A run of ordinary days shaped like his real ones, newest first.
function normal(count = 20, over = {}) {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(NOW.getTime() - (i + 1) * 86400000).toISOString().slice(0, 10),
    hrvMedian: 18 + (i % 3) - 1,
    rhrMedian: 77 + (i % 3) - 1,
    asleepHours: 7.7 + ((i % 4) - 1.5) * 0.2,
    wristTemp: 34.2 + ((i % 3) - 1) * 0.05,
    complete: true,
    ...over,
  }));
}

/** Overwrite the newest `n` days. */
function withRecent(days, n, patch) {
  return days.map((d, i) => (i < n ? { ...d, ...patch } : d));
}

test('a normal fortnight raises nothing', () => {
  const r = signals.assess({ days: normal(20), metrics: [], now: NOW });
  assert.deepEqual(r.findings, []);
  assert.equal(r.allClear, true);
});

test('resting heart rate up for three days is a finding, and says what it cannot tell apart', () => {
  const days = withRecent(normal(20), 3, { rhrMedian: 82 });
  const r = signals.assess({ days, metrics: [], now: NOW });
  const f = r.findings.find(x => x.id === 'rhr-elevated');
  assert.ok(f, 'expected the elevated-RHR finding');
  assert.match(f.caveat, /cannot tell those apart/);
  assert.equal(f.evidence.length, 3, 'every finding names its evidence');
});

test('two days up is NOT a finding — one bad night is not a trend', () => {
  const days = withRecent(normal(20), 2, { rhrMedian: 82 });
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.equal(r.findings.find(x => x.id === 'rhr-elevated'), undefined);
});

test('a missing resting heart rate is an unknown, never an all-clear', () => {
  const days = withRecent(normal(20), 3, { rhrMedian: null });
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.equal(r.findings.length, 0);
  assert.ok(r.unknowns.some(u => u.input === 'rhr'), 'must say it could not look');
  assert.equal(r.allClear, false, 'unknowns mean this is not an all-clear');
});

test('raised wrist temperature two nights running is a finding', () => {
  const days = withRecent(normal(20), 2, { wristTemp: 35.0 });
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.ok(r.findings.find(x => x.id === 'wrist-temp-up'));
});

test('HRV below range for three days is a finding', () => {
  const days = withRecent(normal(20), 3, { hrvMedian: 12 });
  const r = signals.assess({ days, metrics: [], now: NOW });
  const f = r.findings.find(x => x.id === 'hrv-suppressed');
  assert.ok(f);
  assert.ok(f.evidence.every(e => e.z <= -1), 'evidence carries the z-score it fired on');
});

test('a week of short nights becomes sleep debt', () => {
  const days = withRecent(normal(20), 7, { asleepHours: 6.5 });
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.ok(r.findings.find(x => x.id === 'sleep-debt'));
});

test('his ACTUAL sleep spread does not fire the debt rule', () => {
  // Measured: 7.7h mean, 5.1–9.7h range, 6 nights under six in 90. A rule that
  // fires on this shape is a rule he learns to ignore.
  const spread = [7.9, 7.2, 8.4, 6.8, 7.7, 8.1, 7.4];
  const days = normal(20).map((d, i) => (i < 7 ? { ...d, asleepHours: spread[i] } : d));
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.equal(r.findings.find(x => x.id === 'sleep-debt'), undefined);
});

test('today is excluded — half a day is not a short night', () => {
  const days = [
    { day: '2026-08-29', asleepHours: 0, rhrMedian: 95, hrvMedian: 6, complete: false },
    ...normal(20),
  ];
  const r = signals.assess({ days, metrics: [], now: NOW });
  assert.deepEqual(r.findings, [], 'an in-progress day must not trigger anything');
});

test('no baseline means no trend claims, and it says so', () => {
  const r = signals.assess({ days: normal(3), metrics: [], now: NOW });
  assert.ok(r.unknowns.some(u => u.input === 'baseline'));
  assert.equal(r.allClear, false);
});

// ── Sensors that stopped ────────────────────────────────────────────────────

test('a monitor that stopped months ago is a finding', () => {
  // The real case: blood pressure ran from Aug 2024 to 1 Apr 2026 and stopped.
  const quiet = signals.sensorsQuiet([{
    metric: 'blood_pressure_systolic', samples: 10389,
    first_at: '2024-08-16 17:13:00', last_at: '2026-04-01 11:00:00',
  }], NOW);
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].level, 'warn');
  assert.match(quiet[0].detail, /150 days ago/);
});

test('a metric still arriving is not quiet', () => {
  const quiet = signals.sensorsQuiet([{
    metric: 'hrv', samples: 43334,
    first_at: '2024-08-16 17:18:35', last_at: '2026-08-29 07:36:15',
  }], NOW);
  assert.deepEqual(quiet, []);
});

test('a naturally occasional metric is info, not a warning', () => {
  const quiet = signals.sensorsQuiet([{
    metric: 'weight_body_mass', samples: 452,
    first_at: '2024-08-17 09:24:00', last_at: '2026-08-07 08:23:05',
  }], NOW);
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].level, 'info', 'not weighing yourself is not a broken sensor');
});

test('a metric with too little history is never called quiet', () => {
  const quiet = signals.sensorsQuiet([{
    metric: 'waist_circumference', samples: 3,
    first_at: '2026-01-01 10:11:00', last_at: '2026-02-10 06:40:00',
  }], NOW);
  assert.deepEqual(quiet, [], 'three readings is an experiment, not a cadence');
});

test('a chatty metric is not called quiet after one afternoon', () => {
  // heartRate arrives every couple of minutes; 8x its own gap is minutes, so the
  // 14-day floor is what stops this being absurd.
  const quiet = signals.sensorsQuiet([{
    metric: 'heartRate', samples: 483769,
    first_at: '2024-08-16 16:40:31', last_at: '2026-08-28 07:46:20',
  }], NOW);
  assert.deepEqual(quiet, [], 'a day of silence on a two-minute metric is not news');
});

test('warnings rank above information', () => {
  const r = signals.assess({
    days: withRecent(normal(20), 3, { rhrMedian: 82 }),
    metrics: [{ metric: 'weight_body_mass', samples: 452, first_at: '2024-08-17 09:24:00', last_at: '2026-08-07 08:23:05' }],
    now: NOW,
  });
  assert.equal(r.findings[0].level, 'warn');
  assert.equal(r.findings[r.findings.length - 1].level, 'info');
});
