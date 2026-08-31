// Room inference by fingerprint. Pure, so it pins without sensors or a house.
//
// The tests that matter are the refusals: an uncalibrated room must never be
// answered with the least-bad guess, because this feeds automation.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildProfile, classify } = require('../src/presence/fingerprint');

// Modelled on the real readings from 31 Aug 2026. Note the awkward part: with
// Nick in the LIVING ROOM the kitchen sensor reads LOUDER (-73 vs -68 is close,
// and it reached -64 vs -73). That is the observation that broke "loudest wins"
// and it is exactly what a fingerprint absorbs.
function samples(spec, n = 12) {
  return Array.from({ length: n }, (_, i) => {
    const out = {};
    for (const [sensor, [rssi, rate]] of Object.entries(spec)) {
      // A little jitter, deterministic so the tests do not flake.
      const wobble = ((i % 5) - 2);
      out[sensor] = { rssi: rssi + wobble, rate: rate + wobble * 0.05 };
    }
    return out;
  });
}

const LIVING = buildProfile('living-room', samples({
  'living-room': [-68, 2.3], kitchen: [-70, 1.6], bedroom: [-88, 0.2],
}));
const KITCHEN = buildProfile('kitchen', samples({
  'living-room': [-82, 0.7], kitchen: [-58, 2.6], bedroom: [-86, 0.2],
}));
const BEDROOM = buildProfile('bedroom', samples({
  'living-room': [-89, 0.2], kitchen: [-84, 0.3], bedroom: [-60, 2.4],
}));
const PROFILES = { 'living-room': LIVING, kitchen: KITCHEN, bedroom: BEDROOM };

test('a profile records every sensor, not just the room it is named for', () => {
  assert.deepEqual(Object.keys(LIVING.sensors).sort(), ['bedroom', 'kitchen', 'living-room']);
  assert.equal(LIVING.samples, 12);
  assert.ok(LIVING.sensors.kitchen.rssi.mean < -60, 'the kitchen reading is part of the living room fingerprint');
});

test('the living room is recognised even though the kitchen hears him louder', () => {
  // The exact shape that defeated "loudest wins": kitchen -64 beats living -73.
  const r = classify({
    'living-room': { rssi: -73, rate: 2.1 },
    kitchen: { rssi: -64, rate: 2.05 },
    bedroom: { rssi: -88, rate: 0.17 },
  }, PROFILES);
  assert.equal(r.room, 'living-room');
  assert.notEqual(r.confidence, 'none');
});

test('the kitchen is recognised when he is actually in it', () => {
  const r = classify({
    'living-room': { rssi: -83, rate: 0.6 },
    kitchen: { rssi: -57, rate: 2.7 },
    bedroom: { rssi: -85, rate: 0.2 },
  }, PROFILES);
  assert.equal(r.room, 'kitchen');
  assert.equal(r.confidence, 'sure');
});

test('the bedroom is recognised when he is actually in it', () => {
  const r = classify({
    'living-room': { rssi: -90, rate: 0.15 },
    kitchen: { rssi: -85, rate: 0.25 },
    bedroom: { rssi: -61, rate: 2.3 },
  }, PROFILES);
  assert.equal(r.room, 'bedroom');
});

// ⚠ The refusal that matters most: this drives automation.
test('an uncalibrated room is `unknown`, NEVER the least-bad match', () => {
  const r = classify({
    'living-room': { rssi: -95, rate: 0.05 },
    kitchen: { rssi: -97, rate: 0.02 },
    bedroom: { rssi: -96, rate: 0.03 },
  }, PROFILES);
  assert.equal(r.room, null);
  assert.equal(r.confidence, 'none');
  assert.match(r.why, /no sensor|nothing matches/);
});

test('a close call is reported as unsure, with the rival named', () => {
  const between = classify({
    'living-room': { rssi: -75, rate: 1.5 },
    kitchen: { rssi: -70, rate: 1.5 },
    bedroom: { rssi: -87, rate: 0.2 },
  }, PROFILES, { minMargin: 5 });   // forced, to pin the shape of the answer
  assert.equal(between.confidence, 'unsure');
  assert.ok(between.why.includes('close'));
});

test('with no profiles at all there is no answer, and it says so', () => {
  const r = classify({ 'living-room': { rssi: -68, rate: 2.3 } }, {});
  assert.equal(r.room, null);
  assert.equal(r.confidence, 'none');
  assert.match(r.why, /calibrated/);
});

test('with no readings there is no answer', () => {
  assert.equal(classify({}, PROFILES).room, null);
});

test('a profile sharing no sensor with the reading is skipped, not scored badly', () => {
  const study = buildProfile('study', samples({ study: [-60, 2.4] }));
  const r = classify({ 'living-room': { rssi: -68, rate: 2.3 } },
    { study, 'living-room': LIVING });
  assert.equal(r.room, 'living-room');
  assert.ok(!r.scores.some(s => s.room === 'study'),
    'an unscoreable room must not appear to have been considered');
});

test('a missing sensor degrades the answer rather than breaking it', () => {
  // The bedroom Pi is offline; the other two still identify the room.
  const r = classify({
    'living-room': { rssi: -73, rate: 2.1 },
    kitchen: { rssi: -64, rate: 2.05 },
  }, PROFILES);
  assert.equal(r.room, 'living-room');
  assert.ok(r.scores[0].sensorsUsed >= 2);
});

test('every candidate is returned with its score, so a wrong call is diagnosable', () => {
  const r = classify({
    'living-room': { rssi: -73, rate: 2.1 },
    kitchen: { rssi: -64, rate: 2.05 },
    bedroom: { rssi: -88, rate: 0.17 },
  }, PROFILES);
  assert.equal(r.scores.length, 3);
  for (const s of r.scores) assert.ok(typeof s.score === 'number');
});
