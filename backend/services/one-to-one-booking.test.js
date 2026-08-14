'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('./one-to-one-booking');
const {
  findGapInWindow, countOneToOnes, dateStr, isWorkingDay, toMinutes,
  PM_WINDOW, AM_WINDOW, MAX_PER_DAY,
} = _internals;

// Graph hands back naive local wall-clock strings once Prefer: outlook.timezone
// is set, so slot maths is plain string/minute arithmetic — no offsets by hand.

const DAY = new Date('2026-08-17T12:00:00'); // a Monday
const D = dateStr(DAY);

function ev(start, end, extra = {}) {
  return { date: D, start: `${D}T${start}:00`, end: `${D}T${end}:00`, showAs: 'busy', ...extra };
}

test('reads wall-clock times without timezone conversion', () => {
  assert.equal(toMinutes('2026-08-17T14:30:00'), 14 * 60 + 30);
});

test('weekends are not working days', () => {
  assert.equal(isWorkingDay(new Date('2026-08-17T12:00:00')), true);  // Mon
  assert.equal(isWorkingDay(new Date('2026-08-22T12:00:00')), false); // Sat
  assert.equal(isWorkingDay(new Date('2026-08-23T12:00:00')), false); // Sun
});

// ---------------------------------------------------------------------------
// Nick's booking rules (14 Aug 2026)
// ---------------------------------------------------------------------------

test('rule: never at 9am — the morning window opens at 10:00', () => {
  assert.equal(AM_WINDOW.from, 10 * 60);
  const gap = findGapInWindow(DAY, [], AM_WINDOW, 30);
  assert.equal(gap.start, 10 * 60, 'earliest morning slot is 10:00, never 09:00');
});

test('rule: never 12-2 — nothing can be offered in the lunch gap', () => {
  // The two windows are the only bookable space, and neither touches 12:00-14:00.
  assert.equal(AM_WINDOW.to, 12 * 60);
  assert.equal(PM_WINDOW.from, 14 * 60);
  for (const w of [AM_WINDOW, PM_WINDOW]) {
    const gap = findGapInWindow(DAY, [], w, 30);
    assert.ok(gap.end <= 12 * 60 || gap.start >= 14 * 60, 'slot must avoid 12:00-14:00');
  }
});

test('rule: never after 4.30pm — a 30-min slot cannot start later than 16:00', () => {
  assert.equal(PM_WINDOW.to, 16 * 60 + 30);
  // Afternoon busy right up to 16:00 leaves exactly one legal 30-min slot.
  const gap = findGapInWindow(DAY, [ev('14:00', '16:00')], PM_WINDOW, 30);
  assert.deepEqual(gap, { start: 16 * 60, end: 16 * 60 + 30 });
  // Busy to 16:15 leaves only 15 minutes before the window shuts — no slot.
  assert.equal(findGapInWindow(DAY, [ev('14:00', '16:15')], PM_WINDOW, 30), null);
});

test('rule: never when a meeting already exists', () => {
  const gap = findGapInWindow(DAY, [ev('14:00', '15:00')], PM_WINDOW, 30);
  assert.equal(gap.start, 15 * 60, 'must skip past the existing meeting');
});

test('rule: never more than 2 per day', () => {
  assert.equal(MAX_PER_DAY, 2);
  const existing = [
    ev('10:00', '10:30', { subject: '1-2-1 — Nick / Heidi' }),
    ev('14:00', '14:30', { subject: 'One-to-one with Luke' }),
  ];
  assert.equal(countOneToOnes(DAY, existing), 2, 'counts both naming conventions');
  assert.ok(countOneToOnes(DAY, existing) >= MAX_PER_DAY, 'day is full for 1-2-1s');
});

test('the 2-per-day cap only counts 1-2-1s, not ordinary meetings', () => {
  const events = [
    ev('10:00', '10:30', { subject: 'Weekly Meeting: Ticket Review' }),
    ev('11:00', '11:30', { subject: 'Sprint planning' }),
    ev('14:00', '14:30', { subject: '1-2-1 — Nick / Zoe' }),
  ];
  assert.equal(countOneToOnes(DAY, events), 1);
});

test('a cancelled 1-2-1 does not count toward the daily cap', () => {
  const events = [
    ev('10:00', '10:30', { subject: '1-2-1 — Nick / Heidi', showAs: 'cancelled' }),
    ev('14:00', '14:30', { subject: '1-2-1 — Nick / Zoe' }),
  ];
  assert.equal(countOneToOnes(DAY, events), 1);
});

test('the cap ignores 1-2-1s on other days', () => {
  const other = { date: '2026-08-18', start: '2026-08-18T14:00:00', end: '2026-08-18T14:30:00', subject: '1-2-1 — Nick / Abdi', showAs: 'busy' };
  assert.equal(countOneToOnes(DAY, [other]), 0);
});

// ---------------------------------------------------------------------------
// Gap finding
// ---------------------------------------------------------------------------

test('takes the top of the window when the day is clear', () => {
  assert.deepEqual(findGapInWindow(DAY, [], PM_WINDOW, 30), { start: 14 * 60, end: 14 * 60 + 30 });
});

test('finds a gap between two meetings', () => {
  const gap = findGapInWindow(DAY, [ev('14:00', '15:00'), ev('15:30', '16:30')], PM_WINDOW, 30);
  assert.deepEqual(gap, { start: 15 * 60, end: 15 * 60 + 30 });
});

test('returns null when the window is full', () => {
  assert.equal(findGapInWindow(DAY, [ev('14:00', '16:30')], PM_WINDOW, 30), null);
});

test('events marked free or cancelled do not block', () => {
  const gap = findGapInWindow(DAY, [
    ev('14:00', '15:00', { showAs: 'free' }),
    ev('14:00', '15:00', { showAs: 'cancelled' }),
  ], PM_WINDOW, 30);
  assert.equal(gap.start, 14 * 60);
});

test('a tentative meeting still blocks — it is not a free slot', () => {
  const gap = findGapInWindow(DAY, [ev('14:00', '15:00', { showAs: 'tentative' })], PM_WINDOW, 30);
  assert.equal(gap.start, 15 * 60);
});

test('an all-day event blocks the whole window', () => {
  assert.equal(findGapInWindow(DAY, [{ date: D, isAllDay: true, showAs: 'busy' }], PM_WINDOW, 30), null);
});

test("another day's events are ignored", () => {
  const other = { date: '2026-08-18', start: '2026-08-18T14:00:00', end: '2026-08-18T16:30:00', showAs: 'busy' };
  assert.equal(findGapInWindow(DAY, [other], PM_WINDOW, 30).start, 14 * 60);
});

test('dateStr uses local getters, not UTC', () => {
  // A BST evening: toISOString() would roll this to the 18th.
  assert.equal(dateStr(new Date(2026, 7, 17, 23, 30)), '2026-08-17');
});
