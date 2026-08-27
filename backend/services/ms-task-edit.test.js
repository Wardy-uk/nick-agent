'use strict';

/**
 * Editing a task Microsoft owns.
 *
 * Two halves, and neither talks to Graph: the input rules that run BEFORE a
 * token is fetched (so a bad edit never leaves the building at all), and the
 * mirror-line repaint that stops the list showing the old wording afterwards.
 *
 * The rule underneath: Microsoft owns these tasks, so the mirror is a repaint
 * and never a store. It is only ever asked to reflect a write that has already
 * succeeded — which is why the tests care most about what it REFUSES.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const microsoft = require('./microsoft');
const { _plannerDue, _todoDue, _dueDateOf } = microsoft._internals;

// ── Dates ────────────────────────────────────────────────────────────────────

test('a due date is written at MIDDAY, never midnight', () => {
  // Planner stores an instant and renders it in the reader's zone. Midnight UTC
  // lands on the previous day for anyone west of here; midday cannot shift the
  // date in any plausible offset.
  assert.equal(_plannerDue('2026-08-27'), '2026-08-27T12:00:00Z');
  assert.equal(_todoDue('2026-08-27').dateTime, '2026-08-27T12:00:00.0000000');
  assert.ok(_todoDue('2026-08-27').timeZone, 'To Do takes a zone NAME, not an offset');
});

test('null clears the date, and stays distinct from "leave it alone"', () => {
  assert.equal(_plannerDue(null), null);
  assert.equal(_todoDue(null), null);
});

test('a due date is read back from either API shape', () => {
  assert.equal(_dueDateOf('2026-08-27T12:00:00Z'), '2026-08-27');          // Planner
  assert.equal(_dueDateOf({ dateTime: '2026-08-27T12:00:00.0000000' }), '2026-08-27'); // To Do
  assert.equal(_dueDateOf(null), null);
  assert.equal(_dueDateOf({}), null);
});

// ── What never reaches Graph ─────────────────────────────────────────────────
// These all return before a token is fetched, so they are testable offline —
// and that is the point: a bad edit is refused here rather than at the API.

test('the field whitelist is the safety model, not a guard', async () => {
  // Buckets, assignments and checklists are board structure other people
  // maintain. They are not reachable through this function at all.
  const r = await microsoft.updateMicrosoftTaskFields('task-1', {
    bucketId: 'b1', assignments: {}, percentComplete: 100,
  }, 'MS Planner');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nothing_to_change');
});

test('an empty title is refused — a nameless card on a shared board', async () => {
  const r = await microsoft.updateMicrosoftTaskFields('task-1', { title: '   ' }, 'MS Planner');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_title');
});

test('empty NOTES are a legitimate erase, unlike an empty title', async () => {
  // Reaches the token fetch and fails there (no Microsoft session in a test),
  // which is exactly the point: it was not rejected as input.
  const r = await microsoft.updateMicrosoftTaskFields('task-1', { notes: '' }, 'MS Planner');
  assert.notEqual(r.reason, 'empty_title');
  assert.notEqual(r.reason, 'nothing_to_change');
});

test('a malformed due date never leaves the building', async () => {
  for (const bad of ['27/08/2026', 'tomorrow', '2026-8-27']) {
    const r = await microsoft.updateMicrosoftTaskFields('task-1', { dueDate: bad }, 'MS Planner');
    assert.equal(r.reason, 'bad_due_date', `${bad} should be refused`);
  }
});

test('no task id is refused before anything else', async () => {
  const r = await microsoft.updateMicrosoftTaskFields('', { title: 'x' }, 'MS Planner');
  assert.equal(r.reason, 'no_task_id');
});

// ── The mirror repaint ───────────────────────────────────────────────────────

const obsidian = require('./obsidian');

function withMirror(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-msedit-'));
  const file = path.join(dir, 'Microsoft Tasks.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  try {
    return fn(file, () => fs.readFileSync(file, 'utf-8').split('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LINES = [
  '# Microsoft Tasks',
  '',
  '## Planner',
  '',
  '### Support Squad',
  '',
  '- [ ] Re-instate regular 121s (75%) 📅 2026-09-01 <!--id:p1-->',
  '- [ ] Plain task <!--id:p2-->',
  '- [ ] Urgent thing ⚡ <!--id:p3-->',
];

test('repaint: the title changes and everything else on the line survives', () => {
  withMirror(LINES, (file, read) => {
    obsidian.setTaskFields(file, 6, { title: 'Reinstate weekly 1-2-1s' }, 'p1');
    const line = read()[6];
    assert.match(line, /^- \[ \] Reinstate weekly 1-2-1s \(75%\) 📅 2026-09-01 <!--id:p1-->$/,
      'progress, due date and id all have to survive or the line stops parsing');
  });
});

test('repaint: a due date can be set and cleared', () => {
  withMirror(LINES, (file, read) => {
    obsidian.setTaskFields(file, 7, { dueDate: '2026-08-31' }, 'p2');
    assert.match(read()[7], /^- \[ \] Plain task 📅 2026-08-31 <!--id:p2-->$/);

    obsidian.setTaskFields(file, 7, { dueDate: null }, 'p2');
    assert.match(read()[7], /^- \[ \] Plain task <!--id:p2-->$/);
  });
});

test('repaint: the ⚡ importance flag is not lost to an edit', () => {
  withMirror(LINES, (file, read) => {
    obsidian.setTaskFields(file, 8, { title: 'Still urgent' }, 'p3');
    assert.match(read()[8], /^- \[ \] Still urgent ⚡ <!--id:p3-->$/);
  });
});

test('repaint: REFUSES the wrong line, because a rename looks like Nick wrote it', () => {
  withMirror(LINES, (file, read) => {
    // A line number is a position; the task is an identity. This file is
    // regenerated wholesale, so a stale client can hand back a number that now
    // points at somebody else's task.
    assert.throws(
      () => obsidian.setTaskFields(file, 7, { title: 'Wrong task' }, 'p1'),
      /refusing to edit the wrong task/i
    );
    assert.match(read()[7], /Plain task/, 'the line is untouched');
  });
});

test('repaint: a title carrying markup cannot break the line format', () => {
  withMirror(LINES, (file, read) => {
    // Pasting a title with an id comment or a date in it would otherwise
    // produce a line that parses back as a different task.
    obsidian.setTaskFields(file, 7, { title: 'Sneaky <!--id:evil--> 📅 2020-01-01 title' }, 'p2');
    const line = read()[7];
    assert.equal((line.match(/<!--id:/g) || []).length, 1, 'exactly one id survives');
    assert.match(line, /<!--id:p2-->$/);
    assert.ok(!line.includes('2020-01-01'), 'a pasted date is not mistaken for the due date');
  });
});

test('repaint: an empty title is refused rather than written', () => {
  withMirror(LINES, (file, read) => {
    assert.throws(() => obsidian.setTaskFields(file, 7, { title: '   ' }, 'p2'), /empty/i);
    assert.match(read()[7], /Plain task/);
  });
});

test('repaint: a non-task line is refused', () => {
  withMirror(LINES, (file) => {
    assert.throws(() => obsidian.setTaskFields(file, 4, { title: 'x' }, null), /Not a task line/);
  });
});

test('repaint: CRLF line endings survive the rewrite', () => {
  withMirror(['- [ ] Windows task <!--id:w1-->\r'], (file, read) => {
    obsidian.setTaskFields(file, 0, { title: 'Renamed' }, 'w1');
    assert.equal(read()[0], '- [ ] Renamed <!--id:w1-->\r');
  });
});
