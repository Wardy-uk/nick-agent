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

/**
 * Is the cache actually populated, and how recently?
 *
 * This must NOT be inferred from "how many events today" — the first cut did
 * exactly that and reported "no calendar data" on a Saturday with an empty
 * diary, which is the precise confusion the flag exists to prevent. An empty
 * day and a broken sync look identical from today's rows alone; they are
 * distinguishable from the cache as a whole.
 */
function calendarKnown() {
  try {
    const row = require('../db/database').get('SELECT COUNT(*) AS n, MAX(fetched_at) AS fetched FROM calendar_cache');
    if (!row || !row.n) return { known: false, fetchedAt: null };
    // A cache nobody has refreshed in a day is a stopped sync wearing the
    // clothes of a quiet week.
    const ageH = row.fetched ? (Date.now() - new Date(`${String(row.fetched).replace(' ', 'T')}Z`).getTime()) / 3600000 : null;
    return { known: ageH == null || ageH < 24, fetchedAt: row.fetched, ageHours: ageH == null ? null : Math.round(ageH) };
  } catch {
    return { known: false, fetchedAt: null };
  }
}

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
    const cal = calendarKnown();
    res.json({
      ...gap,
      // "I can't see your diary" and "your diary is clear" are different
      // answers, and one of them means calendar-sync has stopped.
      calendarKnown: cal.known,
      calendarFetchedAt: cal.fetchedAt,
      eventsToday: events.length,
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

    const cal = calendarKnown();
    res.json({
      ...fit,
      gap,
      calendarKnown: cal.known,
      calendarFetchedAt: cal.fetchedAt,
      eventsToday: events.length,
      coverage: timeFit.estimateCoverage(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * What the working-day predicate is running on (#25).
 *
 * Follows #65's rule: report what was OBSERVED, not what was configured. A
 * bank-holiday list that has quietly frozen is indistinguishable from a correct
 * one until the day it books a meeting on Christmas, so `source` and `ageDays`
 * are the answer, not a bare boolean.
 */
router.get('/working-days', (req, res) => {
  try {
    const wd = require('../services/working-days');
    const today = new Date();
    res.json({
      ...wd.status(),
      today: {
        date: require('../../shared/working-days.cjs').toDateStr(today),
        working: wd.isWorkingDay(today),
        reason: wd.nonWorkingReason(today),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
