'use strict';

/**
 * Apple Calendar and Reminders, pushed from the phone.
 *
 * ── Why push, and why Scriptable ─────────────────────────────────────────────
 *
 * NEURO cannot reach into iCloud. There is no server-side API worth having:
 * CalDAV against iCloud needs an app-specific password and is undocumented and
 * flaky, EventKit needs a Mac and Nick is on Windows, and Reminders has no web
 * API at all. So the phone pushes.
 *
 * Scriptable is the vehicle because it is already on his phone, already trusted,
 * already holds the NEURO API token in the Keychain for the widget, and has
 * native `Reminder` and `CalendarEvent` classes. A scheduled Shortcut runs it.
 * Nothing leaves the tailnet and no third party is involved.
 *
 * ⚠ Scriptable has NO HealthKit API — checked against its docs, not assumed.
 * Health is not and cannot be part of this; it already arrives via the FreeReps
 * app on /api/v1/ingest, and the route for moving off that would be Shortcuts'
 * "Find Health Samples", not this file.
 *
 * ── The calendar is the point ────────────────────────────────────────────────
 *
 * Until now NEURO could only see the WORK diary, so every "is Nick free"
 * answer — time-fit, the day planner, 1-2-1 booking, context-state — was wrong
 * outside working hours and blind to anything personal inside them. Apple events
 * land in the SAME `calendar_cache` as Graph events, with a `source` column,
 * precisely so all of those keep asking one question of one table.
 *
 * ⚠ That column is load-bearing for deletes. calendar-sync is replace-by-window
 * and runs every few minutes; it used to empty the whole table, which would have
 * wiped every Apple event minutes after it arrived, silently. See
 * db.clearCalendarCache.
 *
 * ── Reminders are one-way, and that is safe ──────────────────────────────────
 *
 * A reminder becomes a task. Completing that task does NOT complete the
 * reminder — NEURO cannot write to iCloud — so the reminder keeps being pushed.
 * That would be a resurrection loop except for one property of task-store:
 * `createTask` folds on dedupe_key into the existing row WHATEVER its status,
 * and the fold never touches status. So a re-pushed completed reminder folds
 * into the done task and stays done. Verified, not assumed, and pinned.
 *
 * Known limitation, stated rather than hidden: identity is the task TEXT, not
 * Apple's identifier, so renaming a reminder creates a second task. That is a
 * visible, droppable annoyance rather than a silent failure, and it is how every
 * other capture route in NEURO already behaves. An `external_id` column would
 * fix it and is deliberately not built until something needs it.
 */

const db = require('../db/database');
const { domainOrDefault } = require('../../shared/task-domain.cjs');

const SOURCE = 'apple';

// Reminders live in lists, and the LIST is the evidence for the domain — the
// same rule as the capture link's token. A list named here is work; everything
// else on a personal iCloud account is personal, which is the safe default
// because a personal task mis-filed as work is the visible mistake.
function workListNames() {
  return String(process.env.APPLE_WORK_LISTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function domainForList(listName) {
  const name = String(listName || '').trim().toLowerCase();
  return workListNames().includes(name) ? 'work' : 'personal';
}

/**
 * Normalise one pushed calendar event. PURE.
 *
 * Returns null for anything unusable rather than writing a half-row — a cached
 * event with no start is worse than a missing one, because every consumer reads
 * the cache as the truth about the diary.
 */
function normaliseEvent(raw) {
  if (!raw || !raw.id || !raw.start) return null;
  const start = String(raw.start);
  const end = raw.end ? String(raw.end) : start;

  return {
    // Namespaced so an Apple identifier can never collide with a Graph one in
    // the UNIQUE(event_id) index — they are opaque strings from two systems
    // that have never heard of each other.
    id: `apple:${raw.id}`,
    subject: raw.title ? String(raw.title).slice(0, 400) : '(no title)',
    start,
    end,
    isAllDay: raw.isAllDay === true,
    location: raw.location ? String(raw.location).slice(0, 200) : null,
    organizer: raw.organizer ? String(raw.organizer).slice(0, 200) : null,
    // Apple has no free/busy flag as such. An all-day event is treated as free
    // rather than as a wall, matching how the agenda already filters Graph's —
    // a birthday must not block the afternoon.
    showAs: raw.isAllDay === true ? 'free' : 'busy',
    // ⚠ THREE-VALUED, and undefined must survive as undefined. Scriptable's
    // CalendarEvent.attendees is not always populated, and coercing that to
    // false would tell context-state "solo block" about a real meeting.
    // context-state requires exactly `true` to call something a meeting, so an
    // unknown fails closed on its own.
    attendeesOther: typeof raw.attendeesOther === 'boolean' ? raw.attendeesOther : undefined,
    source: SOURCE,
  };
}

/**
 * Replace the Apple events in the pushed window.
 *
 * Windowed rather than whole-source: the phone sends the range it looked at, and
 * deleting outside that range would throw away events from a wider push that a
 * narrower one simply did not ask about.
 *
 * ⚠ An EMPTY events array with a window is a legitimate "nothing in the diary"
 * and must clear the window. An empty array with NO window is refused — that is
 * the shape a broken client sends, and honouring it would silently empty the
 * personal calendar.
 */
function ingestCalendar({ from, to, events } = {}) {
  if (!from || !to) return { ok: false, error: 'a from/to window is required' };
  if (!Array.isArray(events)) return { ok: false, error: 'events must be an array' };

  const rows = events.map(normaliseEvent).filter(Boolean);
  const rejected = events.length - rows.length;

  db.batchSaves(() => {
    db.clearCalendarWindow(SOURCE, String(from), String(to));
    for (const row of rows) db.upsertCalendarEvent(row);
  });

  return {
    ok: true,
    window: { from, to },
    stored: rows.length,
    // Never silent. A push where half the events were unusable is a broken
    // client, and a bare success count reads as a quiet day.
    rejected,
  };
}

/**
 * Turn pushed reminders into tasks.
 *
 * Completed reminders are skipped outright rather than created-then-completed:
 * creating a task to immediately close it would put work in the wins ledger that
 * nobody did today, which is the rule "a win is DETECTED, not declared" protects.
 */
function ingestReminders({ reminders } = {}) {
  if (!Array.isArray(reminders)) return { ok: false, error: 'reminders must be an array' };

  const taskStore = require('./task-store');
  let created = 0;
  let folded = 0;
  let skipped = 0;
  const rejected = [];

  for (const r of reminders) {
    const text = r && r.title ? String(r.title).trim() : '';
    if (!text) { rejected.push('a reminder with no title'); continue; }
    if (r.isCompleted === true) { skipped++; continue; }

    try {
      const res = taskStore.createTask({
        text: text.slice(0, 500),
        domain: domainForList(r.list),
        // Apple's own due date, when it set one. `dueDate` arrives as a plain
        // YYYY-MM-DD from the phone, never an instant — a reminder due "today"
        // must not become tomorrow west of here, which is the bug Planner's
        // midnight timestamps already caused once.
        due_date: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
        source: 'apple-reminders',
        notes: r.notes ? String(r.notes).slice(0, 1000) : null,
      });
      if (res.created) created++; else folded++;
    } catch (e) {
      rejected.push(`${text.slice(0, 40)}: ${e.message}`);
    }
  }

  return { ok: true, created, folded, skippedCompleted: skipped, rejected };
}

/**
 * What NEURO currently holds from the phone, so a stale push is visible.
 *
 * A push-based sync fails SILENTLY by definition — the phone simply stops
 * calling, and a frozen calendar answers every question exactly as a live one
 * does. Same species as the Jira cache that read as current for seven weeks.
 */
function status(now = new Date()) {
  try {
    const row = db.get(
      "SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM calendar_cache WHERE source = ?",
      [SOURCE]
    );
    const last = row && row.last ? new Date(`${String(row.last).replace(' ', 'T')}Z`) : null;
    const ageHours = last ? Math.round((now - last) / 36e5 * 10) / 10 : null;
    return {
      known: true,
      events: (row && row.n) || 0,
      lastPushAt: row ? row.last : null,
      ageHours,
      // Named rather than left for a caller to re-derive. The phone is meant to
      // push a few times a day; a day of silence means the Shortcut has stopped.
      stale: ageHours === null ? true : ageHours > 24,
    };
  } catch (e) {
    return { known: false, why: e.message };
  }
}

module.exports = {
  ingestCalendar,
  ingestReminders,
  status,
  SOURCE,
  // pure, exported for tests
  normaliseEvent,
  domainForList,
};
