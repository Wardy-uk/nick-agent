'use strict';

/**
 * Calendar sync — fill the cache nothing was filling.
 *
 * `db.upsertCalendarEvent` has existed, been exported, and been called by
 * absolutely nothing. `calendar_cache` has therefore always been empty, and
 * every feature reading it has been quietly dark:
 *
 *   - working-memory sets ctx.calendar from the cache, so it was always []
 *   - decision-engine.collectMeetings() never produced an item, so a meeting
 *     has never appeared in Focus
 *   - briefing.checkMeetingAlerts() reads the same context, so the "starting in
 *     10 minutes" push has never fired once
 *   - the chat get_calendar tool and the ADHD dashboard both returned nothing
 *
 * It went unnoticed because the calendar VIEWS call Graph live — the screens
 * looked right while everything that reasons about the calendar was blind.
 *
 * Sync is replace-by-window rather than merge: a meeting that gets cancelled or
 * moved must disappear, and diffing for deletions against Graph is more work
 * than simply rewriting the window.
 */

const db = require('../db/database');

function _dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pull the next `days` of calendar into the cache.
 * Returns { synced, from, to } or { synced: 0, reason } when unavailable.
 */
async function sync({ days = 14 } = {}) {
  const microsoft = require('./microsoft');

  const now = new Date();
  const from = _dateStr(now);
  const to = _dateStr(new Date(now.getTime() + days * 86400000));

  let events;
  try {
    events = await microsoft.fetchCalendarEvents(from, to);
  } catch (e) {
    console.warn('[CalendarSync] Fetch failed:', e.message);
    return { synced: 0, reason: e.message };
  }

  if (!Array.isArray(events)) return { synced: 0, reason: 'no events returned' };

  // Nothing back from Graph is ambiguous — an empty diary and a broken auth look
  // identical. Leave the existing cache alone rather than wiping a good one on a
  // transient failure; a stale calendar beats an empty one.
  if (events.length === 0) {
    console.log('[CalendarSync] Graph returned no events — leaving the cache as it is');
    return { synced: 0, from, to, reason: 'empty response' };
  }

  let synced = 0;
  try {
    db.batchSaves(() => {
      db.clearCalendarCache();
      for (const event of events) {
        if (!event?.id || !event.start) continue;
        db.upsertCalendarEvent(event);
        synced++;
      }
    });
  } catch (e) {
    console.error('[CalendarSync] Write failed:', e.message);
    return { synced: 0, reason: e.message };
  }

  try { require('./working-memory').invalidate('calendar synced'); } catch {}

  console.log(`[CalendarSync] ${synced} event(s) cached for ${from} → ${to}`);
  return { synced, from, to };
}

module.exports = { sync };
