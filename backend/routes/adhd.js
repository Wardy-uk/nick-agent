'use strict';

/**
 * ADHD dashboard API.
 *
 * GET  /api/adhd            — the whole panel in one call
 * POST /api/adhd/win        — log a win that has no other home ("I did a thing")
 *
 * One endpoint by design: this view is read at moments of low executive function,
 * so it loads in a single request and never renders half-populated.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const adhd = require('../services/adhd-dashboard');

router.get('/', async (req, res) => {
  try {
    res.json(await adhd.build());
  } catch (e) {
    console.error('[ADHD] Build failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Not everything that counts goes through the task store — meetings survived,
// a hard conversation had, an hour of actual focus. If it isn't loggable it
// doesn't show up in momentum, and a day of real work reads as an empty one.
router.post('/win', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    db.logActivity('task_done', { text, source: 'manual-win' });
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
