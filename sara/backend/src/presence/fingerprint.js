// Which room is Nick ACTUALLY in — by fingerprint, not by loudest sensor.
//
// PURE classification; the profile store is separate. No I/O, no clock.
//
// ── Why not "the loudest sensor wins" ───────────────────────────────────────
// Because it was measured wrong, twice, on 31 Aug 2026:
//
//   · pi5 (Pi 5) and pi-dev (Pi 4) have different radios. Absolute RSSI is not
//     comparable between them, so the ranking partly measured the hardware.
//   · Nick sat still in the living room with the watch on the arm shielded by
//     his own body, and the KITCHEN out-read the living room by 9 dB. A body
//     attenuates 2.4 GHz by 5-15 dB; a plasterboard wall by 3-5. His arm
//     outweighed a wall.
//
// Neither is fixable by choosing a better threshold, because neither is about
// distance. Both vanish under fingerprinting: a room is identified by the WHOLE
// PATTERN across every sensor, so "the kitchen hears me 9 dB louder than the
// living room does" stops being an error and becomes part of what the living
// room LOOKS like. A constant hardware offset appears in every profile and
// cancels; a body shadow is learned if calibration spans a few orientations.
//
// ── What a profile is ───────────────────────────────────────────────────────
// Per room, per sensor: mean and standard deviation of RSSI and of advert rate,
// plus how many samples it rests on. Classification scores the live vector by
// summed normalised deviation and picks the nearest.
//
// ⚠ RATE AND RSSI BOTH COUNT, deliberately. Rate is robust to a turned wrist
// (measured: in-room 1.75-2.55/s against upstairs 0.10-0.40/s, a 4x gap) but
// coarse. RSSI is finer but swings 26 dB at a fixed seat. Together they
// disagree in different directions, which is what makes the combination worth
// more than either.
//
// ── Three refusals ──────────────────────────────────────────────────────────
// ⚠ NO PROFILE, NO ANSWER. A room that has never been calibrated can never be
// inferred. Better a null than a confident wrong room driving automation.
//
// ⚠ A POOR MATCH IS `unknown`, NOT THE LEAST-BAD ROOM. Nick standing in the
// garage - a room with no profile at all - must not resolve to whichever
// bedroom scores least badly.
//
// ⚠ A NARROW WIN IS `unsure`, AND SAYS SO. Two rooms within a hair of each
// other is a coin toss; automation asking "which room" deserves to be told it
// was a close call rather than handed the winner of a tie.

'use strict';

// A sample must deviate by more than this (in summed normalised units, per
// sensor) before the whole match is called poor. Generous: a false `unknown`
// costs a beat of automation, a false ROOM turns lights on above someone else.
const MAX_MEAN_DEVIATION = 3.0;
// How much better the winner must score than the runner-up to be called sure.
const MIN_MARGIN = 0.35;
// A standard deviation of zero (one sample, or a perfectly still calibration)
// would divide by nothing and make that sensor infinitely important.
const MIN_SD = { rssi: 3.0, rate: 0.25 };

/** Mean and sample standard deviation. */
function stats(values) {
  const xs = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, sd: 0, n: 1 };
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sd: Math.sqrt(varr), n: xs.length };
}

/**
 * Turn labelled samples into one room's profile.
 *
 * `samples` is an array of readings, each a map of sensorRoom -> {rssi, rate}.
 * A sensor absent from a sample contributes nothing to that sensor's stats
 * rather than counting as a zero — "did not hear" and "heard at zero" are the
 * same distinction this whole codebase keeps making.
 */
function buildProfile(room, samples = []) {
  const bySensor = {};
  for (const s of samples) {
    for (const [sensor, v] of Object.entries(s || {})) {
      if (!bySensor[sensor]) bySensor[sensor] = { rssi: [], rate: [] };
      if (v && typeof v.rssi === 'number') bySensor[sensor].rssi.push(v.rssi);
      if (v && typeof v.rate === 'number') bySensor[sensor].rate.push(v.rate);
    }
  }

  const sensors = {};
  for (const [sensor, v] of Object.entries(bySensor)) {
    const rssi = stats(v.rssi);
    const rate = stats(v.rate);
    if (!rssi && !rate) continue;
    sensors[sensor] = { rssi, rate };
  }

  return { room, sensors, samples: samples.length };
}

/** Normalised distance for one feature, floored so a still calibration cannot dominate. */
function deviation(value, stat, floor) {
  if (!stat || typeof value !== 'number') return null;
  const sd = Math.max(stat.sd, floor);
  return Math.abs(value - stat.mean) / sd;
}

/**
 * Which room does this live reading look like?
 *
 * `reading` is a map of sensorRoom -> {rssi, rate} for right now.
 * `profiles` is a map of room -> profile from buildProfile.
 */
function classify(reading = {}, profiles = {}, {
  maxDeviation = MAX_MEAN_DEVIATION,
  minMargin = MIN_MARGIN,
} = {}) {
  const names = Object.keys(profiles || {});
  if (!names.length) {
    return { room: null, confidence: 'none', why: 'no rooms have been calibrated', scores: [] };
  }

  const live = Object.entries(reading || {})
    .filter(([, v]) => v && (typeof v.rssi === 'number' || typeof v.rate === 'number'));
  if (!live.length) {
    return { room: null, confidence: 'none', why: 'no sensor readings', scores: [] };
  }

  const scores = [];
  for (const name of names) {
    const profile = profiles[name];
    const devs = [];
    const missing = [];

    for (const [sensor, v] of live) {
      const p = profile.sensors && profile.sensors[sensor];
      if (!p) { missing.push(sensor); continue; }
      const d1 = deviation(v.rssi, p.rssi, MIN_SD.rssi);
      const d2 = deviation(v.rate, p.rate, MIN_SD.rate);
      // Average the two features for this sensor so a sensor with only one
      // readable feature is not weighted less than one with both.
      const both = [d1, d2].filter(d => d !== null);
      if (both.length) devs.push(both.reduce((a, b) => a + b, 0) / both.length);
    }

    // A profile that overlaps the live reading in NO sensor cannot be scored.
    // Skipped rather than scored badly — an unscoreable room must not be able
    // to win by being least-bad, nor to lose and imply it was considered.
    if (!devs.length) continue;

    scores.push({
      room: name,
      score: devs.reduce((a, b) => a + b, 0) / devs.length,
      sensorsUsed: devs.length,
      sensorsMissing: missing,
      samples: profile.samples || 0,
    });
  }

  if (!scores.length) {
    return {
      room: null,
      confidence: 'none',
      why: 'no calibrated room shares a sensor with this reading',
      scores: [],
    };
  }

  scores.sort((a, b) => a.score - b.score);
  const best = scores[0];
  const runnerUp = scores[1] || null;

  // ⚠ Least-bad is not a match. Nick in an uncalibrated room must come back
  // unknown rather than resolving to whichever room scored least badly.
  if (best.score > maxDeviation) {
    return {
      room: null,
      confidence: 'none',
      why: `nothing matches — closest was ${best.room} at ${best.score.toFixed(2)}, `
         + `beyond the ${maxDeviation} limit. You may be somewhere with no sensor.`,
      scores,
    };
  }

  const margin = runnerUp ? runnerUp.score - best.score : Infinity;
  if (margin < minMargin) {
    return {
      room: best.room,
      confidence: 'unsure',
      why: `${best.room} and ${runnerUp.room} are close (${best.score.toFixed(2)} vs `
         + `${runnerUp.score.toFixed(2)})`,
      margin,
      scores,
    };
  }

  return {
    room: best.room,
    confidence: 'sure',
    why: null,
    margin: margin === Infinity ? null : margin,
    scores,
  };
}

module.exports = {
  buildProfile, classify, stats,
  MAX_MEAN_DEVIATION, MIN_MARGIN, MIN_SD,
};
