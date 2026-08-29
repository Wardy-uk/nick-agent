'use strict';

/**
 * The standalone task screen — mounted at /api/c, EXEMPT from the PIN
 * middleware, served at its own address (tasks.nickward.co.uk).
 *
 * POST /api/c/login   { username, pin } → a signed session token
 * GET  /api/c/tasks   → what THIS account has sent, and what became of it
 * POST /api/c/tasks   { text } → add one
 *
 * ⚠ THIS IS THE ONLY PART OF NEURO DELIBERATELY OPEN TO THE PUBLIC INTERNET.
 * pi5 runs Tailscale Funnel, so an auth exemption publishes the route to
 * anyone, not merely to the tailnet. That is the point — Nick's wife has no
 * NEURO PIN and must never have one, because it unlocks the whole brain.
 *
 * Two rules hold the boundary:
 *
 *  • AN ACCOUNT SEES ONLY ITS OWN SUBMISSIONS. Enforced by a `source` match in
 *    the query, never by filtering a fuller list here or in the page. Nothing
 *    else about Nick's day is reachable: not his other tasks, not counts, not
 *    the calendar.
 *  • THE ADMIN HALF IS NOT HERE. Creating accounts and setting PINs lives on
 *    /api/capture-links, behind the PIN like everything else. Putting them on
 *    the same exempt mount is how a public door becomes a public admin door.
 */

const express = require('express');
const router = express.Router();
const capture = require('../services/capture-links');

/**
 * Resolve the bearer session, or 401.
 *
 * ⚠ Re-reads the account every request rather than trusting the token's claim,
 * so revoking someone takes effect immediately rather than in twelve hours.
 */
function requireAccount(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const account = capture.resolveSession(token);
  if (!account) {
    return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  }
  req.account = account;
  next();
}

router.post('/login', (req, res) => {
  try {
    const result = capture.login(req.body && req.body.username, req.body && req.body.pin);
    if (!result.ok) return res.status(result.status || 401).json({ ok: false, error: result.error });
    res.json({ ok: true, token: result.token, label: result.label });
  } catch (e) {
    console.error('[Capture] Login failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

router.get('/tasks', requireAccount, (req, res) => {
  try {
    res.json({
      ok: true,
      label: req.account.label,
      tasks: capture.submissions(req.account),
    });
  } catch (e) {
    console.error('[Capture] List failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not load your list.' });
  }
});

router.post('/tasks', requireAccount, (req, res) => {
  try {
    const result = capture.submit(req.account, req.body && req.body.text);
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
    // `created:false` means it folded into a task that already existed.
    // Reported honestly rather than as a fresh add — she can see her own list
    // now, so a duplicate that silently vanished would look like a lost message.
    res.json({ ok: true, created: result.created, tasks: capture.submissions(req.account) });
  } catch (e) {
    console.error('[Capture] Submit failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not add that. Try again in a moment.' });
  }
});

module.exports = router;
