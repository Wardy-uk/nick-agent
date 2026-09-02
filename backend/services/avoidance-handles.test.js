'use strict';

/**
 * A card that names a task must carry a handle to it.
 *
 * The "What you're pushing away" rows on the default screen were built from
 * real tasks and then rendered as text alone — label, detail, nothing else.
 * That is not a styling gap: the identity was DROPPED on the way out of
 * `_avoidance` and `buildFollowThroughCandidate`, so the client could not have
 * offered an action even if it wanted to.
 *
 * These pin the carry. They are cheap and they are the kind of thing that
 * silently regresses when someone reshapes a payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFollowThroughCandidate } = require('./todo-intelligence');
const { _nudgeDestination } = require('./adhd-dashboard');

// ── The follow-through candidate ─────────────────────────────────────────────

test('the follow-through candidate carries the handles of the task it names', () => {
  const candidate = buildFollowThroughCandidate([{
    id: 'x', task_id: 41, ms_id: 'AAMk-1', source: 'MS Planner',
    filePath: 'Tasks/Microsoft Tasks.md', lineNumber: 8,
    text: 'Sign off the risk assessment',
    moscow: 'must', priority: 'high',
    created_at: '2026-07-01 09:00:00',
  }], '2026-09-01');

  assert.ok(candidate, 'positive control: this task should qualify as a follow-through');
  assert.equal(candidate.task_id, 41);
  assert.equal(candidate.ms_id, 'AAMk-1');
  assert.equal(candidate.filePath, 'Tasks/Microsoft Tasks.md');
  assert.equal(candidate.lineNumber, 8);
  assert.equal(candidate.source, 'MS Planner');
});

test('a task with no handles reports nulls rather than omitting the fields', () => {
  // Null is what the client tests to decide whether to render buttons. An
  // ABSENT field reads the same, but only by luck — say it explicitly.
  const candidate = buildFollowThroughCandidate([{
    id: 'y', text: 'Something with no identity at all',
    moscow: 'must', created_at: '2026-06-01 09:00:00',
  }], '2026-09-01');

  assert.ok(candidate);
  assert.equal(candidate.task_id, null);
  assert.equal(candidate.ms_id, null);
  assert.equal(candidate.filePath, null);
});

// ── Where a snoozed reminder goes ────────────────────────────────────────────

test('every nudge type maps to a view that exists, or to nothing', () => {
  const fs = require('fs');
  const path = require('path');
  const { NUDGE_TYPES } = require('./nudges');

  const app = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf-8'
  );
  const views = new Set([...app.matchAll(/case\s+'([a-z0-9-]+)'\s*:/gi)].map((m) => m[1]));
  assert.ok(views.size > 20, `positive control: expected App.jsx to expose many views, saw ${views.size}`);

  assert.ok(NUDGE_TYPES.length > 0, 'positive control: there are nudge types to check');
  for (const type of NUDGE_TYPES) {
    const dest = _nudgeDestination(type);
    assert.notEqual(dest, undefined, `${type} must resolve to a view or explicitly to null`);
    if (dest !== null) {
      assert.ok(views.has(dest), `nudge type '${type}' points at '${dest}', which App.jsx cannot render`);
    }
  }
});

test('an unrecognised nudge type gets no button rather than a guess', () => {
  // ⚠ `_avoidance` falls back to the literal string 'reminder' when it cannot
  // parse a type out of the activity row. A map that guessed would send Nick to
  // an unrelated screen — the exact failure the deleted "Queue" button was.
  assert.equal(_nudgeDestination('reminder'), null);
  assert.equal(_nudgeDestination(''), null);
  assert.equal(_nudgeDestination(null), null);
  assert.equal(_nudgeDestination('something-invented'), null);
  // Positive control, or a broken map would pass this test by returning null
  // for absolutely everything.
  assert.equal(_nudgeDestination('todo'), 'todos');
});
