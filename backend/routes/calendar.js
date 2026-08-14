const express = require('express');
const router = express.Router();
const microsoft = require('../services/microsoft');
const eventParser = require('../services/event-parser');
const contacts = require('../services/contact-directory');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Graph failure reasons → something Nick can act on.
const FAIL_MESSAGES = {
  auth: 'Not signed in to Microsoft — reconnect in settings.',
  scope: 'Calendars.ReadWrite permission not granted — re-consent to Microsoft (POST /api/microsoft/auth).',
  no_subject: 'Give the meeting a title.',
  no_times: 'Start and end times are required.',
};

// POST /api/calendar/parse — free text → a draft to confirm. Creates nothing.
router.post('/parse', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    const result = await eventParser.parseEventText(text, {
      useAi: req.body?.useAi !== false,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/calendar/resolve?q=abdi — name → address, for the attendee field
router.get('/resolve', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'q required' });
    res.json({ ok: true, ...(await contacts.resolveName(q)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/calendar/events — create the event. Sends invites, so it only ever
// runs off an explicit confirm in the UI, never straight off a parse.
router.post('/events', async (req, res) => {
  try {
    const {
      subject, date, startTime, endTime,
      attendees = [], location = null, body = null,
      isAllDay = false, isOnline = false,
    } = req.body || {};

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ ok: false, error: 'subject required' });
    }
    if (!DATE_RE.test(date || '')) {
      return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
    }

    let start;
    let end;
    if (isAllDay) {
      // Graph wants all-day events midnight-to-midnight on date boundaries.
      const next = new Date(`${date}T00:00:00`);
      next.setDate(next.getDate() + 1);
      const p = (n) => String(n).padStart(2, '0');
      start = `${date}T00:00:00`;
      end = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}T00:00:00`;
    } else {
      if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
        return res.status(400).json({ ok: false, error: 'startTime and endTime must be HH:MM' });
      }
      if (endTime <= startTime) {
        return res.status(400).json({ ok: false, error: 'End time must be after start time' });
      }
      start = `${date}T${startTime}:00`;
      end = `${date}T${endTime}:00`;
    }

    const invalid = attendees
      .map((a) => (typeof a === 'string' ? a : a?.email))
      .filter((e) => !String(e || '').includes('@'));
    if (invalid.length) {
      return res.status(400).json({ ok: false, error: `Unresolved attendee: ${invalid.join(', ')}` });
    }

    const result = await microsoft.createCalendarEvent({
      subject, start, end, attendees, location, body, isAllDay, isOnline,
    });

    if (!result.created) {
      return res.status(502).json({
        ok: false,
        reason: result.reason,
        error: FAIL_MESSAGES[result.reason] || `Could not create the event (${result.reason})`,
      });
    }

    res.json({ ok: true, event: result.event });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
