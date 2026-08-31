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

/**
 * POST /api/friction/note — Nick has taken an observation on board.
 *
 * ⚠ It is a DISMISSAL OF THE LINE, never of the evidence, and it holds only
 * while the evidence is unchanged: the signature Nick was looking at is
 * required, so a third shrink on the same task raises the finding again.
 *
 * The GET above stays read-only. This is an explicit press, which is a
 * different thing from a poll — but it is the one write in this area, so it
 * lives in its own route rather than as a side effect of reading.
 */
router.post('/note', (req, res) => {
  const { id, signature } = req.body || {};
  const result = friction.note(id, signature, new Date());
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/** Undo one. Nothing about this section is irreversible. */
router.delete('/note/:id', (req, res) => {
  const result = friction.unnote(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

module.exports = router;
