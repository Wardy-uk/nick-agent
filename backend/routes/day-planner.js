'use strict';

const express = require('express');
const router = express.Router();
const planner = require('../services/day-planner');

/**
 * What WOULD be blocked. Creates nothing — looking must always be safe, and a
 * dry run must stay possible even mid-pass, so this deliberately takes no lock.
 *
 *   GET /api/day-plan?window=morning|afternoon
 */
router.get('/', async (req, res) => {
  try {
    const window = req.query.window === 'afternoon' ? 'afternoon' : 'morning';
    res.json(await planner.run(window, { apply: false }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Create the blocks for one half-day.
 *
 * `force` re-plans a half-day already in the ledger — needed because a diary
 * that changed after the morning run is the normal case, not an edge one. It is
 * NOT a way round the lock.
 *
 *   POST /api/day-plan/apply  { window, force }
 */
router.post('/apply', async (req, res) => {
  try {
    const window = req.body?.window === 'afternoon' ? 'afternoon' : 'morning';
    const result = await planner.run(window, { apply: true, force: Boolean(req.body?.force) });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Forget that a half-day was planned, so it can be planned again.
 *
 * The way back, and it is not optional. The ledger is what stops a re-run
 * double-booking; without a way to clear an entry, a half-day whose blocks Nick
 * deleted could never be replanned — and deleting a block is a DECISION, so the
 * planner must not simply notice and recreate it.
 */
router.post('/forget', (req, res) => {
  const { dateKey, window } = req.body || {};
  if (!dateKey || !window) {
    return res.status(400).json({ ok: false, error: 'dateKey and window are both required' });
  }
  planner.forget(dateKey, window);
  res.json({ ok: true, forgotten: `${dateKey}:${window}` });
});

/** The ledger itself, so "why did nothing happen this morning?" is answerable. */
router.get('/ledger', (req, res) => {
  res.json({ ok: true, enabled: planner.ENABLED, ledger: planner.ledger() });
});

module.exports = router;
