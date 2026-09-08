'use strict';

/**
 * What has CHANGED about the body, ranked — not a dashboard of numbers.
 *
 * WHY THIS SHAPE. `HealthCard` already renders today's figures, and a figure is
 * only meaningful against two years of the same figure. The things worth an
 * interruption are all trends: resting heart rate climbing for three days,
 * sleeping wrist temperature up, a fortnight of accumulating sleep debt. None of
 * them is visible in a single day's reading, and all of them are visible in this
 * data — there are two years of it.
 *
 * Split like `pi-health` and `state-of-play`: `assess()` is PURE and holds the
 * judgement; `snapshot()` does the reads. The ORDERING is the product — a
 * findings list nobody can act on top-down is a dashboard again.
 *
 * ── The three refusals ──────────────────────────────────────────────────────
 *
 * IT NEVER DIAGNOSES. "Resting heart rate is 5bpm above your normal and has been
 * for three days" is a fact. "You are coming down with something" is a guess
 * dressed as one, and Apple Health cannot separate exercise, illness, alcohol
 * and a stressful week — `stress-score` already carries that caveat and this
 * inherits it rather than quietly dropping it.
 *
 * A SOURCE THAT STOPPED IS A FINDING, NOT AN ABSENCE. Blood pressure stopped on
 * 1 Apr 2026 and blood glucose in Sep 2025, and nothing anywhere noticed for
 * months, because a metric with no recent rows returns an empty result rather
 * than an error. That is the same species as the dead KV writer this work
 * started from, and it is why `sensorsQuiet` exists.
 *
 * NOTHING HERE PUSHES. Pull-only, deliberately. Nudge volume is the one signal
 * allowed to argue against building more, and a health feed that interrupts is
 * how the notifications that already matter stop being read. If any of this
 * earns an interruption it will be one Nick asks for, not one this decided.
 */

const db = require('../db/database');
const healthDaily = require('./health-daily');

// ── Thresholds, and where they came from ────────────────────────────────────
//
// Measured over Nick's last 90 days rather than picked from a wellness article:
// resting heart rate runs 70.0–83.3 (mean 77.1), HRV 13.2–27.0 (mean 18.4),
// sleep 5.1–9.7h (mean 7.7) with only 6 nights under six hours. A rule that
// fires on a tenth of a normal quarter is one he will learn to ignore, and an
// ignored health alert is worse than none because it also trains him past the
// real one.

// Resting heart rate, in bpm above his own median, held for this many days.
const RHR_ELEVATED_BPM = 4;
const RHR_ELEVATED_DAYS = 3;

// Sleeping wrist temperature, in °C above his own median. Apple's own Cycle
// Tracking treats about 1°C as notable; this is deliberately close to that.
const WRIST_TEMP_DELTA = 0.6;
const WRIST_TEMP_DAYS = 2;

// HRV below the normal range for this many days running.
const HRV_LOW_Z = -1.0;
const HRV_LOW_DAYS = 3;

// Cumulative shortfall against his own median, over a week.
const SLEEP_DEBT_HOURS = 5;

// A metric counts as QUIET when the gap since its last reading is this many
// times its own typical gap. Ratio rather than a fixed number of days, because
// body weight arriving every four days and heart rate arriving every two minutes
// cannot share a threshold. The floor stops a chatty metric being called quiet
// after an afternoon.
const QUIET_RATIO = 8;
const QUIET_FLOOR_DAYS = 14;

// Below this, a metric has not established a cadence to be quiet against — a
// one-off reading from an experiment is not a sensor that stopped.
const QUIET_MIN_SAMPLES = 30;
const QUIET_MIN_SPAN_DAYS = 30;

// Metrics whose whole nature is sporadic. Not silenced — reported at `info` and
// ranked below everything else, because "you have not weighed yourself since
// August" is true, mildly useful, and not the same kind of fact as a monitor
// that has stopped reporting.
const SPORADIC = new Set([
  'weight_body_mass', 'body_mass_index', 'body_fat_percentage', 'lean_body_mass',
  'waist_circumference', 'vo2_max', 'six_minute_walk_test_distance',
  'apple_walking_steadiness', 'distance_swimming', 'swimming_stroke_count',
  'underwater_depth', 'water_temperature', 'heart_rate_recovery_one_minute',
  'workout_effort_score', 'estimated_workout_effort_score', 'atrial_fibrillation_burden',
]);

function median(nums) {
  const s = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(n, dp = 1) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Rank what has changed. PURE — takes days, per-metric summary and `now`.
 *
 * `days`    health-daily rows, newest first (complete and incomplete)
 * `metrics` db.getHealthMetricSummary() rows: {metric, samples, first_at, last_at}
 *
 * Returns `{findings, unknowns, baselineDays}`. `unknowns` is not decoration:
 * "resting heart rate could not be checked" and "resting heart rate is fine" are
 * different facts, and only one of them is an all-clear.
 */
function assess({ days = [], metrics = [], now = new Date() } = {}) {
  const findings = [];
  const unknowns = [];

  // Judged on FINISHED days only. Today is half a day; a partial day's step
  // count and sleep are not comparable with a full one.
  const complete = days.filter(d => d && d.complete);
  const baseline = healthDaily.buildBaseline(complete.slice(1, healthDaily.BASELINE_DAYS + 1));
  const recent = complete.slice(0, Math.max(RHR_ELEVATED_DAYS, HRV_LOW_DAYS, 7));

  if (!baseline.ready) {
    unknowns.push({ input: 'baseline', why: baseline.reason });
    // Sensor quietness needs no baseline of days, so the pass continues.
  } else {
    // ── Resting heart rate, held up ──
    if (baseline.rhr) {
      const run = recent.slice(0, RHR_ELEVATED_DAYS).filter(d => Number.isFinite(d.rhrMedian));
      if (run.length < RHR_ELEVATED_DAYS) {
        unknowns.push({ input: 'rhr', why: `only ${run.length} of the last ${RHR_ELEVATED_DAYS} days carry a resting heart rate` });
      } else if (run.every(d => d.rhrMedian - baseline.rhr.median >= RHR_ELEVATED_BPM)) {
        const worst = Math.max(...run.map(d => d.rhrMedian));
        findings.push({
          id: 'rhr-elevated',
          level: 'warn',
          title: `Resting heart rate up for ${RHR_ELEVATED_DAYS} days`,
          detail: `${round(worst)}bpm against your usual ${round(baseline.rhr.median)}bpm.`,
          // ⚠ Says what it CANNOT tell apart. This is the one place a health
          // reading is most likely to be over-read.
          caveat: 'Could be a bug coming on, a heavy week, alcohol or hard exercise — this cannot tell those apart.',
          evidence: run.map(d => ({ day: d.day, rhr: d.rhrMedian })),
        });
      }
    } else {
      unknowns.push({ input: 'rhr', why: 'no resting-heart-rate baseline yet' });
    }

    // ── Sleeping wrist temperature ──
    const tempDays = complete.filter(d => Number.isFinite(d.wristTemp));
    const tempBase = median(tempDays.slice(WRIST_TEMP_DAYS).map(d => d.wristTemp));
    const tempRun = recent.slice(0, WRIST_TEMP_DAYS).filter(d => Number.isFinite(d.wristTemp));
    if (tempBase == null || tempRun.length < WRIST_TEMP_DAYS) {
      unknowns.push({ input: 'wristTemp', why: 'not enough sleeping wrist temperature to compare' });
    } else if (tempRun.every(d => d.wristTemp - tempBase >= WRIST_TEMP_DELTA)) {
      findings.push({
        id: 'wrist-temp-up',
        level: 'warn',
        title: 'Sleeping wrist temperature raised',
        detail: `${round(tempRun[0].wristTemp, 2)}°C against your usual ${round(tempBase, 2)}°C, ${WRIST_TEMP_DAYS} nights running.`,
        caveat: 'A raised overnight temperature has many causes — a warm room is one of them.',
        evidence: tempRun.map(d => ({ day: d.day, wristTemp: d.wristTemp })),
      });
    }

    // ── HRV suppressed ──
    if (baseline.hrv) {
      const run = recent.slice(0, HRV_LOW_DAYS).filter(d => Number.isFinite(d.hrvMedian) && d.hrvMedian > 0);
      if (run.length < HRV_LOW_DAYS) {
        unknowns.push({ input: 'hrv', why: `only ${run.length} of the last ${HRV_LOW_DAYS} days carry an HRV reading` });
      } else {
        const zs = run.map(d => (Math.log(d.hrvMedian) - baseline.hrv.logMedian) / baseline.hrv.logSigma);
        if (zs.every(z => z <= HRV_LOW_Z)) {
          findings.push({
            id: 'hrv-suppressed',
            level: 'warn',
            title: `HRV below your normal range for ${HRV_LOW_DAYS} days`,
            detail: `Around ${round(run[0].hrvMedian)}ms against your usual ${round(baseline.hrv.median)}ms.`,
            caveat: 'Recovery is down on your own baseline. It does not say why.',
            evidence: run.map((d, i) => ({ day: d.day, hrv: d.hrvMedian, z: round(zs[i], 2) })),
          });
        }
      }
    }

    // ── Sleep debt ──
    if (baseline.sleep) {
      const week = complete.slice(0, 7).filter(d => Number.isFinite(d.asleepHours));
      if (week.length < 5) {
        unknowns.push({ input: 'sleep', why: `only ${week.length} of the last 7 nights were recorded` });
      } else {
        const debt = week.reduce((sum, d) => sum + Math.min(0, d.asleepHours - baseline.sleep.median), 0);
        if (debt <= -SLEEP_DEBT_HOURS) {
          findings.push({
            id: 'sleep-debt',
            level: 'warn',
            title: `${round(Math.abs(debt))}h of sleep debt this week`,
            detail: `Against your usual ${round(baseline.sleep.median, 1)}h a night, over ${week.length} recorded nights.`,
            evidence: week.map(d => ({ day: d.day, hours: d.asleepHours })),
          });
        }
      }
    }
  }

  // ── Sources that have gone quiet ──
  for (const q of sensorsQuiet(metrics, now)) findings.push(q);

  const order = { warn: 0, info: 1 };
  findings.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

  return {
    findings,
    unknowns,
    baselineDays: baseline.ready ? baseline.days : 0,
    // An empty findings list means "nothing stood out in what could be read" —
    // which is only an all-clear when `unknowns` is empty too.
    allClear: findings.length === 0 && unknowns.length === 0,
  };
}

/**
 * Metrics that were arriving regularly and have stopped. PURE.
 *
 * Ratio-based against each metric's OWN cadence, because heart rate arrives
 * every couple of minutes and body weight every few days, and a shared
 * threshold would either shout about the weight or never notice the heart.
 */
function sensorsQuiet(metrics = [], now = new Date()) {
  const entries = [];
  for (const row of metrics) {
    if (!row || !row.metric || !row.last_at || !row.first_at) continue;
    if (!(row.samples >= QUIET_MIN_SAMPLES)) continue;

    const firstMs = Date.parse(`${String(row.first_at).replace(' ', 'T')}Z`);
    const lastMs = Date.parse(`${String(row.last_at).replace(' ', 'T')}Z`);
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) continue;

    const spanDays = (lastMs - firstMs) / 86400000;
    if (spanDays < QUIET_MIN_SPAN_DAYS) continue;

    const typicalGapDays = spanDays / row.samples;
    const silentDays = (now.getTime() - lastMs) / 86400000;
    if (silentDays < Math.max(QUIET_FLOOR_DAYS, typicalGapDays * QUIET_RATIO)) continue;

    entries.push({
      metric: row.metric,
      lastAt: row.last_at,
      lastDay: String(row.last_at).slice(0, 10),
      samples: row.samples,
      silentDays: Math.round(silentDays),
      typicalGapDays,
      sporadic: SPORADIC.has(row.metric),
    });
  }

  // ⚠ METRICS THAT STOPPED ON THE SAME DAY ARE ONE EVENT, and folding them is
  // not cosmetic. Measured on the first live run: 23 findings, 20 of them
  // warnings — and 17 were `dietary_*` metrics that all went quiet on
  // 2026-03-30, because Nick stopped logging food. That is ONE fact rendered
  // seventeen times, and a first open showing twenty warnings is a screen
  // nobody reads by week two. Same rule as commits folding to one row per repo
  // per day, and as a commitment extracted fourteen times still being one
  // commitment: the pile is what stops the real item being seen.
  //
  // The fold is LOSSLESS — every metric is still named in `evidence`, so
  // nothing that stopped is hidden, it just stops being its own row.
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.lastDay)) byDay.set(e.lastDay, []);
    byDay.get(e.lastDay).push(e);
  }

  const out = [];
  for (const [day, group] of byDay) {
    const anyReal = group.some(e => !e.sporadic);
    const silentDays = Math.max(...group.map(e => e.silentDays));
    // Sporadic-by-nature metrics are informational; a monitor that used to
    // report several times a day and has not for months is not.
    const level = anyReal ? 'warn' : 'info';

    if (group.length === 1) {
      const e = group[0];
      out.push({
        id: `quiet:${e.metric}`,
        level,
        title: `${e.metric} stopped arriving`,
        detail: `Last reading ${day}, ${e.silentDays} days ago. It had been arriving roughly every ${formatGap(e.typicalGapDays)} across ${e.samples.toLocaleString()} readings.`,
        caveat: e.sporadic ? 'This one is naturally occasional.' : 'A source that stops looks exactly like a source with nothing to report.',
        evidence: [{ metric: e.metric, lastAt: e.lastAt, samples: e.samples }],
      });
      continue;
    }

    const names = group.map(e => e.metric).sort();
    const shown = names.slice(0, 5).join(', ');
    out.push({
      // Keyed on the DAY, so the id is stable as long as the group is.
      id: `quiet:${day}`,
      level,
      title: `${group.length} metrics stopped arriving on ${day}`,
      detail: `${silentDays} days ago: ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. Stopping together usually means one source stopped, not ${group.length}.`,
      caveat: anyReal
        ? 'A source that stops looks exactly like a source with nothing to report.'
        : 'These are naturally occasional, so this may just be a habit that lapsed.',
      evidence: group.map(e => ({ metric: e.metric, lastAt: e.lastAt, samples: e.samples })),
    });
  }

  // Longest silence first — the ones most likely to have been forgotten.
  return out.sort((a, b) => {
    const aDay = String(a.id).startsWith('quiet:2') ? a.id.slice(6) : (a.evidence[0]?.lastAt || '');
    const bDay = String(b.id).startsWith('quiet:2') ? b.id.slice(6) : (b.evidence[0]?.lastAt || '');
    return aDay < bDay ? -1 : aDay > bDay ? 1 : 0;
  });
}

function formatGap(days) {
  if (days >= 1) return `${round(days)} days`;
  const hours = days * 24;
  if (hours >= 1) return `${round(hours)} hours`;
  return `${Math.round(hours * 60)} minutes`;
}

/** The I/O half. Every read is guarded — a failure is an unknown, never a zero. */
// ── "I've read it" ──────────────────────────────────────────────────────────
//
// Every finding here is a TREND or a SILENCE, so it is true for as long as the
// condition lasts — blood_glucose has been quiet for 354 days and will say so
// every morning until it comes back. That is correct behaviour and it is also
// how a panel stops being read: the four rows Nick has already understood bury
// the fifth he has not.
//
// So a finding can be acknowledged, and the rule is ONE rule:
//
//   ⚠ AN ACKNOWLEDGEMENT IS CLEARED THE FIRST TIME ITS FINDING IS ABSENT.
//
// That is what "until it reoccurs" means, and it is the whole mechanism. A
// quiet metric that starts arriving again drops out of the pass, its ack goes
// with it, and the NEXT time it stops it is a new thing to be told about.
// Resting heart rate acknowledged while it is up stays acknowledged for as long
// as it stays up, clears when it comes back to normal, and speaks again on the
// next episode. No occurrence signature to invent, no date in the key, and
// nothing to keep in step with the finding ids.
//
// ⚠ IT IS AN ACKNOWLEDGEMENT, NOT A RESOLUTION. Acked findings are RETURNED,
// on their own list, and `allClear` is deliberately computed on ALL of them —
// a system that reports itself healthy because the warning was dismissed is
// telling Nick what he just told it.
const ACK_KEY = 'health_signals_ack';

// ⚠ Unreadable is NOT empty (the `triage-shadow._load` rule). Returning {} here
// and then writing it would erase every acknowledgement on one bad read, so
// null is carried all the way to the pruning decision, which refuses to run.
function readAcks() {
  try {
    const raw = db.getState(ACK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return null;
  }
}

function writeAcks(acks) {
  try { db.setState(ACK_KEY, JSON.stringify(acks)); return true; } catch { return false; }
}

/**
 * Split a pass into what Nick still needs to see and what he has already read,
 * and name the acks whose finding has gone. PURE — no DB, no clock.
 */
function partitionAcked(findings = [], acks = {}) {
  const present = new Set(findings.map(f => f.id));
  const active = [];
  const acknowledged = [];
  for (const f of findings) {
    const ack = acks[f.id];
    if (ack) acknowledged.push({ ...f, acknowledgedAt: ack.at || null });
    else active.push(f);
  }
  // The ack has outlived its finding: the metric came back, or the trend ended.
  const stale = Object.keys(acks).filter(id => !present.has(id));
  return { findings: active, acknowledged, stale };
}

/**
 * Record that Nick has read a finding.
 *
 * ⚠ REFUSES anything not in the CURRENT pass. You cannot acknowledge something
 * you were not shown, and the failure it prevents is the expensive one: a stale
 * screen acking a finding that has already cleared would pre-emptively silence
 * the NEXT occurrence — the one thing "until it reoccurs" promises not to do.
 */
function acknowledge(id, { now = new Date() } = {}) {
  if (!id || typeof id !== 'string') return { ok: false, reason: 'no finding id' };
  const current = snapshot({ now });
  const all = [...(current.findings || []), ...(current.acknowledged || [])];
  const found = all.find(f => f.id === id);
  if (!found) return { ok: false, reason: 'not in the current findings' };

  const acks = readAcks();
  if (!acks) return { ok: false, reason: 'the acknowledgement store could not be read' };
  if (acks[id]) return { ok: true, already: true, id };

  acks[id] = { at: now.toISOString(), title: found.title };
  if (!writeAcks(acks)) return { ok: false, reason: 'could not record it' };
  return { ok: true, id, title: found.title };
}

/** The way back. Every other decision in NEURO has one. */
function unacknowledge(id) {
  const acks = readAcks();
  if (!acks) return { ok: false, reason: 'the acknowledgement store could not be read' };
  if (!acks[id]) return { ok: false, reason: 'not acknowledged' };
  delete acks[id];
  if (!writeAcks(acks)) return { ok: false, reason: 'could not record it' };
  return { ok: true, id };
}

function snapshot({ now = new Date(), days = 45 } = {}) {
  let rows = [];
  let metrics = [];
  const gaps = [];
  try { rows = healthDaily.recentDays(days); }
  catch (e) { gaps.push({ input: 'health_daily', why: e.message }); }
  try { metrics = db.getHealthMetricSummary(null); }
  catch (e) { gaps.push({ input: 'metric summary', why: e.message }); }

  const result = assess({ days: rows, metrics, now });

  const stored = readAcks();
  const acks = stored || {};
  const split = partitionAcked(result.findings, acks);

  // ⚠ Pruned ONLY on a sound pass. A finding missing because the read failed is
  // not a finding that has cleared, and dropping the ack there would nag Nick
  // about something he has already read the moment the disk hiccups. Written
  // only when something actually changed, so a polled read writes nothing.
  if (stored && split.stale.length && gaps.length === 0) {
    const next = { ...acks };
    for (const id of split.stale) delete next[id];
    writeAcks(next);
  }

  return {
    ...result,
    findings: split.findings,
    acknowledged: split.acknowledged,
    unknowns: [...gaps, ...result.unknowns],
    // ⚠ ALL of them, acknowledged included. "Nothing stood out" must never be
    // something Nick can bring about by pressing a button.
    allClear: result.allClear && gaps.length === 0,
    ackStoreReadable: stored != null,
    daysRead: rows.length,
  };
}

module.exports = {
  assess,
  sensorsQuiet,
  snapshot,
  partitionAcked,
  acknowledge,
  unacknowledge,
  ACK_KEY,
  RHR_ELEVATED_BPM,
  RHR_ELEVATED_DAYS,
  WRIST_TEMP_DELTA,
  HRV_LOW_Z,
  HRV_LOW_DAYS,
  SLEEP_DEBT_HOURS,
  QUIET_RATIO,
  QUIET_FLOOR_DAYS,
};
