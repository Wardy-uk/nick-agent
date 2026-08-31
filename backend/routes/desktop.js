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
      // Deliberately NOT the samples themselves. They are a rolling record of
      // which app was in front of him minute by minute, and there is no reason
      // for a browser to hold that — the derived answer is the useful part.
      sampleCount: desktop.samples().length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
