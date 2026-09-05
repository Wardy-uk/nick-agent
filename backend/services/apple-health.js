'use strict';

// The only import in this file, and a node builtin rather than a dependency —
// so the parser stays testable without a database, a network or a compiled
// native module. Used solely to hash a document into a dedupe key for records
// that arrive without an id.
const crypto = require('crypto');

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
 * ⚠ Non-sleep category samples (symptoms, handwashing, mindfulness…) are stored
 * as DOCUMENTS in `health_records`, as of 5 Sep 2026. They were previously
 * counted and dropped, and the reasoning still holds as far as it went — they
 * are events, not scalars, and coercing them into a numeric time series would
 * fill `health_samples` with metrics nothing reads. The error was treating "it
 * does not fit this table" as "it does not belong anywhere". `ignoredCategory`
 * survives as a COUNT of how many took the document route, so the response
 * still says out loud what happened to them.
 */
function parseCategorySamples(samples, out) {
  if (!Array.isArray(samples)) return;

  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    if (!SLEEP_TYPE_RE.test(String(s.type || ''))) {
      out.ignoredCategory++;
      out.recordsReceived++;
      const rec = toRecord('category_sample', s);
      if (!rec.startedAt) {
        out.recordsWithoutDate.category_sample = (out.recordsWithoutDate.category_sample || 0) + 1;
      }
      out.records.push(rec);
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

// ── Workouts ─────────────────────────────────────────────────────────────────

/**
 * Distance and energy units, and what one of each is worth in the stored unit.
 *
 * Stored units are METRES and KCAL. ⚠ An unrecognised unit is REFUSED, never
 * stored at unknown scale — the same rule `UNIT_RULES` applies to hrv, and for
 * the same reason: a 5km run stored as 5 is not a small error, it is a
 * different fact.
 */
const DISTANCE_UNITS = { m: 1, metre: 1, meter: 1, metres: 1, meters: 1, km: 1000, mi: 1609.344, mile: 1609.344, miles: 1609.344, yd: 0.9144 };
const ENERGY_UNITS = { kcal: 1, cal: 0.001, kj: 0.239006, calories: 1, kilocalories: 1 };

/**
 * The fields this parser understands, in every spelling it has been taught.
 *
 * ⚠ This was written WITHOUT a real Health Auto Export workout payload to read
 * — the section has always been counted and discarded, so there is no captured
 * example anywhere in the repo. The spellings below cover HAE's documented
 * shape and the obvious camelCase variants, and anything unrecognised is kept
 * in `payload` and reported in `unknownFields`. That reporting is the point:
 * the first live payload has to be able to tell us what we guessed wrong,
 * rather than quietly storing a workout with three null columns.
 */
const WORKOUT_FIELDS = {
  activityType: ['name', 'workoutActivityType', 'activityType', 'type'],
  start: ['start', 'startDate', 'start_date'],
  end: ['end', 'endDate', 'end_date'],
  duration: ['duration'],
  distance: ['distance', 'totalDistance'],
  energy: ['activeEnergyBurned', 'activeEnergy', 'totalEnergyBurned'],
  elevation: ['elevationUp', 'elevationAscended', 'totalElevationGain'],
  avgHeartRate: ['avgHeartRate', 'averageHeartRate'],
  maxHeartRate: ['maxHeartRate'],
  sourceUuid: ['id', 'uuid', 'source_uuid'],
};

/** First present spelling of a field, or undefined. */
function _field(w, names) {
  for (const n of names) if (w[n] !== undefined && w[n] !== null) return w[n];
  return undefined;
}

/**
 * A measurement that may be a bare number or HAE's `{ qty, units }` object.
 *
 * Returns `{ ok, value }` in the stored unit, or `{ ok:false, reason }`. A bare
 * number is taken at face value in the stored unit — that is a real assumption,
 * and it is why the units table refuses anything it does not recognise rather
 * than falling back to "probably metres".
 */
function _measure(raw, table, label, storedUnit) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: `${label} is not a finite number` };
  }
  if (typeof raw === 'object') {
    const qty = Number(raw.qty !== undefined ? raw.qty : raw.value);
    if (!Number.isFinite(qty)) return { ok: false, reason: `${label} has no numeric qty` };
    const units = String(raw.units || raw.unit || '').trim().toLowerCase();
    if (!units) return { ok: true, value: qty };
    const factor = table[units];
    if (factor === undefined) {
      return { ok: false, reason: `unexpected units "${raw.units || raw.unit}" for ${label} (expected ${storedUnit})` };
    }
    return { ok: true, value: qty * factor };
  }
  return { ok: false, reason: `${label} is neither a number nor a { qty, units }` };
}

/**
 * Workouts, from `data.workouts`.
 *
 * This is what retires Strava: every field `strava.formatActivity()` reads —
 * type, distance, duration, elevation, average heart rate — is here, and has
 * been arriving in the payload all along only to be counted and thrown away.
 *
 * ⚠ The one thing that does NOT come across is Strava's `suffer_score`, which
 * is proprietary and computed on their side. Nothing here reconstructs it, and
 * nothing should: an invented effort score that looks like Strava's but is not
 * would be worse than its absence.
 *
 * A workout with no parseable start is REJECTED rather than stamped with the
 * ingest time. A run whose time is "whenever the phone got signal" is not a
 * record of a run.
 */
function parseWorkouts(workouts, out) {
  if (!Array.isArray(workouts)) return;

  const known = new Set(Object.values(WORKOUT_FIELDS).flat());

  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue;
    out.workoutsReceived++;

    const startedAt = parseHealthDate(_field(w, WORKOUT_FIELDS.start));
    if (!startedAt) {
      out.rejected.push({ metric: 'workout', reason: `unparseable workout start "${_field(w, WORKOUT_FIELDS.start)}"` });
      continue;
    }

    const activityType = String(_field(w, WORKOUT_FIELDS.activityType) || '').trim();
    if (!activityType) {
      out.rejected.push({ metric: 'workout', reason: 'workout has no activity type' });
      continue;
    }

    const distance = _measure(_field(w, WORKOUT_FIELDS.distance), DISTANCE_UNITS, 'distance', 'm');
    const energy = _measure(_field(w, WORKOUT_FIELDS.energy), ENERGY_UNITS, 'activeEnergy', 'kcal');
    const elevation = _measure(_field(w, WORKOUT_FIELDS.elevation), DISTANCE_UNITS, 'elevation', 'm');
    const failed = [distance, energy, elevation].find((m) => !m.ok);
    if (failed) {
      // Refused whole rather than stored with the bad field nulled: a run with
      // a silently missing distance reads as a treadmill session.
      out.rejected.push({ metric: 'workout', reason: failed.reason });
      continue;
    }

    const endedAt = parseHealthDate(_field(w, WORKOUT_FIELDS.end));
    let durationSeconds = Number(_field(w, WORKOUT_FIELDS.duration));
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      // Derived from the span when absent, which is what HealthKit means by
      // duration anyway. Null when neither is available — never 0, which would
      // render as an instantaneous workout.
      const toMs = (sql) => Date.parse(`${sql.replace(' ', 'T')}Z`);
      durationSeconds = endedAt ? Math.round((toMs(endedAt) - toMs(startedAt)) / 1000) : null;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) durationSeconds = null;
    }

    const hr = (names) => {
      const m = _measure(_field(w, names), { bpm: 1, 'count/min': 1 }, 'heartRate', 'bpm');
      return m.ok ? m.value : null;
    };

    const extras = {};
    for (const k of Object.keys(w)) if (!known.has(k)) extras[k] = w[k];
    if (Object.keys(extras).length) {
      for (const k of Object.keys(extras)) out.unknownWorkoutFields[k] = (out.unknownWorkoutFields[k] || 0) + 1;
    }

    out.workouts.push({
      sourceUuid: _field(w, WORKOUT_FIELDS.sourceUuid) || null,
      activityType,
      startedAt,
      endedAt,
      durationSeconds,
      distanceM: distance.value,
      activeEnergyKcal: energy.value,
      elevationM: elevation.value,
      avgHeartRate: hr(WORKOUT_FIELDS.avgHeartRate),
      maxHeartRate: hr(WORKOUT_FIELDS.maxHeartRate),
      payload: Object.keys(extras).length ? extras : null,
    });
  }
}

// ── Document-shaped records ──────────────────────────────────────────────────

/**
 * Sections that are DOCUMENTS rather than numbers, and the kind each stores as.
 *
 * ⚠ All of these were counted-and-discarded until 5 Sep 2026, when Nick asked
 * for all health data to come in. `workouts` left first, to its own table,
 * because it had a consumer already waiting (Strava). The rest go to
 * `health_records` as documents — see the schema for why one generic table
 * rather than six guessed ones.
 */
const RECORD_SECTIONS = {
  ecg_recordings: 'ecg',
  audiograms: 'audiogram',
  activity_summaries: 'activity_summary',
  medications: 'medication',
  vision_prescriptions: 'vision_prescription',
  state_of_mind: 'state_of_mind',
};

/** Every spelling of a date seen across HAE's sections. */
const RECORD_START_FIELDS = ['start', 'start_date', 'startDate', 'date', 'dateIssued', 'timestamp'];
const RECORD_END_FIELDS = ['end', 'end_date', 'endDate'];
const RECORD_ID_FIELDS = ['id', 'uuid', 'source_uuid'];

function _firstField(o, names) {
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
}

/**
 * A stable key for a record, so a re-sent backfill folds rather than doubling.
 *
 * The uuid when there is one. When there is not — and HAE does not give every
 * section an id — a hash of the document, because the same document IS the same
 * observation. Keys are sorted before hashing so two encodings of one record
 * hash alike.
 */
function recordDedupeKey(record) {
  const id = _firstField(record, RECORD_ID_FIELDS);
  if (id) return String(id);
  const canonical = JSON.stringify(record, Object.keys(record).sort());
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Turn one document into a stored record.
 *
 * ⚠ A record with NO parseable date is STORED, not refused — the opposite call
 * from `parseWorkouts`, and deliberately so. A workout without a time is
 * meaningless as a workout; a medication or a vision prescription without one
 * still carries the medication. Losing it to a date-format guess would be
 * precisely the silent discarding this change exists to end, so `started_at` is
 * null and the count is reported instead.
 */
function toRecord(kind, raw) {
  const rawValue = raw.value !== undefined ? raw.value : raw.valence;
  const numericValue = rawValue !== undefined && rawValue !== null && Number.isFinite(Number(rawValue))
    ? Number(rawValue)
    : null;

  return {
    kind,
    dedupeKey: recordDedupeKey(raw),
    recordType: raw.type ? String(raw.type) : null,
    label: raw.value_label ? String(raw.value_label) : (raw.name ? String(raw.name) : null),
    startedAt: parseHealthDate(_firstField(raw, RECORD_START_FIELDS)) || null,
    endedAt: parseHealthDate(_firstField(raw, RECORD_END_FIELDS)) || null,
    // A natural scalar where one exists, as an INDEX into the document — never
    // a replacement for it.
    numericValue,
    document: raw,
  };
}

/**
 * The six document sections, plus an alarm for any section we have never seen.
 *
 * ⚠ `unstored` INVERTS MEANING here. It used to be a standing list of sections
 * discarded on purpose; it is now only sections this parser has never heard of.
 * That makes it an alarm for something Apple or HAE has ADDED, rather than an
 * inventory of things ignored by design — and an inventory nobody rereads is
 * how "we know about that one" becomes "we forgot about that one".
 */
function parseRecordSections(data, out) {
  for (const [section, kind] of Object.entries(RECORD_SECTIONS)) {
    const rows = data[section];
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      out.recordsReceived++;
      const rec = toRecord(kind, raw);
      if (!rec.startedAt) out.recordsWithoutDate[kind] = (out.recordsWithoutDate[kind] || 0) + 1;
      out.records.push(rec);
    }
  }

  const known = new Set(['metrics', 'category_samples', 'workouts', ...Object.keys(RECORD_SECTIONS)]);
  for (const key of Object.keys(data)) {
    if (known.has(key)) continue;
    const n = Array.isArray(data[key]) ? data[key].length : 0;
    if (n > 0) out.unstored[key] = n;
  }
}

/**
 * Parse a whole payload.
 *
 * Since 5 Sep 2026 there is no standing list of sections dropped on purpose:
 * metrics and sleep become samples, workouts get their own table, and every
 * other document section is stored in `health_records`. `unstored` catches only
 * sections this parser has never heard of.
 */
const UNSTORED_SECTIONS = [];

function parsePayload(body) {
  const out = {
    samples: [],
    received: 0,
    rejected: [],
    ignoredCategory: 0,
    unstored: {},
    excluded: {},
    workouts: [],
    workoutsReceived: 0,
    unknownWorkoutFields: {},
    records: [],
    recordsReceived: 0,
    recordsWithoutDate: {},
  };

  const data = body && body.data;
  if (!data || typeof data !== 'object') {
    return { ...out, ok: false, error: 'payload must be { data: { ... } }' };
  }

  parseMetrics(data.metrics, out, excludedMetrics());
  parseCategorySamples(data.category_samples, out);
  parseWorkouts(data.workouts, out);
  parseRecordSections(data, out);

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
  parseWorkouts,
  WORKOUT_FIELDS,
  DISTANCE_UNITS,
  ENERGY_UNITS,
  RECORD_SECTIONS,
  parseRecordSections,
  recordDedupeKey,
  toRecord,
};
