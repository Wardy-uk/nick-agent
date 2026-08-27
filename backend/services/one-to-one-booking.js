'use strict';

/**
 * 1-2-1 booking — find the next sensible slot for a person's 1-2-1 and, on a
 * separate confirmed call, put it in the calendar with them invited.
 *
 * Deliberately two-step: propose() reads and returns a draft, book() writes.
 * Attendees mean Graph emails a real invite to a real colleague, so nothing here
 * creates an event as a side effect of looking — same rule as event-parser.
 *
 * What it can and cannot see: only Nick's calendar. Reading a colleague's
 * free/busy needs Calendars.Read.Shared, which NEURO doesn't hold, so a proposed
 * slot is guaranteed free for Nick and merely *offered* to them. That's why the
 * invite is a normal meeting request they can decline, not a silent booking.
 */

const detect = require('./one-to-one-detect');
const workingDays = require('./working-days');

// Nick's booking rules (14 Aug 2026), expressed as the only two windows a 1-2-1
// may sit in. Everything outside them is off-limits by construction rather than
// by a pile of exclusions:
//   - never at 9am        → the morning window opens at 10:00
//   - never 12-2          → the gap between the two windows IS lunch
//   - never after 4.30pm  → the afternoon window CLOSES at 16:30, and a slot has
//                           to finish inside its window, so a 30-min 1-2-1 can
//                           start no later than 16:00
//   - never when a meeting already exists → findGapInWindow clash detection
// PM is tried first: every entry in the vault's 1-2-1 Tracker reads "✅ 9 Apr PM".
// Bounds are in MINUTES from midnight so 16:30 is expressible.
const PM_WINDOW = { from: 14 * 60, to: 16 * 60 + 30 };
const AM_WINDOW = { from: 10 * 60, to: 12 * 60 };
const DEFAULT_DURATION_MIN = 30;
const SEARCH_DAYS = 21;
const MAX_PER_DAY = 2;

function pad(n) { return String(n).padStart(2, '0'); }

/** Local date string. Never toISOString() — that shifts the day on BST evenings. */
function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Graph returns naive local wall-clock strings ("2026-08-18T14:00:00"). */
function toMinutes(dateTime) {
  const [h, m] = dateTime.split('T')[1].slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/**
 * The earliest day a 1-2-1 should be offered: never today (no ambush meetings),
 * never a date already gone. An overdue 1-2-1 wants the next working day; one
 * that isn't due yet waits for its due date.
 */
function earliestDate(person) {
  const tomorrow = addDays(new Date(), 1);
  const due = person.nextDue ? new Date(`${person.nextDue}T12:00:00`) : null;
  if (due && due > tomorrow) return due;
  return tomorrow;
}

/**
 * Mon-Fri was the whole of this check until 16 Aug 2026 (#25), which meant
 * bookAll() would email real invites to real direct reports on a bank holiday —
 * and with SEARCH_DAYS at 21, the 31 Aug Summer bank holiday was inside the
 * live window when that was found. Now the one shared predicate, which also
 * takes the events already in hand so a day Nick is on leave (showAs 'oof') is
 * not offered either.
 */
const isWorkingDay = workingDays.isWorkingDay;

// Anything that reads as an existing 1-2-1 in the calendar, however it was named.
const ONE_TO_ONE_SUBJECT = /1-2-1|1:1|(^|[^\d-])1-1([^\d-]|$)|one[- ]to[- ]one|one[- ]on[- ]one/i;

/**
 * How many 1-2-1s are already in the diary on this day. Nick's cap is 2 — back
 * to back 1-2-1s all day is how the cadence gets abandoned.
 */
function countOneToOnes(day, events) {
  return events.filter(e =>
    e.date === dateStr(day) &&
    !['cancelled'].includes(String(e.showAs || 'busy').toLowerCase()) &&
    ONE_TO_ONE_SUBJECT.test(String(e.subject || ''))
  ).length;
}

/**
 * First gap of `duration` minutes inside `window` on `day` that doesn't collide
 * with a busy event. Events marked free or cancelled don't block. The slot must
 * finish inside the window, which is what enforces "never after 4.30pm".
 */
function findGapInWindow(day, events, window, duration) {
  const busy = events
    .filter(e => e.date === dateStr(day))
    .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .map(e => (e.isAllDay
      ? { start: 0, end: 24 * 60 }
      : { start: toMinutes(e.start), end: toMinutes(e.end) }))
    .sort((a, b) => a.start - b.start);

  for (let start = window.from; start + duration <= window.to; start += 15) {
    const end = start + duration;
    const clash = busy.some(b => start < b.end && end > b.start);
    if (!clash) return { start, end };
  }
  return null;
}

async function resolveAttendee(name) {
  // A People note `email:` is the trusted source; Graph is the fallback.
  const roster = detect.buildRoster({ includeInactive: true });
  const person = roster.people.find(p => p.name === name);
  if (person?.email) return { email: person.email, via: 'people-note' };

  try {
    const result = await require('./contact-directory').resolveName(name);
    if (result?.status === 'resolved' && result.email) {
      return { email: result.email, via: result.via || 'directory' };
    }
    return { email: null, via: null, status: result?.status || 'unresolved', candidates: result?.candidates || [] };
  } catch {
    return { email: null, via: null, status: 'unresolved', candidates: [] };
  }
}

function subjectFor(name) {
  return `1-2-1 — Nick / ${name.split(' ')[0]}`;
}

function minutesToClock(dayStr, minutes) {
  return `${dayStr}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

/**
 * The shared slot search. Pure with respect to `events` — it never fetches, so
 * a batch can hand it one calendar read plus the slots it has already handed
 * out, and each subsequent person is placed around them.
 *
 * `personOff` is the set of dates the OTHER person is booked off, or null when
 * that could not be established.
 *
 * ⚠ Until this existed the search could only see NICK's diary. Only his own
 * leave was avoidable (`showAs: 'oof'` among the events); the person being
 * invited could be on a beach and the slot would look perfectly free, because
 * NEURO does not hold their calendar — reading a colleague's free/busy needs
 * `Calendars.Read.Shared`, which it has never had. `book()` emails a real
 * invite to a real direct report, so that is not a cosmetic miss.
 *
 * NULL means "could not tell" and deliberately does NOT block. Refusing to
 * book because NOVA is unreachable would take the feature down every time the
 * bridge hiccups, and the status quo — booking blind, as it always has — is
 * survivable. What must not happen is a blind booking that CLAIMS to have
 * checked, which is why callers surface `awayCheck` rather than swallowing it.
 */
function findSlot(events, from, durationMinutes, personOff = null) {
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = addDays(from, i);
    if (!isWorkingDay(day, events)) continue;
    if (personOff && personOff.has(dateStr(day))) continue;
    if (countOneToOnes(day, events) >= MAX_PER_DAY) continue;
    for (const window of [PM_WINDOW, AM_WINDOW]) {
      const gap = findGapInWindow(day, events, window, durationMinutes);
      if (!gap) continue;
      const d = dateStr(day);
      return {
        date: d,
        start: minutesToClock(d, gap.start),
        end: minutesToClock(d, gap.end),
        window: window === PM_WINDOW ? 'afternoon' : 'morning',
      };
    }
  }
  return null;
}

/**
 * When is this person booked off? A synchronous cache read — `team-availability`
 * refreshes from NOVA on its own schedule, and a booking flow must not wait on
 * the bridge.
 *
 * Never throws and never blocks: an unreadable feed returns `known:false`, and
 * every caller treats that as "carry on as before, but say so".
 */
function awayFor(personName) {
  try {
    const availability = require('./team-availability');
    const info = availability.daysOffFor(personName, availability.snapshot());
    return {
      checked: info.known,
      dates: info.known ? info.dates : null,
      // Named so a proposal can say WHY it could not check, rather than
      // implying it did.
      reason: info.known ? null : info.reason,
      coversTo: info.coversTo || null,
    };
  } catch (e) {
    return { checked: false, dates: null, reason: e.message, coversTo: null };
  }
}

/** A held slot, shaped like a calendar event so the next search sees it. */
function reserve(events, name, slot) {
  events.push({
    date: slot.date,
    start: slot.start,
    end: slot.end,
    subject: subjectFor(name),
    showAs: 'busy',
  });
}

async function fetchWindow(from) {
  const microsoft = require('./microsoft');
  return microsoft.fetchCalendarEvents(dateStr(from), dateStr(addDays(from, SEARCH_DAYS)));
}

async function describe(name, slot, { durationMinutes, fmDue, latest }) {
  const attendee = await resolveAttendee(name);
  return {
    ok: true,
    person: name,
    start: slot.start,
    end: slot.end,
    date: slot.date,
    durationMinutes,
    window: slot.window,
    subject: subjectFor(name),
    attendee,
    dueDate: fmDue || null,
    lastOneToOne: latest ? { date: latest.date, title: latest.title } : null,
    note: attendee.email
      ? null
      : 'No email resolved — the event can be created without an invite, or add the address manually.',
  };
}

/**
 * Propose a slot. Reads only — creates nothing.
 */
async function propose(name, { durationMinutes = DEFAULT_DURATION_MIN } = {}) {
  const index = detect.getIndex();
  const person = index.people?.find(p => p.name === name);
  if (!person) return { ok: false, error: `${name} is not an active direct report` };
  if (!person.bookable) {
    return { ok: false, error: `${name} is not on a 1-2-1 cadence${person.status ? ` (${person.status})` : ''}` };
  }

  const latest = index.byPerson?.[name]?.[0] || null;

  // Read the due date straight from the person note so a manual edit is honoured.
  const fmDue = readNextDue(name);
  const from = earliestDate({ nextDue: fmDue });

  let events = [];
  try {
    events = await fetchWindow(from);
  } catch (e) {
    return { ok: false, error: `Could not read the calendar: ${e.message}` };
  }

  const away = awayFor(name);
  const slot = findSlot(events, from, durationMinutes, away.dates);
  if (!slot) {
    return {
      ok: false,
      error: `No free ${durationMinutes}-minute slot in the next ${SEARCH_DAYS} days`
        + (away.checked && away.dates.size ? ` (${name} is off ${away.dates.size} of them)` : ''),
      awayCheck: away.checked ? 'checked' : 'unknown',
    };
  }
  // The proposal states whether the other person's leave was actually consulted.
  // A confirm dialog that silently means "I did not look" is how an invite ends
  // up in someone's holiday.
  return { ...describe(name, slot, { durationMinutes, fmDue, latest }),
    awayCheck: away.checked ? 'checked' : 'unknown',
    awayNote: away.checked ? null : `Could not check ${name}'s leave — ${away.reason}` };
}

/**
 * Plan a slot for several people in one pass. Reads only — creates nothing.
 *
 * The calendar is fetched ONCE and each allocation is reserved back into that
 * working set, which is the whole point: proposing people one at a time returns
 * the same free slot to everybody, so booking the lot would stack them all on
 * top of each other. Reserving as we go also lets MAX_PER_DAY count the
 * 1-2-1s this plan is itself creating, so a batch spreads across days.
 *
 * Most overdue first, so if the diary runs out it's the longest-neglected who
 * got the slots.
 */
async function planAll(names, { durationMinutes = DEFAULT_DURATION_MIN } = {}) {
  const index = detect.getIndex();
  const active = new Set((index.people || []).map(p => p.name));
  const byName = new Map((index.people || []).map(p => [p.name, p]));

  const wanted = [...new Set(names || [])].filter(Boolean);
  const unknown = wanted.filter(n => !active.has(n));
  // Anyone on leave or off-cadence is dropped here rather than planned and then
  // quietly failed — the caller is told, by name and reason.
  const notBookable = wanted
    .filter(n => active.has(n) && !byName.get(n).bookable)
    .map(n => ({ person: n, reason: byName.get(n).status || 'not on a 1-2-1 cadence' }));
  const candidates = wanted
    .filter(n => active.has(n) && byName.get(n).bookable)
    .map(n => ({ name: n, fmDue: readNextDue(n), latest: index.byPerson?.[n]?.[0] || null }))
    // No due date at all is the most neglected case, so it sorts first.
    .sort((a, b) => String(a.fmDue || '0000-00-00').localeCompare(String(b.fmDue || '0000-00-00')));

  if (!candidates.length) {
    return { ok: false, error: 'Nobody in that list is due a 1-2-1', unknown, notBookable };
  }

  // One read covers everyone: the earliest possible start is the same for all.
  const from = earliestDate({ nextDue: null });
  let events;
  try {
    events = await fetchWindow(from);
  } catch (e) {
    return { ok: false, error: `Could not read the calendar: ${e.message}` };
  }

  const planned = [];
  const skipped = [];
  const awayChecked = [];
  const awayUnchecked = [];
  for (const c of candidates) {
    // Honour each person's own due date — someone not due yet is not pulled forward.
    const earliest = earliestDate({ nextDue: c.fmDue });
    // Per person: each has their own leave, so this cannot be hoisted out of
    // the loop the way the calendar read can.
    const away = awayFor(c.name);
    if (away.checked) awayChecked.push(c.name); else awayUnchecked.push({ person: c.name, reason: away.reason });

    const slot = findSlot(events, earliest, durationMinutes, away.dates);
    if (!slot) {
      skipped.push({
        person: c.name,
        reason: `no free slot in the next ${SEARCH_DAYS} days`
          + (away.checked && away.dates.size ? ` (off for ${away.dates.size} of them)` : ''),
      });
      continue;
    }
    reserve(events, c.name, slot);
    planned.push(await describe(c.name, slot, { durationMinutes, fmDue: c.fmDue, latest: c.latest }));
  }

  return {
    ok: true,
    planned,
    skipped,
    unknown,
    notBookable,
    totalRequested: wanted.length,
    withoutInvite: planned.filter(p => !p.attendee?.email).map(p => p.person),
    // `bookAll` emails real invites, so the confirm screen must be able to say
    // whose leave was actually consulted and whose could not be. A batch that
    // silently checked nobody looks identical to one that checked everybody.
    awayChecked,
    awayUnchecked,
  };
}

function readNextDue(name) {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(process.env.OBSIDIAN_VAULT_PATH || '', 'People', `${name}.md`);
    const raw = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
    const m = raw.match(/^next-1-2-1-due:\s*(\d{4}-\d{2}-\d{2})/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/** The subject of the first busy event overlapping this slot, or null. */
async function findClash(start, end) {
  const day = start.split('T')[0];
  let events;
  try {
    const microsoft = require('./microsoft');
    events = await microsoft.fetchCalendarEvents(day, day);
  } catch {
    return null; // best-effort: never block a booking on a failed read
  }
  const from = toMinutes(start);
  const to = toMinutes(end);
  const hit = (events || [])
    .filter(e => e.date === day)
    .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .find(e => (e.isAllDay ? true : from < toMinutes(e.end) && to > toMinutes(e.start)));
  return hit ? (hit.subject || 'an existing meeting') : null;
}

/**
 * Create the event. Only ever called after Nick has seen the proposal.
 */
async function book({ person, start, end, email, subject, durationMinutes, skipClashCheck = false }) {
  if (!person || !start || !end) return { ok: false, error: 'person, start and end are required' };

  // A hand-picked date/time bypasses the planner, so re-check the one rule that
  // matters most here: never onto an existing meeting. Cheap, and it turns a
  // silent double-booking into a message Nick can act on.
  if (!skipClashCheck) {
    const clash = await findClash(start, end);
    if (clash) return { ok: false, error: `That slot clashes with "${clash}"` };
  }

  const microsoft = require('./microsoft');
  const result = await microsoft.createCalendarEvent({
    subject: subject || `1-2-1 — Nick / ${person.split(' ')[0]}`,
    start,
    end,
    attendees: email ? [email] : [],
    isOnline: true,
    body: `Regular 1-2-1. Booked from NEURO.`,
  });

  if (!result.created) {
    return { ok: false, error: `Calendar create failed: ${result.reason}`, detail: result.detail || null };
  }

  // Record WHAT IS IN THE DIARY, in its own field. This used to write the
  // booked date into `next-1-2-1-due`, but the detector writes that field as
  // "when the next one is OWED" (last held + cadence) and both readers — the
  // nudge and the Team board — read it that way. So every booking stamped a
  // reminder to make the booking that had just been made, and turned into
  // "these need booking now" the day after the meeting.
  //
  // `last-1-2-1` is still NOT touched — that only moves when a note proves the
  // meeting actually happened, which is the whole point of the detector. A
  // booked date that passes with no note reads as `unwritten`, not as held.
  try {
    require('./obsidian').updatePersonNote(person, { booked121: start.split('T')[0] });
  } catch (e) {
    console.warn('[1-2-1] Could not stamp 1-2-1-booked:', e.message);
  }

  // NOVA preps the 1-2-1 the day before, but only for a session it holds. Pushed after
  // the event and the stamp so a NOVA outage can never cost us the booking itself; the
  // morning reconciliation sweep re-sends anything that fails here.
  const novaPush = await require('./nova-121-sync').pushBooking(person, start.split('T')[0], {
    outlookEventId: result.event?.id || null,
  });

  return {
    ok: true,
    person,
    event: result.event,
    invited: Boolean(email),
    durationMinutes: durationMinutes || DEFAULT_DURATION_MIN,
    // Surfaced rather than swallowed: a booking NOVA never heard about is a 1-2-1 with
    // no prep, and the caller is the only one still in a position to say so out loud.
    novaSynced: novaPush.ok,
  };
}

// ── Rescheduling ────────────────────────────────────────────────────────────
//
// Moving a 1-2-1 is not booking a new one, and the difference matters socially:
// the attendee has already accepted. So this finds the meeting that EXISTS —
// including ones booked by hand in Outlook, which is most of them — rather than
// only ones NEURO created. book() never stored a Graph event id, and storing one
// from here on would still leave every historic 1-2-1 unreachable.
//
// The move itself is a PATCH (see microsoft.updateCalendarEvent) so the invitee
// gets "moved", not "cancelled" then "invited".

const MOVES_KEY = 'one_to_one_moves';
const MOVE_HISTORY_LIMIT = 20;

/**
 * A synthesised id (from the ICS/bridge fallback) cannot address a real event.
 * Refusing loudly beats a PATCH that 404s after Nick has confirmed a move.
 */
function isRealEventId(id) {
  return Boolean(id) && !String(id).startsWith('graph-');
}

function moveHistory() {
  try {
    const raw = require('../db/database').getState(MOVES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** Every recorded move for a person, newest first. */
function movesFor(name) {
  const all = moveHistory();
  return Array.isArray(all[name]) ? all[name] : [];
}

/**
 * Record that a 1-2-1 moved. This is the point of the feature, not bookkeeping:
 * `one-to-one-detect` catches a 1-2-1 that hasn't HAPPENED, but one slid three
 * times looks healthy in the calendar right up until it's 40 days overdue.
 * Nothing recorded that it moved, so nothing could say so.
 *
 * KV rather than a table, following standup-session and focus-session — a schema
 * migration on the live DB costs more than the query convenience is worth.
 */
function recordMove(name, { from, to, reason = null }) {
  try {
    const db = require('../db/database');
    const all = moveHistory();
    const list = Array.isArray(all[name]) ? all[name] : [];
    list.unshift({ from, to, reason, at: new Date().toISOString() });
    all[name] = list.slice(0, MOVE_HISTORY_LIMIT);
    db.setState(MOVES_KEY, JSON.stringify(all));
    return all[name];
  } catch (e) {
    console.warn('[1-2-1] Could not record move:', e.message);
    return movesFor(name);
  }
}

/**
 * The next 1-2-1 with this person in the diary. Attendee email is the strong
 * match and is tried first; subject is the fallback, because a hand-booked
 * "Catch up - Nick/Hope" may carry no attendee NEURO can resolve.
 */
async function findOneToOne(name, { from = new Date(), days = SEARCH_DAYS } = {}) {
  if (!name) return { ok: false, error: 'person is required' };

  const attendee = await resolveAttendee(name);
  const first = name.split(' ')[0].toLowerCase();

  let events;
  try {
    const microsoft = require('./microsoft');
    events = await microsoft.fetchCalendarEvents(dateStr(from), dateStr(addDays(from, days)));
  } catch (e) {
    return { ok: false, error: `Could not read the calendar: ${e.message}` };
  }

  const candidates = (events || [])
    .filter(e => !['cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .filter(e => !e.isAllDay)
    .filter((e) => {
      const looks121 = ONE_TO_ONE_SUBJECT.test(String(e.subject || ''));
      const byEmail = attendee.email
        && (e.attendees || []).some(a => String(a.email || '').toLowerCase() === attendee.email.toLowerCase());
      // A meeting naming them in the subject counts only if it also reads as a
      // 1-2-1 — "Team Meeting Hope handover" is not one.
      const bySubject = looks121 && String(e.subject || '').toLowerCase().includes(first);
      return byEmail ? looks121 || (e.attendees || []).length <= 2 : bySubject;
    })
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  if (!candidates.length) {
    return { ok: false, error: `No upcoming 1-2-1 with ${name} found in the next ${days} days`, searched: days };
  }

  const event = candidates[0];
  return {
    ok: true,
    person: name,
    event: {
      id: event.id,
      subject: event.subject,
      start: event.start,
      end: event.end,
      date: event.date,
      attendees: event.attendees || [],
    },
    addressable: isRealEventId(event.id),
    alsoFound: candidates.length - 1,
    matchedBy: attendee.email
      && (event.attendees || []).some(a => String(a.email || '').toLowerCase() === attendee.email.toLowerCase())
      ? 'attendee' : 'subject',
  };
}

/**
 * Propose where a 1-2-1 should move TO. Reads only — moves nothing.
 *
 * The existing event is removed from the working calendar before the search, or
 * it clashes with itself and every slot on its own day is refused.
 */
async function proposeReschedule(name, { after = null, durationMinutes = null } = {}) {
  const found = await findOneToOne(name);
  if (!found.ok) return found;
  if (!found.addressable) {
    return { ok: false, error: 'That meeting has no addressable Graph id (calendar came from the ICS fallback) — it cannot be moved from here.', current: found.event };
  }

  const current = found.event;
  const minutes = durationMinutes
    || Math.max(15, toMinutes(current.end) - toMinutes(current.start))
    || DEFAULT_DURATION_MIN;

  // Never today, and never back onto the slot it already has.
  const earliest = after ? new Date(`${after}T12:00:00`) : addDays(new Date(), 1);

  let events;
  try {
    events = await fetchWindow(earliest);
  } catch (e) {
    return { ok: false, error: `Could not read the calendar: ${e.message}` };
  }

  const without = (events || []).filter(e => e.id !== current.id);
  // Moving a 1-2-1 onto a day the person is off is the same mistake as booking
  // one there, and Graph mails them an "updated" notice either way.
  const away = awayFor(name);
  const slot = findSlot(without, earliest, minutes, away.dates);
  if (!slot) {
    return {
      ok: false,
      error: `No free ${minutes}-minute slot in the next ${SEARCH_DAYS} days`
        + (away.checked && away.dates.size ? ` (${name} is off ${away.dates.size} of them)` : ''),
      current,
      awayCheck: away.checked ? 'checked' : 'unknown',
    };
  }

  const attendee = await resolveAttendee(name);
  const priorMoves = movesFor(name);
  return {
    ok: true,
    person: name,
    current,
    proposed: { start: slot.start, end: slot.end, date: slot.date, window: slot.window },
    durationMinutes: minutes,
    attendee,
    eventId: current.id,
    moveCount: priorMoves.length,
    previousMoves: priorMoves.slice(0, 5),
    awayCheck: away.checked ? 'checked' : 'unknown',
    awayNote: away.checked ? null : `Could not check ${name}'s leave — ${away.reason}`,
    // Surfaced so the confirm screen can say it out loud rather than NEURO
    // quietly moving the same 1-2-1 for the fourth time.
    warning: priorMoves.length >= 2
      ? `This 1-2-1 has already been moved ${priorMoves.length} times.`
      : null,
  };
}

/**
 * Move the event. Only ever called after Nick has seen the proposal.
 *
 * `1-2-1-booked` follows the meeting to its new date; `last-1-2-1` does NOT —
 * same rule as book(). Only a written-up note proves a 1-2-1 actually happened.
 */
async function reschedule({ person, eventId, start, end, reason = null, skipClashCheck = false }) {
  if (!person || !eventId || !start || !end) {
    return { ok: false, error: 'person, eventId, start and end are required' };
  }
  if (!isRealEventId(eventId)) {
    return { ok: false, error: 'That event id cannot address a real calendar event' };
  }

  // Re-check right before writing: the proposal may have sat on screen a while.
  // The event being moved is excluded, or it always clashes with itself.
  if (!skipClashCheck) {
    const clash = await findClashExcluding(start, end, eventId);
    if (clash) return { ok: false, error: `That slot clashes with "${clash}"` };
  }

  let previousStart = null;
  try {
    const found = await findOneToOne(person);
    if (found.ok && found.event.id === eventId) previousStart = found.event.start;
  } catch { /* best effort — the move matters more than the audit line */ }

  const microsoft = require('./microsoft');
  const result = await microsoft.updateCalendarEvent(eventId, { start, end });
  if (!result.updated) {
    return { ok: false, error: `Calendar update failed: ${result.reason}`, detail: result.detail || null };
  }

  try {
    require('./obsidian').updatePersonNote(person, { booked121: start.split('T')[0] });
  } catch (e) {
    console.warn('[1-2-1] Could not stamp 1-2-1-booked:', e.message);
  }

  const moves = recordMove(person, { from: previousStart, to: start, reason });
  console.log(`[1-2-1] Moved ${person}: ${previousStart || '(unknown)'} -> ${start} (move ${moves.length})`);

  // Moving the meeting has to move NOVA's session too, or the prep email goes out for
  // the old date — or, worse, not at all, because NOVA already logged it as sent.
  const novaPush = await require('./nova-121-sync').pushBooking(person, start.split('T')[0], {
    outlookEventId: eventId,
  });

  return {
    ok: true,
    person,
    event: result.event,
    movedFrom: previousStart,
    moveCount: moves.length,
    previousMoves: moves.slice(0, 5),
    novaSynced: novaPush.ok,
  };
}

/** findClash, but blind to one event — used when that event is the one moving. */
async function findClashExcluding(start, end, exceptId) {
  const day = start.split('T')[0];
  let events;
  try {
    const microsoft = require('./microsoft');
    events = await microsoft.fetchCalendarEvents(day, day);
  } catch {
    return null; // best-effort: never block on a failed read
  }
  const from = toMinutes(start);
  const to = toMinutes(end);
  const hit = (events || [])
    .filter(e => e.date === day && e.id !== exceptId)
    .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .find(e => (e.isAllDay ? true : from < toMinutes(e.end) && to > toMinutes(e.start)));
  return hit ? (hit.subject || 'an existing meeting') : null;
}

/**
 * Book a whole plan. Sequential and fault-isolated on purpose: these are real
 * invites to real people, so a Graph failure on the fourth must not silently
 * abandon the remaining seven, and it must never retry one that already went
 * out. Every entry comes back with its own outcome.
 *
 * Each slot is re-checked for a clash immediately before it is created — the
 * plan may have been sitting on Nick's screen for a while, and something else
 * could have taken the slot in the meantime.
 */
async function bookAll(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'nothing to book' };
  }

  let events = null;
  try {
    events = await fetchWindow(earliestDate({ nextDue: null }));
  } catch {
    events = null; // clash re-check is best-effort; never blocks the booking
  }

  const results = [];
  for (const item of items) {
    const { person, start, end, email, subject, durationMinutes } = item || {};
    if (!person || !start || !end) {
      results.push({ person: person || '(unknown)', ok: false, error: 'missing person, start or end' });
      continue;
    }

    if (events) {
      const day = new Date(`${start.split('T')[0]}T12:00:00`);
      const from = toMinutes(start);
      const to = toMinutes(end);
      const taken = events
        .filter(e => e.date === start.split('T')[0])
        .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
        .some(e => (e.isAllDay ? true : from < toMinutes(e.end) && to > toMinutes(e.start)));
      if (taken) {
        results.push({ person, ok: false, error: 'slot was taken since the plan was made — re-plan' });
        continue;
      }
      if (countOneToOnes(day, events) >= MAX_PER_DAY) {
        results.push({ person, ok: false, error: `already ${MAX_PER_DAY} 1-2-1s that day — re-plan` });
        continue;
      }
    }

    let outcome;
    try {
      // bookAll has already clash-checked this slot against one calendar read;
      // re-checking per person would be a Graph round-trip each.
      outcome = await book({ person, start, end, email, subject, durationMinutes, skipClashCheck: Boolean(events) });
    } catch (e) {
      outcome = { ok: false, error: e.message };
    }
    results.push({ person, start, end, ...outcome });

    // Reserve it locally too, so two plan entries on the same day still respect
    // the cap even if the calendar read above was unavailable.
    if (outcome.ok && events) reserve(events, person, { date: start.split('T')[0], start, end });
  }

  const booked = results.filter(r => r.ok);
  return {
    ok: booked.length > 0,
    booked: booked.length,
    failed: results.length - booked.length,
    invited: booked.filter(r => r.invited).length,
    results,
  };
}

module.exports = {
  propose,
  planAll,
  book,
  bookAll,
  findOneToOne,
  proposeReschedule,
  reschedule,
  movesFor,
  // exported for tests
  _internals: {
    findGapInWindow, countOneToOnes, findSlot, reserve, subjectFor,
    dateStr, isWorkingDay, earliestDate, toMinutes,
    isRealEventId, recordMove, findClashExcluding, MOVES_KEY,
    PM_WINDOW, AM_WINDOW, MAX_PER_DAY, SEARCH_DAYS,
  },
};
