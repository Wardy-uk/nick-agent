'use strict';

const express = require('express');
const router = express.Router();
const briefingService = require('../services/briefing');

// GET /api/briefing — return the last stored brief
router.get('/', (req, res) => {
  const brief = briefingService.getLastBrief();
  if (!brief) return res.json({ brief: null, message: 'No brief generated yet' });
  res.json({ brief });
});

// POST /api/briefing/trigger — manually trigger a brief (for testing)
router.post('/trigger', async (req, res) => {
  try {
    const brief = await briefingService.buildAndDeliver({ label: req.body?.label || 'manual' });
    res.json({ ok: true, brief });
  } catch (e) {
    console.error('[Briefing route] Trigger error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
