'use strict';

/**
 * Weekly target API — the number Nick sets on a Monday, and how far through it
 * he is.
 *
 * GET    /api/weekly-target          — where the week stands, plus a proposal
 * POST   /api/weekly-target          — set it   { target, weekOf? }
 * DELETE /api/weekly-target          — clear it { weekOf? }
 * GET    /api/weekly-target/history  — recent whole weeks, newest first
 *
 * The proposal comes back WITH the snapshot rather than from a separate call,
 * because the moment Nick is looking at "no target set" is the moment he needs
 * a number to argue with. It is explicitly a proposal, never applied: a target
 * NEURO picked for him is one he has no reason to feel anything about, which is
 * the entire mechanism (`moscow_proposed`'s distinction, one level up).
 *
 * `weekOf` exists so next week's target can be set on a Friday, which is when a
 * person actually thinks about it.
 */

const express = require('express');
const router = express.Router();
const weeklyTarget = require('../services/weekly-target');

/**
 * ⚠ Registered BEFORE the bare '/' handlers below is not the issue here — but
 * '/history' MUST stay above any future parameterised sibling. Express matches
 * in registration order, and a literal path declared after ':something' is read
 * as that parameter. That is exactly how /triage/feedback broke.
 */
router.get('/history', (req, res) => {
  try {
    const n = Math.min(52, Math.max(1, parseInt(req.query.weeks, 10) || 8));
    const weeks = weeklyTarget.recentWeeks(new Date(), n);
    if (weeks === null) {
      // Null means the ledger could not be read. An empty array would say "you
      // have never finished anything", which is a different and untrue claim.
      return res.status(503).json({
        ok: false,
        known: false,
        error: 'the wins ledger could not be read',
      });
    }
    res.json({ ok: true, known: true, weeks });
  } catch (e) {
    console.error('[WeeklyTarget] history failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/', (req, res) => {
  try {
    const now = new Date();
    res.json({
      ...weeklyTarget.snapshot(now),
      // A proposal, never an application. `null` when there is not enough
      // history to propose from, which is honest rather than a made-up number.
      suggestion: weeklyTarget.suggest(now),
      maxTarget: weeklyTarget.MAX_TARGET,
    });
  } catch (e) {
    console.error('[WeeklyTarget] snapshot failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const weekOf = req.body?.weekOf ? new Date(req.body.weekOf) : new Date();
    if (Number.isNaN(weekOf.getTime())) {
      return res.status(400).json({ ok: false, error: 'weekOf is not a date' });
    }
    const result = weeklyTarget.setTarget(req.body?.target, {
      weekOf,
      source: req.body?.source || 'manual',
    });
    // setTarget REPORTS rather than throws, so a fat-fingered number comes back
    // as a sentence Nick can read instead of a 500.
    if (!result.ok) return res.status(400).json(result);

    res.json({ ...result, snapshot: weeklyTarget.snapshot(weekOf) });
  } catch (e) {
    console.error('[WeeklyTarget] set failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/', (req, res) => {
  try {
    const weekOf = req.body?.weekOf ? new Date(req.body.weekOf) : new Date();
    if (Number.isNaN(weekOf.getTime())) {
      return res.status(400).json({ ok: false, error: 'weekOf is not a date' });
    }
    const result = weeklyTarget.clearTarget({ weekOf });
    res.json({ ...result, snapshot: weeklyTarget.snapshot(weekOf) });
  } catch (e) {
    console.error('[WeeklyTarget] clear failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
