'use strict';

/**
 * GET /api/friction — what has actually got in the way, with the evidence.
 *
 * READ-ONLY, and it must stay so: this is rendered on the execution surface and
 * polled alongside it, so it must never be the reason something changed
 * (`state-of-play`'s rule).
 *
 * Deliberately NOT a dashboard of its own. It is one small section under the
 * thing Nick is trying to start, because a page about how hard his week has
 * been is a page that gets opened once.
 */

const express = require('express');
const router = express.Router();
const friction = require('../services/friction');

router.get('/', (req, res) => {
  try {
    res.json(friction.build(new Date()));
  } catch (e) {
    console.error('[Friction] build failed:', e.message);
    // An error is not "nothing in your way" — the same distinction the
    // attention pool draws between an unreadable feed and a calm one.
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
