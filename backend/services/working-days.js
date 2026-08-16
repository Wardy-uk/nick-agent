'use strict';

/**
 * Working days — the half that knows WHICH days are holidays.
 *
 * Before this, a repo-wide grep for "bank holiday" returned exactly one hit: a
 * hardcoded three-date array inside `obsidian.parseNinetyDayPlan()`, which was
 * already wrong for its own year (it lists 3 Apr, 6 Apr and 4 May 2026 and
 * misses 25 May) and is now dead code besides — the 90 Day Plan folder was
 * archived on 12 Aug, so that function returns null. Everything else meant
 * nothing more than Mon-Fri.
 *
 * That is not cosmetic. `one-to-one-booking.bookAll()` creates real Graph
 * events and emails real invites to Nick's direct reports, and its SEARCH_DAYS
 * is 21 — so on 16 Aug 2026 the Summer bank holiday (31 Aug) sat inside the
 * live booking window.
 *
 * ── Failure direction ───────────────────────────────────────────────────────
 * This is a network call, and **failing open books meetings on Christmas Day**.
 * So it never falls back to "every weekday is a working day". Three sources, in
 * order, and `status()` always says which one answered:
 *
 *   live    — gov.uk fetched this run
 *   cache   — the last good copy, in `agent_state.bank_holidays`
 *   builtin — the BUILTIN floor below, compiled in
 *
 * The floor is what makes the safe direction cheap: the gov.uk feed is not a
 * live API but a static publication covering 2019-2028, so a copy taken today
 * is correct for years. A Pi that has never once reached the internet still
 * knows about Christmas. It is a FLOOR, not a substitute — the fetch keeps it
 * honest, and `status()` reports the age so a silently frozen list is visible
 * rather than assumed.
 *
 * ── Leave ───────────────────────────────────────────────────────────────────
 * Nick's own leave is not a property of the day, it is a property of Nick, so
 * it does not live in the holiday set. `leaveDates(events)` reads it from
 * calendar events the CALLER already has (`showAs: 'oof'`) rather than fetching
 * — one-to-one-booking holds a whole window of events in hand when it searches,
 * and a slot search that pauses for I/O per day is a slot search that times
 * out. Note an all-day OOF event already blocked booking by accident, because
 * `findGapInWindow` treats anything not free/cancelled as busy; a TIMED oof did
 * not, and nothing anywhere could say the word "leave".
 */

const db = require('../db/database');
const shared = require('../../shared/working-days.cjs');

const FEED_URL = 'https://www.gov.uk/bank-holidays.json';
const DIVISION = 'england-and-wales';
const STATE_KEY = 'bank_holidays';
// The feed is a static publication, not a live API. Weekly is plenty and the
// builtin floor covers the gap if it lapses.
const REFRESH_AFTER_DAYS = 7;
const STALE_AFTER_DAYS = 90;

/**
 * England-and-Wales bank holidays, taken verbatim from the gov.uk feed on
 * 16 Aug 2026. Regenerate by extending it from the same feed — do NOT hand-type
 * Easter, which moves.
 */
const BUILTIN = [
  ['2026-01-01', "New Year's Day"],
  ['2026-04-03', 'Good Friday'],
  ['2026-04-06', 'Easter Monday'],
  ['2026-05-04', 'Early May bank holiday'],
  ['2026-05-25', 'Spring bank holiday'],
  ['2026-08-31', 'Summer bank holiday'],
  ['2026-12-25', 'Christmas Day'],
  ['2026-12-28', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-03-26', 'Good Friday'],
  ['2027-03-29', 'Easter Monday'],
  ['2027-05-03', 'Early May bank holiday'],
  ['2027-05-31', 'Spring bank holiday'],
  ['2027-08-30', 'Summer bank holiday'],
  ['2027-12-27', 'Christmas Day'],
  ['2027-12-28', 'Boxing Day'],
  ['2028-01-03', "New Year's Day"],
  ['2028-04-14', 'Good Friday'],
  ['2028-04-17', 'Easter Monday'],
  ['2028-05-01', 'Early May bank holiday'],
  ['2028-05-29', 'Spring bank holiday'],
  ['2028-08-28', 'Summer bank holiday'],
  ['2028-12-25', 'Christmas Day'],
  ['2028-12-26', 'Boxing Day'],
].map(([date, title]) => ({ date, title }));

// In-memory snapshot so `isWorkingDay` can stay SYNC. Every caller is inside a
// loop over days; making the predicate async would push a DB read into each
// iteration of the slot search for no gain.
let _snapshot = null;

function _todayStr() {
  return shared.toDateStr(new Date());
}

function _daysBetween(fromStr, toStr) {
  const a = new Date(`${fromStr}T12:00:00`);
  const b = new Date(`${toStr}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

function _readCache() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.events) || parsed.events.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The set in force right now. Falls back through cache to builtin, and never
 * returns an empty set — an empty set is indistinguishable from "no holidays
 * this year", which is the failure mode this whole module exists to avoid.
 */
function _load() {
  if (_snapshot) return _snapshot;
  const cached = _readCache();
  if (cached) {
    _snapshot = {
      source: 'cache',
      fetchedAt: cached.fetchedAt || null,
      events: cached.events,
    };
  } else {
    _snapshot = { source: 'builtin', fetchedAt: null, events: BUILTIN };
  }
  _snapshot.dates = new Set(_snapshot.events.map(e => e.date));
  return _snapshot;
}

/** Drop the memoised snapshot — used after a refresh and by tests. */
function _reset() {
  _snapshot = null;
}

/** The bank-holiday date set, as `YYYY-MM-DD` strings. */
function holidaySet() {
  return _load().dates;
}

/**
 * Fetch the feed and persist it. Returns the same shape as `status()` so a
 * caller can log one line. Never throws — a failed refresh leaves the previous
 * source in place, which is the whole point.
 */
async function refresh({ force = false } = {}) {
  const before = _load();
  if (!force && before.source === 'cache' && before.fetchedAt) {
    const age = _daysBetween(before.fetchedAt, _todayStr());
    if (age !== null && age < REFRESH_AFTER_DAYS) {
      return { ...status(), skipped: 'fresh' };
    }
  }

  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const division = body && body[DIVISION];
    const events = (division && Array.isArray(division.events) ? division.events : [])
      .filter(e => e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .map(e => ({ date: e.date, title: String(e.title || '').trim() }));

    // A structurally valid response carrying nothing is a failure, not an
    // answer. Same rule as #56: a partial result must not overwrite a good one.
    if (events.length === 0) throw new Error(`feed had no ${DIVISION} events`);

    db.setState(STATE_KEY, JSON.stringify({
      fetchedAt: _todayStr(),
      division: DIVISION,
      events,
    }));
    _reset();
    const s = status();
    console.log(`[WorkingDays] refreshed ${events.length} ${DIVISION} bank holidays (through ${events[events.length - 1].date})`);
    return { ...s, refreshed: true };
  } catch (err) {
    // Loud, because a list that silently stops updating is exactly how the
    // hardcoded array in obsidian.js went stale for a year.
    console.warn(`[WorkingDays] bank-holiday refresh failed (${err.message}) — falling back to ${before.source}`);
    return { ...status(), refreshed: false, error: err.message };
  }
}

/** What the module is actually running on, and how old it is. */
function status() {
  const snap = _load();
  const ageDays = snap.fetchedAt ? _daysBetween(snap.fetchedAt, _todayStr()) : null;
  const today = _todayStr();
  const upcoming = snap.events.filter(e => e.date >= today).slice(0, 3);
  return {
    source: snap.source,
    fetchedAt: snap.fetchedAt,
    ageDays,
    count: snap.events.length,
    coversTo: snap.events.length ? snap.events[snap.events.length - 1].date : null,
    // "builtin" is not an error — a Pi that has never reached gov.uk still
    // knows about Christmas. It IS worth saying out loud, which is why it is
    // its own state rather than being folded into ok/stale (same three-state
    // rule as state-of-play: unknown is not broken).
    stale: snap.source === 'builtin' || (ageDays !== null && ageDays > STALE_AFTER_DAYS),
    upcoming,
  };
}

/** The bank holiday on a date, or null. */
function holidayOn(date) {
  const str = typeof date === 'string' ? date : shared.toDateStr(date);
  return _load().events.find(e => e.date === str) || null;
}

/**
 * Dates Nick is out of office, derived from calendar events the caller already
 * holds. Graph reports leave as `showAs: 'oof'`; an all-day OOF spans its whole
 * date range, so a week off is one event, not five.
 */
function leaveDates(events) {
  const out = new Set();
  for (const e of events || []) {
    if (String(e.showAs || '').toLowerCase() !== 'oof') continue;
    const startStr = String(e.start || e.date || '').split('T')[0];
    const endStr = String(e.end || e.start || e.date || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) continue;
    const cursor = new Date(`${startStr}T12:00:00`);
    const last = new Date(`${/^\d{4}-\d{2}-\d{2}$/.test(endStr) ? endStr : startStr}T12:00:00`);
    // Graph's all-day end date is EXCLUSIVE — a single day off ends on the
    // following date. A timed event's end is inclusive of the same day.
    if (e.isAllDay && last > cursor) last.setDate(last.getDate() - 1);
    // Bounded so a malformed pair cannot spin; a month is far longer than any
    // single leave block and the cap is logged by the caller if it ever bites.
    for (let i = 0; i < 40 && cursor <= last; i++) {
      out.add(shared.toDateStr(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return out;
}

/**
 * The ONE predicate. Mon-Fri, not a bank holiday, and — when the caller passes
 * the calendar events it already fetched — not a day Nick is on leave.
 */
function isWorkingDay(date, events) {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00`) : date;
  const nonWorking = events ? new Set([...holidaySet(), ...leaveDates(events)]) : holidaySet();
  return shared.isWorkingDay(d, nonWorking);
}

/** 'weekend' | 'holiday' | 'leave' | null — so a caller can say why. */
function nonWorkingReason(date, events) {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00`) : date;
  const base = shared.nonWorkingReason(d, holidaySet());
  if (base) return base;
  if (events && leaveDates(events).has(shared.toDateStr(d))) return 'leave';
  return null;
}

/** The next working day strictly after `from`. */
function nextWorkingDay(from, events) {
  const nonWorking = events ? new Set([...holidaySet(), ...leaveDates(events)]) : holidaySet();
  return shared.nextWorkingDay(from, nonWorking);
}

module.exports = {
  isWorkingDay,
  nonWorkingReason,
  nextWorkingDay,
  holidaySet,
  holidayOn,
  leaveDates,
  refresh,
  status,
  BUILTIN,
  _internals: { _reset, _daysBetween, STATE_KEY, FEED_URL, DIVISION },
};
