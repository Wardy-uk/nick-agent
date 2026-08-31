'use strict';

/**
 * /api/ambient — what SARA can notice about Nick's body and his day, on its own.
 *
 * The same block rides on `GET /api/attention`; this exists for a surface that
 * wants the observations without paying for a full decision-engine evaluation,
 * and for looking at the read directly while it is being tuned.
 *
 * READ-ONLY, and nothing here notifies.
 */

const express = require('express');
const router = express.Router();
const ambient = require('../services/ambient');

router.get('/', async (req, res) => {
  try {
    let context = null;
    try {
      const attention = require('../services/attention');
      const { inputs } = await attention.gather();
      context = require('../services/context-state').resolveContext(inputs);
    } catch {
      // Context only softens the wording and gates the meeting case. Losing it
      // is a smaller loss than refusing to answer, so it degrades rather than
      // failing — and `build` treats a null context as "not in a meeting,
      // duty unknown", which is the safe direction here (it says LESS).
    }
    res.json(await ambient.build({ context }));
  } catch (e) {
    console.error('[Ambient] build failed:', e.message);
    // An error is NOT a quiet body. Returning an empty observation list here
    // would be indistinguishable from having looked and found nothing.
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
