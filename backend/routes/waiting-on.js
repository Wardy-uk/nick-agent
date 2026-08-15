'use strict';

/**
 * Waiting-on API — what other people owe Nick.
 *
 * GET  /api/waiting-on            — open items, oldest first
 * GET  /api/waiting-on/by-person  — grouped, which is how a 1-2-1 is prepared
 * POST /api/waiting-on/:key/chase — QUEUE a chase for approval (never sends)
 * POST /api/waiting-on/:key/resolve — mark done or dropped
 * POST /api/waiting-on/:key/snooze  — hide until a date, or clear with no date
 */

const express = require('express');
const router = express.Router();
const waitingOn = require('../services/waiting-on');

router.get('/', (req, res) => {
  try {
    res.json({
      items: waitingOn.list({ status: req.query.status || 'open', person: req.query.person || null }),
      staleAfterDays: waitingOn.STALE_DAYS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/by-person', (req, res) => {
  try {
    res.json({ people: waitingOn.byPerson() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/waiting-on/backfill — populate from meeting notes already on disk.
// The live path only sees new or changed notes, so without this the feature
// starts empty. Read-only over the vault; records nothing but waiting-on items.
router.post('/backfill', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 120, 1), 365);
    res.json(require('../services/waiting-on').backfill({ days }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:key/chase', (req, res) => {
  try {
    const result = waitingOn.queueChase(decodeURIComponent(req.params.key));
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snooze is not resolve: the commitment is still outstanding and still ages,
// it just stops being asked about until the date they actually gave.
router.post('/:key/snooze', (req, res) => {
  try {
    const item = require('../services/waiting-on')
      .snooze(decodeURIComponent(req.params.key), req.body?.until || null);
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(/must be YYYY-MM-DD/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
});

router.post('/:key/resolve', (req, res) => {
  try {
    const item = waitingOn.resolve(decodeURIComponent(req.params.key), req.body?.status || 'done');
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
