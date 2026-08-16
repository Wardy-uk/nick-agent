'use strict';

/**
 * #40 — the Apple Health wire contract.
 *
 * Everything asserted here was read out of the FreeReps iOS app's source, so
 * these tests are the record of what the phone actually sends. The parser is
 * pure, so the contract pins without a DB, a network or a phone.
 */

const test = require('node:test');
const assert = require('node:assert');
const ah = require('../services/apple-health');

test('the wire date format parses to UTC without leaning on Date()', () => {
  // FreeReps' HealthTimeLayout: "2006-01-02 15:04:05 -0700".
  assert.equal(ah.parseHealthDate('2026-08-16 07:12:33 +0100'), '2026-08-16 06:12:33');
  assert.equal(ah.parseHealthDate('2025-12-25 23:59:59 -0500'), '2025-12-26 04:59:59');
  assert.equal(ah.parseHealthDate('2026-08-16 07:12:33 +0000'), '2026-08-16 07:12:33');
  // Half-hour offsets are a real timezone, not a typo.
  assert.equal(ah.parseHealthDate('2026-08-16 07:12:33 +0530'), '2026-08-16 01:42:33');
  // No zone: treated as UTC rather than guessing the host's. The Pi may run UTC
  // while the phone is on BST, and a guess is how a reading lands an hour out.
  assert.equal(ah.parseHealthDate('2026-08-16 07:12:33'), '2026-08-16 07:12:33');
  assert.equal(ah.parseHealthDate('nonsense'), null);
  assert.equal(ah.parseHealthDate(null), null);
});

test('the six metrics NEURO already reads keep their existing names', () => {
  // stress-score queries 'hrv' and 'heartRate'; routes/health.js lists all six.
  // Storing them under the HAE spelling would empty the baseline silently.
  assert.equal(ah.metricName('heart_rate_variability'), 'hrv');
  assert.equal(ah.metricName('resting_heart_rate'), 'rhr');
  assert.equal(ah.metricName('heart_rate'), 'heartRate');
  assert.equal(ah.metricName('step_count'), 'steps');
  assert.equal(ah.metricName('active_energy'), 'activeEnergy');
  assert.equal(ah.metricName('respiratory_rate'), 'respiratoryRate');
});

test('every other metric keeps its HAE name verbatim — no allowlist', () => {
  // Nick asked for everything the app offers. An allowlist would have to be
  // maintained forever and is wrong the moment Apple adds a type.
  for (const name of ['vo2_max', 'blood_oxygen_saturation', 'apple_sleeping_wrist_temperature',
    'body_fat_percentage', 'dietary_caffeine', 'walking_heart_rate_average',
    'heart_rate_recovery_one_minute', 'time_in_daylight']) {
    assert.equal(ah.metricName(name), name);
  }
});

test('an aggregated point uses Avg, never the encoder-defaulted qty', () => {
  // The Swift encoder defaults `qty` to 0, and heart rate arrives as Min/Avg/Max.
  // Reading qty blindly stores a genuine-looking zero heart rate.
  assert.equal(ah.pointValue({ qty: 0, Min: 58, Avg: 72, Max: 96 }), 72);
  assert.equal(ah.pointValue({ qty: 8421 }), 8421);
  assert.equal(ah.pointValue({ qty: 0 }), 0, 'a real zero step count is still a value');
  assert.equal(ah.pointValue({}), null);
  assert.equal(ah.pointValue(null), null);
});

test('HRV units are enforced, because a silent rescale would not error anywhere', () => {
  // HealthKit stores SDNN in seconds; the app converts to ms. If that ever
  // changed, a 14-day baseline would quietly rebase and the score would look
  // plausible and be wrong.
  assert.deepEqual(ah.convertUnits('hrv', 45, 'ms'), { ok: true, value: 45 });
  assert.deepEqual(ah.convertUnits('hrv', 0.045, 's'), { ok: true, value: 45 });
  assert.equal(ah.convertUnits('hrv', 45, 'furlongs').ok, false);
  // Metrics nothing interprets pass through unchecked — we do not pretend to
  // know what the right unit for dietary_molybdenum is.
  assert.deepEqual(ah.convertUnits('dietary_molybdenum', 12, 'mcg'), { ok: true, value: 12 });
});

test('a realistic payload parses, and a bad point is rejected rather than dropped', () => {
  const out = ah.parsePayload({
    data: {
      metrics: [
        {
          name: 'heart_rate_variability',
          units: 'ms',
          data: [
            { date: '2026-08-16 03:14:00 +0100', qty: 47.2, source_uuid: 'uuid-hrv-1' },
            { date: 'not a date', qty: 50, source_uuid: 'uuid-hrv-bad' },
          ],
        },
        {
          name: 'heart_rate',
          units: 'bpm',
          data: [{ date: '2026-08-16 07:00:00 +0100', qty: 0, Min: 55, Avg: 68, Max: 91, source_uuid: 'uuid-hr-1' }],
        },
        {
          name: 'vo2_max',
          units: 'mL/min·kg',
          data: [{ date: '2026-08-15 18:00:00 +0100', qty: 41.3, source_uuid: 'uuid-vo2' }],
        },
      ],
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.received, 4);
  assert.equal(out.samples.length, 3);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /unparseable date/);

  const hrv = out.samples.find(s => s.metric === 'hrv');
  assert.equal(hrv.value, 47.2);
  assert.equal(hrv.recordedAt, '2026-08-16 02:14:00', 'stored in UTC');
  assert.equal(hrv.sourceUuid, 'uuid-hrv-1');

  assert.equal(out.samples.find(s => s.metric === 'heartRate').value, 68);
  assert.equal(out.samples.find(s => s.metric === 'vo2_max').value, 41.3);
});

test('sleep becomes per-segment hours, stamped at the segment start', () => {
  const out = ah.parsePayload({
    data: {
      category_samples: [
        {
          id: 'uuid-sleep-1', type: 'HKCategoryTypeIdentifierSleepAnalysis',
          value: 3, value_label: 'Deep',
          start_date: '2026-08-16 01:00:00 +0100', end_date: '2026-08-16 02:30:00 +0100',
        },
        {
          id: 'uuid-sleep-2', type: 'HKCategoryTypeIdentifierSleepAnalysis',
          value: 5, value_label: 'REM',
          start_date: '2026-08-16 02:30:00 +0100', end_date: '2026-08-16 03:00:00 +0100',
        },
        // Not sleep — counted, deliberately not stored as a fake scalar.
        {
          id: 'uuid-hand', type: 'HKCategoryTypeIdentifierHandwashingEvent',
          value: 1, start_date: '2026-08-16 08:00:00 +0100', end_date: '2026-08-16 08:00:20 +0100',
        },
      ],
    },
  });

  const deep = out.samples.find(s => s.metric === 'sleep_deep_hours');
  assert.equal(deep.value, 1.5);
  assert.equal(deep.recordedAt, '2026-08-16 00:00:00');
  assert.equal(deep.sourceUuid, 'uuid-sleep-1');
  assert.equal(out.samples.find(s => s.metric === 'sleep_rem_hours').value, 0.5);
  assert.equal(out.ignoredCategory, 1);
  assert.equal(out.samples.length, 2);
});

test('record-shaped sections are reported as not stored, never silently discarded', () => {
  const out = ah.parsePayload({
    data: {
      metrics: [],
      workouts: [{ id: 'w1' }, { id: 'w2' }],
      ecg_recordings: [{ id: 'e1' }],
      state_of_mind: [],
    },
  });
  // They do not fit health_samples(metric, value, recorded_at), so they are
  // counted and named. Accepting a payload and quietly binning half of it is the
  // failure mode this codebase keeps finding.
  assert.deepEqual(out.unstored, { workouts: 2, ecg_recordings: 1 });
  assert.equal(out.samples.length, 0);
});

test('APPLE_HEALTH_EXCLUDE drops a metric by either spelling, and says it did', () => {
  const prev = process.env.APPLE_HEALTH_EXCLUDE;
  // Written in HAE names, but six metrics are STORED under a NEURO name — so
  // matching one spelling only would silently miss them.
  process.env.APPLE_HEALTH_EXCLUDE = 'physical_effort, step_count';
  try {
    const out = ah.parsePayload({
      data: {
        metrics: [
          { name: 'physical_effort', units: 'kcal/hr·kg', data: [{ date: '2026-08-16 09:00:00 +0100', qty: 3 }] },
          { name: 'step_count', units: 'count', data: [{ date: '2026-08-16 09:00:00 +0100', qty: 812 }] },
          { name: 'vo2_max', units: 'mL/min·kg', data: [{ date: '2026-08-16 09:00:00 +0100', qty: 41 }] },
        ],
      },
    });
    assert.equal(out.samples.length, 1, 'only vo2_max survives');
    assert.equal(out.samples[0].metric, 'vo2_max');
    // Counted and named, never silently dropped.
    assert.deepEqual(out.excluded, { physical_effort: 1, steps: 1 });
  } finally {
    if (prev === undefined) delete process.env.APPLE_HEALTH_EXCLUDE;
    else process.env.APPLE_HEALTH_EXCLUDE = prev;
  }
});

test('nothing is excluded by default — Nick asked for everything the app offers', () => {
  const prev = process.env.APPLE_HEALTH_EXCLUDE;
  delete process.env.APPLE_HEALTH_EXCLUDE;
  try {
    const out = ah.parsePayload({
      data: { metrics: [{ name: 'physical_effort', units: 'x', data: [{ date: '2026-08-16 09:00:00 +0100', qty: 3 }] }] },
    });
    assert.equal(out.samples.length, 1);
    assert.deepEqual(out.excluded, {});
  } finally {
    if (prev !== undefined) process.env.APPLE_HEALTH_EXCLUDE = prev;
  }
});

test('a night is the one you WAKE on, so evening and small-hours segments merge', () => {
  // 23:30 BST (22:30 UTC) on the 15th and 03:00 BST (02:00 UTC) on the 16th are
  // the same night, and both belong to the 16th.
  assert.equal(ah.nightKey('2026-08-15 22:30:00'), '2026-08-16');
  assert.equal(ah.nightKey('2026-08-16 02:00:00'), '2026-08-16');
  assert.equal(ah.nightKey('2026-08-16 06:00:00'), '2026-08-16');
  // Known wart, asserted so it is a decision and not a surprise: an afternoon
  // nap lands on the following night.
  assert.equal(ah.nightKey('2026-08-16 13:00:00'), '2026-08-17');
});

test('sleep segments roll up into nights with stages and efficiency', () => {
  const nights = ah.rollupSleepNights([
    { metric: 'sleep_core_hours', value: 3.5, recorded_at: '2026-08-15 22:30:00' },
    { metric: 'sleep_deep_hours', value: 1.2, recorded_at: '2026-08-16 02:00:00' },
    { metric: 'sleep_rem_hours', value: 1.3, recorded_at: '2026-08-16 04:00:00' },
    { metric: 'sleep_awake_hours', value: 0.4, recorded_at: '2026-08-16 03:00:00' },
    { metric: 'sleep_in_bed_hours', value: 7.0, recorded_at: '2026-08-15 22:15:00' },
    // A different night entirely.
    { metric: 'sleep_core_hours', value: 5.0, recorded_at: '2026-08-16 23:00:00' },
  ]);

  assert.equal(nights.length, 2);
  assert.equal(nights[0].night, '2026-08-17', 'newest first');

  const night = nights.find(n => n.night === '2026-08-16');
  assert.equal(night.asleepHours, 6, 'core + deep + rem, awake and in-bed excluded');
  assert.equal(night.awakeHours, 0.4);
  assert.equal(night.inBedHours, 7);
  assert.equal(night.efficiency, 85.7);
  assert.equal(night.segments, 5);
  assert.equal(night.stages.deep, 1.2);
});

test('efficiency is null without In Bed data, never a confident 100%', () => {
  const [night] = ah.rollupSleepNights([
    { metric: 'sleep_core_hours', value: 6, recorded_at: '2026-08-15 23:00:00' },
  ]);
  assert.equal(night.asleepHours, 6);
  assert.equal(night.efficiency, null);
});

test('a malformed payload is refused rather than counted as an empty success', () => {
  assert.equal(ah.parsePayload({}).ok, false);
  assert.equal(ah.parsePayload(null).ok, false);
  assert.equal(ah.parsePayload({ data: 'nope' }).ok, false);
  // Well-formed but empty is a legitimate no-op, not an error.
  const empty = ah.parsePayload({ data: { metrics: [] } });
  assert.equal(empty.ok, true);
  assert.equal(empty.samples.length, 0);
});
