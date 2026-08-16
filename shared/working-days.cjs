'use strict';

/**
 * What counts as a working day — the pure half.
 *
 * There were FIVE independent Mon-Fri checks in this repo (one-to-one-booking,
 * standup-session, due-dates, obsidian's 90-day plan, and assorted inline
 * `getDay()` tests) and every one of them meant nothing more than "Mon-Fri".
 * That is not a cosmetic duplication: `one-to-one-booking.bookAll()` creates
 * real Graph events and emails real invites to Nick's direct reports, so it
 * would happily book a 1-2-1 on a bank holiday, and the standup would plan him
 * a full day on one.
 *
 * This module is deliberately PURE and browser-safe — no DB, no network, no
 * `require` of anything. It is imported by both frontends via
 * `shared/due-dates.cjs`, so it cannot reach agent_state. The knowledge of
 * WHICH days are holidays lives in `backend/services/working-days.js`, which
 * owns the gov.uk feed and its cache and hands a set in here. Same split as
 * `pi-health.assess()` and `one-to-one-detect.cadenceState()`: the judgement is
 * testable without a vault, a DB or a network.
 *
 * `nonWorking` is always an OPTIONAL set of `YYYY-MM-DD` strings. Omitting it
 * gives the old Mon-Fri behaviour exactly, which is what the browser callers
 * still get — they have no way to fetch the list, and a preset button that is
 * one day wrong at Christmas is a far smaller problem than an invite is.
 */

/** Local getters, never toISOString() — the Pi runs UTC and that rolls the date. */
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function isWeekday(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

/** Accepts a Set, an array, or nothing. Nothing means "no holidays known". */
function _has(nonWorking, dateStr) {
  if (!nonWorking) return false;
  if (typeof nonWorking.has === 'function') return nonWorking.has(dateStr);
  return Array.isArray(nonWorking) && nonWorking.includes(dateStr);
}

function isWorkingDay(d, nonWorking) {
  if (!isWeekday(d)) return false;
  return !_has(nonWorking, toDateStr(d));
}

/**
 * Why a day is not a working one. Callers surface this rather than silently
 * skipping — "no slot found" and "that week is Christmas" are different answers
 * and only one of them is worth showing.
 */
function nonWorkingReason(d, nonWorking) {
  const day = d.getDay();
  if (day === 0 || day === 6) return 'weekend';
  if (_has(nonWorking, toDateStr(d))) return 'holiday';
  return null;
}

/** The next working day strictly after `from`. */
function nextWorkingDay(from, nonWorking) {
  let d = addDays(from, 1);
  // Bounded: a run of non-working days longer than a fortnight means the set is
  // wrong, and an unbounded loop would hang the request rather than say so.
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d, nonWorking)) return d;
    d = addDays(d, 1);
  }
  return d;
}

module.exports = { toDateStr, addDays, isWeekday, isWorkingDay, nonWorkingReason, nextWorkingDay };
