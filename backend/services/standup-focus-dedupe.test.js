'use strict';

/**
 * One job must appear ONCE in Focus Today.
 *
 * The fixtures are Nick's real standup of 27 Aug 2026, which rendered six focus
 * lines for three jobs — "Review Vantage prototype and sign off" byte-identically
 * twice, and "Verify and compile her response" beside "Verify and compile
 * Phillipa's email response".
 *
 * This matters beyond tidiness because today's `## Focus Today` is what
 * standup-accountability parses tomorrow as the carry source. Every duplicate is
 * re-read the next morning as another distinct open commitment, so the list
 * breeds — which is how SARA came to open a standup insisting on "four
 * escalations" Nick had never committed to and could not find in his calendar.
 */

const test = require('node:test');
const assert = require('node:assert');

const { _renderDailyNote } = require('./standup-session');

const session = ({ focus = [], commitments = [], openCommitments = [] }) => ({
  dateKey: '2026-08-27',
  outcome: { focus, commitments, blockers: null, mood: null },
  context: { accountability: { openCommitments }, queue: null },
});

const focusLines = (note) => note
  .split('## Focus Today')[1]
  .split('##')[0]
  .split('\n')
  .filter(l => l.trim().startsWith('- '));

const carryLines = (note) => note
  .split('## Carry-Overs')[1]
  .split('##')[0]
  .split('\n')
  .filter(l => l.trim().startsWith('- ') && !/- None/.test(l));

test('an identical carried commitment is not written twice', () => {
  const note = _renderDailyNote(session({
    focus: ['Review Vantage prototype and sign off'],
    commitments: [{ key: 'k1', decision: 'today' }],
    openCommitments: [{ key: 'k1', text: 'Review Vantage prototype and sign off', daysCarried: 1 }],
  }));
  const lines = focusLines(note);
  assert.equal(lines.length, 1, `one job, one line — got:\n${lines.join('\n')}`);
});

test('the surviving line keeps the #carried tag, because the age is the useful half', () => {
  const note = _renderDailyNote(session({
    focus: ['Review Vantage prototype and sign off'],
    commitments: [{ key: 'k1', decision: 'today' }],
    openCommitments: [{ key: 'k1', text: 'Review Vantage prototype and sign off', daysCarried: 3 }],
  }));
  assert.match(focusLines(note)[0], /#carried-3d/,
    'day-3 decisions key off this number — losing it loses the chase');
});

test('a reworded restatement of the same job also folds', () => {
  // Scored 1.0 by containment against the live pool. This is the pair a plain
  // string compare would miss.
  const note = _renderDailyNote(session({
    focus: ['Verify and compile her response'],
    commitments: [{ key: 'k2', decision: 'today' }],
    openCommitments: [{ key: 'k2', text: 'Verify and compile Phillipa’s email response', daysCarried: 1 }],
  }));
  assert.equal(focusLines(note).length, 1);
});

test('two genuinely different jobs both survive', () => {
  // "Handle Phillipa's email" vs "Collate Phillipa's data and reply within the
  // hour" scored 0.076 — related, not the same, and merging them would delete
  // a commitment from the note Nick works from.
  const note = _renderDailyNote(session({
    focus: ['Collate Phillipa’s data and reply within the hour'],
    commitments: [{ key: 'k3', decision: 'today' }],
    openCommitments: [{ key: 'k3', text: 'Handle Phillipa’s email', daysCarried: 2 }],
  }));
  assert.equal(focusLines(note).length, 2, 'different jobs must not be merged away');
});

test('a commitment taken as today does NOT also sit in Carry-Overs', () => {
  const note = _renderDailyNote(session({
    focus: ['Review Vantage prototype and sign off'],
    commitments: [{ key: 'k1', decision: 'today' }],
    openCommitments: [{ key: 'k1', text: 'Review Vantage prototype and sign off', daysCarried: 1 }],
  }));
  assert.equal(carryLines(note).length, 0, 'one job in two sections reads as two jobs tomorrow');
});

test('an undecided carry that today\'s focus already covers is not listed twice', () => {
  // No resolve_commitment call at all — the model simply agreed the same job as
  // focus. Without this, the note holds it under both headings.
  const note = _renderDailyNote(session({
    focus: ['Review Vantage prototype and sign off'],
    commitments: [],
    openCommitments: [{ key: 'k1', text: 'Review Vantage prototype and sign off', daysCarried: 1 }],
  }));
  assert.equal(focusLines(note).length, 1);
  assert.equal(carryLines(note).length, 0);
});

test('an undecided carry NOT covered by today still carries', () => {
  const note = _renderDailyNote(session({
    focus: ['Something else entirely'],
    commitments: [],
    openCommitments: [{ key: 'k1', text: 'Chase the Guild RCA with Ricky', daysCarried: 4 }],
  }));
  assert.equal(carryLines(note).length, 1, 'dropping an unaddressed carry would lose real work');
  assert.match(carryLines(note)[0], /#carried-4d/);
});

test('Nick\'s real 27 Aug standup renders three jobs, not six', () => {
  const note = _renderDailyNote(session({
    focus: [
      'Collate Phillipa’s data and reply within the hour',
      'Verify and compile her response',
      'Review Vantage prototype and sign off',
    ],
    commitments: [
      { key: 'a', decision: 'today' },
      { key: 'b', decision: 'today' },
      { key: 'c', decision: 'today' },
    ],
    openCommitments: [
      { key: 'a', text: 'Handle Phillipa’s email', daysCarried: 2 },
      { key: 'b', text: 'Verify and compile Phillipa’s email response', daysCarried: 1 },
      { key: 'c', text: 'Review Vantage prototype and sign off', daysCarried: 1 },
    ],
  }));
  const lines = focusLines(note);
  // "Handle Phillipa's email" is legitimately distinct (0.076), so four lines
  // is the honest answer here — the point is that it is not six.
  assert.ok(lines.length <= 4, `expected at most 4 lines, got ${lines.length}:\n${lines.join('\n')}`);
  const vantage = lines.filter(l => /Review Vantage prototype/.test(l));
  assert.equal(vantage.length, 1, 'the byte-identical duplicate must be gone');
});

test('the section headings are unchanged — accountability parses them tomorrow', () => {
  const note = _renderDailyNote(session({ focus: ['x'] }));
  assert.match(note, /^## Focus Today$/m);
  assert.match(note, /^## Carry-Overs$/m);
});
