'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { foldDetected, cadenceDays, isoDateOrNull, cadenceState, CADENCES } = require('./one-to-one-detect');

// ⚠ Every fixture here is a LIVE People note from 1 Sep 2026, not an invented shape.
// The whole defect was that the board looked plausible while being wrong, so a fixture
// that does not match what is actually on disk would prove nothing.

// ── isoDateOrNull ────────────────────────────────────────────────────────────

test('a date with no year is not a date', () => {
  // Seven live People notes store `last-1-2-1` this way.
  for (const v of ['Thu Jun 18', 'Wed May 27', 'Tue Aug 18', 'Thu Apr 30']) {
    assert.equal(isoDateOrNull(v), null, v);
  }
});

test('only a full ISO date survives', () => {
  assert.equal(isoDateOrNull('2026-08-20'), '2026-08-20');
  assert.equal(isoDateOrNull('  2026-08-20  '), '2026-08-20');
  for (const v of ['2026-8-2', '20/08/2026', '', null, undefined, 'n/a', 0]) {
    assert.equal(isoDateOrNull(v), null, JSON.stringify(v));
  }
});

// ── The string-comparison bug ────────────────────────────────────────────────

test('a non-ISO stamp does not discard the detected 1-2-1', () => {
  // THE BUG: `"2026-08-20" <= "Thu Jun 18"` is TRUE, because "2" sorts before "T" in
  // ASCII. So the fold silently took the stale branch and Abdi Mohamed — seen twelve
  // days earlier — rendered as "Overdue by 103d" against a due date from May.
  const fm = { 'last-1-2-1': 'Thu Jun 18', 'next-1-2-1-due': '2026-05-21', cadence: 'monthly' };
  const f = foldDetected(fm, '2026-08-20');
  assert.equal(f.lastHeld, '2026-08-20');
  assert.equal(f.nextDue, '2026-09-17');
  assert.notEqual(f.nextDue, '2026-05-21');
});

test('the live Abdi card is not overdue', () => {
  const fm = { 'last-1-2-1': 'Thu Jun 18', 'next-1-2-1-due': '2026-05-21', cadence: 'monthly' };
  assert.notEqual(cadenceState(foldDetected(fm, '2026-08-20'), '2026-09-01').state, 'overdue');
});

test('a string comparison would still pass a naive ISO-only test', () => {
  // A positive control for the test above: with two ISO dates the old code was fine,
  // which is exactly why this survived — every fixture in the suite used ISO dates.
  assert.equal('2026-08-20' > '2026-06-18', true);
  assert.equal('2026-08-20' > 'Thu Jun 18', false);
});

// ── The equal-date bug ───────────────────────────────────────────────────────

test('a stored due date EARLIER than the 1-2-1 it follows is never trusted', () => {
  // Isabel Busk, live: stamp and detection agree on 25 Aug, but the stored due reads
  // 12 Aug — before the meeting. A strict comparison stopped folding and handed that
  // back, so her card said "Overdue by 20d" the week after Nick saw her.
  const fm = { 'last-1-2-1': '2026-08-25', 'next-1-2-1-due': '2026-08-12', cadence: 'monthly' };
  const f = foldDetected(fm, '2026-08-25');
  assert.equal(f.nextDue, '2026-09-22');
  assert.notEqual(cadenceState(f, '2026-09-01').state, 'overdue');
});

test('a stamp genuinely NEWER than the detector still wins', () => {
  // A 1-2-1 entered by hand for a meeting not yet written up must not be pulled
  // backwards to whatever the detector last found.
  const fm = { 'last-1-2-1': '2026-08-30', 'next-1-2-1-due': '2026-09-27', cadence: 'monthly' };
  const f = foldDetected(fm, '2026-08-20');
  assert.equal(f.lastHeld, '2026-08-30');
  assert.equal(f.nextDue, '2026-09-27');
});

test('an unparseable stored due is null, never passed through', () => {
  const f = foldDetected({ 'last-1-2-1': '2026-08-30', 'next-1-2-1-due': 'Thu Sep 27' }, null);
  assert.equal(f.nextDue, null);
});

// ── six-weekly ───────────────────────────────────────────────────────────────

test('six-weekly is 42 days, however it is written', () => {
  for (const v of ['six-weekly', 'six weekly', '6-weekly', '6 weekly', 'Six Weekly', 'six-week']) {
    assert.equal(cadenceDays(v), 42, v);
  }
});

test('six-weekly is NOT read as weekly', () => {
  // ⚠ The matcher is a regex ladder ending in /week/i, so a six-weekly entry placed
  // below that rule resolves to 7 days — silently, and six times too often.
  assert.notEqual(cadenceDays('six weekly'), cadenceDays('weekly'));
  assert.notEqual(cadenceDays('six weekly'), 7);
});

test('adding six-weekly did not disturb the other cadences', () => {
  assert.equal(cadenceDays('weekly'), 7);
  assert.equal(cadenceDays('bi-weekly'), 14);
  assert.equal(cadenceDays('fortnightly'), 14);
  assert.equal(cadenceDays('monthly'), 28);
  assert.equal(cadenceDays('bi-monthly'), 56);
});

// ── Client/server parity ─────────────────────────────────────────────────────

test('the board mirrors the server cadence table exactly', () => {
  // PeopleBoard.jsx re-declares this map by hand (it cannot require a backend service),
  // so the two are free to drift. They decide the same fact — when a 1-2-1 is next owed
  // — and one number is not allowed to mean two things.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'PeopleBoard.jsx'),
    'utf8'
  );
  const map = src.match(/function cadenceDays\(raw\) \{\s*return \{([^}]*)\}/);
  assert.ok(map, 'cadenceDays not found in PeopleBoard.jsx — did it move?');

  const clientDays = {};
  for (const m of map[1].matchAll(/'?([a-z-]+)'?\s*:\s*(\d+)/g)) clientDays[m[1]] = Number(m[2]);

  assert.ok(Object.keys(clientDays).length >= 5, 'positive control: parsed the client map');
  for (const [word, days] of Object.entries(clientDays)) {
    assert.equal(cadenceDays(word), days, `client says ${word}=${days}, server disagrees`);
  }
  assert.equal(clientDays['six-weekly'], 42);
});

test('the board offers exactly the cadences the server understands', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'PeopleBoard.jsx'),
    'utf8'
  );
  const block = src.match(/const CADENCE_OPTIONS = \[([\s\S]*?)\];/);
  assert.ok(block, 'CADENCE_OPTIONS not found');
  const offered = [...block[1].matchAll(/value: '([^']+)'/g)].map((m) => m[1]).filter((v) => v !== 'n/a');
  assert.ok(offered.length >= 5, 'positive control: parsed the options');
  assert.ok(offered.includes('six-weekly'), 'six-weekly must be pickable, not just parseable');

  // Every value the picker can write must be a cadence the server actually names —
  // otherwise the board offers a choice that silently lands on the 14-day default.
  const known = new Set(CADENCES.map((c) => c.value));
  for (const v of offered) {
    assert.ok(known.has(v), `the board offers "${v}", which the server does not name`);
  }
});
