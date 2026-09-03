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
const appleCaldav = require('../services/apple-caldav');

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

// ── CalDAV: the same data, pulled instead of pushed ──────────────────────────
//
// The push above depends on a Shortcuts automation running a Scriptable script
// on a phone, which has delivered ONE push in its life — see the header of
// `services/apple-caldav.js` for why, and why it cannot be fixed from here.
// These routes are the server-side pull. The push routes stay mounted: they are
// a working fallback, and nothing here writes until it has a complete read.
//
// ⚠ Registration order matters — `/caldav/...` is declared after the literal
// `/status` above and shares no prefix with it, but this router has form for the
// literal-vs-parameter trap, so keep new literals above anything parameterised.

router.get('/caldav/status', (req, res) => {
  try {
    res.json(appleCaldav.status());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Read iCloud. DRY RUN BY DEFAULT — `apply: true` is required to write.
 *
 * The same two-step as `event-parser`, `one-to-one-booking` and `task-blocks`:
 * looking must be free, and the first thing anyone does with a new credential is
 * check what it can see. It also matters more here than usual, because a real
 * run reaches `clearCalendarWindow`.
 */
router.post('/caldav/sync', async (req, res) => {
  try {
    const apply = (req.body || {}).apply === true;
    const result = await appleCaldav.sync({ dryRun: !apply });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[AppleCalDAV] Sync failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** What the account can see, without reading or writing any events. */
router.get('/caldav/collections', async (req, res) => {
  try {
    const d = await appleCaldav.discover();
    res.json({ ok: true, collections: d.collections });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * Store the Apple ID and app-specific password.
 *
 * ⚠ The credential is NEVER returned by any route — `configStatus()` reports
 * whether one is set and where it came from, never what it is. Stored in
 * `agent_state` rather than `.env` so a paste works with no restart and nothing
 * lands in the repo, which is PUBLIC (`notion-sync`'s rule, same reasoning).
 *
 * ⚠ It must be an APP-SPECIFIC password from appleid.apple.com. Apple refuses
 * the account password for CalDAV outright, and an app password is revocable on
 * its own without touching the Apple ID.
 */
router.post('/caldav/credentials', (req, res) => {
  try {
    const { appleId, appPassword } = req.body || {};
    if (!appleId || !appPassword) {
      return res.status(400).json({ ok: false, error: 'appleId and appPassword are both required' });
    }
    res.json({ ok: true, ...appleCaldav.setCredentials(appleId, appPassword) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
