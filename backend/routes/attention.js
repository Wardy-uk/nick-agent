'use strict';

const express = require('express');
const router = express.Router();
const attention = require('../services/attention');

/**
 * GET /api/attention — the one thing SARA should surface right now.
 *
 * This is the feed both SARA surfaces render. It is READ-ONLY and must stay so:
 * an ambient screen polled every minute must never be the reason something
 * changed (`state-of-play`'s rule).
 *
 * `primary: null` is a valid, correct answer — most of a calm day should be
 * quiet. Consumers must render silence, not treat it as a failure.
 */
router.get('/', async (req, res) => {
  try {
    // ?view=work|personal pins the AGENDA for a widget locked to one side of
    // the split. Anything else is ignored rather than rejected: an unknown
    // value must fall back to the brain's own read, never to an empty diary.
    // work | personal pin a side; flip asks for the opposite of the brain's own
    // read, for the second card in a stack. Anything else is ignored rather
    // than rejected: an unknown value must fall back to the brain, never to an
    // empty diary.
    const asked = String(req.query.view || '').toLowerCase();
    const view = ['work', 'personal', 'flip'].indexOf(asked) !== -1 ? asked : null;
    res.json(await attention.build({ view }));
  } catch (e) {
    console.error('[Attention] build failed:', e.message);
    // An error is NOT an empty feed. Returning `{primary:null}` here would be
    // indistinguishable from a genuinely quiet moment, which is exactly the
    // false all-clear this whole layer is built to avoid.
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/attention/context — the situational read alone, without the pool.
 * Cheap, and useful for a surface that wants to know where Nick is without
 * paying for a full decision-engine evaluation.
 */
router.get('/context', async (req, res) => {
  try {
    const { inputs, gaps } = await attention.gather();
    const { resolveContext } = require('../services/context-state');
    res.json({ context: resolveContext(inputs), gaps });
  } catch (e) {
    console.error('[Attention] context failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
