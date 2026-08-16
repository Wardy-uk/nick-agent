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
function parseMetrics(metrics, out) {
  if (!Array.isArray(metrics)) return;

  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') continue;
    const name = metricName(metric.name);
    if (!name || !Array.isArray(metric.data)) continue;

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
  };

  const data = body && body.data;
  if (!data || typeof data !== 'object') {
    return { ...out, ok: false, error: 'payload must be { data: { ... } }' };
  }

  parseMetrics(data.metrics, out);
  parseCategorySamples(data.category_samples, out);

  for (const section of UNSTORED_SECTIONS) {
    const n = Array.isArray(data[section]) ? data[section].length : 0;
    if (n > 0) out.unstored[section] = n;
  }

  return { ...out, ok: true };
}

module.exports = {
  parsePayload,
  parseHealthDate,
  metricName,
  pointValue,
  convertUnits,
  NEURO_ALIAS,
  UNIT_RULES,
  UNSTORED_SECTIONS,
};
