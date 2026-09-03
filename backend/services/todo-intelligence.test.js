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

test('a shared card whose half he has finished stops being his overdue work', () => {
  // Nick's Planner cards with sub-tasks: his bits done, somebody else's open.
  // Every date-driven arm asks "does this demand something from Nick today",
  // and for that half the answer is now no.
  const row = { id: 1, text: 'Brief the teams on the escalation standard', due_date: '2026-08-21', source: 'MS Planner', priority: 'normal', meta: {} };
  const before = triageTodo({ text: row.text, dueDate: row.due_date }, '2026-09-02');
  assert.equal(before.overdue, true);
  assert.equal(before.needsToday, true);
  assert.equal(before.moscow, 'must');

  const after = triageTodo({ text: row.text, dueDate: row.due_date, myPartDone: true }, '2026-09-02');
  assert.equal(after.overdue, false);
  assert.equal(after.dueToday, false);
  assert.equal(after.needsToday, false);
  assert.notEqual(after.moscow, 'must');
  assert.notEqual(after.priority, 'high');

  // And it leaves the lane, which is the screen this exists to clear.
  assert.equal(buildTodayLane([row], '2026-09-02').length, 1);
  assert.equal(buildTodayLane([{ ...row, myPartDone: true }], '2026-09-02').length, 0);
});

test('the date survives, because the board really is late', () => {
  // The suppression is about who owes it, not about hiding it. A row that lost
  // its date would say the card is fine when somebody is still waiting on it.
  const [row] = buildTodayLane([
    { id: 1, text: 'Shared card', due_date: '2026-08-21', mustdo: true, myPartDone: true, source: 'MS Planner', meta: {} },
  ], '2026-09-02');
  assert.ok(row, 'an explicit mustdo is a call Nick made himself and is not overruled');
  assert.equal(row.due_date, '2026-08-21');
  assert.equal(row.myPartDone, true);
  // And the lane does not tell him it is overdue, which is the reason it would
  // have named before the date stopped being his.
  assert.ok(!/overdue/i.test(row.why), `lane still calls it overdue: ${row.why}`);
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

// ── WIP survives into the lane ───────────────────────────────────────────────
//
// `buildTodayLane` returns an explicit whitelist, so a field left out of it is
// silently `undefined` on the client — which is exactly how `overdue` and
// `dueToday` came to be unreadable by `buildFollowThroughCandidate` (#73/#74).
// The WIP badge and its toggle both key on `status`, and a dropped status would
// make the button one-way: every click would send 'in-progress' and nothing
// could ever go back to 'open'.

test('the lane carries a task\'s status, so WIP can be shown and undone', () => {
  const lane = buildTodayLane([
    { task_id: 1, text: 'Started thing', status: 'in-progress', moscow: 'must', priority: 'high' },
    { task_id: 2, text: 'Untouched thing', status: 'open', moscow: 'must', priority: 'high' },
  ], '2026-08-27');

  const started = lane.find(r => r.task_id === 1);
  const untouched = lane.find(r => r.task_id === 2);
  assert.ok(started, 'the in-progress task must still appear — WIP does not remove it from the lane');
  assert.strictEqual(started.status, 'in-progress');
  assert.strictEqual(untouched.status, 'open');
});

test('a task with no status reads as open, never undefined', () => {
  const lane = buildTodayLane([
    { task_id: 3, text: 'No status field', moscow: 'must', priority: 'high' },
  ], '2026-08-27');
  assert.strictEqual(lane[0].status, 'open', 'undefined would make the WIP toggle one-way');
});

// ── Planner progress is read, never invented or overwritten ─────────────────
//
// syncMicrosoftTasks renders Planner's percentComplete into the mirror line as
// a "(75%)" suffix, so the number is already on Nick's screen. Nothing read it
// back, so a WIP button that PATCHed percentComplete=50 would have REDUCED a
// task already at 75% — destroying real progress on a board his team reads.

test('a Planner row reports the progress already in its text', () => {
  const lane = buildTodayLane([
    { ms_id: 'p1', text: 'Re-instate reglar 121s with team (75%)', source: 'MS Planner', moscow: 'must', priority: 'high' },
  ], '2026-08-27');
  assert.strictEqual(lane[0].percentComplete, 75);
});

test('a Planner row with no marker is null, not zero', () => {
  // Planner omits the suffix at 0%, and a To Do task has no such field at all.
  // "Not started" and "cannot say" are different facts.
  const lane = buildTodayLane([
    { ms_id: 'p2', text: 'Brief TPJ and Dev teams', source: 'MS Planner', moscow: 'must', priority: 'high' },
  ], '2026-08-27');
  assert.strictEqual(lane[0].percentComplete, null);
});

test('a NEURO task never reports Planner progress, even if its text has a percentage', () => {
  // Nick writing "(50%)" into his own task's wording is not Planner state, and
  // reading it as such would put a WIP badge on an untouched task.
  const lane = buildTodayLane([
    { task_id: 9, text: 'Cut the backlog (50%) by Friday', status: 'open', moscow: 'must', priority: 'high' },
  ], '2026-08-27');
  assert.strictEqual(lane[0].percentComplete, null);
});

test('a nonsense percentage is rejected rather than carried', () => {
  const lane = buildTodayLane([
    { ms_id: 'p3', text: 'Weird one (999%)', source: 'MS Planner', moscow: 'must', priority: 'high' },
  ], '2026-08-27');
  assert.strictEqual(lane[0].percentComplete, null);
});

// ── "Not today" ──────────────────────────────────────────────────────────────
//
// Lane membership is recomputed on every read, so until this there was nothing
// to disagree with. These pin the two properties that make the snooze honest
// rather than merely present: the lane does not shrink, and nothing vanishes.

const laneKey = (row) => `todo:${String(row.text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}`;

function musts(...texts) {
  return texts.map((text, i) => ({
    id: i + 1, text, mustdo: true, due_date: '2020-01-01', source: 'NEURO',
  }));
}

test('a snoozed row leaves the lane and the next task moves UP into its place', () => {
  // Filtering after the slice would leave a gap and quietly shrink the lane,
  // which makes snoozing feel like losing capacity.
  const tasks = musts('alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot');
  const full = buildTodayLane(tasks, '2026-09-02', 5);
  assert.strictEqual(full.length, 5);
  assert.ok(!full.some(r => r.text === 'foxtrot'), 'foxtrot should be the one over the limit');

  const deferred = new Map([[laneKey({ text: 'alpha' }), { until: '2099-01-01T07:00:00Z', reason: 'too-big' }]]);
  const lane = buildTodayLane(tasks, '2026-09-02', 5, { deferred, keyFor: laneKey });

  assert.strictEqual(lane.length, 5, 'the lane must stay five deep');
  assert.ok(!lane.some(r => r.text === 'alpha'), 'the snoozed row is still showing');
  assert.ok(lane.some(r => r.text === 'foxtrot'), 'nothing backfilled the gap');
});

test('what was held back is REPORTED, with its reason and return time', () => {
  // A lane that is simply shorter is indistinguishable from one that found less
  // work — and if everything were snoozed, an empty lane would read as a clear
  // day over four deferred musts.
  const tasks = musts('alpha', 'bravo');
  const held = [];
  const deferred = new Map([
    [laneKey({ text: 'alpha' }), { until: '2099-01-01T07:00:00Z', reason: 'waiting-on-someone' }],
  ]);
  const lane = buildTodayLane(tasks, '2026-09-02', 5, { deferred, keyFor: laneKey, held });

  assert.deepEqual(lane.map(r => r.text), ['bravo']);
  assert.strictEqual(held.length, 1);
  assert.strictEqual(held[0].text, 'alpha');
  assert.strictEqual(held[0].snoozeReason, 'waiting-on-someone');
  assert.strictEqual(held[0].snoozedUntil, '2099-01-01T07:00:00Z');
});

test('without a key function nothing is hidden — an unreadable lifecycle shows the whole lane', () => {
  // Fails OPEN, deliberately. Hiding work on the strength of not having been
  // able to check what was snoozed is the false all-clear this codebase refuses
  // everywhere else.
  const tasks = musts('alpha', 'bravo');
  const deferred = new Map([[laneKey({ text: 'alpha' }), { until: '2099-01-01T07:00:00Z', reason: 'not-now' }]]);
  assert.strictEqual(buildTodayLane(tasks, '2026-09-02', 5, { deferred }).length, 2, 'no keyFor should hide nothing');
  assert.strictEqual(buildTodayLane(tasks, '2026-09-02', 5, { keyFor: laneKey }).length, 2, 'no deferrals should hide nothing');
  assert.strictEqual(buildTodayLane(tasks, '2026-09-02', 5).length, 2, 'the old call shape must be unchanged');
});
