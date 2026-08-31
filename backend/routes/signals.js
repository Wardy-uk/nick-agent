'use strict';

/**
 * /api/signals — every sense SARA has, and whether it is actually working.
 *
 * READ-ONLY. This page must never be the reason something changed.
 */

const express = require('express');
const router = express.Router();
const signals = require('../services/signals');

router.get('/', (req, res) => {
  try {
    res.json(signals.snapshot());
  } catch (e) {
    console.error('[Signals] snapshot failed:', e.message);
    // An error is NOT a healthy set of senses. A 200 with an empty list here
    // would render as "everything is fine", which is the exact failure this
    // whole page exists to make impossible.
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
