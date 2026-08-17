'use strict';

/**
 * Wins API — the derived ledger of finished work.
 *
 * GET  /api/wins           — the counters plus today's wins, in one call
 * GET  /api/wins/feed      — the scrollable log, newest first, paginated
 * POST /api/wins           — log a win that has no other home
 * POST /api/wins/sync      — force a fold now (normally hourly + on startup)
 *
 * The summary and today's list come back together for the same reason
 * /api/adhd does: this is read at moments of low executive function, and a
 * surface that renders half-populated at that moment is one that gets closed.
 */

const express = require('express');
const router = express.Router();
const wins = require('../services/wins');

router.get('/', (req, res) => {
  try {
    // Sync on read so the number is never stale by an hour at the moment it is
    // being looked at. It is idempotent and cheap; the scheduled pass exists so
    // the ledger stays current for the surfaces that do NOT hit this route.
    let gaps = [];
    try { gaps = wins.sync({ since: wins.dateKey(new Date(Date.now() - 3 * 86400000)) }).gaps; } catch { /* read still works */ }

    const summary = wins.summary();
    res.json({ ...summary, today: wins.winsForDate(summary.dateKey), gaps });
  } catch (e) {
    console.error('[WINS] Summary failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/feed', (req, res) => {
  try {
    res.json(wins.feed({
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : undefined,
      source: req.query.source || null,
      dateKey: req.query.date || null,
    }));
  } catch (e) {
    console.error('[WINS] Feed failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Not everything that counts leaves an artefact — a hard conversation, an hour
// of real focus, something survived. Stamped `manual` so the feed never claims
// it was detected.
router.post('/', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    wins.logManual(text);
    res.json({ ok: true, ...wins.summary() });
  } catch (e) {
    console.error('[WINS] Manual win failed:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Force a fold. `since` is how the backfill runs — the ledger must OPEN with
 * real history in it, because an honest wins feed that starts empty tomorrow
 * reproduces exactly the bug it was built to fix.
 */
router.post('/sync', (req, res) => {
  try {
    res.json(wins.sync({ since: req.body?.since || undefined, until: req.body?.until || undefined }));
  } catch (e) {
    console.error('[WINS] Sync failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
