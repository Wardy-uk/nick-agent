'use strict';

const test = require('node:test');
const assert = require('node:assert');

const shared = require('../../shared/working-days.cjs');
const workingDays = require('./working-days');

// ── The pure half — no DB, no network ────────────────────────────────────────

test('shared: weekends are not working days, weekdays are', () => {
  assert.equal(shared.isWorkingDay(new Date('2026-08-17T12:00:00')), true);  // Mon
  assert.equal(shared.isWorkingDay(new Date('2026-08-21T12:00:00')), true);  // Fri
  assert.equal(shared.isWorkingDay(new Date('2026-08-22T12:00:00')), false); // Sat
  assert.equal(shared.isWorkingDay(new Date('2026-08-23T12:00:00')), false); // Sun
});

test('shared: a holiday in the set turns a weekday off', () => {
  const set = new Set(['2026-08-31']);
  assert.equal(shared.isWorkingDay(new Date('2026-08-31T12:00:00')), true, 'no set = old Mon-Fri behaviour');
  assert.equal(shared.isWorkingDay(new Date('2026-08-31T12:00:00'), set), false);
  assert.equal(shared.nonWorkingReason(new Date('2026-08-31T12:00:00'), set), 'holiday');
  assert.equal(shared.nonWorkingReason(new Date('2026-08-22T12:00:00'), set), 'weekend');
  assert.equal(shared.nonWorkingReason(new Date('2026-08-17T12:00:00'), set), null);
});

test('shared: accepts an array as well as a Set', () => {
  assert.equal(shared.isWorkingDay(new Date('2026-12-25T12:00:00'), ['2026-12-25']), false);
});

test('shared: nextWorkingDay steps over a holiday, not just a weekend', () => {
  // Fri 2026-12-25 is Christmas, Mon 2026-12-28 is Boxing Day observed.
  const set = new Set(['2026-12-25', '2026-12-28']);
  const next = shared.nextWorkingDay(new Date('2026-12-24T12:00:00'), set);
  assert.equal(shared.toDateStr(next), '2026-12-29');
});

test('shared: nextWorkingDay is bounded rather than able to hang', () => {
  // A set that swallows everything must terminate; an unbounded while-loop here
  // would hang the request instead of returning a wrong-but-visible answer.
  const everything = { has: () => true };
  const next = shared.nextWorkingDay(new Date('2026-08-17T12:00:00'), everything);
  assert.ok(next instanceof Date);
});

// ── The data half ────────────────────────────────────────────────────────────

test('the builtin floor knows about Christmas', () => {
  // The whole safety argument rests on this: with no network AND no cache, the
  // predicate must still refuse to book a meeting on Christmas Day.
  const dates = new Set(workingDays.BUILTIN.map(e => e.date));
  assert.ok(dates.has('2026-12-25'));
  assert.ok(dates.has('2026-08-31'));
  assert.ok(dates.has('2027-03-26'), 'Easter moves — it must come from the feed, not a guess');
  assert.ok(workingDays.BUILTIN.length >= 24);
});

test('the holiday set is never empty', () => {
  // An empty set reads as "no holidays this year" and is exactly the failure
  // this module exists to prevent, so there is no code path that produces one.
  assert.ok(workingDays.holidaySet().size > 0);
});

test('status names its source and never claims a live fetch it did not make', () => {
  const s = workingDays.status();
  assert.ok(['live', 'cache', 'builtin'].includes(s.source));
  assert.ok(s.count > 0);
  if (s.source === 'builtin') assert.equal(s.stale, true, 'builtin is a floor, and must say so');
});

test('a bank holiday is not a working day', () => {
  assert.equal(workingDays.isWorkingDay('2026-08-31'), false, 'Summer bank holiday (a Monday)');
  assert.equal(workingDays.isWorkingDay('2026-12-25'), false, 'Christmas Day (a Friday)');
  assert.equal(workingDays.isWorkingDay('2026-08-17'), true, 'an ordinary Monday');
  assert.equal(workingDays.nonWorkingReason('2026-08-31'), 'holiday');
  assert.equal(workingDays.holidayOn('2026-08-31').title, 'Summer bank holiday');
});

// ── Leave ────────────────────────────────────────────────────────────────────

test('leaveDates reads showAs oof and nothing else', () => {
  const events = [
    { date: '2026-09-01', start: '2026-09-01T09:00:00', end: '2026-09-01T17:00:00', showAs: 'busy' },
    { date: '2026-09-02', start: '2026-09-02T09:00:00', end: '2026-09-02T17:00:00', showAs: 'oof' },
  ];
  const leave = workingDays.leaveDates(events);
  assert.equal(leave.has('2026-09-02'), true);
  assert.equal(leave.has('2026-09-01'), false);
});

test('an all-day OOF spans its range, and Graph\'s exclusive end date is honoured', () => {
  // A week off is ONE event, not five. Graph's all-day end is the day AFTER the
  // last day off — counting it would mark an extra day as leave and quietly
  // refuse a slot that was actually free.
  const events = [{
    start: '2026-09-07T00:00:00', end: '2026-09-12T00:00:00',
    isAllDay: true, showAs: 'oof', subject: 'Annual leave',
  }];
  const leave = workingDays.leaveDates(events);
  assert.equal(leave.has('2026-09-07'), true);
  assert.equal(leave.has('2026-09-11'), true, 'Friday is still leave');
  assert.equal(leave.has('2026-09-12'), false, 'the exclusive end date is NOT leave');
});

test('a single all-day OOF day does not collapse to nothing', () => {
  const events = [{ start: '2026-09-07T00:00:00', end: '2026-09-08T00:00:00', isAllDay: true, showAs: 'oof' }];
  assert.deepEqual([...workingDays.leaveDates(events)], ['2026-09-07']);
});

test('leave makes a weekday non-working, but only when events are passed', () => {
  const events = [{ start: '2026-09-07T00:00:00', end: '2026-09-08T00:00:00', isAllDay: true, showAs: 'oof' }];
  assert.equal(workingDays.isWorkingDay('2026-09-07'), true, 'no events = leave is unknown, not assumed');
  assert.equal(workingDays.isWorkingDay('2026-09-07', events), false);
  assert.equal(workingDays.nonWorkingReason('2026-09-07', events), 'leave');
});

test('a bank holiday outranks leave in the reason, and both stop a booking', () => {
  const events = [{ start: '2026-08-31T00:00:00', end: '2026-09-01T00:00:00', isAllDay: true, showAs: 'oof' }];
  assert.equal(workingDays.isWorkingDay('2026-08-31', events), false);
  assert.equal(workingDays.nonWorkingReason('2026-08-31', events), 'holiday');
});
