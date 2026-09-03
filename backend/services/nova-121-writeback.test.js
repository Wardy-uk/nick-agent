'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { spliceActions, renderAction, existingIds, START, END } = require('./nova-121-writeback');

const CARD = [
  '---',
  'type: person',
  'role: Senior Service Desk Agent',
  'last-1-2-1: 2026-04-22',
  '---',
  '',
  '## 1-2-1 History',
  '',
  '| Date | Type | Notes |',
  '|------|------|-------|',
  '',
  '## Notes',
  '',
  '- Off sick from 2026-03-24',
  '',
].join('\n');

const action = (over = {}) => ({ id: 101, description: 'Give Nathan access to AI approvals', owner: null, dueDate: '2026-09-10', ...over });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('an action renders in the syntax action-items already parses', () => {
  const line = renderAction(action(), 'Nathan Rutland');
  assert.match(line, /^- \[ \] Give Nathan access to AI approvals/);
  assert.match(line, /👤 \[\[People\/Nathan Rutland\|Nathan Rutland\]\]/);
  assert.match(line, /📅 2026-09-10/);
  assert.match(line, /<!-- nova:101 -->/);

  // The whole point of the markers is that the existing scanner reads them.
  const { _internals } = require('./action-items');
  if (_internals?.parseActionLine) {
    const parsed = _internals.parseActionLine(line, 'People/Nathan Rutland.md', 1);
    assert.equal(parsed.assignee, 'Nathan Rutland');
    assert.equal(parsed.dueDate, '2026-09-10');
  }
});

test('an unowned action is attributed to whoever the card belongs to', () => {
  // An action with no owner on someone's 1-2-1 card is theirs. Leaving the marker off
  // would hide it from every person-filtered query.
  assert.match(renderAction(action({ owner: null }), 'Zoe Rees'), /👤 \[\[People\/Zoe Rees\|Zoe Rees\]\]/);
  assert.match(renderAction(action({ owner: 'Nick Ward' }), 'Zoe Rees'), /👤 \[\[People\/Nick Ward\|Nick Ward\]\]/);
});

test('a multi-line description cannot break the task line', () => {
  const line = renderAction(action({ description: 'Do a thing\nthen another' }), 'Zoe Rees');
  assert.equal(line.split('\n').length, 1);
});

test('no due date simply omits the marker', () => {
  assert.doesNotMatch(renderAction(action({ dueDate: null }), 'Zoe Rees'), /📅/);
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

test('ids are recovered even after the text has been edited', () => {
  const text = '- [x] Something Nick reworded entirely <!-- nova:42 -->\n- [ ] Another <!--nova:43-->';
  assert.deepEqual([...existingIds(text)].sort((a, b) => a - b), [42, 43]);
});

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

test('a first run inserts the block after the frontmatter, not at the end', () => {
  const next = spliceActions(CARD, ['- [ ] First action <!-- nova:1 -->']);
  assert.ok(next);
  assert.match(next, /## 1-2-1 Actions/);
  // Before the existing content, so it is the first thing on the card.
  assert.ok(next.indexOf('## 1-2-1 Actions') < next.indexOf('## 1-2-1 History'));
  // Frontmatter survives intact.
  assert.ok(next.startsWith('---\ntype: person'));
  assert.match(next, /last-1-2-1: 2026-04-22/);
});

test('a second run APPENDS inside the block rather than replacing it', () => {
  // A carried-over action from three 1-2-1s ago is still owed. Regenerating the block
  // from only the newest session would quietly drop it.
  const first = spliceActions(CARD, ['- [ ] First <!-- nova:1 -->']);
  const second = spliceActions(first, ['- [ ] Second <!-- nova:2 -->']);
  assert.ok(second);
  assert.match(second, /First <!-- nova:1 -->/);
  assert.match(second, /Second <!-- nova:2 -->/);
  // One block, not two.
  assert.equal(second.split(START).length - 1, 1);
  assert.equal(second.split(END).length - 1, 1);
});

test("a tick Nick has already made is never rewritten", () => {
  const first = spliceActions(CARD, ['- [ ] First <!-- nova:1 -->']);
  const ticked = first.replace('- [ ] First', '- [x] First');
  const next = spliceActions(ticked, ['- [ ] Second <!-- nova:2 -->']);
  assert.match(next, /- \[x\] First <!-- nova:1 -->/);
});

test('nothing to write means no write at all', () => {
  // An unchanged run must not churn the mtime — that drags the note into every
  // "recently modified" scan.
  assert.equal(spliceActions(CARD, []), null);
});

test('editorial outside the block is untouched', () => {
  const first = spliceActions(CARD, ['- [ ] First <!-- nova:1 -->']);
  const edited = first.replace('- Off sick from 2026-03-24', '- Back at work, doing well');
  const next = spliceActions(edited, ['- [ ] Second <!-- nova:2 -->']);
  assert.match(next, /- Back at work, doing well/);
  assert.match(next, /## 1-2-1 History/);
  assert.match(next, /## Notes/);
});

test('CRLF cards splice correctly', () => {
  // The vault is authored on Windows. one-to-one-detect and meeting-notes-source both
  // learned that an unnormalised \r makes anchored frontmatter regexes fail silently.
  const next = spliceActions(CARD.replace(/\n/g, '\r\n'), ['- [ ] First <!-- nova:1 -->']);
  assert.ok(next);
  assert.match(next, /## 1-2-1 Actions/);
  assert.ok(next.startsWith('---\ntype: person'));
});

test('a card with no frontmatter still gets its actions', () => {
  const next = spliceActions('# Someone\n\nNotes here.\n', ['- [ ] First <!-- nova:1 -->']);
  assert.ok(next);
  assert.match(next, /## 1-2-1 Actions/);
  assert.match(next, /Notes here\./);
});

// ---------------------------------------------------------------------------
// Dates — the five-night outage (item 1)
//
// NOVA answers with two date-ish fields and only one of them is a date.
// `scheduledDate` is `2026-08-18`; `completedAt` is `Tue Aug 18` — a display
// string with no year. The watermark took `max(completedAt)` by STRING
// comparison, so "Tue Aug 18" beat "2026-05-27" ("T" > "2") and the display
// string became the next `since`. NOVA's `/121/completed` 400s on it, before a
// single session is read, so nothing in the run could ever move it on again.
// ---------------------------------------------------------------------------

const { toIsoDate, sessionDate } = require('./nova-121-writeback');

test('an ISO date passes through, with or without a time', () => {
  assert.equal(toIsoDate('2026-08-18'), '2026-08-18');
  assert.equal(toIsoDate('2026-08-18T09:14:00Z'), '2026-08-18');
  assert.equal(toIsoDate('2026-08-18 09:14:00'), '2026-08-18');
});

test("NOVA's display string is refused, not parsed", () => {
  // The exact values that wedged it live, and the exact shape they arrive in.
  assert.equal(toIsoDate('Tue Aug 18'), null);
  assert.equal(toIsoDate('Wed May 27'), null);
  assert.equal(toIsoDate('Mon Aug 24'), null);
  // The year is genuinely absent. Guessing one puts a watermark in the wrong
  // year and silently skips sessions, or writes a wrong date onto a real card.
});

test('nothing, junk and an impossible date are all null', () => {
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate('   '), null);
  assert.equal(toIsoDate('yesterday'), null);
  assert.equal(toIsoDate('18/08/2026'), null);
  // Rolled into March by Date(), which is exactly the silent wrong answer.
  assert.equal(toIsoDate('2026-02-31'), null);
});

test('a session dates from scheduledDate when completedAt is a display string', () => {
  // The live shape, taken from the bridge on 2026-09-03.
  assert.equal(sessionDate({ completedAt: 'Tue Aug 18', scheduledDate: '2026-08-18' }), '2026-08-18');
});

test('a real completedAt wins over the scheduled date', () => {
  // A 1-2-1 held late is held on the day it was held, not the day it was booked.
  assert.equal(sessionDate({ completedAt: '2026-08-20', scheduledDate: '2026-08-18' }), '2026-08-20');
});

test('a session NOVA cannot date is null, never a guess', () => {
  assert.equal(sessionDate({ completedAt: 'Tue Aug 18', scheduledDate: null }), null);
  assert.equal(sessionDate({}), null);
});

test('the watermark fold only ever moves forward, and only on real dates', () => {
  // The fold as `writeBack` performs it. The bug was that this reduce compared
  // display strings, so the first session in the list wrote one into the key.
  const fold = (sessions, from) => sessions.reduce((max, s) => {
    const iso = sessionDate(s);
    return iso && iso > max ? iso : max;
  }, from);

  const live = [
    { completedAt: 'Tue Aug 18', scheduledDate: '2026-08-18' },
    { completedAt: 'Tue Aug 18', scheduledDate: '2026-08-18' },
    { completedAt: 'Wed Aug 19', scheduledDate: '2026-08-19' },
    { completedAt: 'Thu Aug 20', scheduledDate: '2026-08-20' },
    { completedAt: 'Mon Aug 24', scheduledDate: '2026-08-24' },
  ];
  assert.equal(fold(live, '2026-07-01'), '2026-08-24');
  assert.match(fold(live, '2026-07-01'), /^\d{4}-\d{2}-\d{2}$/);

  // An undateable session leaves it where it was rather than poisoning it.
  assert.equal(fold([{ completedAt: 'Tue Aug 18', scheduledDate: null }], '2026-07-01'), '2026-07-01');
  // And it never goes backwards.
  assert.equal(fold([{ scheduledDate: '2026-01-05' }], '2026-07-01'), '2026-07-01');
});
