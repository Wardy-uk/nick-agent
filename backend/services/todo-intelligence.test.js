'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFollowThroughCandidate,
  buildTodayLane,
  parseEmbeddedMeta,
  serializeEmbeddedMeta,
  triageTodo,
} = require('./todo-intelligence');

test('triageTodo marks urgent customer work as must/high/needsToday', () => {
  const result = triageTodo({
    text: 'Reply to customer on SLA breach today',
    sourcePath: 'Meetings/2026-07-10-queue.md',
    dueDate: null,
  });
  assert.equal(result.moscow, 'must');
  assert.equal(result.priority, 'high');
  assert.equal(result.needsToday, true);
  assert.equal(result.context, 'meeting-follow-up');
});

test('embedded metadata round-trips cleanly', () => {
  const raw = serializeEmbeddedMeta({ context: 'queue', moscow: 'must', created: '2026-07-10' });
  assert.deepEqual(parseEmbeddedMeta(`- [ ] Do the thing ${raw}`), {
    context: 'queue',
    moscow: 'must',
    created: '2026-07-10',
  });
});

test('buildTodayLane favours must-move work', () => {
  const lane = buildTodayLane([
    { id: 1, text: 'Reply to breached queue item', priority: 'high', due_date: null, source: 'Master (Inbox)', mustdo: true, meta: { created: '2026-07-09' }, _score: 88 },
    { id: 2, text: 'Tidy old notes', priority: 'low', due_date: null, source: 'Master (Later)', mustdo: false, meta: { created: '2026-07-01' }, _score: 4 },
  ], '2026-07-10');
  assert.equal(lane.length, 1);
  assert.equal(lane[0].text, 'Reply to breached queue item');
});

// ── Calibration (#73/#74) ───────────────────────────────────────────────────
//
// Both classifiers listed words that describe Head of Technical Support and
// treated them as urgency. Everything became a MUST and everything became
// must-move-today, which is arithmetically the same as no priorities — while
// still driving Focus, the lane and the nudge count.

test('a task is not urgent for containing the word "customer"', () => {
  // The measured example: no date, no must flag, no priority — in Must Move
  // Today because of one noun.
  const r = triageTodo({ text: 'Make amends to Customer Portal', sourcePath: null, dueDate: null });
  assert.equal(r.moscow, 'should', 'domain words describe the work, not when it is due');
  assert.equal(r.needsToday, false);
});

test('the queue context no longer implies today on its own', () => {
  const r = triageTodo({ text: 'Tidy the SLA reporting spreadsheet', sourcePath: null, dueDate: null });
  assert.equal(r.context, 'queue', 'still queue work — that classification was never the problem');
  assert.equal(r.needsToday, false, 'but queue has to earn today like everything else');
});

test('none of the job-description words promote to must on their own', () => {
  for (const text of [
    'Review the onboarding pack',
    'Send the approval to finance',
    'Approve the new rota',
    'Update the SLA definitions',
    'Escalation process write-up',
    'Payroll checklist for September',
  ]) {
    assert.equal(triageTodo({ text, sourcePath: null, dueDate: null }).moscow, 'should', text);
  }
});

test('words that say WHEN still make a must', () => {
  for (const text of [
    'Call Stephen back today',
    'URGENT: portal is down',
    'Send the deck before lunch',
    'Respond to the SLA breach',
  ]) {
    assert.equal(triageTodo({ text, sourcePath: null, dueDate: null }).moscow, 'must', text);
  }
});

test('an explicit rating or a real date always wins', () => {
  assert.equal(triageTodo({ text: 'Tidy old notes', dueDate: null, mustdo: true }).moscow, 'must');
  assert.equal(triageTodo({ text: 'Tidy old notes', dueDate: '2020-01-01' }).moscow, 'must');
  assert.equal(triageTodo({ text: 'Tidy old notes', dueDate: null, priority: 'high' }).moscow, 'must');
  // And a rating Nick made himself is never second-guessed by the classifier.
  assert.equal(triageTodo({ text: 'Call Stephen back today', metadata: { moscow: 'could' } }).moscow, 'could');
});

test('the lane names the test that put each row there', () => {
  const lane = buildTodayLane([
    { id: 1, text: 'Renew the certificate', due_date: '2026-07-08', source: 'x', meta: { created: '2026-07-01' } },
    { id: 2, text: 'Submit the return', due_date: '2026-07-10', source: 'x', meta: { created: '2026-07-01' } },
    { id: 3, text: 'Ring the supplier', mustdo: true, source: 'x', meta: { created: '2026-07-01' } },
  ], '2026-07-10');
  const why = Object.fromEntries(lane.map(r => [r.text, r.why]));
  assert.match(why['Renew the certificate'], /Overdue/);
  assert.equal(why['Submit the return'], 'Due today');
  assert.equal(why['Ring the supplier'], 'You marked this a must');
});

test('decorateTask passes overdue and dueToday through', () => {
  // They were computed and dropped, so buildFollowThroughCandidate's overdue
  // and dueToday arms read undefined and could never fire.
  const lane = buildTodayLane([
    { id: 1, text: 'Renew the certificate', due_date: '2026-07-08', source: 'x', meta: { created: '2026-07-01' } },
  ], '2026-07-10');
  assert.equal(lane.length, 1);
});

test('buildFollowThroughCandidate returns the stalest high-signal task', () => {
  const follow = buildFollowThroughCandidate([
    { id: 1, text: 'Chase finance approval', priority: 'normal', due_date: null, source: 'Master (Inbox)', mustdo: false, meta: { created: '2026-07-08', sourcePath: 'Meetings/finance.md' }, _score: 60 },
  ], '2026-07-10');
  assert.match(follow.message, /Chase finance approval/);
  assert.equal(follow.context, 'meeting-follow-up');
});

// ── The Must Move lane can be completed from ─────────────────────────────────

test('the lane carries the real task id, not its display key', () => {
  // Measured live and this is why the test exists: the lane row for "Follow up
  // with Liam" carried id 28, while task 28 in the DB was "Review Molly's Guild
  // website request". `id` is a display key — parseVaultTodos numbers todos as
  // it walks them — so completing by it ticks off an unrelated task, silently,
  // in the one screen Nick uses to find what he owes.
  const lane = buildTodayLane([
    { id: 28, task_id: 159, text: 'Follow up with Liam', moscow: 'must', priority: 'high', source: 'NEURO' },
  ], '2026-08-18');

  assert.equal(lane.length, 1);
  assert.equal(lane[0].task_id, 159, 'the lane must expose the DB id, or the checkbox completes the wrong task');
  assert.notEqual(lane[0].task_id, lane[0].id);
});

test('a file-backed lane row has no task_id and keeps its line identity', () => {
  // NEURO does not own a daily-note line, so filePath + lineNumber is the only
  // identity there — the same owner order completeTask uses everywhere.
  const lane = buildTodayLane([
    {
      id: 32, text: 'Action four escalations', moscow: 'must', priority: 'high',
      source: 'Daily (Focus Today)', filePath: '/vault/Daily/2026-08-18.md', lineNumber: 9,
    },
  ], '2026-08-18');

  assert.equal(lane[0].task_id, null, 'inventing a task id for a vault line would complete something else');
  assert.equal(lane[0].filePath, '/vault/Daily/2026-08-18.md');
  assert.equal(lane[0].lineNumber, 9);
});

test('a Microsoft-backed lane row keeps its ms_id, so the push can follow', () => {
  const lane = buildTodayLane([
    {
      id: 40, text: 'Succession plan', moscow: 'must', priority: 'high',
      source: 'MS Planner', ms_id: 'g2D79J0Bpkq', filePath: '/vault/Tasks/Microsoft Tasks.md', lineNumber: 4,
    },
  ], '2026-08-18');

  assert.equal(lane[0].ms_id, 'g2D79J0Bpkq');
});
