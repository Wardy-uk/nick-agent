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

module.exports = router;
