'use strict';

/**
 * The half-day planner's judgement, pinned without a DB, a calendar or a clock.
 * Everything here goes through `planWindow` / `estimateMultiplier` / `freeGaps`,
 * which take their inputs — the pi-health.assess() split.
 */

const test = require('node:test');
const assert = require('node:assert');

const planner = require('./day-planner');
const { MORNING, AFTERNOON } = planner;

const mins = (h, m = 0) => h * 60 + m;
const task = (id, text, estimateMinutes = null) => ({ id, text, estimateMinutes });

// ── The multiplier ───────────────────────────────────────────────────────────

test('with no samples the multiplier is the default AND says it is not learned', () => {
  const m = planner.estimateMultiplier([]);
  assert.equal(m.multiplier, planner.DEFAULT_MULTIPLIER);
  assert.equal(m.learned, false);
  assert.match(m.basis, /default/);
});

test('too few samples does not pretend to have learned', () => {
  // Nick's two real focus sessions. Two is not a calibration, and presenting it
  // as one is the whole class of bug this codebase keeps catching.
  const m = planner.estimateMultiplier([
    { planned: 30, actual: 44 },
    { planned: 30, actual: 111 },
  ]);
  assert.equal(m.learned, false);
  assert.equal(m.samples, 2);
  assert.equal(m.multiplier, planner.DEFAULT_MULTIPLIER);
});

test('enough samples learns the MEDIAN, so one runaway cannot distort it', () => {
  const m = planner.estimateMultiplier([
    { planned: 30, actual: 30 },   // 1.0
    { planned: 30, actual: 45 },   // 1.5
    { planned: 30, actual: 60 },   // 2.0
    { planned: 30, actual: 66 },   // 2.2
    { planned: 30, actual: 300 },  // 10.0 — a session left running
  ]);
  assert.equal(m.learned, true);
  assert.equal(m.multiplier, 2, 'the median, not the mean (which would be 3.34)');
});

test('the multiplier never shrinks a block below the estimate', () => {
  const m = planner.estimateMultiplier(
    Array.from({ length: 6 }, () => ({ planned: 60, actual: 20 }))
  );
  assert.ok(m.multiplier >= 1, 'a sub-1 multiplier would start under-booking');
});

test('a runaway corpus is clamped rather than eating the whole day', () => {
  const m = planner.estimateMultiplier(
    Array.from({ length: 6 }, () => ({ planned: 10, actual: 600 }))
  );
  assert.ok(m.multiplier <= 4, `clamped, got ${m.multiplier}`);
});

// ── Sizing ───────────────────────────────────────────────────────────────────

test('an explicit estimate is NEVER inflated', () => {
  // Nick typed 45. The planner does not silently make it 112 in his own diary.
  assert.equal(planner.sizeOf(task(1, 'x', 45), 2.5), 45);
});

test('an assumed duration IS inflated, because the assumption is known wrong', () => {
  const sized = planner.sizeOf(task(1, 'x', null), 2.5);
  assert.ok(sized > 30, `30 is the assumption already measured as too small, got ${sized}`);
  assert.equal(sized % 5, 0, 'lands on a readable five minutes');
});

// ── The shape contract ───────────────────────────────────────────────────────
//
// This is the bug that shipped and was caught only by a dry run against the
// live server: `activeTodos()` returns the LEGACY todo shape, so the id is
// `task_id` and the estimate is `estimateMinutes`. Reading `id` /
// `estimate_minutes` silently filtered out all 148 open tasks and the planner
// announced "nothing open to schedule" against a full backlog. Nothing threw.
// A wrong key here does not fail loudly — it produces an empty, plausible day.

test('a NEURO task row maps across, reading task_id and estimateMinutes', () => {
  const mapped = planner.toPlannerTask({
    task_id: 58,
    text: 'Build succession plan',
    estimateMinutes: 45,
    source: 'NEURO',
    filePath: null,
  });
  assert.deepEqual(mapped, { id: 58, text: 'Build succession plan', estimateMinutes: 45 });
});

test('a missing estimate maps to null, never to a number', () => {
  const mapped = planner.toPlannerTask({ task_id: 1, text: 'x', estimateMinutes: null });
  assert.strictEqual(mapped.estimateMinutes, null, 'null means "assume", 0 would mean "instant"');
});

test('a file-backed line is dropped, because nothing can block it', () => {
  // Microsoft owns this one; task-blocks has no row to attach to.
  assert.strictEqual(planner.toPlannerTask({
    task_id: null, text: 'Succession plan', source: 'MS Planner',
  }), null);
});

test('the row-shaped keys are NOT accepted — that was the bug', () => {
  // If someone later passes raw task rows in, this must fail loudly in a test
  // rather than quietly producing an empty plan.
  assert.strictEqual(planner.toPlannerTask({ id: 58, text: 'x', estimate_minutes: 45 }), null);
});

// ── Gaps ─────────────────────────────────────────────────────────────────────

test('a meeting is a wall, and the buffer is honoured on both sides', () => {
  const gaps = planner.freeGaps({
    window: MORNING,
    busy: [{ startMin: mins(10), endMin: mins(11) }],
    nowMin: mins(7),
    isToday: true,
  });
  assert.equal(gaps.length, 2);
  assert.ok(gaps[0].endMin <= mins(10), 'first gap stops before the meeting');
  assert.ok(gaps[1].startMin >= mins(11), 'second gap starts after it');
});

test('today never proposes a slot that has already started', () => {
  const gaps = planner.freeGaps({ window: MORNING, busy: [], nowMin: mins(11), isToday: true });
  assert.ok(gaps.every(g => g.startMin > mins(11)), 'every gap is in the future');
});

test('a half-day with no room returns no gaps rather than a bad one', () => {
  const gaps = planner.freeGaps({
    window: MORNING,
    busy: [{ startMin: mins(9), endMin: mins(13) }],
    nowMin: mins(7),
    isToday: true,
  });
  assert.equal(gaps.length, 0);
});

// ── Packing ──────────────────────────────────────────────────────────────────

const openMorning = (over = {}) => ({
  window: MORNING,
  tasks: [task(1, 'Guild RCA'), task(2, 'HR risk assessment'), task(3, 'Call process report')],
  busy: [],
  nowMin: mins(7),
  isToday: true,
  multiplier: 2.5,
  ...over,
});

test('an empty morning produces blocks, in rank order', () => {
  const out = planner.planWindow(openMorning());
  assert.ok(out.blocks.length >= 1);
  assert.equal(out.blocks[0].tasks[0].text, 'Guild RCA', 'rank order, never re-sorted by duration');
});

test('a block never exceeds the maximum, however much room there is', () => {
  const out = planner.planWindow(openMorning());
  for (const b of out.blocks) {
    assert.ok(b.minutes <= planner.MAX_BLOCK_MINUTES, `${b.minutes} exceeds the cap`);
  }
});

test('a half-day is capped at MAX_BLOCKS_PER_HALF, so the day still has room to happen', () => {
  const many = Array.from({ length: 20 }, (_, i) => task(i + 1, `Task ${i + 1}`));
  const out = planner.planWindow(openMorning({ tasks: many }));
  assert.ok(out.blocks.length <= planner.MAX_BLOCKS_PER_HALF);
});

test('a block holds at most MAX_TASKS_PER_BLOCK — the ten-in-thirty-minutes bug', () => {
  const many = Array.from({ length: 20 }, (_, i) => task(i + 1, `Task ${i + 1}`));
  const out = planner.planWindow(openMorning({ tasks: many }));
  for (const b of out.blocks) {
    assert.ok(b.tasks.length <= planner.MAX_TASKS_PER_BLOCK, `${b.tasks.length} tasks in one block`);
  }
});

test('what did not fit is REPORTED, never silently dropped', () => {
  const many = Array.from({ length: 20 }, (_, i) => task(i + 1, `Task ${i + 1}`));
  const out = planner.planWindow(openMorning({ tasks: many }));
  const planned = out.blocks.reduce((n, b) => n + b.tasks.length, 0);
  assert.equal(out.overflowed, 20 - planned, 'the overflow count must account for every task');
  assert.ok(out.overflowed > 0);
});

test('nothing open is a REASON, not an empty success', () => {
  const out = planner.planWindow(openMorning({ tasks: [] }));
  assert.equal(out.blocks.length, 0);
  assert.match(out.reason, /nothing open/);
});

test('a full diary gives the reason, and it is not "nothing to do"', () => {
  const out = planner.planWindow(openMorning({
    busy: [{ startMin: mins(9), endMin: mins(13) }],
  }));
  assert.equal(out.blocks.length, 0);
  assert.match(out.reason, /no free gap/);
});

test('a block whose tasks all lack estimates is flagged assumed', () => {
  const out = planner.planWindow(openMorning());
  assert.ok(out.blocks[0].assumed, 'the duration is a guess and must say so');
});

test('a block sized from a real estimate is NOT flagged assumed', () => {
  const out = planner.planWindow(openMorning({ tasks: [task(1, 'Known job', 60)] }));
  assert.equal(out.blocks[0].assumed, false);
});

test('one oversized task still gets scheduled rather than never fitting', () => {
  // A four-hour job would clear every gap and sit open for ever otherwise. It is
  // capped to the gap and Nick can carry on in the next block.
  const out = planner.planWindow(openMorning({ tasks: [task(1, 'Big migration', 240)] }));
  assert.equal(out.blocks.length >= 1, true);
  assert.ok(out.blocks[0].minutes <= planner.MAX_BLOCK_MINUTES);
  assert.equal(out.blocks[0].overpacked, true, 'and it says the window is too small for it');
});

test('blocks never overlap each other', () => {
  const many = Array.from({ length: 12 }, (_, i) => task(i + 1, `Task ${i + 1}`));
  const out = planner.planWindow(openMorning({ tasks: many }));
  for (let i = 1; i < out.blocks.length; i++) {
    assert.ok(out.blocks[i].startMin >= out.blocks[i - 1].endMin,
      'a later block starts after the previous one ends');
  }
});

test('the afternoon window never reaches back into the morning', () => {
  const out = planner.planWindow(openMorning({ window: AFTERNOON, nowMin: mins(12, 30) }));
  for (const b of out.blocks) {
    assert.ok(b.startMin >= AFTERNOON.startMin, 'no afternoon block before 13:00');
    assert.ok(b.endMin <= AFTERNOON.endMin, 'and none past the end of the day');
  }
});

test('a block is never shorter than the minimum worth blocking', () => {
  const out = planner.planWindow(openMorning({
    // A ten-minute slot between two meetings is not a place to do a job.
    busy: [{ startMin: mins(9), endMin: mins(10) }, { startMin: mins(10, 15), endMin: mins(13) }],
  }));
  for (const b of out.blocks) {
    assert.ok(b.minutes >= planner.MIN_BLOCK_MINUTES);
  }
});
