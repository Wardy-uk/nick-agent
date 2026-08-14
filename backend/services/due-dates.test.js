'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { duePresets, describeDue, nextWorkingDay, nextMonday } = require('../../shared/due-dates.cjs');

// Fixed dates throughout. 2026-08-14 is a Friday, 2026-08-17 a Monday.
const FRIDAY = new Date(2026, 7, 14, 15, 0);
const TUESDAY = new Date(2026, 7, 11, 9, 0);
const SATURDAY = new Date(2026, 7, 15, 10, 0);

test('a weekday offers tomorrow, Monday and next week', () => {
  const p = duePresets(TUESDAY);
  assert.deepEqual(p.map(x => x.id), ['tomorrow', 'monday', 'week']);
  assert.equal(p[0].date, '2026-08-12');
  assert.equal(p[1].date, '2026-08-17');
});

test('Friday does not offer Saturday as tomorrow', () => {
  const p = duePresets(FRIDAY);
  assert.ok(!p.some(x => x.id === 'tomorrow'), 'tomorrow is Saturday and must not be offered');
  // Nick works Mon-Fri; a Saturday due date is silently overdue by Monday.
  for (const preset of p) {
    const d = new Date(`${preset.date}T00:00:00`);
    assert.ok(d.getDay() >= 1 && d.getDay() <= 5, `${preset.label} landed on a weekend`);
  }
});

test('the weekend never offers two buttons for the same day', () => {
  for (const now of [FRIDAY, SATURDAY, TUESDAY]) {
    const dates = duePresets(now).map(p => p.date);
    assert.equal(new Set(dates).size, dates.length, 'duplicate preset dates');
  }
});

test('next working day and next Monday skip the weekend', () => {
  assert.equal(nextWorkingDay(FRIDAY).getDay(), 1);
  assert.equal(nextMonday(FRIDAY).getDate(), 17);
  // From a Monday, "next Monday" is a week away, not today.
  const monday = new Date(2026, 7, 17, 9, 0);
  assert.equal(nextMonday(monday).getDate(), 24);
});

test('due dates read relatively while that is still useful', () => {
  const now = new Date(2026, 7, 14, 9, 0);
  assert.equal(describeDue('2026-08-14', now).label, 'Today');
  assert.equal(describeDue('2026-08-15', now).label, 'Tomorrow');
  assert.equal(describeDue('2026-08-17', now).label, 'Monday');
  // Far enough out that the weekday stops carrying meaning. Matched loosely:
  // en-GB renders the month as "Sept", other ICU builds as "Sep".
  assert.match(describeDue('2026-09-30', now).label, /^30 Sept?$/);
});

test('overdue is flagged, not just described', () => {
  const now = new Date(2026, 7, 14, 9, 0);
  const past = describeDue('2026-08-10', now);
  assert.equal(past.overdue, true);
  assert.match(past.label, /4 days ago/);
  assert.equal(describeDue('2026-08-13', now).label, 'Yesterday');
  assert.equal(describeDue('2026-08-20', now).overdue, false);
});

test('a missing or unparseable date is handled, not thrown', () => {
  assert.equal(describeDue(null), null);
  assert.equal(describeDue(''), null);
  assert.equal(describeDue('not-a-date'), null);
  // ISO timestamps come back from the DB too.
  assert.equal(describeDue('2026-08-14T00:00:00.000Z', new Date(2026, 7, 14)).label, 'Today');
});
