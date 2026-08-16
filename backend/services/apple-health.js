'use strict';

/**
 * Apple Health ingestion — the transport half of #40.
 *
 * The FreeReps iOS companion app (App Store id6760661354) posts HealthKit data
 * straight here. There is no FreeReps server, no Postgres and no poller: the
 * app's networking is a bare `POST {base}/api/v1/ingest/` with a JSON body and
 * **no credentials of any kind** — its config model has exactly seven fields
 * (host, port, useHTTPS, testMode, testHost, testPort, backfillMonths) and none
 * of them is a token. It uses a default URLSession with no delegate, so there is
 * no certificate pinning either, and `useHTTPS` is a toggle. Verified by reading
 * the app source, not assumed.
 *
 * That is why this module exists rather than a client for FreeReps' own API:
 * standing up a Go server and a TimescaleDB purely to receive a JSON POST and
 * hand it on would have meant a second copy of every reading and an
 * eventual-consistency gap between two stores.
 *
 * This file is PURE — parsing and mapping only, no DB and no network — so the
 * wire contract can be pinned by tests without a database. Same split as
 * `pi-health.assess()` and `one-to-one-detect.cadenceState()`.
 *
 * Payload is Health Auto Export format:
 *   { data: { metrics: [ { name, units, data: [ { date, qty, source_uuid,
 *                                                Min, Avg, Max } ] } ],
 *             category_samples: [ { id, type, value, value_label,
 *                                   start_date, end_date, source } ],
 *             workouts: [...], ecg_recordings: [...], ... } }
 */

// Six metrics already have NEURO names, and existing consumers read those names:
// `stress-score` queries 'hrv' and 'heartRate', and `routes/health.js` lists all
// six in SERIES_METRICS. Renaming them to the HAE spelling would silently empty
// the stress baseline, so the HAE name is mapped onto the existing one instead.
// Everything else keeps its HAE snake_case name verbatim — Nick asked for every
// metric the app offers, and an allowlist is a thing that has to be maintained
// forever and is wrong the moment Apple adds a type.
const NEURO_ALIAS = {
  heart_rate_variability: 'hrv',
  resting_heart_rate: 'rhr',
  heart_rate: 'heartRate',
  step_count: 'steps',
  active_energy: 'activeEnergy',
  respiratory_rate: 'respiratoryRate',
};

// Units are checked ONLY for the metrics something actually interprets. A silent
// unit change on HRV would not error anywhere — it would quietly rescale a
// 14-day baseline, and the score would look plausible and be wrong. HealthKit
// stores HRV SDNN in seconds natively and the app converts to ms
// (`.secondUnit(with: .milli)`, unitString "ms"), so both are handled and
// anything else is rejected rather than stored at an unknown scale.
const UNIT_RULES = {
  hrv: { ms: 1, s: 1000 },
  heartRate: { bpm: 1, 'count/min': 1 },
  rhr: { bpm: 1, 'count/min': 1 },
};

const SLEEP_TYPE_RE = /sleepanalysis/i;

// Optional denylist, read from APPLE_HEALTH_EXCLUDE as a comma-separated list of
// HAE names. Empty by default: Nick asked for everything the app offers, and
// this is the switch for changing his mind, not a decision taken for him.
//
// It exists because the first backfill measured the cost — `physical_effort`
// alone was 38,460 rows in six months, 65% of everything ingested, and
// `basal_energy_burned` is the one FreeReps' own uploader refuses outright
// ("~8 MB/day of estimated BMR data, not useful"). Both are estimates rather
// than measurements. Excluded metrics are COUNTED and reported, never silently
// dropped — a payload that shrinks with no explanation is the thing this
// codebase keeps having to debug.
function excludedMetrics() {
  return new Set(
    String(process.env.APPLE_HEALTH_EXCLUDE || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

/**
 * Parse the wire date format: "2006-01-02 15:04:05 -0700" (FreeReps'
 * HealthTimeLayout), returning 'YYYY-MM-DD HH:MM:SS' in UTC to match what
 * `routes/health.js` already stores — string comparison in the baseline queries
 * is also chronological comparison, which only holds if everything is UTC.
 *
 * Parsed explicitly rather than handed to `new Date()`. V8 does accept this
 * shape (checked on the Pi's Node 22.22.2 as well as locally), but that is
 * lenient non-standard behaviour rather than a guarantee, and the whole series
 * would shift by an offset if it ever changed.
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(?:(Z)|([+-]\d{2}):?(\d{2}))?$/;

function parseHealthDate(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const m = DATE_RE.exec(s);
  let ms;

  if (m) {
    const [, y, mo, d, h, mi, sec, z, offH, offM] = m;
    ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
    if (!z && offH !== undefined) {
      const sign = offH.startsWith('-') ? -1 : 1;
      ms -= sign * ((Math.abs(+offH) * 60) + (+offM)) * 60000;
    }
    // No zone at all: treat as UTC rather than guessing the host's zone. The Pi
    // may run UTC while the phone is in BST, and guessing is how a reading lands
    // an hour out with nothing to show for it.
  } else {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    ms = d.getTime();
  }

  const out = new Date(ms);
  if (isNaN(out.getTime())) return null;
  return out.toISOString().replace('T', ' ').slice(0, 19);
}

function metricName(haeName) {
  const key = String(haeName || '').trim();
  if (!key) return null;
  return NEURO_ALIAS[key] || key;
}

/**
 * Pick the number for one data point.
 *
 * Aggregated types (heart rate is the big one) arrive as Min/Avg/Max with `qty`
 * defaulted to 0 by the Swift encoder, so reading `qty` blindly would store a
 * genuine-looking zero heart rate. Avg wins whenever it is present.
 */
function pointValue(point) {
  if (!point || typeof point !== 'object') return null;
  const avg = Number(point.Avg);
  if (Number.isFinite(avg)) return avg;
  const qty = Number(point.qty);
  if (Number.isFinite(qty)) return qty;
  return null;
}

function convertUnits(metric, value, units) {
  const rule = UNIT_RULES[metric];
  if (!rule) return { ok: true, value };
  const u = String(units || '').trim().toLowerCase();
  const factor = rule[u];
  if (factor === undefined) {
    return { ok: false, reason: `unexpected units "${units}" for ${metric}` };
  }
  return { ok: true, value: value * factor };
}

/**
 * Turn the quantity `metrics` array into flat samples.
 * Never invents a reading: a point without a usable number or a parseable date
 * is counted as rejected and named, not silently dropped.
 */
function parseMetrics(metrics, out, excluded) {
  if (!Array.isArray(metrics)) return;

  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') continue;
    const name = metricName(metric.name);
    if (!name || !Array.isArray(metric.data)) continue;

    // Checked against BOTH spellings: the denylist is written in HAE names
    // (what the app sends and what Nick reads in the logs), but six of them are
    // stored under a NEURO name, so matching only one would silently miss them.
    if (excluded && (excluded.has(metric.name) || excluded.has(name))) {
      out.excluded[name] = (out.excluded[name] || 0) + metric.data.length;
      continue;
    }

    for (const point of metric.data) {
      out.received++;
      const raw = pointValue(point);
      if (raw === null) {
        out.rejected.push({ metric: name, reason: 'no numeric value' });
        continue;
      }

      const recordedAt = parseHealthDate(point && point.date);
      if (!recordedAt) {
        out.rejected.push({ metric: name, reason: `unparseable date "${point && point.date}"` });
        continue;
      }

      const converted = convertUnits(name, raw, metric.units);
      if (!converted.ok) {
        out.rejected.push({ metric: name, reason: converted.reason });
        continue;
      }

      out.samples.push({
        metric: name,
        value: converted.value,
        recordedAt,
        sourceUuid: point.source_uuid || null,
        units: metric.units || null,
      });
    }
  }
}

/**
 * Sleep, from `category_samples`.
 *
 * Stored as one sample per SEGMENT, valued in hours and stamped at the segment
 * start — deliberately raw. Rolling segments up into "last night" needs a
 * decision about which night a 01:30 segment belongs to, and inventing that
 * silently here would bake a day-boundary rule into the ingest where nothing
 * could see it. Nightly aggregation is a follow-up on top of this data.
 *
 * Non-sleep category samples (symptoms, handwashing, mindfulness…) are counted
 * and reported but NOT stored: they are events, not scalars, and coercing them
 * into a numeric time series would fill the table with metrics nothing reads.
 */
function parseCategorySamples(samples, out) {
  if (!Array.isArray(samples)) return;

  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    if (!SLEEP_TYPE_RE.test(String(s.type || ''))) {
      out.ignoredCategory++;
      continue;
    }

    out.received++;
    const start = parseHealthDate(s.start_date);
    const end = parseHealthDate(s.end_date);
    if (!start || !end) {
      out.rejected.push({ metric: 'sleep', reason: 'unparseable sleep segment dates' });
      continue;
    }

    // Re-parsed as strict ISO ('T' separator, explicit Z) for the same reason
    // parseHealthDate does not lean on `new Date()`: both forms work in V8
    // today, only one of them is specified.
    const toMs = (sql) => Date.parse(`${sql.replace(' ', 'T')}Z`);
    const hours = (toMs(end) - toMs(start)) / 3600000;
    if (!Number.isFinite(hours) || hours <= 0) {
      out.rejected.push({ metric: 'sleep', reason: 'non-positive sleep segment' });
      continue;
    }

    const label = String(s.value_label || 'unspecified').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    out.samples.push({
      metric: `sleep_${label}_hours`,
      value: hours,
      recordedAt: start,
      sourceUuid: s.id || null,
      units: 'h',
    });
  }
}

/**
 * Parse a whole payload.
 *
 * Returns what was understood AND what was not. The record-shaped sections
 * (workouts, ECG, audiograms, medications, state of mind, activity summaries,
 * vision prescriptions) do not fit `health_samples(metric, value, recorded_at)`
 * and are NOT stored — they are counted and named in `unstored` so the response
 * says so out loud. Accepting a payload and silently discarding half of it is
 * the failure mode this codebase keeps finding.
 */
const UNSTORED_SECTIONS = [
  'workouts', 'ecg_recordings', 'audiograms', 'activity_summaries',
  'medications', 'vision_prescriptions', 'state_of_mind',
];

function parsePayload(body) {
  const out = {
    samples: [],
    received: 0,
    rejected: [],
    ignoredCategory: 0,
    unstored: {},
    excluded: {},
  };

  const data = body && body.data;
  if (!data || typeof data !== 'object') {
    return { ...out, ok: false, error: 'payload must be { data: { ... } }' };
  }

  parseMetrics(data.metrics, out, excludedMetrics());
  parseCategorySamples(data.category_samples, out);

  for (const section of UNSTORED_SECTIONS) {
    const n = Array.isArray(data[section]) ? data[section].length : 0;
    if (n > 0) out.unstored[section] = n;
  }

  return { ...out, ok: true };
}

// ── Sleep rollup ─────────────────────────────────────────────────────────────
//
// Ingest stores sleep per SEGMENT because grouping them into nights needs a
// day-boundary rule, and burying that in the write path would have hidden it.
// This is that rule, kept separate and pure so it can be argued with and changed
// without re-ingesting anything.
//
// A segment belongs to the night you WAKE on: night = date(start + 12h). So
// 23:30 and 03:00 both land on the same morning's date, which is how Apple
// presents sleep and how anyone actually talks about it. The known wart is that
// an afternoon nap lands on the FOLLOWING night; naps are rare in this data and
// the alternative (a fixed 18:00 cut) breaks shift-shaped sleep instead.
//
// TWO SOURCES, NEVER SUMMED (#122). Every night carries a staged breakdown from
// the Watch (core/deep/rem, many segments) AND — on 324 of 728 nights — a single
// whole-night sample from a second source. They are two accounts of the same
// sleep, so adding them double-counts the night to ~2x. `asleepHours` therefore
// PREFERS the staged sum and falls back to the unspecified value only when
// there is no staged sleep at all (3 nights of 728), and `asleepSource` says
// which answered — the same honesty rule working-days.status() follows.
//
// Preferring staged is not a coin toss. Measured over the 324 both-source
// nights, the unspecified sample disagrees by more than half an hour on 241 of
// them, in BOTH directions: it over-states by up to 3.4h and under-states by up
// to 9.7h (2025-05-24 recorded 0.33h against 10.08h of staged sleep). It is not
// a reliable whole-night figure, and the staged segments are the ones the card
// is built to draw.
const STAGED_ASLEEP = new Set(['deep', 'rem', 'core', 'light']);
const UNSPECIFIED_ASLEEP = new Set(['unspecified', 'asleep']);
const AWAKE_STAGES = new Set(['awake']);
const IN_BED_STAGES = new Set(['in_bed']);

// Apple labels the stages "Asleep Core" / "Asleep REM" / "Asleep Deep", which
// ingest slugs to `asleep_core` and friends. Consumers — this rollup, the route
// and the card — were all written against a guessed `core`. Canonicalise here,
// once, rather than teaching three places the same aliases.
const STAGE_ALIASES = {
  asleep_core: 'core',
  asleep_rem: 'rem',
  asleep_deep: 'deep',
  asleep_light: 'light',
  asleep_unspecified: 'unspecified',
  asleepunspecified: 'unspecified',
  asleep_awake: 'awake',
  inbed: 'in_bed',
};

function sleepStage(metric) {
  const m = /^sleep_(.+)_hours$/.exec(String(metric || ''));
  if (!m) return null;
  return STAGE_ALIASES[m[1]] || m[1];
}

function nightKey(sqlUtc) {
  const ms = Date.parse(`${String(sqlUtc).replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 12 * 3600000).toISOString().slice(0, 10);
}

/**
 * Group stored sleep segments into nights.
 * `rows` are health_samples rows: { metric, value, recorded_at }.
 *
 * Efficiency is asleep / inBed and is null when there is no In Bed data at all,
 * rather than falling back to asleep/asleep — which would report a confident
 * 100% for every night the watch did not record time in bed.
 */
function rollupSleepNights(rows) {
  const nights = new Map();

  for (const row of rows || []) {
    const stage = sleepStage(row && row.metric);
    if (!stage) continue;
    const key = nightKey(row.recorded_at);
    if (!key) continue;
    const hours = Number(row.value);
    if (!Number.isFinite(hours) || hours <= 0) continue;

    if (!nights.has(key)) {
      nights.set(key, { night: key, stagedHours: 0, unspecifiedHours: 0, awakeHours: 0, inBedHours: 0, stages: {}, segments: 0 });
    }
    const n = nights.get(key);
    n.segments++;
    n.stages[stage] = Math.round(((n.stages[stage] || 0) + hours) * 100) / 100;

    if (STAGED_ASLEEP.has(stage)) n.stagedHours += hours;
    else if (UNSPECIFIED_ASLEEP.has(stage)) n.unspecifiedHours += hours;
    else if (AWAKE_STAGES.has(stage)) n.awakeHours += hours;
    else if (IN_BED_STAGES.has(stage)) n.inBedHours += hours;
  }

  return [...nights.values()]
    .map(({ stagedHours, unspecifiedHours, ...n }) => {
      const asleepHours = stagedHours > 0 ? stagedHours : unspecifiedHours;
      return {
        ...n,
        asleepHours: Math.round(asleepHours * 100) / 100,
        // Named, not inferred from `stages`, so a consumer never has to
        // re-derive the choice this function already made.
        asleepSource: stagedHours > 0 ? 'staged' : (unspecifiedHours > 0 ? 'unspecified' : 'none'),
        awakeHours: Math.round(n.awakeHours * 100) / 100,
        inBedHours: Math.round(n.inBedHours * 100) / 100,
        efficiency: n.inBedHours > 0 ? Math.round((asleepHours / n.inBedHours) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => (a.night < b.night ? 1 : -1));
}

module.exports = {
  rollupSleepNights,
  sleepStage,
  nightKey,
  excludedMetrics,
  parsePayload,
  parseHealthDate,
  metricName,
  pointValue,
  convertUnits,
  NEURO_ALIAS,
  UNIT_RULES,
  UNSTORED_SECTIONS,
};
