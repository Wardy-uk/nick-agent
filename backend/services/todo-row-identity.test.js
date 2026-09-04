'use strict';

/**
 * Two bugs that made a task row's controls look broken, and neither threw.
 *
 * ── 1. A row's identity was its POSITION ─────────────────────────────────────
 *
 * `/api/todos` assigns `id: i + 1` over the parsed list, and `listTaskRows`
 * orders by due date with the undated last. So setting a due date moved that
 * row up the ordering, shifted every index below it, and any key built from
 * `id` then named a DIFFERENT task. The expanded row collapsed, or a neighbour
 * opened instead — indistinguishable from the control not working, which is
 * exactly how it was reported: "I can't edit the due date for some tasks".
 *
 * It applied to every control on the row. The date one is simply the one that
 * moves the row it lives on, so it is where the breakage always showed.
 *
 * ── 2. The date picker wrote on every keystroke ──────────────────────────────
 *
 * `<input type="date">` reports an empty value while it is partially typed, so
 * patching straight from onChange fired `due_date: null` before the month had
 * been entered — a write and a full refetch per keystroke, each one re-sorting
 * the list underneath the person typing.
 *
 * ⚠ A SOURCE SCAN, so it pins the shape rather than the runtime behaviour: what
 * it catches is somebody reintroducing the positional key or the direct patch.
 * The positive control is what stops a broken scan passing by finding nothing.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PANEL = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'TodoPanel.jsx');
const SOURCE = fs.readFileSync(PANEL, 'utf8');

test('positive control: the scan is reading the real panel', () => {
  assert.ok(SOURCE.length > 10000, 'TodoPanel.jsx is suspiciously small — wrong file?');
  assert.ok(SOURCE.includes('function TodoItem('), 'TodoItem not found — the scan is looking at the wrong text');
  assert.ok(SOURCE.includes('type="date"'), 'no date input found — the scan cannot prove anything about it');
});

test('a row is keyed on its identity, never on its position in the list', () => {
  assert.ok(SOURCE.includes('function rowKey('), 'rowKey helper missing');
  assert.ok(
    !SOURCE.includes('`${todo.source}-${todo.id}`'),
    'a positional row key is back: setting a due date re-sorts the list and the key then names a different task',
  );
});

test('rowKey prefers the task id, and falls back rather than inventing one', () => {
  const start = SOURCE.indexOf('function rowKey(');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  assert.match(body, /todo\.task_id/, 'the NEURO task id is the only stable identity a row has');
  assert.match(body, /todo\.filePath/, 'a file-backed mirror has no task id and must fall back to where the line lives');
});

test('the date picker does not write a patch straight from its onChange', () => {
  // The specific shape that caused it.
  assert.ok(
    !/onPatch\(\{\s*due_date:\s*e\.target\.value/.test(SOURCE),
    'the date input is patching on every transitional value again — a null write per keystroke',
  );
});

test('nothing on the card writes until Save — the ONE call site', () => {
  // ⚠ This replaces the old `\d{4}-\d{2}-\d{2}` completeness check, which is
  // obsolete rather than merely passing: the half-typed-date write it guarded
  // against is now impossible BY CONSTRUCTION, because no control writes on
  // change at all. Every button edits a local draft and one Save sends one
  // PATCH, which is also what stopped the list re-sorting the card out from
  // under the cursor mid-triage.
  //
  // ⚠ Pinned STRUCTURALLY rather than as a count. It was a count of two — the
  // save() call plus the prop wired in TodoItem — and that broke the moment the
  // Must Move lane started rendering the same card, which is a third perfectly
  // correct prop wiring. A count fails on the safe change and would then be
  // bumped to 3 by whoever hit it, which is how a guard quietly becomes a
  // rubber stamp. What actually matters is the SHAPE of every call site: one
  // write that sends the whole accumulated draft, and forwarding arrows that
  // carry a caller's fields without inventing any.
  const sites = [...SOURCE.matchAll(/onPatch\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(sites.length >= 2, 'onPatch should still be both written and wired');
  for (const args of sites) {
    assert.ok(
      args === 'changed' || /^[A-Za-z_$][\w$]*, fields$/.test(args),
      `onPatch(${args}) writes something other than the accumulated draft — a control `
      + 'is patching on click again, which re-sorts the card out from under the cursor',
    );
  }
  assert.ok(sites.includes('changed'), 'the single write should send the whole accumulated draft');
  assert.ok(SOURCE.includes('await onPatch(changed)'), 'the single write should send the whole accumulated draft');
});

test('clearing a date stays an EXPLICIT act, not an inference from an empty box', () => {
  // An empty picker mid-typing is not a request to wipe the date, so the Clear
  // button has to remain the way to say so.
  assert.match(SOURCE, /due_date:\s*null\s*\}\)/, 'the explicit clear is gone');
  assert.ok(SOURCE.includes('Clear'), 'the Clear button is what makes ignoring the empty value honest');
});
