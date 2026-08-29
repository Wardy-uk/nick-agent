'use strict';

/**
 * Apple Calendar and Reminders ingest, pushed from Scriptable on Nick's phone.
 *
 * POST /api/apple/calendar   { from, to, events: [...] }
 * POST /api/apple/reminders  { reminders: [...] }
 * GET  /api/apple/status     — when the phone last pushed, and whether it is stale
 *
 * ⚠ NO auth exemption, deliberately. The FreeReps health route needed one only
 * because that app's config has no credential field at all; Scriptable can set
 * headers, so this sits behind the ordinary PIN/API-token middleware like
 * everything else. Adding an exemption here would publish a task-writing
 * endpoint to the internet (Funnel is on) for no reason whatsoever.
 */

const express = require('express');
const router = express.Router();
const appleIngest = require('../services/apple-ingest');

router.post('/calendar', (req, res) => {
  try {
    const result = appleIngest.ingestCalendar(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    if (result.rejected > 0) {
      console.warn(`[Apple] ${result.rejected} pushed event(s) were unusable and not stored`);
    }
    res.json(result);
  } catch (e) {
    console.error('[Apple] Calendar ingest failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/reminders', (req, res) => {
  try {
    const result = appleIngest.ingestReminders(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    if (result.rejected.length) {
      console.warn(`[Apple] ${result.rejected.length} reminder(s) rejected:`, result.rejected.slice(0, 5));
    }
    res.json(result);
  } catch (e) {
    console.error('[Apple] Reminder ingest failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/status', (req, res) => {
  try {
    res.json(appleIngest.status());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
