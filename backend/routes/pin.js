'use strict';

/**
 * PIN routes.
 *   GET  /api/pin  — status: configured, length, when it last changed, what breaks
 *   POST /api/pin  — change it { currentPin, newPin }
 *
 * Reaching either already requires the current PIN (the `/api` middleware), so
 * the `currentPin` in the body is a SECOND gate rather than the only one. It is
 * there for the realistic case: a browser tab left signed in on a machine
 * somebody else can reach. Knowing the header is not the same as being Nick
 * sitting in front of it.
 *
 * Machine clients are refused outright. `X-NEURO-API-TOKEN` exists so n8n can
 * write todos, not so a webhook can lock Nick out of his own system.
 */

const express = require('express');
const router = express.Router();
const pin = require('../services/pin');

router.get('/', (_req, res) => {
  try {
    res.json({ ok: true, ...pin.status() });
  } catch (e) {
    console.error('[pin]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    if (req.apiClient) {
      return res.status(403).json({
        ok: false,
        error: 'The PIN can only be changed by a signed-in person, not by an API token.',
      });
    }

    const result = pin.change({
      currentPin: req.body?.currentPin,
      newPin: req.body?.newPin,
    });

    if (!result.ok) {
      // 400 for a bad new PIN, 401 for the wrong current one — the client shows
      // the message against the right field either way, but the status should
      // not call a rejected credential a validation error.
      return res.status(result.field === 'currentPin' ? 401 : 400).json(result);
    }

    res.json(result);
  } catch (e) {
    console.error('[pin]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
