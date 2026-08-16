'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const stressScore = require('../services/stress-score');
const appleHealth = require('../services/apple-health');

// Metrics kept as a time series in health_samples. Everything else still only
// lands in the daily KV blob — a stress baseline needs history, a body weight
// does not.
const SERIES_METRICS = [
  'hrv', 'rhr', 'heartRate', 'steps', 'activeEnergy', 'respiratoryRate'
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
function recordSamples(payload) {
  let written = 0;

  if (Array.isArray(payload.samples)) {
    for (const s of payload.samples) {
      if (!s || !SERIES_METRICS.includes(s.metric)) continue;
      const v = Number(s.value);
      if (!isFinite(v)) continue;
      if (db.insertHealthSample(s.metric, v, toSqlUtc(s.recordedAt), 'ingest')) written++;
    }
    return written;
  }

  const stamp = toSqlUtc(payload.timestamp);
  for (const metric of SERIES_METRICS) {
    const v = Number(payload[metric]);
    if (!isFinite(v) || payload[metric] === null || payload[metric] === undefined) continue;
    if (db.insertHealthSample(metric, v, stamp, 'ingest')) written++;
  }
  return written;
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

    // Store each metric separately so individual fields can be queried
    // Also store the full payload for reference
    const entry = {
      date: payload.date || todayKey,
      hrv: payload.hrv || null,                          // ms — HRV SDNN
      rhr: payload.rhr || null,                          // bpm — resting heart rate
      sleepDuration: payload.sleepDuration || null,      // hours
      sleepDeep: payload.sleepDeep || null,              // hours
      sleepRem: payload.sleepRem || null,                // hours
      sleepAwake: payload.sleepAwake || null,            // hours
      sleepEfficiency: payload.sleepEfficiency || null,  // 0-100%
      steps: payload.steps || null,                      // count
      activeEnergy: payload.activeEnergy || null,        // kcal
      vo2max: payload.vo2max || null,                    // mL/kg/min
      respiratoryRate: payload.respiratoryRate || null,  // breaths/min
      heartRate: payload.heartRate || null,              // bpm — current, not resting
      bodyWeight: payload.bodyWeight || null,            // kg
      timestamp: new Date().toISOString()
    };

    // Store keyed by date so today's data overwrites stale data.
    // MERGE rather than replace: at a 30-minute polling cadence most posts carry
    // only some metrics (the watch samples HRV a handful of times a day), and a
    // straight overwrite would null out this morning's HRV every half hour.
    const stateKey = `health_data_${entry.date}`;
    let merged = entry;
    try {
      const prevRaw = db.getState(stateKey);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        if (prev && prev.date === entry.date) {
          merged = { ...prev };
          for (const [k, v] of Object.entries(entry)) {
            if (v !== null && v !== undefined) merged[k] = v;
          }
        }
      }
    } catch { /* corrupt previous blob — fall back to this post alone */ }

    db.setState(stateKey, JSON.stringify(merged));

    // Also store as 'health_latest' for quick access without knowing the date
    db.setState('health_latest', JSON.stringify(merged));

    // Append to the time series that backs the stress baseline
    const seriesWritten = recordSamples(payload);

    console.log(`[Health] Ingested data for ${entry.date}:`,
      `HRV=${entry.hrv}ms RHR=${entry.rhr}bpm sleep=${entry.sleepDuration}h steps=${entry.steps}`
    );

    res.json({
      success: true,
      date: entry.date,
      received: Object.keys(entry).filter(k => entry[k] !== null).length + ' fields',
      samplesStored: seriesWritten
    });
  } catch (e) {
    console.error('[Health] Ingest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/today — retrieve today's health data
router.get('/today', (req, res) => {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const raw = db.getState(`health_data_${todayKey}`) || db.getState('health_latest');
    if (!raw) return res.json({ data: null, date: todayKey });
    const data = JSON.parse(raw);
    // Only return today's data — don't surface stale yesterday data as "today"
    if (data.date !== todayKey) return res.json({ data: null, date: todayKey, note: 'No data yet today' });
    res.json({ data, date: todayKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/history?days=7 — last N days of health data
router.get('/history', (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const results = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const raw = db.getState(`health_data_${dateKey}`);
      if (raw) {
        try { results.push(JSON.parse(raw)); } catch {}
      }
    }
    res.json({ history: results, days });
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
router.get('/status', (req, res) => {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const raw = db.getState(`health_data_${todayKey}`);
    const latestRaw = db.getState('health_latest');
    const latest = latestRaw ? JSON.parse(latestRaw) : null;
    res.json({
      hasToday: !!raw,
      latestDate: latest?.date || null,
      latestTimestamp: latest?.timestamp || null
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

    const rows = [];
    for (const stage of ['deep', 'rem', 'core', 'light', 'awake', 'in_bed', 'inbed', 'asleep', 'unspecified', 'asleep_unspecified', 'asleepunspecified']) {
      for (const r of db.getHealthSamples(`sleep_${stage}_hours`, since, 5000)) {
        rows.push({ metric: `sleep_${stage}_hours`, value: r.value, recorded_at: r.recorded_at });
      }
    }

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
