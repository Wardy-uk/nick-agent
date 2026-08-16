'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cadenceState } = require('./one-to-one-detect');

// These pin the fix for the bug where NEURO reminded Nick to book 1-2-1s that
// were already in his diary.
//
// The cause: `next-1-2-1-due` carried two meanings. one-to-one-detect wrote it
// as "when the next one is OWED" (last held + cadence); one-to-one-booking's
// book() overwrote it with the date of the meeting it had just created. Both
// readers — the 1-2-1 nudge and the Team board — assumed the first meaning, so
// every booking wrote a nag against itself: "Get them in the diary" about a
// meeting already in it, then "These need booking now" the day after it
// happened. A booking now lives in `1-2-1-booked` and this function is the one
// place that decides what any of it means.

const TODAY = '2026-08-16';

test('a 1-2-1 in the diary is silent — the whole point of the fix', () => {
  const s = cadenceState({
    lastHeld: '2026-03-26',   // genuinely ages ago...
    nextDue: '2026-04-09',    // ...so the cadence date is long past
    booked: '2026-08-18',     // ...but it IS booked
  }, TODAY);
  assert.equal(s.state, 'booked');
  assert.equal(s.daysUntil, 2);
});

test('a booking today still counts as booked, not overdue', () => {
  const s = cadenceState({ lastHeld: '2026-07-01', nextDue: '2026-07-15', booked: TODAY }, TODAY);
  assert.equal(s.state, 'booked');
  assert.equal(s.daysUntil, 0);
});

test('the booked date passing with no note is unwritten, NOT "needs booking"', () => {
  // This is the state the old code reported as "Overdue 1-2-1: Stephen (was
  // 2026-08-18). These need booking now." — about a meeting that had happened.
  const s = cadenceState({
    lastHeld: '2026-03-26',
    nextDue: '2026-04-09',
    booked: '2026-08-14',
  }, TODAY);
  assert.equal(s.state, 'unwritten');
  assert.equal(s.daysSince, 2);
});

test('a note dated on the booking clears it — the booking is spent', () => {
  const s = cadenceState({
    lastHeld: '2026-08-14',   // the write-up landed
    nextDue: '2026-08-28',
    booked: '2026-08-14',
  }, TODAY);
  assert.equal(s.state, 'ok');
});

test('a note dated BEFORE the booking does not cancel it', () => {
  // An unrelated earlier meeting note must not make a future booking vanish.
  const s = cadenceState({
    lastHeld: '2026-08-01',
    nextDue: '2026-08-15',
    booked: '2026-08-20',
  }, TODAY);
  assert.equal(s.state, 'booked');
});

test('nothing booked and the due date is past → overdue', () => {
  const s = cadenceState({ lastHeld: '2026-07-01', nextDue: '2026-07-15' }, TODAY);
  assert.equal(s.state, 'overdue');
  assert.equal(s.daysOverdue, 32);
});

test('nothing booked and due within the window → due-soon', () => {
  const s = cadenceState({ lastHeld: '2026-08-04', nextDue: '2026-08-18' }, TODAY);
  assert.equal(s.state, 'due-soon');
  assert.equal(s.daysUntil, 2);
});

test('soonDays is respected — the board uses 3, the nudge 2', () => {
  const args = { lastHeld: '2026-08-05', nextDue: '2026-08-19' };
  assert.equal(cadenceState(args, TODAY, { soonDays: 2 }).state, 'ok');
  assert.equal(cadenceState(args, TODAY, { soonDays: 3 }).state, 'due-soon');
});

test('someone off-cadence is never chased, however overdue the numbers look', () => {
  // `cadence: n/a` is how maternity / long-term sick comes out of the rota.
  const s = cadenceState({ lastHeld: '2026-01-01', nextDue: '2026-01-15', bookable: false }, TODAY);
  assert.equal(s.state, 'ok');
});

test('no due date and no booking is quiet, not overdue', () => {
  assert.equal(cadenceState({ lastHeld: '2026-08-01' }, TODAY).state, 'ok');
});

test('a booking with no last-1-2-1 at all still reads unwritten once it passes', () => {
  const s = cadenceState({ booked: '2026-08-10' }, TODAY);
  assert.equal(s.state, 'unwritten');
  assert.equal(s.daysSince, 6);
});

test('date maths does not drift across the BST boundary', () => {
  // The Pi may run UTC; addDays/daysBetween both anchor at midday for this.
  const s = cadenceState({ nextDue: '2026-10-26' }, '2026-10-24', { soonDays: 3 });
  assert.equal(s.state, 'due-soon');
  assert.equal(s.daysUntil, 2);
});
