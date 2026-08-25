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
async function sync({ days = 14, checkArrivals = true } = {}) {
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

  // Which ids we already knew about, so the caller can act on just the new
  // ones. Checking every event on every pass would mean a Graph detail fetch
  // per meeting per cycle — the arrival of an invite is the interesting moment,
  // not its continued existence.
  let known = new Set();
  try {
    known = new Set(
      db.getCalendarEvents(from, to).map(e => e.event_id).filter(Boolean)
    );
  } catch {}

  // Does each event have OTHER PEOPLE in it? The cache dropped `attendees` on
  // write, so everything reasoning off it — the ambient SARA surface most of all
  // — could not tell a 1-2-1 from a solo focus block, and half Nick's diary is
  // solo blocks. Judged here, once, at the only point a live attendee list
  // exists, using plaud-admin-blocks' test rather than a second copy of it.
  //
  // ⚠ Fails CLOSED to UNKNOWN, not to false. With no signed-in address Nick's
  // own entry cannot be told from anyone else's, and the NOVA bridge supplies no
  // attendee list at all — in both cases we do not know, and saying "solo block"
  // would be a confident wrong answer rather than an absent one.
  let me = null;
  try { me = await microsoft.getSignedInAddress(); } catch {}
  const { attendeesOther } = require('./plaud-admin-blocks');
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    event.attendeesOther = (me && Array.isArray(event.attendees))
      ? attendeesOther(event, me).length > 0
      : undefined;
  }
  if (!me) console.warn('[CalendarSync] No signed-in address — attendee judgement left unknown on every event');

  let synced = 0;
  const newEventIds = [];
  try {
    db.batchSaves(() => {
      db.clearCalendarCache();
      for (const event of events) {
        if (!event?.id || !event.start) continue;
        db.upsertCalendarEvent(event);
        if (!known.has(event.id)) newEventIds.push(event.id);
        synced++;
      }
    });
  } catch (e) {
    console.error('[CalendarSync] Write failed:', e.message);
    return { synced: 0, reason: e.message };
  }

  try { require('./working-memory').invalidate('calendar synced'); } catch {}

  // The 5-minute Plaud write-up block after every meeting Nick created or
  // accepted. Hooked here rather than on its own cron for the same reason the
  // 1-2-1 tracker hangs off syncPeopleNotes: this is the one place a fresh view
  // of the calendar exists, so a block can never be placed around a meeting
  // that has already moved.
  //
  // Deliberately ABOVE the cold-start return and deliberately NOT gated on
  // `newEventIds`. Both would be wrong: accepting an invite that arrived
  // yesterday is the central case and that event is not new, and a cold cache
  // (a restored DB) is not a reason to stop writing up meetings. Repeats are
  // held off by the service's own ledger, not by arrival detection.
  //
  // Gated on PLAUD_ADMIN_BLOCKS_ENABLED and never allowed to fail the sync.
  try {
    await require('./plaud-admin-blocks').syncHook(events);
  } catch (e) {
    console.warn('[CalendarSync] Plaud admin blocks failed:', e.message);
  }


  // First run has no history, so everything looks new. Reporting 50 "new"
  // meetings would queue a chaser for each — treat a cold cache as a baseline.
  const coldStart = known.size === 0;
  if (coldStart && newEventIds.length) {
    console.log(`[CalendarSync] ${synced} event(s) cached (cold start — treated as baseline, no arrivals reported)`);
    return { synced, from, to, newEventIds: [], coldStart: true };
  }

  console.log(`[CalendarSync] ${synced} event(s) cached for ${from} → ${to}${newEventIds.length ? `, ${newEventIds.length} new` : ''}`);

  // A new invite is the moment worth acting on — check it now rather than
  // waiting for the daily sweep, so the ask reaches the organiser while they
  // are still thinking about the meeting they just sent.
  if (newEventIds.length && checkArrivals) {
    try {
      await require('./meeting-triage').checkEvents(newEventIds);
    } catch (e) {
      console.warn('[CalendarSync] Agenda check on arrivals failed:', e.message);
    }
  }

  return { synced, from, to, newEventIds, coldStart: false };
}

module.exports = { sync };
