'use strict';

const db = require('../db/database');

// Stress score from HRV + heart rate.
//
// The whole point is that this is RELATIVE. An HRV of 45ms tells you nothing on
// its own — it only means something against Nick's own recent range. So every
// number here is a deviation from a rolling personal baseline, and the score
// refuses to report at all until there is enough history to have one.
//
// Statistics are deliberately robust (median + MAD, not mean + stdev): HRV is
// noisy and a single 12ms reading during a stressful call should not permanently
// widen the baseline.

const BASELINE_DAYS = 14;      // rolling window the baseline is drawn from
const MIN_BASELINE_DAYS = 7;   // below this, report "calibrating" rather than lie
const MIN_BASELINE_SAMPLES = 20;
const CURRENT_WINDOW_HOURS = 6; // how recent an HRV reading must be to count as "now"
const CURRENT_SAMPLE_COUNT = 3; // median the last few, so one outlier can't spike it

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function isoHoursAgo(hours) {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median absolute deviation, scaled to be comparable to a standard deviation
// for normally-distributed data. Resistant to the outliers HRV is full of.
function robustSigma(nums, mid) {
  if (nums.length < 2) return null;
  const devs = nums.map(n => Math.abs(n - mid));
  const mad = median(devs);
  return mad > 0 ? 1.4826 * mad : null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function distinctDays(rows) {
  return new Set(rows.map(r => String(r.recorded_at).slice(0, 10))).size;
}

// HRV is log-normally distributed, so all the maths happens in log space —
// otherwise a high reading looks further from baseline than an equally
// meaningful low one.
function buildHrvBaseline() {
  const rows = db.getHealthSamples('hrv', isoDaysAgo(BASELINE_DAYS), 5000)
    .filter(r => r.value > 0);

  const days = distinctDays(rows);
  if (days < MIN_BASELINE_DAYS || rows.length < MIN_BASELINE_SAMPLES) {
    return { ready: false, days, samples: rows.length };
  }

  const logs = rows.map(r => Math.log(r.value));
  const mid = median(logs);
  const sigma = robustSigma(logs, mid);

  return {
    ready: true,
    days,
    samples: rows.length,
    logMedian: mid,
    // Floor sigma: an unusually stable fortnight would otherwise make every
    // small wobble read as a huge z-score and peg the output at the clamp.
    logSigma: Math.max(sigma || 0.22, 0.18),
    medianMs: Math.exp(mid)
  };
}

function currentHrv() {
  const rows = db.getHealthSamples('hrv', isoHoursAgo(CURRENT_WINDOW_HOURS), CURRENT_SAMPLE_COUNT)
    .filter(r => r.value > 0);
  if (!rows.length) return null;
  return { value: median(rows.map(r => r.value)), at: rows[0].recorded_at, n: rows.length };
}

// Resting HR baseline is a plain median — RHR is far more stable than HRV and
// does not need the log treatment.
function restingHrBaseline() {
  const rows = db.getHealthSamples('rhr', isoDaysAgo(BASELINE_DAYS), 500)
    .filter(r => r.value > 0);
  if (rows.length < 3) return null;
  return median(rows.map(r => r.value));
}

function computeStressScore() {
  const baseline = buildHrvBaseline();

  if (!baseline.ready) {
    return {
      status: 'calibrating',
      score: null,
      label: 'Calibrating',
      detail: `Need ${MIN_BASELINE_DAYS} days of HRV data to build a baseline — have ${baseline.days}.`,
      baselineDays: baseline.days,
      samples: baseline.samples
    };
  }

  const hrv = currentHrv();
  if (!hrv) {
    return {
      status: 'stale',
      score: null,
      label: 'No recent reading',
      detail: `No HRV sample in the last ${CURRENT_WINDOW_HOURS}h.`,
      baselineMs: Math.round(baseline.medianMs)
    };
  }

  // Negative z = HRV below your own baseline = sympathetic load = higher stress.
  const z = (Math.log(hrv.value) - baseline.logMedian) / baseline.logSigma;

  // 50 is "exactly your baseline". One robust sigma below baseline lands ~68,
  // two below ~86. Clamped so a freak reading cannot report 0 or 100.
  let score = clamp(50 - 18 * z, 2, 98);

  const caveats = [];
  let hrTerm = null;

  // Heart-rate elevation above resting is the fast-moving half of the signal:
  // HRV updates a handful of times a day, HR every few minutes.
  const rhr = restingHrBaseline();
  const latestHr = db.getLatestHealthSample('heartRate');
  if (rhr && latestHr && latestHr.value > 0) {
    const fresh = new Date(String(latestHr.recorded_at).replace(' ', 'T') + 'Z').getTime();
    const ageMin = (Date.now() - fresh) / 60000;
    if (ageMin <= 60) {
      const elevation = (latestHr.value - rhr) / rhr;
      // 70 keeps the term useful across the realistic range: +20% over resting
      // reads 64, +50% reads 85. A steeper slope pegged everything at the clamp.
      hrTerm = clamp(50 + elevation * 70, 2, 98);
      // 70/30 — HRV is the better-established stress proxy; HR mostly adds
      // responsiveness between HRV readings.
      score = 0.7 * score + 0.3 * hrTerm;

      // Exercise raises HR exactly like stress does, and Apple Health gives us
      // no way to tell them apart from the sample alone. Flag rather than guess.
      if (elevation > 0.35) {
        caveats.push('Heart rate is well above resting — if you have just been active, this reads high.');
      }
    }
  }

  score = Math.round(score);

  const label =
    score >= 75 ? 'High' :
    score >= 60 ? 'Elevated' :
    score >= 40 ? 'Balanced' :
    score >= 25 ? 'Low' : 'Very low';

  return {
    status: 'ok',
    score,
    label,
    hrv: Math.round(hrv.value * 10) / 10,
    hrvAt: hrv.at,
    baselineMs: Math.round(baseline.medianMs),
    deviation: Math.round(z * 100) / 100,
    restingHr: rhr ? Math.round(rhr) : null,
    currentHr: hrTerm !== null && latestHr ? Math.round(latestHr.value) : null,
    baselineDays: baseline.days,
    caveats
  };
}

module.exports = {
  computeStressScore,
  // exported for tests / debugging the baseline without a score
  buildHrvBaseline
};
