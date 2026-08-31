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
 * POST   /api/capture-links/:user/scopes — { scopes: [] } — what they may see
 * GET    /api/capture-links/scopes     — the scope vocabulary
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

// The scope names the UI may offer, from the service rather than a copy — a
// second list is how a screen comes to show a permission that does not exist,
// or miss one that does.
//
// ⚠ Registered BEFORE the parameterised routes below. Express matches in
// registration order and this codebase has shipped a literal path swallowed as
// a parameter more than once; there is a test that fails if that happens here.
router.get('/scopes', (req, res) => {
  res.json({ ok: true, scopes: capture.SCOPES });
});

/**
 * What an account may see, changed after the fact.
 *
 * ⚠ This existed in the service from the day scopes shipped and had NO ROUTE,
 * so the only way to widen an account was to delete it and make a new one —
 * which means handing the person a new PIN over a change that is none of their
 * business. `setScopes` was reachable from the test suite and nowhere else.
 *
 * Admin-side ONLY, like the rest of this router, and deliberately not on
 * `/api/v`: an account that could widen its own scope would make the whole
 * model decorative. `normaliseScopes` drops anything unknown rather than
 * passing it through, so a typo cannot become a permission.
 */
router.post('/:username/scopes', (req, res) => {
  try {
    const asked = (req.body || {}).scopes;
    // Distinguished from an empty array, which legitimately means "narrow this
    // back to tasks only". Omitting the field is a malformed request, and
    // treating it as the defaults would silently change an account nobody asked
    // to change.
    if (!Array.isArray(asked)) {
      return res.status(400).json({ ok: false, error: 'scopes must be an array' });
    }
    const result = capture.setScopes(req.params.username, asked);
    if (!result.ok) return res.status(404).json(result);
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
