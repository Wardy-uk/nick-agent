'use strict';

/**
 * Managing capture accounts — behind the PIN, unlike the screen itself.
 *
 * Deliberately a SEPARATE mount from /api/c. That one is exempt from auth so
 * the people in Nick's house can reach it from the open internet; putting
 * create, set-PIN and revoke on the same router would make a public door a
 * public admin door, which is the whole failure this split exists to prevent.
 *
 * GET    /api/capture-links            — the accounts, never their PINs
 * POST   /api/capture-links            — { label, username, pin, domain? }
 * POST   /api/capture-links/:user/pin  — { pin } — reset, and clear a lockout
 * DELETE /api/capture-links/:user      — revoke
 */

const express = require('express');
const router = express.Router();
const capture = require('../services/capture-links');

router.get('/', (req, res) => {
  try {
    res.json({ ok: true, accounts: capture.list() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const result = capture.create(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// The way back in for someone who has locked themselves out — Nick resets it
// for them, which is why setPin also clears the lockout.
router.post('/:username/pin', (req, res) => {
  try {
    const result = capture.setPin(req.params.username, req.body && req.body.pin);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/:username', (req, res) => {
  try {
    const result = capture.revoke(req.params.username);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
