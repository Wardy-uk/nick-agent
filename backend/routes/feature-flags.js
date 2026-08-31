'use strict';

const express = require('express');

const router = express.Router();
const flags = require('../services/feature-flags');

/** GET /api/feature-flags — every switch, its state, and whether it can be set. */
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, flags: flags.list() });
  } catch (e) {
    console.error('[feature-flags] read failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/feature-flags/:key — turn one switch on or off.
 *
 * An env-pinned switch is REFUSED with the reason rather than silently ignored:
 * a toggle that appears to work and changes nothing is worse than one that says
 * it cannot.
 */
router.post('/:key', (req, res) => {
  try {
    const result = flags.setEnabled(req.params.key, req.body?.enabled === true);
    res.status(result.ok ? 200 : 400).json({ ...result, flags: flags.list() });
  } catch (e) {
    console.error('[feature-flags] write failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
