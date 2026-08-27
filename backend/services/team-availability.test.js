'use strict';

/**
 * The decision that licenses SILENCE.
 *
 * `selfAbsenceOn` is pure — it takes the snapshot and the date — so the rule
 * pins without NOVA, a network or a clock. That matters more here than usual:
 * every failure mode of this feature is NEURO going quiet when it should not
 * have, and a quiet system is indistinguishable from a working one until Nick
 * misses something.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ta = require('./team-availability');

const ME = { rosterId: 24, name: 'Nick Ward', pool: 'support', syncable: true };
const HOPE = { rosterId: 9, name: 'Hope Goodall', pool: 'cc', syncable: true };

const snap = (over = {}) => ({
  known: true,
  stale: false,
  fetchedAt: '2026-08-27T11:00:00.000Z',
  rosterCount: 2,
  roster: [ME, HOPE],
  absences: [],
  ...over,
});

const byId = { by: 'id', id: 24, name: null };
const byName = { by: 'name', id: null, name: 'Nick Ward' };

// ── The all-clear, and the things that only look like one ───────────────────

test('a working day with no booked absence is a REAL all-clear', () => {
  const r = ta.selfAbsenceOn('2026-08-27', snap(), byId);
  assert.equal(r.off, false);
  assert.equal(r.known, true, 'we looked, and he is in');
});

test('no snapshot at all is NOT an all-clear', () => {
  const r = ta.selfAbsenceOn('2026-08-27', { known: false, reason: 'never fetched' }, byId);
  assert.equal(r.off, false);
  assert.equal(r.known, false, 'never fetched must not read as "he is working"');
});

test('an EMPTY roster is a broken roster, not a free team', () => {
  const r = ta.selfAbsenceOn('2026-08-27', snap({ rosterCount: 0, roster: [] }), byId);
  assert.equal(r.known, false);
  assert.match(r.reason, /roster empty/);
});

test('not being in the roster is reported, not treated as present', () => {
  const r = ta.selfAbsenceOn('2026-08-27', snap({ roster: [HOPE], rosterCount: 1 }), byId);
  assert.equal(r.known, false);
  assert.match(r.reason, /not in the NOVA roster/);
});

test('an agent with no People HR id can never be known to be off', () => {
  // They simply always look available — absence of evidence reading exactly
  // like evidence of presence.
  const r = ta.selfAbsenceOn('2026-08-27', snap({ roster: [{ ...ME, syncable: false }, HOPE] }), byId);
  assert.equal(r.known, false);
  assert.match(r.reason, /People HR id/);
});

// ── Being off ───────────────────────────────────────────────────────────────

test('a booked absence on the day suppresses, and says why', () => {
  const r = ta.selfAbsenceOn('2026-08-28', snap({
    absences: [{ rosterId: 24, date: '2026-08-28', status: 'annual_leave', reason: 'Annual Leave', setBy: 'peoplehr' }],
  }), byId);
  assert.equal(r.off, true);
  assert.equal(r.status, 'annual_leave');
  assert.equal(r.detail, 'Annual Leave');
});

test('someone else being off does not make Nick off', () => {
  const r = ta.selfAbsenceOn('2026-08-28', snap({
    absences: [{ rosterId: 9, date: '2026-08-28', status: 'annual_leave', reason: 'Annual Leave' }],
  }), byId);
  assert.equal(r.off, false);
  assert.equal(r.known, true);
});

test('an absence on a DIFFERENT date does not suppress today', () => {
  const r = ta.selfAbsenceOn('2026-08-27', snap({
    absences: [{ rosterId: 24, date: '2026-08-31', status: 'annual_leave', reason: 'Annual Leave' }],
  }), byId);
  assert.equal(r.off, false);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('matching by name finds the same row as matching by id', () => {
  const absences = [{ rosterId: 24, date: '2026-08-28', status: 'sick', reason: 'Toothache' }];
  const a = ta.selfAbsenceOn('2026-08-28', snap({ absences }), byId);
  const b = ta.selfAbsenceOn('2026-08-28', snap({ absences }), byName);
  assert.equal(a.off, true);
  assert.equal(b.off, true);
});

test('name matching is case-insensitive but not fuzzy', () => {
  assert.equal(ta.isSelf({ rosterId: 24, name: 'nick ward' }, byName), true);
  assert.equal(ta.isSelf({ rosterId: 9, name: 'Nick Wardle' }, byName), false,
    'a longer name that merely starts the same is a different person');
});

// ── The rest of the team ────────────────────────────────────────────────────

test('othersOff lists the team and excludes Nick', () => {
  const out = ta.othersOff('2026-08-28', snap({
    absences: [
      { rosterId: 9, date: '2026-08-28', status: 'annual_leave', reason: 'Annual Leave', name: 'Hope Goodall' },
      { rosterId: 24, date: '2026-08-28', status: 'annual_leave', reason: 'Annual Leave', name: 'Nick Ward' },
    ],
  }), byId);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Hope Goodall');
});

test('othersOff on an unknown snapshot is empty, not invented', () => {
  assert.deepEqual(ta.othersOff('2026-08-28', { known: false }), []);
});

// ── daysOffFor: what the 1-2-1 booker asks ──────────────────────────────────
//
// `known` is the load-bearing half and is NOT the same as an empty set. "He is
// free all fortnight" and "I have no idea" license opposite behaviour, and
// collapsing them fails in the expensive direction — a real invite emailed to
// someone on a beach.

test('a person with booked leave returns those dates', () => {
  const r = ta.daysOffFor('Hope Goodall', snap({
    absences: [
      { rosterId: 9, date: '2026-08-28', status: 'annual_leave' },
      { rosterId: 9, date: '2026-08-31', status: 'annual_leave' },
      { rosterId: 24, date: '2026-08-28', status: 'sick' },
    ],
  }));
  assert.equal(r.known, true);
  assert.deepEqual([...r.dates].sort(), ['2026-08-28', '2026-08-31']);
});

test('a person with no leave is KNOWN free, not unknown', () => {
  const r = ta.daysOffFor('Hope Goodall', snap());
  assert.equal(r.known, true, 'we looked and she has nothing booked');
  assert.equal(r.dates.size, 0);
});

test('an unknown name is NOT reported as free', () => {
  const r = ta.daysOffFor('Someone Else', snap());
  assert.equal(r.known, false);
  assert.equal(r.dates.size, 0, 'and the empty set must never be read as an all-clear');
  assert.match(r.reason, /not in the NOVA roster/);
});

test('a person who cannot sync is unknown, however empty their absences look', () => {
  const r = ta.daysOffFor('Hope Goodall', snap({ roster: [ME, { ...HOPE, syncable: false }] }));
  assert.equal(r.known, false);
  assert.match(r.reason, /People HR id/);
});

test('no snapshot at all is unknown', () => {
  assert.equal(ta.daysOffFor('Hope Goodall', { known: false }).known, false);
});

test('matching is on FULL name and is case-insensitive', () => {
  assert.equal(ta.daysOffFor('hope goodall', snap()).known, true);
  assert.equal(ta.daysOffFor('Hope', snap()).known, false, 'a first name is not an identifier');
});
