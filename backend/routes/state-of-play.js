'use strict';

const express = require('express');
const router = express.Router();
const stateOfPlay = require('../services/state-of-play');

// GET /api/state-of-play — the whole picture in one payload.
//
// One request, not nine. The panel is the first thing opened in the morning and
// on a phone over Tailscale; nine round trips is a visibly slower screen, and a
// partial render where six sections have arrived and three are spinning reads as
// "something is broken" even when everything is fine.
router.get('/', (req, res) => {
  try {
    const snapshot = stateOfPlay.snapshot();
    const issues = stateOfPlay.assess(snapshot);
    res.json({ ...snapshot, issues, overall: stateOfPlay.overall(issues) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
