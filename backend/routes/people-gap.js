'use strict';

/**
 * People gap API.
 *   GET  /api/people-gap             — scan (read-only)
 *   POST /api/people-gap/report      — scan + write the Vault Audit report
 *   POST /api/people-gap/apply       — create stub People notes
 *
 * Apply is deliberately a separate call: the nightly pass only ever reports.
 */

const express = require('express');
const router = express.Router();
const peopleGap = require('../services/people-gap');

router.get('/', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const minSightings = Math.max(parseInt(req.query.minSightings, 10) || 2, 1);
    res.json(peopleGap.findGaps({ days, minSightings }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

router.post('/report', (req, res) => {
  try {
    res.json(peopleGap.runNightlyScan({ days: req.body?.days || 90 }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

router.post('/apply', (req, res) => {
  try {
    const { names, days = 90, minSightings = 2, dryRun = false } = req.body || {};
    res.json(peopleGap.createStubs({ names, days, minSightings, dryRun }));
  } catch (e) {
    console.error('[people-gap]', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

module.exports = router;
