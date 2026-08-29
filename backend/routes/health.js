'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const stressScore = require('../services/stress-score');
const appleHealth = require('../services/apple-health');
const healthDaily = require('../services/health-daily');

// What the legacy flat-key ingest can store, and under which canonical metric
// name. This route predates the FreeReps app and survives as the iOS Shortcut
// fallback; the app itself posts to /api/v1/ingest/ (routes/apple-health.js).
//
// ⚠ It used to write a daily KV blob in agent_state ALONGSIDE these samples, and
// that blob was what /today, /history, /status, chat context and the journal
// prompt all read. When the phone moved to the app, the blob stopped being
// written and all five went quiet — for months, silently, because a missing blob
// reads as "no data yet". The blob is gone: everything derives from
// health_samples now, so a second writer cannot fall behind the first.
const FLAT_KEY_METRICS = {
  hrv: 'hrv',
  rhr: 'rhr',
  heartRate: 'heartRate',
  steps: 'steps',
  activeEnergy: 'activeEnergy',
  respiratoryRate: 'respiratoryRate',
  vo2max: 'vo2_max',
  bodyWeight: 'weight_body_mass',
};

// Accepted by the old payload but NOT storable as a scalar sample: sleep lives
// in health_samples as per-SEGMENT rows and is rolled into nights at read time,
// so a single "sleepDuration: 7.4" cannot be written without inventing segments
// that were never recorded. Reported back rather than silently dropped.
const FLAT_KEYS_UNSTORABLE = [
  'sleepDuration', 'sleepDeep', 'sleepRem', 'sleepAwake', 'sleepEfficiency',
];

// Store UTC as 'YYYY-MM-DD HH:MM:SS' so string comparison in the baseline
// queries is also chronological comparison.
function toSqlUtc(input) {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().replace('T', ' ').slice(0, 19);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Two shapes are accepted, because the phone side is not settled yet:
//   1. a `samples` array of {metric, value, recordedAt} — real per-reading
//      timestamps, which is what a proper baseline wants
//   2. the existing flat keys, stamped with one timestamp for the whole post
// Both funnel into the same INSERT OR IGNORE, so overlapping posts fold.
//
// Returns what it stored AND what it could not, because a payload that shrinks
// with no explanation is the thing this codebase keeps having to debug.
function recordSamples(payload) {
  const result = { written: 0, unstored: {} };

  if (Array.isArray(payload.samples)) {
    for (const s of payload.samples) {
      if (!s || !s.metric) continue;
      const metric = FLAT_KEY_METRICS[s.metric] || appleHealth.metricName(s.metric);
      const v = Number(s.value);
      if (!metric || !isFinite(v)) {
        result.unstored[s.metric || 'unnamed'] = (result.unstored[s.metric || 'unnamed'] || 0) + 1;
        continue;
      }
      if (db.insertHealthSample(metric, v, toSqlUtc(s.recordedAt), 'ingest')) result.written++;
    }
    return result;
  }

  const stamp = toSqlUtc(payload.timestamp);
  for (const [key, metric] of Object.entries(FLAT_KEY_METRICS)) {
    const v = Number(payload[key]);
    if (!isFinite(v) || payload[key] === null || payload[key] === undefined) continue;
    if (db.insertHealthSample(metric, v, stamp, 'ingest')) result.written++;
  }
  for (const key of FLAT_KEYS_UNSTORABLE) {
    if (payload[key] !== null && payload[key] !== undefined) result.unstored[key] = 1;
  }
  return result;
}

// POST /api/health/ingest — receive Apple Health data from iOS Shortcut
// Secured with a simple token (INGEST_SECRET env var, same as used elsewhere)
router.post('/ingest', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const expected = process.env.INGEST_SECRET || '';

  if (expected && token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }

    const todayKey = new Date().toISOString().split('T')[0];
    const date = payload.date || todayKey;

    // ONE store. Samples go into health_samples and every reader derives from
    // there — see the note on FLAT_KEY_METRICS for what the second store cost.
    const stored = recordSamples(payload);

    const unstored = Object.keys(stored.unstored);
    console.log(`[Health] Ingest for ${date}: ${stored.written} sample(s) stored` +
      (unstored.length ? `, ${unstored.length} field(s) not storable: ${unstored.join(', ')}` : ''));

    res.json({
      success: true,
      date,
      samplesStored: stored.written,
      // Named, never silently dropped. Sleep is the one that matters here: it is
      // stored per segment and cannot be reconstructed from a nightly total.
      unstored: stored.unstored,
    });
  } catch (e) {
    console.error('[Health] Ingest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/today — today's rolled-up day, plus the readiness read.
//
// Never serves yesterday as today: a stale figure presented as current is the
// failure this whole area has just been dug out of.
router.get('/today', (req, res) => {
  try {
    const snapshot = healthDaily.today();
    res.json({
      date: snapshot.day,
      data: snapshot.data,
      readiness: snapshot.readiness,
      sentence: snapshot.sentence,
      // "Nothing has arrived yet today" and "the rollup has not run" are
      // different problems and must not share an empty response.
      note: snapshot.data ? null : 'No health data recorded yet today',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/history?days=7 — the last N days, newest first.
router.get('/history', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 365);
    const history = healthDaily.recentDays(days);
    res.json({ history, days, hasData: history.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/readiness — how much this body has to give today, and why.
router.get('/readiness', (req, res) => {
  try {
    const snapshot = healthDaily.today();
    res.json({ date: snapshot.day, ...snapshot.readiness, sentence: snapshot.sentence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/signals — what has CHANGED, ranked. Trends, not today's
// numbers: a resting heart rate held 4bpm high for three days is not visible in
// any single reading. Pull-only — nothing here notifies.
router.get('/signals', (req, res) => {
  try {
    res.json(require('../services/health-signals').snapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/health/rollup — recompute the daily rollup now. Idempotent (every
// row is an UPSERT keyed on the day), so this is safe to hit repeatedly; the
// scheduler runs it hourly anyway.
router.post('/rollup', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || healthDaily.SYNC_WINDOW_DAYS, 1), 3650);
    res.json(healthDaily.sync({ days }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/stress — current stress score against a rolling personal baseline.
// Returns status 'calibrating' until there is enough history to mean anything.
router.get('/stress', (req, res) => {
  try {
    res.json(stressScore.computeStressScore());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/status — is health data available and fresh?
//
// Freshness comes from the newest SAMPLE, not from whether a rollup row exists:
// the rollup writes a row for every day in its window whether the phone synced
// or not, so "a row exists" is not "data arrived".
router.get('/status', (req, res) => {
  try {
    const all = db.getHealthMetricSummary(null);
    const newest = all.reduce((m, r) => (!m || r.last_at > m ? r.last_at : m), null);
    const ageHours = newest
      ? Math.round(((Date.now() - Date.parse(`${String(newest).replace(' ', 'T')}Z`)) / 3600000) * 10) / 10
      : null;
    res.json({
      hasToday: require('../services/health').getTodayData() !== null,
      latestSampleAt: newest,
      ageHours,
      metricCount: all.length,
      totalSamples: all.reduce((n, r) => n + r.samples, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/metrics — what is actually in the series, per metric (#40).
//
// The point of this is freshness, not volume. iOS decides when the phone syncs
// (BGProcessingTask is a request, not a schedule, and stops entirely after a
// force-quit), so a feed going quiet is the EXPECTED failure. `lastAt` and
// `ageHours` are what make that visible; a row count alone cannot.
router.get('/metrics', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
    const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const now = Date.now();

    const metrics = db.getHealthMetricSummary(since).map((row) => ({
      metric: row.metric,
      samples: row.samples,
      firstAt: row.first_at,
      lastAt: row.last_at,
      ageHours: row.last_at
        ? Math.round(((now - Date.parse(`${row.last_at.replace(' ', 'T')}Z`)) / 3600000) * 10) / 10
        : null,
    }));

    // All-time context alongside the window, because during a backfill they
    // disagree wildly and the window alone is misleading. Measured live: 161,637
    // rows spanning Aug 2024 → Nov 2025 while the 30-day window was EMPTY,
    // because the app backfills forward chronologically and had not yet reached
    // the present. Reporting only the window would have said "no data" over a
    // table with 161k rows in it — indistinguishable from a broken feed.
    const all = db.getHealthMetricSummary(null);
    const newestAt = all.reduce((m, r) => (!m || r.last_at > m ? r.last_at : m), null);
    const oldestAt = all.reduce((m, r) => (!m || r.first_at < m ? r.first_at : m), null);

    res.json({
      windowDays: days,
      metricCount: metrics.length,
      totalSamples: metrics.reduce((n, m) => n + m.samples, 0),
      metrics,
      allTime: {
        metricCount: all.length,
        samples: all.reduce((n, r) => n + r.samples, 0),
        oldestAt,
        newestAt,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/sleep — per-night totals from the per-segment rows (#40).
//
// The ingest deliberately stores segments raw because grouping them needs a
// day-boundary rule; that rule lives in apple-health.rollupSleepNights and is
// applied here at read time, so changing it never means re-ingesting.
router.get('/sleep', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    // Reach back an extra day: a night is keyed by its WAKE date, so the
    // earliest night in the window has segments that started before it.
    const since = new Date(Date.now() - (days + 1) * 86400000).toISOString().replace('T', ' ').slice(0, 19);

    // Fetched by PREFIX, never by a list of stage names (#122). The list here
    // asked for `sleep_core_hours`; Apple's label is `sleep_asleep_core_hours`,
    // so the staged breakdown returned zero rows on every night and the card's
    // stage bar was empty by construction — silently, because a wrong metric
    // name is an empty result, not an error.
    const rows = db.getSleepSamples(since, 20000);

    const nights = appleHealth.rollupSleepNights(rows).slice(0, days);
    res.json({
      windowDays: days,
      nights,
      // Distinguishes "no sleep data at all" from "nothing recent" — with iOS
      // deciding when the phone syncs, those are different problems.
      hasData: nights.length > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
