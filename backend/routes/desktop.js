'use strict';

/**
 * /api/desktop — where the Windows reporter posts what the laptop is doing.
 *
 * ⚠ The reporter sends the FOREGROUND PROCESS NAME and nothing else. Never a
 * window title, never a path, never a URL. See the header of
 * services/desktop-activity.js for why that line matters on this machine
 * specifically — and note the service sanitises again on the way in, so a
 * careless future reporter is truncated here rather than trusted.
 *
 * Machine client: authenticated by the app-level NEURO_API_TOKEN header like
 * n8n and the other scheduled callers, not by the PIN.
 */

const express = require('express');
const router = express.Router();
const desktop = require('../services/desktop-activity');

// POST /api/desktop/activity — one sample, or a batch after the laptop wakes.
router.post('/activity', (req, res) => {
  try {
    const body = req.body || {};
    const batch = Array.isArray(body.samples) ? body.samples : [body];
    if (!batch.length) return res.status(400).json({ error: 'no samples' });
    // A reporter catching up after a sleep can post a backlog, but not an
    // unbounded one — a runaway client must not be able to fill agent_state.
    if (batch.length > 60) return res.status(400).json({ error: 'at most 60 samples per call' });

    const stored = batch.map(s => desktop.record(s));
    res.json({ ok: true, stored: stored.length, sample: stored[stored.length - 1] });
  } catch (e) {
    console.error('[Desktop] record failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/desktop/activity — the current read. Read-only, nothing notifies.
router.get('/activity', (req, res) => {
  try {
    const now = new Date();
    res.json({
      run: desktop.run(now),
      present: desktop.present(now),
      // Which machines are reporting, and when each last spoke. Names only — a
      // hostname is not what the privacy line is about, and without this a
      // second machine that quietly stopped reporting is invisible.
      hosts: desktop.hosts(),
      // Deliberately NOT the samples themselves. They are a rolling record of
      // which app was in front of him minute by minute, and there is no reason
      // for a browser to hold that — the derived answer is the useful part.
      sampleCount: desktop.samples().length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/desktop/daily?days=30 — the kept history, newest first, one row per
// machine per day. Read-only.
//
// ⚠ Rows are NOT summed across machines here or anywhere else: two hosts used in
// the same hour each counted that hour, and the samples needed to take a union
// are long gone. A caller that wants one number per day has to say which machine
// it means.
router.get('/daily', (req, res) => {
  try {
    const daily = require('../services/desktop-daily');
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const completeOnly = req.query.completeOnly === 'true';
    const host = req.query.host || null;
    const rows = daily.recentDays(days, { completeOnly, host });
    res.json({
      days: rows,
      // What the rollup could see, so an empty list is never mistaken for an
      // empty diary: no rows plus a live agent means the rollup has not run yet.
      hosts: require('../services/desktop-activity').hosts(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/desktop/daily/sync — roll the live buffer now. The hourly job does
// this; the route exists so a deploy does not have to wait up to an hour to see
// whether the change worked.
router.post('/daily/sync', (req, res) => {
  try {
    res.json(require('../services/desktop-daily').sync());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
