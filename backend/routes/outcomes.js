'use strict';

/**
 * Outcomes API — is the system helping?
 *
 * GET  /api/outcomes           — last 8 weeks plus this week live, and the trend
 * POST /api/outcomes/snapshot  — force a snapshot of the current week
 */

const express = require('express');
const router = express.Router();
const outcomes = require('../services/outcomes');

router.get('/', (req, res) => {
  try {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 8, 2), 26);
    res.json({ weeks: outcomes.recent(weeks), trend: outcomes.trend(5) });
  } catch (e) {
    console.error('[Outcomes] Read failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/snapshot', (req, res) => {
  try {
    res.json({ ok: true, snapshot: outcomes.snapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
