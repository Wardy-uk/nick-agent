'use strict';

/**
 * Time — how long until the next thing, and what fits in the gap.
 *
 * GET /api/time/gap        — minutes until the next meeting today
 * GET /api/time/what-fits  — open tasks that fit, ?minutes= to override the gap
 *
 * Reads `calendar_cache`, not Graph. The whole point is an instant answer: a
 * surface that hesitates is one Nick has already navigated away from, and this
 * is meant to be readable in the thirty seconds between finishing one thing and
 * losing the thread. The cache is filled by calendar-sync every few minutes; if
 * it is empty the honest answer is "I don't know", not a network wait.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const timeFit = require('../services/time-fit');
const taskStore = require('../services/task-store');
const taskScoring = require('../services/task-scoring');

/** calendar_cache rows -> the shape time-fit reads. */
function todaysEvents(now = new Date()) {
  const today = timeFit.dateStr(now);
  try {
    return db.getCalendarEvents(`${today}T00:00:00`, `${today}T23:59:59`).map(row => ({
      date: String(row.start_time || '').split('T')[0],
      start: row.start_time,
      end: row.end_time,
      subject: row.subject,
      isAllDay: Boolean(row.is_all_day),
      showAs: row.show_as || 'busy',
    }));
  } catch {
    return [];
  }
}

router.get('/gap', (req, res) => {
  try {
    const events = todaysEvents();
    const gap = timeFit.nextGap(events, new Date());
    res.json({
      ...gap,
      // Say when the answer is "I don't know" rather than "you are free" — an
      // empty cache and a clear afternoon look identical otherwise, and one of
      // them is a broken sync.
      calendarKnown: events.length > 0,
      bufferMinutes: timeFit.BUFFER_MINUTES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/what-fits', (req, res) => {
  try {
    const events = todaysEvents();
    const gap = timeFit.nextGap(events, new Date());

    // An explicit ?minutes wins — "I have twenty minutes" is a thing Nick knows
    // and the diary does not.
    const override = req.query.minutes != null ? parseInt(req.query.minutes) : null;
    const minutes = Number.isFinite(override) && override > 0 ? override : gap.minutes;

    // Same ranking as everywhere else, so this cannot disagree with Focus about
    // what matters — it only cuts that order down to what fits.
    const ranked = taskScoring.rankTasks(taskStore.activeTodos());

    const fit = timeFit.whatFits(ranked, minutes, { limit: parseInt(req.query.limit) || 5 });

    res.json({
      ...fit,
      gap,
      calendarKnown: events.length > 0,
      coverage: timeFit.estimateCoverage(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
