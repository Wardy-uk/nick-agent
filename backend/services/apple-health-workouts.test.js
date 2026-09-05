'use strict';

/**
 * Workouts — the record-shaped section that retires Strava.
 *
 * ⚠ WRITTEN WITHOUT A REAL HEALTH AUTO EXPORT WORKOUT PAYLOAD. The section has
 * always been counted and discarded, so no captured example exists anywhere in
 * this repo. These tests pin the spellings the parser was TAUGHT and — more
 * importantly — that an unrecognised field is reported rather than swallowed.
 * When the first live payload arrives, `unknownWorkoutFields` in the ingest
 * response is what says which of these guesses was wrong.
 *
 * The parser is pure, so all of this holds without a DB, a network or a phone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ah = require('./apple-health');

function parse(workouts) {
  const out = { samples: [], received: 0, rejected: [], ignoredCategory: 0, unstored: {}, excluded: {},
    workouts: [], workoutsReceived: 0, unknownWorkoutFields: {} };
  ah.parseWorkouts(workouts, out);
  return out;
}

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
  maxHeartRate: { qty: 178, units: 'bpm' },
};

test('a workout carries every field Strava was being paid for', () => {
  // strava.formatActivity() reads exactly these: type, distance, duration,
  // elevation, average heart rate.
  const out = parse([RUN]);
  assert.equal(out.workoutsReceived, 1);
  assert.equal(out.workouts.length, 1);
  const w = out.workouts[0];
  assert.equal(w.activityType, 'Outdoor Run');
  assert.equal(w.startedAt, '2026-08-16 06:00:00');   // +0100 normalised to UTC
  assert.equal(w.durationSeconds, 2700);
  assert.equal(w.distanceM, 8200);                    // km -> m
  assert.equal(w.activeEnergyKcal, 520);
  assert.equal(w.elevationM, 120);
  assert.equal(w.avgHeartRate, 152);
  assert.equal(w.maxHeartRate, 178);
  assert.equal(w.sourceUuid, 'uuid-run-1');
});

test('distance units are converted, and an unknown one is REFUSED', () => {
  // Storing 5 for a 5km run is not a small error, it is a different fact.
  assert.equal(parse([{ ...RUN, distance: { qty: 5, units: 'km' } }]).workouts[0].distanceM, 5000);
  assert.equal(parse([{ ...RUN, distance: { qty: 1, units: 'mi' } }]).workouts[0].distanceM, 1609.344);
  assert.equal(parse([{ ...RUN, distance: { qty: 400, units: 'm' } }]).workouts[0].distanceM, 400);

  const bad = parse([{ ...RUN, distance: { qty: 5, units: 'furlongs' } }]);
  assert.equal(bad.workouts.length, 0);               // refused whole...
  assert.equal(bad.workoutsReceived, 1);              // ...but counted, never silent
  assert.match(bad.rejected[0].reason, /unexpected units/);
});

test('energy in kJ becomes kcal rather than a number four times too big', () => {
  const kj = parse([{ ...RUN, activeEnergyBurned: { qty: 1000, units: 'kJ' } }]);
  assert.equal(Math.round(kj.workouts[0].activeEnergyKcal), 239);
  // Paired positive: kcal passes through untouched.
  assert.equal(parse([{ ...RUN, activeEnergyBurned: { qty: 239, units: 'kcal' } }]).workouts[0].activeEnergyKcal, 239);
});

test('a bare number is taken in the stored unit', () => {
  // Some exporters send a plain number. Documented assumption, not a guess
  // buried in the code — which is why an OBJECT with a bad unit still refuses.
  const w = parse([{ ...RUN, distance: 8200, activeEnergyBurned: 520 }]).workouts[0];
  assert.equal(w.distanceM, 8200);
  assert.equal(w.activeEnergyKcal, 520);
});

test('duration is derived from the span when absent, and never zero', () => {
  const derived = parse([{ ...RUN, duration: undefined }]).workouts[0];
  assert.equal(derived.durationSeconds, 2700);        // 07:00 -> 07:45
  // With neither a duration nor an end, it is null — NOT 0, which would render
  // as an instantaneous workout.
  const neither = parse([{ ...RUN, duration: undefined, end: undefined }]).workouts[0];
  assert.equal(neither.durationSeconds, null);
  assert.notEqual(neither.durationSeconds, 0);
});

test('a workout with no parseable start is refused, not stamped with now', () => {
  // A run whose time is "whenever the phone got signal" is not a record of a run.
  const out = parse([{ ...RUN, start: 'sometime tuesday' }]);
  assert.equal(out.workouts.length, 0);
  assert.match(out.rejected[0].reason, /unparseable workout start/);
  // Paired positive: the same workout with a good start is kept.
  assert.equal(parse([RUN]).workouts.length, 1);
});

test('a workout with no activity type is refused', () => {
  const out = parse([{ ...RUN, name: undefined }]);
  assert.equal(out.workouts.length, 0);
  assert.match(out.rejected[0].reason, /no activity type/);
  // Paired positive: the alternative spellings are understood.
  assert.equal(parse([{ ...RUN, name: undefined, workoutActivityType: 'Cycling' }]).workouts[0].activityType, 'Cycling');
  assert.equal(parse([{ ...RUN, name: undefined, type: 'Yoga' }]).workouts[0].activityType, 'Yoga');
});

test('an optional measurement that is simply absent is null, not a refusal', () => {
  // A treadmill run has no elevation and a yoga session has no distance. Absent
  // is a legitimate answer; only a PRESENT-and-malformed value is refused.
  const w = parse([{ id: 'u', name: 'Yoga', start: RUN.start, end: RUN.end }]).workouts[0];
  assert.equal(w.distanceM, null);
  assert.equal(w.elevationM, null);
  assert.equal(w.avgHeartRate, null);
  assert.equal(w.activityType, 'Yoga');   // paired positive: it still parsed
});

test('an unrecognised field is KEPT and COUNTED, never dropped', () => {
  // The whole safety net for a parser written blind. If HAE calls it
  // `totalDistance` and we guessed `distance`, this is what says so.
  const out = parse([{ ...RUN, temperature: { qty: 14, units: 'degC' }, humidity: 72 }]);
  const w = out.workouts[0];
  assert.equal(w.payload.temperature.qty, 14);
  assert.equal(w.payload.humidity, 72);
  assert.equal(out.unknownWorkoutFields.temperature, 1);
  assert.equal(out.unknownWorkoutFields.humidity, 1);
  // Paired negative: a field we DO understand never leaks into payload, or it
  // would be stored twice and read from the wrong place.
  assert.equal(w.payload.distance, undefined);
  assert.equal(out.unknownWorkoutFields.distance, undefined);
});

test('one bad workout does not lose the good ones beside it', () => {
  const out = parse([RUN, { ...RUN, id: 'u2', start: 'nonsense' }, { ...RUN, id: 'u3', name: 'Walk' }]);
  assert.equal(out.workoutsReceived, 3);
  assert.equal(out.workouts.length, 2);
  assert.equal(out.rejected.length, 1);
  assert.deepEqual(out.workouts.map((w) => w.activityType), ['Outdoor Run', 'Walk']);
});

test('workouts go to their own table rather than the document store', () => {
  // Workouts left UNSTORED_SECTIONS first, on the strength of having a consumer
  // already waiting (Strava). The other six followed later the same day when
  // Nick asked for all health data, but to `health_records` as documents — so
  // the list is now empty and a workout must NOT be swept up as a document.
  assert.deepEqual(ah.UNSTORED_SECTIONS, []);
  assert.equal(Object.keys(ah.RECORD_SECTIONS).includes('workouts'), false);

  const r = ah.parsePayload({ data: { workouts: [RUN] } });
  assert.equal(r.workouts.length, 1);
  assert.equal(r.records.length, 0);            // paired negative: not double-stored
});

test('parsePayload threads workouts through with the metrics', () => {
  const r = ah.parsePayload({ data: {
    metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-08-16 09:00:00 +0100', qty: 900 }] }],
    workouts: [RUN],
    ecg_recordings: [{ id: 'e1' }, { id: 'e2' }],
  } });
  assert.equal(r.ok, true);
  assert.equal(r.samples.length, 1);            // metrics still parse
  assert.equal(r.workouts.length, 1);           // workouts take the table route
  assert.equal(r.workoutsReceived, 1);
  assert.equal(r.records.length, 2);            // ECG takes the document route
  assert.deepEqual(r.unstored, {});             // and nothing is discarded
});
