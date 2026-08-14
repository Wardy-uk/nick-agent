'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('./one-to-one-booking');
const { findGapInWindow, dateStr, isWorkingDay, toMinutes, PM_WINDOW, AM_WINDOW } = _internals;

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

test('takes the top of the window when the day is clear', () => {
  const gap = findGapInWindow(DAY, [], PM_WINDOW, 30);
  assert.deepEqual(gap, { start: 14 * 60, end: 14 * 60 + 30 });
});

test('skips past a clashing meeting', () => {
  const gap = findGapInWindow(DAY, [ev('14:00', '15:00')], PM_WINDOW, 30);
  assert.equal(gap.start, 15 * 60);
});

test('finds a gap between two meetings', () => {
  const gap = findGapInWindow(DAY, [ev('14:00', '15:00'), ev('15:30', '17:00')], PM_WINDOW, 30);
  assert.deepEqual(gap, { start: 15 * 60, end: 15 * 60 + 30 });
});

test('returns null when the window is full', () => {
  assert.equal(findGapInWindow(DAY, [ev('14:00', '17:00')], PM_WINDOW, 30), null);
});

test('a 30-minute slot cannot overrun the end of the window', () => {
  // Free from 16:45, but the window closes at 17:00 — not enough room.
  const gap = findGapInWindow(DAY, [ev('14:00', '16:45')], PM_WINDOW, 30);
  assert.equal(gap, null);
});

test('events marked free or cancelled do not block', () => {
  const gap = findGapInWindow(DAY, [
    ev('14:00', '15:00', { showAs: 'free' }),
    ev('14:00', '15:00', { showAs: 'cancelled' }),
  ], PM_WINDOW, 30);
  assert.equal(gap.start, 14 * 60);
});

test('an all-day event blocks the whole window', () => {
  const gap = findGapInWindow(DAY, [{ date: D, isAllDay: true, showAs: 'busy' }], PM_WINDOW, 30);
  assert.equal(gap, null);
});

test('another day\'s events are ignored', () => {
  const other = { date: '2026-08-18', start: '2026-08-18T14:00:00', end: '2026-08-18T17:00:00', showAs: 'busy' };
  const gap = findGapInWindow(DAY, [other], PM_WINDOW, 30);
  assert.equal(gap.start, 14 * 60);
});

test('the morning window is available as a fallback', () => {
  const gap = findGapInWindow(DAY, [], AM_WINDOW, 30);
  assert.deepEqual(gap, { start: 9 * 60, end: 9 * 60 + 30 });
});

test('dateStr uses local getters, not UTC', () => {
  // A BST evening: toISOString() would roll this to the 18th.
  assert.equal(dateStr(new Date(2026, 7, 17, 23, 30)), '2026-08-17');
});
