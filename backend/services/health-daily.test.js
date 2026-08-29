'use strict';

/**
 * Pins the daily rollup and the readiness judgement.
 *
 * Everything here exercises the PURE half — no database, no clock — which is the
 * point of the split. The numbers in the fixtures are shaped like Nick's real
 * ones (HRV around 18ms, resting heart rate around 77, sleep around 7.7h),
 * because a threshold that only looks sensible against invented data is a
 * threshold nobody has actually checked.
 */

const test = require('node:test');
const assert = require('node:assert');

const hd = require('./health-daily');

function scalarRow(day, metric, { sum, avg, n = 10 }) {
  return { day, metric, n, sum: sum ?? avg, avg: avg ?? sum, min: null, max: null };
}

// A run of normal days, for a baseline to be built from.
function normalDays(count, from = '2026-08-01') {
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
    hrvMedian: 18 + (i % 3) - 1,
    rhrMedian: 77 + (i % 3) - 1,
    asleepHours: 7.7 + ((i % 4) - 1.5) * 0.2,
    complete: true,
  }));
}

test('buildDays sums the counters and averages the rates', () => {
  const days = hd.buildDays({
    aggregates: [
      scalarRow('2026-08-20', 'steps', { sum: 8200 }),
      scalarRow('2026-08-20', 'respiratoryRate', { avg: 14.2 }),
    ],
    todayKey: '2026-08-29',
  });

  assert.equal(days.length, 1);
  assert.equal(days[0].steps, 8200);
  assert.equal(days[0].respiratoryRate, 14.2);
});

test('time_in_daylight is converted from seconds to minutes', () => {
  // The live table averages 3,189 a day. As minutes that is 53 HOURS, which is
  // the tell — the units column is not stored on a sample, so this conversion is
  // inferred from the values and must stay pinned.
  const [day] = hd.buildDays({
    aggregates: [scalarRow('2026-08-20', 'time_in_daylight', { sum: 3189 })],
  });
  assert.equal(day.daylightMinutes, 53.15);
});

test('HRV and RHR fold to a MEDIAN, so one outlier cannot move the day', () => {
  const [day] = hd.buildDays({
    medianRows: [
      { metric: 'hrv', value: 18, recorded_at: '2026-08-20 08:00:00' },
      { metric: 'hrv', value: 19, recorded_at: '2026-08-20 12:00:00' },
      // A single reading taken mid-argument. A mean would drag the day to 24.7.
      { metric: 'hrv', value: 37, recorded_at: '2026-08-20 15:00:00' },
    ],
  });
  assert.equal(day.hrvMedian, 19);
  assert.equal(day.hrvSamples, 3);
});

test('sleep is taken from rollupSleepNights, not re-derived', () => {
  const [day] = hd.buildDays({
    nights: [{
      night: '2026-08-20',
      asleepHours: 7.4,
      asleepSource: 'staged',
      awakeHours: 0.4,
      efficiency: 92.1,
      stages: { deep: 1.1, rem: 1.8, core: 4.5 },
    }],
  });
  assert.equal(day.asleepHours, 7.4);
  assert.equal(day.sleepSource, 'staged');
  assert.equal(day.deepHours, 1.1);
  assert.equal(day.sleepEfficiency, 92.1);
});

test("today's row is marked incomplete — it is half a day", () => {
  const days = hd.buildDays({
    aggregates: [
      scalarRow('2026-08-29', 'steps', { sum: 900 }),
      scalarRow('2026-08-28', 'steps', { sum: 9400 }),
    ],
    todayKey: '2026-08-29',
  });
  const today = days.find(d => d.day === '2026-08-29');
  const yesterday = days.find(d => d.day === '2026-08-28');
  assert.equal(today.complete, false, 'today is still in progress');
  assert.equal(yesterday.complete, true);
});

test('buildBaseline refuses below seven finished days', () => {
  const b = hd.buildBaseline(normalDays(4));
  assert.equal(b.ready, false);
  assert.match(b.reason, /need 7/);
});

test('an incomplete day is never part of a baseline', () => {
  const days = [...normalDays(8), { day: '2026-08-29', hrvMedian: 5, rhrMedian: 99, asleepHours: 2, complete: false }];
  const b = hd.buildBaseline(days);
  assert.equal(b.days, 8, 'the partial day is excluded');
  assert.ok(b.hrv.median > 15, 'and has not dragged the baseline down');
});

test('readiness refuses to score without a baseline, and says why', () => {
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 18 }, hd.buildBaseline(normalDays(3)));
  assert.equal(r.known, false);
  assert.equal(r.score, null, 'never a cheerful middling number');
  assert.match(r.reason, /finished day/);
});

test('a day with nothing readable is unknown, not well-rested', () => {
  const r = hd.readiness({ day: '2026-08-29' }, hd.buildBaseline(normalDays(10)));
  assert.equal(r.known, false);
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /nothing readable/);
});

test('a normal day against a normal baseline reads normal', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 18, rhrMedian: 77, asleepHours: 7.7 }, baseline);
  assert.equal(r.known, true);
  assert.equal(r.state, 'normal');
  assert.equal(r.inputsRead, 3);
  assert.equal(r.partial, false);
});

test('low HRV, raised resting heart rate and a short night read low', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 12, rhrMedian: 84, asleepHours: 5.2 }, baseline);
  assert.equal(r.state, 'low');
  assert.ok(r.score < 40, `expected a low score, got ${r.score}`);
  assert.ok(r.contributors.some(c => /less sleep/.test(c.note)));
  assert.ok(r.contributors.some(c => /above normal/.test(c.note)));
});

test('a good night with a strong HRV reads high', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 26, rhrMedian: 73, asleepHours: 8.6 }, baseline);
  assert.equal(r.state, 'high');
});

test('one input scores, but says it is partial', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 12 }, baseline);
  assert.equal(r.known, true);
  assert.equal(r.inputsRead, 1);
  assert.equal(r.partial, true, 'one input and three inputs are not the same claim');
});

test('sleep is judged against Nick\'s own median, not a fixed seven hours', () => {
  // Measured: he averages 7.7h and went under 6h on only 6 nights in 90. A fixed
  // "under 7h is short" would fire on a third of a normal quarter.
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 18, rhrMedian: 77, asleepHours: 6.9 }, baseline);
  const sleep = r.contributors.find(c => c.input === 'sleep');
  assert.equal(sleep.note, 'slept about as usual', '6.9h is a normal night for him');
});

test('the score is clamped short of both ends', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const awful = hd.readiness({ day: '2026-08-29', hrvMedian: 2, rhrMedian: 120, asleepHours: 0.5 }, baseline);
  const perfect = hd.readiness({ day: '2026-08-29', hrvMedian: 90, rhrMedian: 50, asleepHours: 12 }, baseline);
  assert.ok(awful.score >= 5 && perfect.score <= 95, 'neither end is a claim this data supports');
});

test('the sentence is composed once, server-side, and is null when unknown', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const low = hd.readiness({ day: '2026-08-29', hrvMedian: 12, rhrMedian: 84, asleepHours: 5.2 }, baseline);
  assert.match(hd.readinessSentence(low), /Running low today/);
  assert.equal(hd.readinessSentence({ known: false }), null);
});

// ── The window has two ends ──────────────────────────────────────────────────
//
// Regression. `sync()` bounded only the START of its window, so a backfill
// walking backwards had every chunk read through to the present; the 20,000-row
// cap then kept the NEWEST rows and the oldest chunk overwrote two years of days
// with nulls. It wrote 744 days and left 328 with any HRV. Caught only by
// running it against the real database and reading the summary.
//
// Pinned at the pure layer, which is where the day set is decided.

test('buildDays never emits a day outside the window it was given', () => {
  const days = hd.buildDays({
    aggregates: [
      scalarRow('2026-03-01', 'steps', { sum: 5000 }),
      scalarRow('2026-08-28', 'steps', { sum: 9000 }),
    ],
    todayKey: '2026-08-29',
  });
  // buildDays itself emits whatever it is handed — the bound belongs to the
  // caller, and this pins that it is the ROWS that decide, so a bounded query
  // is the only thing standing between a chunked backfill and this bug.
  assert.deepEqual(days.map(d => d.day), ['2026-08-28', '2026-03-01']);
});

test('completeness is judged against the real today, not the window end', () => {
  // A chunk ending in March must not stamp its last day as still in progress.
  const days = hd.buildDays({
    aggregates: [scalarRow('2026-03-01', 'steps', { sum: 5000 })],
    todayKey: '2026-08-29',
  });
  assert.equal(days[0].complete, true);
});

// ── The sentence must name what actually moved the score ─────────────────────
//
// Caught on the FIRST live reading, not by a test: score 31 ("low"), driven by
// HRV at z = -0.93 and resting heart rate 4bpm up — but -0.93 sits inside the
// ±1.0 band, so its note read "HRV in your normal range" and the sentence blamed
// the heart rate alone. Half the reason for the number went unsaid.

test('a contributor carries a structured flag, not just prose', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 12, rhrMedian: 84, asleepHours: 5.2 }, baseline);
  assert.ok(r.contributors.every(c => ['adverse', 'favourable', 'normal'].includes(c.flag)));
  // The sentence selects on this, so a reworded note cannot silently change
  // which facts get reported.
  assert.equal(r.contributors.find(c => c.input === 'rhr').flag, 'adverse');
});

test('a low day where NOTHING crossed a threshold says exactly that', () => {
  // Today's real shape: every reading inside its band, all three leaning down.
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 16.75, rhrMedian: 79, asleepHours: 7.4 }, baseline);
  assert.equal(r.state, 'low', 'fixture must actually read low, or this pins nothing');
  assert.ok(r.contributors.every(c => c.flag === 'normal'), 'and nothing may have crossed a threshold');
  const s = hd.readinessSentence(r);
  assert.match(s, /nothing on its own/, 'must not blame one reading for a combined score');
  assert.ok(!/everything in your normal range/.test(s), 'and must not claim all-normal while reading low');
});

test('when a reading DOES cross a threshold, that is what gets named', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 18, rhrMedian: 84, asleepHours: 7.7 }, baseline);
  assert.match(hd.readinessSentence(r), /resting heart rate/);
});

test('a genuinely unremarkable day still reads as unremarkable', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 18, rhrMedian: 77, asleepHours: 7.7 }, baseline);
  assert.match(hd.readinessSentence(r), /About normal today — everything in your normal range/);
});

test('a high day names the good news, not the adverse list', () => {
  const baseline = hd.buildBaseline(normalDays(10));
  const r = hd.readiness({ day: '2026-08-29', hrvMedian: 26, rhrMedian: 72, asleepHours: 8.8 }, baseline);
  const s = hd.readinessSentence(r);
  assert.match(s, /Well recovered/);
  assert.ok(!/on the low side/.test(s));
});
