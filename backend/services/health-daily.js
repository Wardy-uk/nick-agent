'use strict';

/**
 * One row per day, from 1.1M raw samples.
 *
 * WHY THIS EXISTS. `health_samples` is the right shape for a rolling HRV
 * baseline and the wrong shape for every other question anyone actually asks:
 * "was last night short", "how does this compare with a normal Tuesday", "has
 * resting heart rate been creeping up" all mean scanning a million rows. So
 * nothing outside the desktop HealthCard ever asked one. Two years of near-daily
 * sleep, HRV, resting heart rate, exercise and daylight sat in the database and
 * reached no surface Nick sees without going and looking for it.
 *
 * Split like `pi-health.assess()` / `state-of-play`: `buildDays()`,
 * `buildBaseline()` and `readiness()` are PURE — no DB, no clock, no network —
 * and hold every judgement worth arguing with. `sync()` does the I/O.
 *
 * ── Three things that are deliberate ────────────────────────────────────────
 *
 * MEDIANS, NOT MEANS, for HRV and resting heart rate. Both are noisy, and one
 * 12ms reading taken during a difficult call should not move the day. Same call
 * `stress-score` already makes, for the same reason.
 *
 * SLEEP IS KEYED ON THE NIGHT YOU WOKE ON, and that rule is not re-implemented
 * here — `apple-health.rollupSleepNights` owns it and this stores its answer.
 * Two places deciding which day a 01:30 sleep segment belongs to is how they
 * come to disagree.
 *
 * ⚠ THE SCALAR DAY KEY IS UTC, because `recorded_at` is stored UTC so that
 * string comparison is chronological comparison (health_samples' own rule). In
 * BST that puts a reading taken between midnight and 01:00 local on the previous
 * day. It is named rather than fixed: guessing a zone is how the calendar lost
 * an hour, and the effect here is a handful of steps on the wrong side of
 * midnight — not something to trade a silent timezone assumption for.
 */

const db = require('../db/database');
const appleHealth = require('./apple-health');

// How the scalar metrics fold into a day. This map IS the decision — steps want
// a sum and respiratory rate wants an average, and which is which is a fact
// about the metric. `median` metrics are pulled raw instead (see below).
//
// ⚠ `time_in_daylight` arrives in SECONDS, not minutes. Measured on the live
// table: it averages 3,189 a day and peaks at 21,420. As minutes that is 53
// HOURS in a day and 357 at the peak, which is impossible; as seconds it is 53
// minutes and just under six hours, which is a British summer. The units column
// is not stored on a sample, so this is inferred from the values rather than
// read — hence the note, and hence the conversion happening once, here.
const SCALAR_METRICS = {
  steps: { key: 'steps', how: 'sum' },
  activeEnergy: { key: 'activeEnergy', how: 'sum' },
  apple_exercise_time: { key: 'exerciseMinutes', how: 'sum' },
  apple_stand_time: { key: 'standMinutes', how: 'sum' },
  time_in_daylight: { key: 'daylightMinutes', how: 'sum', scale: 1 / 60 },
  respiratoryRate: { key: 'respiratoryRate', how: 'avg' },
  apple_sleeping_wrist_temperature: { key: 'wristTemp', how: 'avg' },
  blood_oxygen_saturation: { key: 'spo2', how: 'avg' },
  weight_body_mass: { key: 'weightKg', how: 'avg' },
};

// Pulled raw so the daily figure can be a median. Both are cheap: hrv is ~60
// readings a day and rhr is ~1,200 rows in the table's entire life.
const MEDIAN_METRICS = { hrv: 'hrvMedian', rhr: 'rhrMedian' };

// Baseline window for readiness. Fourteen days is `stress-score`'s window and is
// reused rather than re-picked — two different answers to "what is normal for
// Nick" is how two surfaces come to disagree about the same morning.
const BASELINE_DAYS = 14;
const MIN_BASELINE_DAYS = 7;

function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function median(nums) {
  const s = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation, scaled to compare with a standard deviation. */
function robustSigma(nums, mid) {
  const devs = nums.filter(Number.isFinite).map(n => Math.abs(n - mid));
  if (devs.length < 2) return null;
  const mad = median(devs);
  return mad > 0 ? 1.4826 * mad : null;
}

// ── Building the rows (pure) ────────────────────────────────────────────────

/**
 * Fold aggregates, raw median-metric samples and sleep nights into day rows.
 * PURE: every input is passed in, including what counts as "today".
 *
 * `aggregates`  rows from db.getDailyMetricAggregates — {day, metric, n, avg, sum}
 * `medianRows`  raw {metric, value, recorded_at} for the MEDIAN_METRICS
 * `nights`      output of apple-health.rollupSleepNights
 * `todayKey`    the day that is still in progress; its row is marked incomplete
 */
function buildDays({ aggregates = [], medianRows = [], nights = [], todayKey = null } = {}) {
  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { day: key });
    return days.get(key);
  };

  for (const row of aggregates) {
    const spec = SCALAR_METRICS[row && row.metric];
    if (!spec || !row.day) continue;
    const raw = spec.how === 'sum' ? row.sum : row.avg;
    if (!Number.isFinite(raw)) continue;
    dayOf(row.day)[spec.key] = round(raw * (spec.scale || 1));
  }

  // Group the raw rows by metric and day, then take the median per day.
  const buckets = new Map();
  for (const row of medianRows) {
    const key = MEDIAN_METRICS[row && row.metric];
    if (!key || !row.recorded_at) continue;
    const day = String(row.recorded_at).slice(0, 10);
    const value = Number(row.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const id = `${key}:${day}`;
    if (!buckets.has(id)) buckets.set(id, { key, day, values: [] });
    buckets.get(id).values.push(value);
  }
  for (const { key, day, values } of buckets.values()) {
    dayOf(day)[key] = round(median(values));
    // Sample count for HRV only, because it is the one figure a consumer is
    // entitled to distrust: a "median" of one reading is that reading.
    if (key === 'hrvMedian') dayOf(day).hrvSamples = values.length;
  }

  for (const night of nights) {
    if (!night || !night.night) continue;
    const d = dayOf(night.night);
    d.asleepHours = night.asleepHours ?? null;
    d.sleepSource = night.asleepSource || 'none';
    d.deepHours = night.stages?.deep ?? null;
    d.remHours = night.stages?.rem ?? null;
    d.coreHours = night.stages?.core ?? null;
    d.awakeHours = night.awakeHours ?? null;
    d.sleepEfficiency = night.efficiency ?? null;
  }

  return [...days.values()]
    .map(d => ({
      ...d,
      // ⚠ Not a cosmetic flag. Today's row is a PARTIAL day — half its steps
      // have not been taken yet — and a consumer averaging it in with finished
      // days drags every average down for the whole morning.
      complete: todayKey ? d.day < todayKey : true,
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

// ── Baseline and readiness (pure) ───────────────────────────────────────────

/**
 * What "normal for Nick" is, from finished days only.
 *
 * Returns `ready:false` rather than a number when there is too little history —
 * `stress-score`'s refusal, and for the same reason: a baseline drawn from three
 * days makes the fourth look extraordinary whatever it says.
 *
 * HRV is handled in LOG space because it is log-normally distributed; done
 * linearly, a high reading looks further from normal than an equally meaningful
 * low one, and low is the direction that matters here.
 */
function buildBaseline(days = []) {
  const usable = days.filter(d => d && d.complete !== false);
  if (usable.length < MIN_BASELINE_DAYS) {
    return { ready: false, days: usable.length, reason: `only ${usable.length} finished day(s) — need ${MIN_BASELINE_DAYS}` };
  }

  const hrvLogs = usable.map(d => d.hrvMedian).filter(v => Number.isFinite(v) && v > 0).map(Math.log);
  const rhrs = usable.map(d => d.rhrMedian).filter(Number.isFinite);
  const sleeps = usable.map(d => d.asleepHours).filter(Number.isFinite);

  const hrvMid = hrvLogs.length >= MIN_BASELINE_DAYS ? median(hrvLogs) : null;

  return {
    ready: true,
    days: usable.length,
    hrv: hrvMid == null ? null : {
      logMedian: hrvMid,
      // Floored: an unusually steady fortnight would otherwise make every small
      // wobble a huge z-score and peg the output at its clamp.
      logSigma: Math.max(robustSigma(hrvLogs, hrvMid) || 0, 0.08),
      median: round(Math.exp(hrvMid), 1),
      samples: hrvLogs.length,
    },
    rhr: rhrs.length >= MIN_BASELINE_DAYS ? { median: round(median(rhrs), 1), samples: rhrs.length } : null,
    sleep: sleeps.length >= MIN_BASELINE_DAYS ? { median: round(median(sleeps), 2), samples: sleeps.length } : null,
  };
}

// How far from baseline each input has to be before it is worth saying
// anything. Sleep is a personal median rather than a fixed 7 or 8 hours, for
// exactly the reason stress-score refuses absolute HRV thresholds — and it
// matters here specifically: measured over 90 days Nick averages 7.7 hours and
// went under six on 6 nights. A fixed "under 7h is short" would have fired on a
// third of a perfectly normal quarter and taught him to ignore it.
const HRV_LOW_Z = -1.0;
const HRV_HIGH_Z = 1.0;
const RHR_HIGH_DELTA = 3;      // bpm above the personal median
const SLEEP_SHORT_DELTA = -1.25; // hours below the personal median

/**
 * How much this body has to give today. PURE.
 *
 * Three refusals carry it, and they are the same three the rest of NEURO makes:
 *
 *  1. NO BASELINE, NO SCORE. `known:false` with a reason, never a cheerful
 *     middling number. A readiness of "normal" invented from no history is worse
 *     than silence, because something downstream will act on it.
 *  2. A MISSING INPUT IS NOT A GOOD ONE. Each contributor reports whether it
 *     could be read, and `inputsRead` says how many answered — a day the watch
 *     was off charge must not read as a well-rested one.
 *  3. IT NEVER DIAGNOSES. Low HRV plus high resting heart rate is "your body is
 *     working harder than usual", not an illness, not a hangover and not stress:
 *     Apple Health cannot tell exercise from strain (stress-score's own caveat)
 *     and neither can this.
 */
function readiness(day, baseline) {
  const out = {
    known: false,
    state: 'unknown',
    score: null,
    contributors: [],
    inputsRead: 0,
    reason: null,
  };

  if (!day) return { ...out, reason: 'no day to assess' };
  if (!baseline || !baseline.ready) {
    return { ...out, reason: baseline?.reason || 'no baseline yet — still calibrating' };
  }

  const parts = [];

  if (Number.isFinite(day.hrvMedian) && day.hrvMedian > 0 && baseline.hrv) {
    const z = (Math.log(day.hrvMedian) - baseline.hrv.logMedian) / baseline.hrv.logSigma;
    parts.push({
      input: 'hrv',
      value: day.hrvMedian,
      baseline: baseline.hrv.median,
      z: round(z),
      // Clamped so one extreme reading cannot dominate the other two inputs.
      effect: Math.max(-1, Math.min(1, z / 2)),
      // ⚠ STRUCTURED, not inferred from the prose. The sentence used to pick out
      // the bad news with a regex over `note`, which is brittle in the ordinary
      // way (a reworded note silently stops matching) and wrong in a subtler
      // one — see readinessSentence.
      flag: z <= HRV_LOW_Z ? 'adverse' : z >= HRV_HIGH_Z ? 'favourable' : 'normal',
      note: z <= HRV_LOW_Z ? 'HRV below your normal range'
        : z >= HRV_HIGH_Z ? 'HRV above your normal range'
          : 'HRV in your normal range',
    });
  }

  if (Number.isFinite(day.rhrMedian) && baseline.rhr) {
    const delta = day.rhrMedian - baseline.rhr.median;
    parts.push({
      input: 'rhr',
      value: day.rhrMedian,
      baseline: baseline.rhr.median,
      delta: round(delta, 1),
      effect: Math.max(-1, Math.min(1, -delta / 6)),
      flag: delta >= RHR_HIGH_DELTA ? 'adverse' : delta <= -RHR_HIGH_DELTA ? 'favourable' : 'normal',
      note: delta >= RHR_HIGH_DELTA ? `resting heart rate ${round(delta, 1)}bpm above normal` : 'resting heart rate normal',
    });
  }

  if (Number.isFinite(day.asleepHours) && baseline.sleep) {
    const delta = day.asleepHours - baseline.sleep.median;
    parts.push({
      input: 'sleep',
      value: day.asleepHours,
      baseline: baseline.sleep.median,
      delta: round(delta, 2),
      effect: Math.max(-1, Math.min(1, delta / 2)),
      flag: delta <= SLEEP_SHORT_DELTA ? 'adverse' : delta >= -SLEEP_SHORT_DELTA ? 'favourable' : 'normal',
      note: delta <= SLEEP_SHORT_DELTA ? `${round(Math.abs(delta), 1)}h less sleep than usual` : 'slept about as usual',
    });
  }

  if (!parts.length) {
    return { ...out, reason: 'nothing readable today — no HRV, resting heart rate or sleep' };
  }

  const mean = parts.reduce((sum, p) => sum + p.effect, 0) / parts.length;
  // 50 is "exactly your own normal", not "average for a human". The scale is
  // clamped short of 0 and 100 because neither end is a claim this data can
  // support — stress-score's 2..98 rule, one metric family over.
  const score = Math.round(Math.max(5, Math.min(95, 50 + mean * 45)));

  return {
    known: true,
    state: score <= 40 ? 'low' : score >= 62 ? 'high' : 'normal',
    score,
    contributors: parts,
    inputsRead: parts.length,
    // Said out loud: three inputs and one input produce the same score shape and
    // are not the same claim.
    partial: parts.length < 3,
    baselineDays: baseline.days,
    reason: null,
  };
}

// What counts as "this input is what moved the score" when no single reading
// crossed its own threshold. Below this the day really is unremarkable and the
// sentence should say so rather than reaching for something to blame.
const NOTABLE_EFFECT = 0.2;

/**
 * One line of plain English. Composed here so no surface phrases it twice.
 *
 * ⚠ THE SCORE AND THE SENTENCE MUST NAME THE SAME THING. The first version
 * listed only contributors whose note crossed a named threshold, and caught
 * itself on the first live reading: score 31 ("low"), driven by HRV at z = -0.93
 * AND resting heart rate 4bpm up — but -0.93 is inside the ±1.0 band, so its
 * note read *"HRV in your normal range"* and the sentence blamed the heart rate
 * alone. Nearly half the reason for the number went unmentioned, and a reader
 * would reasonably conclude one figure had produced a 31.
 *
 * So there are two cases, and they are different claims:
 *   - something crossed a threshold → name those things
 *   - nothing did, but the score still moved → say exactly that. "Nothing on
 *     its own, but X and Y are both on the low side" is the honest description
 *     of a day where three readings all lean the same way.
 *
 * Selection is on the structured `flag` and `effect`, never a regex over the
 * prose: a reworded note must not silently change which facts get reported.
 */
function readinessSentence(r) {
  if (!r || !r.known) return null;

  const wantFlag = r.state === 'high' ? 'favourable' : 'adverse';
  const wantSign = r.state === 'high' ? 1 : -1;

  // Crossed a named threshold — these get their full note.
  const crossed = r.contributors.filter(p => p.flag === wantFlag);
  // Did NOT cross, but pushed the score by a measurable amount in the same
  // direction. ⚠ These must be named too. The first fix only reported the
  // crossed ones and still under-reported the live case it was written for:
  // HRV at z = -0.93 contributed -0.46 — two thirds of the resting heart
  // rate's -0.67 — and went unmentioned because -0.93 is inside the ±1.0 band.
  // A threshold decides how to PHRASE a reading, not whether it counted.
  const leaning = r.contributors.filter(p =>
    p.flag !== wantFlag && Math.sign(p.effect) === wantSign && Math.abs(p.effect) >= NOTABLE_EFFECT
  ).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  const side = r.state === 'high' ? 'good' : 'low';
  let detail;
  if (crossed.length && leaning.length) {
    detail = `${crossed.map(p => p.note).join(', ')}, with ${listOf(leaning.map(label))} also on the ${side} side`;
  } else if (crossed.length) {
    detail = crossed.map(p => p.note).join(', ');
  } else if (leaning.length) {
    // Nothing crossed a line, yet the day is not neutral — which is a different
    // statement from either "your heart rate is up" or "all normal".
    detail = `nothing on its own, but ${listOf(leaning.map(label))} ${leaning.length > 1 ? 'are' : 'is'} on the ${side} side`;
  } else {
    detail = 'everything in your normal range';
  }

  if (r.state === 'low') return `Running low today — ${detail}.`;
  if (r.state === 'high') return `Well recovered today — ${detail}.`;
  return `About normal today — ${detail}.`;
}

function label(part) {
  return part.input === 'rhr' ? 'resting heart rate' : part.input === 'hrv' ? 'HRV' : 'sleep';
}

function listOf(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ── Sync (impure) ───────────────────────────────────────────────────────────

// How far back a sync recomputes. Ten days rather than one, because a phone
// syncs when iOS feels like it (BGProcessingTask is a request, not a schedule)
// and last Tuesday's sleep can genuinely land on Thursday. Recomputing is
// idempotent, so the only cost of a wide window is a little CPU.
const SYNC_WINDOW_DAYS = 10;

function toDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function toSqlUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Recompute one window and write it. Idempotent — every row is an UPSERT keyed
 * on the day, so running twice changes nothing.
 *
 * ⚠ THE WINDOW IS BOUNDED AT BOTH ENDS. `now` is its end, not merely the point
 * the count is measured back from. The first version bounded only the start,
 * which is invisible for the hourly rollup and silently wrong for a backfill
 * walking backwards: every chunk read through to the present, the 20,000-row cap
 * kept the NEWEST rows, and the oldest chunk overwrote two years of days with
 * nulls. It wrote 744 days and left 328 with any HRV in them.
 *
 * `today` is separate from `now` for the same reason: a chunk ending in March
 * must not mark its last day incomplete, because completeness is a fact about
 * the real clock, not about where this window happens to stop.
 *
 * Returns what it wrote AND what it could not read. A rollup silently reporting
 * zero days because the table was unreachable is the failure this whole file
 * exists to stop happening again.
 */
function sync({ days = SYNC_WINDOW_DAYS, now = new Date(), today = now } = {}) {
  const gaps = [];
  const sinceDate = new Date(now.getTime() - days * 86400000);
  const since = toSqlUtc(sinceDate);
  const until = toSqlUtc(now);
  const todayKey = toDayKey(today);

  let aggregates = [];
  try {
    aggregates = db.getDailyMetricAggregates(Object.keys(SCALAR_METRICS), since, until);
  } catch (e) {
    gaps.push({ input: 'aggregates', why: e.message });
  }

  let medianRows = [];
  try {
    for (const metric of Object.keys(MEDIAN_METRICS)) {
      medianRows.push(...db.getHealthSamplesBetween(metric, since, until, 20000).map(r => ({ ...r, metric })));
    }
  } catch (e) {
    gaps.push({ input: 'hrv/rhr', why: e.message });
  }

  let nights = [];
  try {
    // A night is keyed by its WAKE date, so the earliest night in the window has
    // segments that started the day before — reach back one extra day, exactly
    // as /api/health/sleep does.
    const sleepSince = toSqlUtc(new Date(sinceDate.getTime() - 86400000));
    nights = appleHealth.rollupSleepNights(db.getSleepSamplesBetween(sleepSince, until, 20000));
  } catch (e) {
    gaps.push({ input: 'sleep', why: e.message });
  }

  const endKey = toDayKey(now);
  const rows = buildDays({ aggregates, medianRows, nights, todayKey })
    .filter(d => d.day >= toDayKey(sinceDate) && d.day <= endKey);

  let written = 0;
  for (const row of rows) {
    try { db.upsertHealthDay(row); written++; }
    catch (e) { gaps.push({ input: `day ${row.day}`, why: e.message }); }
  }

  return { ok: gaps.length === 0, written, days: rows.length, gaps, since: toDayKey(sinceDate) };
}

/**
 * Re-roll a WIDE window by walking back in bounded chunks.
 *
 * WHY THIS EXISTS. The hourly `sync()` re-reads 10 trailing days, which is right
 * for steady state — measured on the live table, no sample in the last week
 * arrived stamped more than 10 days earlier. But the worst arrival lag over the
 * last month is **730 days**, because the phone app backfills history forward
 * chronologically and has delivered two years of it in one go. A sample that
 * lands today stamped last March is invisible to the hourly rollup for ever:
 * `health_daily` would keep the row it computed when that day was empty.
 *
 * ⚠ Chunked, and NOT optional. `sync()` pulls HRV and resting heart rate as raw
 * rows so the daily figure can be a median, capped at 20,000 — so a single wide
 * call silently keeps the newest rows and rolls up a partial history. That is
 * the bug this module already shipped once (744 days written, 328 with any HRV),
 * and the chunking is the reason the backfill script does not hit it.
 *
 * Lives here rather than in the script so the scheduler and the script share one
 * implementation — the alternative is chunking logic in a script the nightly job
 * cannot reuse, which is how the two come to disagree.
 */
function syncRange({ days = 120, chunk = 30, now = new Date(), today = now } = {}) {
  let written = 0;
  const gaps = [];
  for (const step of chunkPlan(days, chunk)) {
    const end = new Date(now.getTime() - step.offset * 86400000);
    const res = sync({ days: step.days, now: end, today });
    written += res.written;
    gaps.push(...res.gaps);
  }
  return { ok: gaps.length === 0, written, gaps, days };
}

/**
 * The walk itself: which bounded windows a wide re-roll is made of. PURE, and
 * separated for exactly that reason — the SHAPE of the reads is the thing worth
 * pinning, because one wide read hits the row cap and silently rolls up a
 * partial history. The last chunk is TRIMMED rather than overshooting, so the
 * range asked for is the range read.
 */
function chunkPlan(days, chunk) {
  const size = Math.max(1, chunk);
  const steps = [];
  for (let offset = 0; offset < days; offset += size) {
    steps.push({ offset, days: Math.min(size, days - offset) });
  }
  return steps;
}

/** The stored days, newest first, with keys the rest of NEURO uses. */
function recentDays(days = 30, { completeOnly = false } = {}) {
  return db.getHealthDays(days, { completeOnly }).map(fromRow);
}

function fromRow(row) {
  if (!row) return null;
  return {
    day: row.day,
    asleepHours: row.asleep_hours,
    sleepSource: row.sleep_source,
    deepHours: row.deep_hours,
    remHours: row.rem_hours,
    coreHours: row.core_hours,
    awakeHours: row.awake_hours,
    sleepEfficiency: row.sleep_efficiency,
    hrvMedian: row.hrv_median,
    hrvSamples: row.hrv_samples,
    rhrMedian: row.rhr_median,
    steps: row.steps,
    activeEnergy: row.active_energy,
    exerciseMinutes: row.exercise_minutes,
    standMinutes: row.stand_minutes,
    daylightMinutes: row.daylight_minutes,
    respiratoryRate: row.respiratory_rate,
    wristTemp: row.wrist_temp,
    spo2: row.spo2,
    weightKg: row.weight_kg,
    complete: row.complete === 1,
  };
}

/**
 * Today's readiness, against the trailing baseline.
 *
 * ⚠ Today's own row is EXCLUDED from its own baseline. Including it drags the
 * baseline towards the day being judged, so a genuinely bad morning partly
 * excuses itself — the failure is quiet and always in the direction of saying
 * nothing is wrong.
 */
function today(now = new Date()) {
  const todayKey = toDayKey(now);
  const rows = recentDays(BASELINE_DAYS + 2);
  const day = rows.find(r => r.day === todayKey) || null;
  const baseline = buildBaseline(rows.filter(r => r.day !== todayKey && r.complete).slice(0, BASELINE_DAYS));
  const r = readiness(day, baseline);
  return { day: todayKey, data: day, readiness: r, sentence: readinessSentence(r) };
}

module.exports = {
  // pure — the half worth pinning
  buildDays,
  buildBaseline,
  readiness,
  readinessSentence,
  // impure
  sync,
  syncRange,
  chunkPlan,
  recentDays,
  today,
  fromRow,
  // constants
  SCALAR_METRICS,
  MEDIAN_METRICS,
  BASELINE_DAYS,
  MIN_BASELINE_DAYS,
  SYNC_WINDOW_DAYS,
};
