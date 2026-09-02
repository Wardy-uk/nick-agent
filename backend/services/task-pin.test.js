'use strict';

/**
 * Which row does "open it" open?
 *
 * `frontend/src/taskPin.js` is the shared answer to that, and it is pure so it
 * can be pinned here — `node --test` only runs from backend/, and the desktop
 * has no runner of its own.
 *
 * ⚠ The direction that matters is the WRONG match, not the missed one. A miss
 * renders as a stated sentence ("couldn't find that one in your open tasks");
 * a wrong match expands somebody else's work under a heading claiming it is the
 * thing the card was about, with live edit controls on it that write to Planner
 * and the vault. So the negatives below are the load-bearing half.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'frontend', 'src', 'taskPin.js')
).href;

let pinFromContext;
let findPinned;

test.before(async () => {
  const mod = await import(MODULE_URL);
  pinFromContext = mod.pinFromContext;
  findPinned = mod.findPinned;
});

const TODOS = [
  { task_id: 7, ms_id: null, source: 'NEURO', text: 'Build succession plan for HoTS cover', filePath: null, lineNumber: null },
  { task_id: null, ms_id: 'AAMk-99', source: 'MS Planner', text: 'Succession plan', filePath: null, lineNumber: null },
  { task_id: null, ms_id: null, source: 'Daily', text: 'Chase Naomi re risk assessment', filePath: 'Daily/2026-09-01.md', lineNumber: 12 },
];

// ── What counts as a handle ──────────────────────────────────────────────────

test('a context with nothing to go on is not a pin', () => {
  assert.equal(pinFromContext(null), null);
  assert.equal(pinFromContext({}), null);
  // ⚠ `filter` is the OLD drill-down context and must not read as a pin, or
  // arriving from Focus would silently collapse the list to one row.
  assert.equal(pinFromContext({ filter: 'overdue', fromFocus: true }), null);
});

test('both spellings of each handle are accepted', () => {
  assert.equal(pinFromContext({ taskId: 7 }).taskId, 7);
  assert.equal(pinFromContext({ task_id: 7 }).taskId, 7);
  assert.equal(pinFromContext({ msId: 'x' }).msId, 'x');
  assert.equal(pinFromContext({ ms_id: 'x' }).msId, 'x');
});

test('task id 0 is a handle, not an absence', () => {
  // The `Number(null) === 0` family. A falsy-but-real id must survive.
  const pin = pinFromContext({ taskId: 0 });
  assert.notEqual(pin, null);
  assert.equal(pin.taskId, 0);
});

// ── Finding the row ──────────────────────────────────────────────────────────

test('a NEURO task id wins, and matches across string/number', () => {
  assert.equal(findPinned(TODOS, pinFromContext({ taskId: 7 })).task_id, 7);
  assert.equal(findPinned(TODOS, pinFromContext({ taskId: '7' })).task_id, 7);
});

test('a Microsoft id finds the mirrored row', () => {
  assert.equal(findPinned(TODOS, pinFromContext({ msId: 'AAMk-99' })).ms_id, 'AAMk-99');
});

test('a vault line needs BOTH the path and the line', () => {
  const hit = findPinned(TODOS, pinFromContext({ filePath: 'Daily/2026-09-01.md', lineNumber: 12 }));
  assert.equal(hit.lineNumber, 12);
  // A path on its own is not an identity — a daily note holds many tasks.
  assert.equal(findPinned(TODOS, pinFromContext({ filePath: 'Daily/2026-09-01.md' })), null);
});

test('the id is preferred over the text, even when the text matches another row', () => {
  // ⚠ The trap: "Succession plan" is a real row AND a substring of another.
  // Handed both, the handle must decide — text is the fallback, never a peer.
  const hit = findPinned(TODOS, pinFromContext({ taskId: 7, taskText: 'Succession plan' }));
  assert.equal(hit.task_id, 7);
});

// ── The negatives, which are the point ───────────────────────────────────────

test('a near miss is a miss, never the closest row', () => {
  // Same subject, different commitment. `task-dedupe` exists precisely because
  // these two are not the same task, and it needed a measured threshold to say
  // so — a display-time matcher must not guess where that service would not.
  assert.equal(
    findPinned(TODOS, pinFromContext({ taskText: 'Succession planning for the team leads' })),
    null
  );
});

test('an unknown id resolves to nothing rather than to the first row', () => {
  assert.equal(findPinned(TODOS, pinFromContext({ taskId: 4242 })), null);
  assert.equal(findPinned(TODOS, pinFromContext({ msId: 'gone' })), null);
});

test('an unreadable list is a miss, not a crash', () => {
  assert.equal(findPinned(null, pinFromContext({ taskId: 7 })), null);
  assert.equal(findPinned(TODOS, null), null);
});

test('text matching ignores punctuation and case but not different words', () => {
  assert.equal(
    findPinned(TODOS, pinFromContext({ taskText: 'chase naomi re: risk assessment!' })).lineNumber,
    12
  );
  assert.equal(findPinned(TODOS, pinFromContext({ taskText: 'chase naomi re invoice' })), null);
});
