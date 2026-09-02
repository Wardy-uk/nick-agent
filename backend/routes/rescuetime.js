'use strict';

/**
 * /api/rescuetime — the second opinion, and whether it is watching.
 *
 * ⚠ The API key is NEVER returned by any route, including the one that sets it.
 * `credentialSource` reports env / stored / null and nothing else — the same
 * rule as the Notion token and the PIN, and it matters more here because the
 * repo is public.
 *
 * ⚠ Nothing on these routes exposes a productivity pulse, a window title or a
 * document name. The service never fetches them; this is the second place that
 * is true rather than the only one.
 */

const express = require('express');
const router = express.Router();
const rt = require('../services/rescuetime');

/**
 * GET /api/rescuetime/status — is it configured, and is it actually watching?
 *
 * The second half is the point. "Configured" was green all through August while
 * RescueTime was blind for nine weekdays.
 */
router.get('/status', (req, res) => {
  try {
    res.json(rt.coverageReport(30));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rescuetime/daily?days=30 — the kept rows, each with its verdict.
router.get('/daily', (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    res.json({ days: rt.recentDays(days), configured: rt.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rescuetime/sync — pull now rather than waiting for the cron.
router.post('/sync', async (req, res) => {
  try {
    const out = await rt.sync();
    res.status(out.ok ? 200 : 503).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/rescuetime/key — store the API key.
 *
 * ⚠ The response says only whether it was accepted and where the credential now
 * comes from. It never echoes the value back, not even masked.
 */
router.post('/key', (req, res) => {
  const result = rt.setStoredKey(req.body && req.body.key);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, configured: rt.isConfigured(), credentialSource: rt.credentialSource() });
});

// DELETE /api/rescuetime/key — forget a stored key.
router.delete('/key', (req, res) => {
  const result = rt.clearStoredKey();
  res.json({ ...result, configured: rt.isConfigured(), credentialSource: rt.credentialSource() });
});

module.exports = router;
