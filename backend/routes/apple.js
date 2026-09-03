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

// ── Why there is no server-side pull here ────────────────────────────────────
//
// Tried and REMOVED, 3 Sep 2026. A CalDAV client against caldav.icloud.com was
// built, tested and run against Nick's real account, and the answer was that the
// data is not there:
//
//   · CALENDARS. iCloud CalDAV exposes only the six iCloud calendars, which hold
//     dormant history — birthdays from 2003, a lapsed BSAC renewal, series that
//     ended in 2020, and EIGHT events in the whole of 2026. Nick's actual diary
//     lives in ward.nickj@gmail.com and 22 other Google/subscribed calendars that
//     exist on the DEVICE. iCloud has never held them.
//   · REMINDERS. The list comes back named "Reminders ⚠️" containing exactly two
//     items: "Where are my reminders?" and "The creator of this list has upgraded
//     these reminders". That is Apple's placeholder — upgraded Reminders lists are
//     deliberately not served over CalDAV.
//
// Both were measured, not assumed. So EventKit on the phone is not an awkward way
// to get this data, it is the ONLY way: it sees all 23 calendars and the real
// Reminders store, and no server-side protocol does.
//
// Which means the push below is the design, and its one real fault is worth
// fixing rather than routing around: the Scriptable script reads its API token
// from the iOS Keychain, and Keychain items written with the default
// accessibility are unreadable while the device is locked — so it works in the
// hand and never in the pocket.
//
// Do not rebuild the CalDAV client. It worked; there was nothing to read.

module.exports = router;
