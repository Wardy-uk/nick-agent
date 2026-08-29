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

/**
 * Calendars whose events are never stored.
 *
 * Measured from the live device, not guessed: 23 calendars are visible, and the
 * defaults here are the ones that are artefacts rather than commitments.
 *
 *  • TWO subscribed UK holiday feeds are both on, which is why every bank
 *    holiday arrived twice. Both are excluded rather than one: `working-days`
 *    already knows the bank holidays from gov.uk and is what the day planner and
 *    1-2-1 booking actually consult, so these rows were duplicated noise in the
 *    one table that answers "is Nick free".
 *  • Zendone, Nozbe and Garmin write calendars from inside their own apps. They
 *    are dormant today; the risk is one waking up and quietly filling the diary
 *    with things that are not commitments.
 *
 * `Birthdays` is deliberately NOT excluded — a birthday is real personal context
 * and exactly the sort of thing a second brain should know about.
 *
 * ⚠ An event whose calendar is UNKNOWN is KEPT, which is the opposite of the
 * Reminders whitelist, on purpose. The failure directions are opposite: for
 * reminders the risk is a shopping list flooding the task store, so unknown is
 * skipped; for the calendar the risk is a MISSING event making a busy day look
 * free — the exact bug that took two rounds to find — so unknown is kept.
 */
const DEFAULT_SKIP_CALENDARS = [
  'UK Holidays',
  'Holidays in United Kingdom',
  'Garmin Workouts',
  'Nozbe',
  'zd-work', 'zd-home', 'zd-completed',
  'zendone-work', 'zendone-home', 'zendone-completed',
];

function skipCalendarNames() {
  const configured = process.env.APPLE_SKIP_CALENDARS;
  const source = configured === undefined ? DEFAULT_SKIP_CALENDARS.join(',') : configured;
  return source.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function calendarIsSkipped(name) {
  // Unknown is kept — see the warning above.
  if (!name) return false;
  return skipCalendarNames().includes(String(name).trim().toLowerCase());
}

function domainForList(listName) {
  const name = String(listName || '').trim().toLowerCase();
  return workListNames().includes(name) ? 'work' : 'personal';
}

/**
 * Which Reminders lists become NEURO tasks. A WHITELIST, empty by default.
 *
 * ⚠ This was the opposite way round on the first run and it was wrong. Ingesting
 * every list pulled in Nick's shopping list — peanut butter, mugs, dog treats,
 * coathangers — plus dictation debris like "1 Image" and "Flipping thing": 15
 * items, none of them a task, sitting alongside 152 real ones.
 *
 * The deeper problem was not the noise, it was that they could never LEAVE.
 * NEURO cannot write to iCloud, so a shopping item is ticked off in Apple while
 * standing in a shop, and NEURO's copy stays open for ever — an append-only
 * store with nothing closing it, growing every sync. That is the `inbox_items`
 * failure exactly, and it is why the default has to be "ingest nothing".
 *
 * A list named here is one Nick has decided he will actually manage from NEURO.
 * Anything else stays in Reminders, where he will actually use it.
 */
// Defaults to the built-in list only — Nick's call: "only ingest anything in the
// reminders folder itself". Everything else (Shopping, Groceries, whatever else
// accumulates) stays on the phone where it is actually used.
function ingestListNames() {
  return String(process.env.APPLE_REMINDER_LISTS || 'Reminders')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function listIsIngested(listName) {
  const allowed = ingestListNames();
  if (!allowed.length) return false;
  // ⚠ A reminder with NO list is never ingested. Scriptable does not always
  // expose `calendar`, and treating unknown as the default list would quietly
  // reopen the whole door this whitelist exists to close.
  const name = String(listName || '').trim().toLowerCase();
  if (!name) return false;
  return allowed.includes(name);
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
    //
    // ⚠ THE START TIME IS PART OF THE KEY, and it is not decoration. EventKit
    // gives every occurrence of a RECURRING event the SAME `identifier` — a
    // weekly Saturday commitment is one identifier and many occurrences. With
    // the identifier alone, `calendar_cache.event_id` is UNIQUE and the upsert
    // is INSERT OR REPLACE, so all of them would collapse into a single row and
    // a repeating event would appear in the diary exactly once. Nothing throws;
    // the calendar is just quietly wrong, in the direction of looking emptier
    // than it is — which is the worst direction for something whose entire job
    // is answering "is Nick free".
    id: `apple:${raw.id}:${start}`,
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
function ingestCalendar({ from, to, events, calendars } = {}) {
  if (!from || !to) return { ok: false, error: 'a from/to window is required' };
  if (!Array.isArray(events)) return { ok: false, error: 'events must be an array' };

  // ── What the phone could SEE ───────────────────────────────────────────────
  //
  // Reported because "my Saturday event is missing" was unanswerable without it.
  // The sync said how many events it sent and nothing about where it looked, so
  // an empty diary and a calendar the phone cannot read produced an identical
  // result — the same conflation the whole codebase keeps stamping out.
  //
  // iOS 17 can grant an app partial calendar access, so a calendar absent from
  // this list is a PERMISSIONS answer, not an empty-diary one.
  const byCalendar = {};
  for (const e of events) {
    const name = (e && e.calendar) ? String(e.calendar) : '(unknown)';
    byCalendar[name] = (byCalendar[name] || 0) + 1;
  }
  const visible = Array.isArray(calendars) ? calendars.map(String) : null;
  if (visible) {
    console.log(`[Apple] ${visible.length} calendar(s) visible: ${visible.join(', ')}`);
  }
  console.log(`[Apple] ${events.length} event(s) in window ${from} → ${to}: ${JSON.stringify(byCalendar)}`);

  // Artefact calendars — holiday feed duplicates, app-written calendars. Counted
  // per calendar rather than totalled, so a newly-noisy calendar is identifiable
  // rather than just a number going up.
  const skippedCalendars = {};
  const wanted = events.filter((e) => {
    const name = e && e.calendar ? String(e.calendar) : null;
    if (!calendarIsSkipped(name)) return true;
    skippedCalendars[name] = (skippedCalendars[name] || 0) + 1;
    return false;
  });
  if (Object.keys(skippedCalendars).length) {
    console.log(`[Apple] skipped calendars: ${JSON.stringify(skippedCalendars)}`);
  }

  const normalised = wanted.map(normaliseEvent).filter(Boolean);
  const rejected = wanted.length - normalised.length;

  // ── The same meeting, twice ────────────────────────────────────────────────
  //
  // Measured before building this: today NOTHING duplicates, because Nick's work
  // account is not added to the iOS Calendar app — 104 Graph events, and none of
  // them came back from the phone. But that is a setting, not a guarantee, and
  // the day it changes every work meeting arrives a second time under an
  // `apple:` id. Nothing would throw; the diary would simply be twice as full,
  // and `time-fit`, `findSlot` and the day planner would all quietly believe it.
  //
  // Graph WINS. It is authoritative for work: it carries the response status and
  // a real attendee list, where the Apple copy usually cannot even say whether
  // anyone else is in the meeting.
  //
  // Matched on start-minute plus subject rather than on an id, because the two
  // systems share no identifier at all — the Apple copy of an Exchange event has
  // its own local identifier and always will.
  let graphKeys = new Set();
  try {
    graphKeys = new Set(
      db.all(
        `SELECT substr(start_time, 1, 16) AS s, lower(subject) AS t
           FROM calendar_cache WHERE source = 'graph' AND start_time BETWEEN ? AND ?`,
        [String(from), String(to)]
      ).map((r) => `${r.s}|${r.t}`)
    );
  } catch (e) {
    // A failed lookup must not fail the push. Worst case is the duplication this
    // guard exists to prevent, which is visible; losing the whole sync is not.
    console.warn('[Apple] Could not read Graph events to de-duplicate:', e.message);
  }

  const rows = normalised.filter(
    (r) => !graphKeys.has(`${String(r.start).slice(0, 16)}|${String(r.subject).toLowerCase()}`)
  );
  const duplicates = normalised.length - rows.length;

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
    // Named rather than quietly dropped: if this starts climbing, the work
    // account has been added to the phone and that is worth knowing.
    duplicates,
    // The diagnostic half. `visibleCalendars: null` means an older copy of the
    // script that does not report them — distinct from an empty list, which
    // would mean the phone can see no calendars at all.
    visibleCalendars: visible,
    byCalendar,
    skippedCalendars,
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
  // Every list the phone offered, and how many came from each. Reported whether
  // ingested or not, so "why has my reminder not appeared" is answerable without
  // guessing — an ingest that silently drops most of its input looks identical
  // to one that received nothing.
  const seenLists = {};
  const skippedLists = {};

  for (const r of reminders) {
    const list = r && r.list ? String(r.list) : '(no list)';
    seenLists[list] = (seenLists[list] || 0) + 1;

    if (!listIsIngested(r && r.list)) {
      skippedLists[list] = (skippedLists[list] || 0) + 1;
      continue;
    }

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

  return {
    ok: true,
    created,
    folded,
    skippedCompleted: skipped,
    rejected,
    seenLists,
    skippedLists,
    ingestingFrom: ingestListNames(),
  };
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
