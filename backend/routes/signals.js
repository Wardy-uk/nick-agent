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

// GET /api/signals/room — which room, and nothing else.
//
// Hung here rather than on a router of its own because it belongs to the same
// question this file already answers ("what can she sense") and because
// server.js is regularly held open by a concurrent session on this repo.
//
// ⚠ It exists so the header does not poll `/api/attention/context`, which runs
// a full gather — Home Assistant, the calendar, location, working days — on
// every call. A banner refreshing every half minute must cost approximately
// nothing; `room-presence` holds a 5s cache, so this is a memory read most times
// it is asked.
router.get('/room', async (req, res) => {
  try {
    const roomPresence = require('../services/room-presence');
    const r = await roomPresence.read();
    // `known: false` with a reason is a 200, not an error: not being able to
    // place him is a normal state of the world, and a 500 here would light up
    // as a fault every time he stands in the hall.
    res.json(r);
  } catch (e) {
    res.status(500).json({ known: false, room: null, why: e.message });
  }
});

module.exports = router;
