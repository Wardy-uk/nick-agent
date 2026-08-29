'use strict';

/**
 * The capture door — mounted at /api/c, EXEMPT from the PIN middleware.
 *
 * ⚠ THIS IS THE ONLY ROUTE IN NEURO DELIBERATELY OPEN TO THE PUBLIC INTERNET.
 * pi5 runs Tailscale Funnel, so an auth exemption is not "tailnet only" — it is
 * reachable by anyone with the URL. That is the point: Nick's wife has no
 * NEURO PIN and no tailnet, and she should have neither, because the PIN
 * unlocks the whole brain. The link token is the entire credential.
 *
 * Everything that follows exists because of that sentence:
 *
 *  • WRITE ONLY. No route here returns a task, a count, a name or anything at
 *    all about Nick's day. GET returns the link's own label so the page can say
 *    "Add something for Nick" and nothing more. A URL leaks in ways a password
 *    does not — history, a shared phone, a screenshot — so the blast radius of
 *    a leaked link is "a stranger can add a personal task", never "a stranger
 *    can read his work".
 *  • UNKNOWN AND REVOKED ANSWER IDENTICALLY. Both 404. Whoever holds a dead
 *    link cannot tell whether it was revoked or never existed.
 *  • The MANAGEMENT routes are NOT here. Creating and revoking links lives on
 *    /api/capture-links, behind the PIN like everything else — putting them on
 *    the same exempt mount is how a public write door becomes a public admin
 *    door.
 */

const express = require('express');
const router = express.Router();
const captureLinks = require('../services/capture-links');

/**
 * Is this link live? Used by the page on load so a revoked link says so instead
 * of silently swallowing what someone types into it.
 *
 * Returns the LABEL only. Not the domain (it is Nick's classification, not
 * hers), not a task, not a count.
 */
router.get('/:token', (req, res) => {
  try {
    const link = captureLinks.resolve(req.params.token);
    if (!link) return res.status(404).json({ ok: false, error: 'This link is not valid.' });
    res.json({ ok: true, label: link.label });
  } catch (e) {
    console.error('[CaptureLink] Check failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

router.post('/:token', (req, res) => {
  try {
    const result = captureLinks.submit(req.params.token, req.body && req.body.text);
    if (!result.ok) {
      // The service decides the status, so the "unknown and revoked look the
      // same" rule is enforced in one place rather than re-derived here.
      return res.status(result.status || 400).json({ ok: false, error: result.error });
    }
    // `created:false` means it folded into an existing task. Reported honestly
    // rather than as a fresh add — otherwise adding the same thing twice looks
    // like it worked twice, and she has no list to check it against.
    res.json({ ok: true, text: result.text, created: result.created });
  } catch (e) {
    console.error('[CaptureLink] Submit failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not add that. Try again in a moment.' });
  }
});

module.exports = router;
