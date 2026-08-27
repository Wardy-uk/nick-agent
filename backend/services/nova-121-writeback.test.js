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
