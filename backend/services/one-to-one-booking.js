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

function isWorkingDay(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

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
 */
function findSlot(events, from, durationMinutes) {
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = addDays(from, i);
    if (!isWorkingDay(day)) continue;
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

  const slot = findSlot(events, from, durationMinutes);
  if (!slot) {
    return { ok: false, error: `No free ${durationMinutes}-minute slot in the next ${SEARCH_DAYS} days` };
  }
  return describe(name, slot, { durationMinutes, fmDue, latest });
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
  for (const c of candidates) {
    // Honour each person's own due date — someone not due yet is not pulled forward.
    const earliest = earliestDate({ nextDue: c.fmDue });
    const slot = findSlot(events, earliest, durationMinutes);
    if (!slot) {
      skipped.push({ person: c.name, reason: `no free slot in the next ${SEARCH_DAYS} days` });
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

/**
 * Create the event. Only ever called after Nick has seen the proposal.
 */
async function book({ person, start, end, email, subject, durationMinutes }) {
  if (!person || !start || !end) return { ok: false, error: 'person, start and end are required' };

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

  // The booking is the commitment, so record the next due date against it. The
  // last-1-2-1 date is NOT touched — that only moves when a note proves the
  // meeting actually happened, which is the whole point of the detector.
  try {
    require('./obsidian').updatePersonNote(person, { next121Due: start.split('T')[0] });
  } catch (e) {
    console.warn('[1-2-1] Could not stamp next-1-2-1-due:', e.message);
  }

  return {
    ok: true,
    person,
    event: result.event,
    invited: Boolean(email),
    durationMinutes: durationMinutes || DEFAULT_DURATION_MIN,
  };
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
      outcome = await book({ person, start, end, email, subject, durationMinutes });
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
  // exported for tests
  _internals: {
    findGapInWindow, countOneToOnes, findSlot, reserve, subjectFor,
    dateStr, isWorkingDay, earliestDate, toMinutes,
    PM_WINDOW, AM_WINDOW, MAX_PER_DAY, SEARCH_DAYS,
  },
};
