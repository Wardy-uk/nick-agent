'use strict';

const express = require('express');
const router = express.Router();
const piHealth = require('../services/pi-health');

// GET /api/pi-health — full system snapshot for the Pi Health dashboard
router.get('/', async (req, res) => {
  try {
    res.json(await piHealth.collect());
  } catch (e) {
    console.error('[PiHealth] collect failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/pi-health/watchdog — run the checks on demand.
// ?notify=1 actually sends the push; default is a dry run so the alerting can
// be inspected without paging anyone.
router.get('/watchdog', async (req, res) => {
  try {
    const notify = req.query.notify === '1';
    res.json(await require('../services/watchdog').run({ notify }));
  } catch (e) {
    console.error('[PiHealth] watchdog failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
