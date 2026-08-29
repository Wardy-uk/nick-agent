'use strict';

/**
 * Managing capture links — behind the PIN, unlike the door itself.
 *
 * Deliberately a SEPARATE mount from `/api/c`. That one is exempt from auth so
 * Nick's wife can reach it from the open internet; putting create and revoke on
 * the same router would make the public write door a public admin door, which
 * is the whole failure this split exists to prevent.
 *
 * GET    /api/capture-links        — list, tokens redacted unless ?reveal=1
 * POST   /api/capture-links        — { label, domain? } → the full token, once
 * DELETE /api/capture-links/:label — revoke
 */

const express = require('express');
const router = express.Router();
const captureLinks = require('../services/capture-links');

router.get('/', (req, res) => {
  try {
    // Redacted by default. A link list is the kind of thing that ends up in a
    // screenshot or a support log, and the token is the entire credential.
    res.json({ ok: true, links: captureLinks.list({ reveal: req.query.reveal === '1' }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const result = captureLinks.create(req.body && req.body.label, {
      domain: (req.body && req.body.domain) || 'personal',
    });
    if (!result.ok) return res.status(400).json(result);
    // The only time the full token is returned on a create. It is stored, so it
    // can be re-read with ?reveal=1 — this is not a one-time secret, it is just
    // not something to hand back by accident.
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/:label', (req, res) => {
  try {
    const result = captureLinks.revoke(req.params.label);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
