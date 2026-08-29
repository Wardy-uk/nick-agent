'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  weekKey, weekBounds, summarise, expectedByNow,
} = require('./weekly-target');

// ── Week maths ──────────────────────────────────────────────────────────────
// Every test pins its own date. These are pure functions precisely so the suite
// cannot break on a Monday.

test('the week starts on MONDAY, not Sunday', () => {
  // Sunday belongs to the week that has just ended, which is what "at the start
  // of the week" means to Nick and what every other weekly thing in NEURO
  // (the risk report, the weekly review) already assumes.
  const sunday = new Date('2026-08-30T12:00:00');
  const monday = new Date('2026-08-31T09:00:00');
  assert.notEqual(weekKey(sunday), weekKey(monday));
  assert.equal(weekKey(new Date('2026-08-31T09:00:00')), weekKey(new Date('2026-09-06T22:00:00')));
});

test('week bounds run Monday to Sunday inclusive', () => {
  const { from, to } = weekBounds(new Date('2026-08-29T10:00:00')); // a Saturday
  assert.equal(from, '2026-08-24');
  assert.equal(to, '2026-08-30');
});

test('ISO week numbering survives the year boundary', () => {
  // 1 Jan 2027 is a Friday, so it belongs to the week that started in December.
  assert.equal(weekKey(new Date('2027-01-01T12:00:00')), weekKey(new Date('2026-12-28T12:00:00')));
});

// ── The states ──────────────────────────────────────────────────────────────

test('an unset target is NOT a target of zero', () => {
  // Zero means "you finished everything you meant to"; unset means nobody has
  // said what the week is for. A ring drawn for the second is an accusation
  // about a number nobody chose.
  const s = summarise({ week: '2026-W35', target: null, done: 12, known: true });
  assert.equal(s.state, 'no-target');
  assert.equal(s.target, null);
  assert.equal(s.pct, null);
  assert.equal(s.done, 12);
});

test('an unreadable ledger is not a week with nothing done', () => {
  const s = summarise({ week: '2026-W35', target: 20, done: null, known: false });
  assert.equal(s.state, 'unknown');
  assert.equal(s.done, null);
});

test('meeting and exceeding the target are different states', () => {
  const met = summarise({ week: 'w', target: 20, done: 20, known: true });
  const over = summarise({ week: 'w', target: 20, done: 26, known: true });
  assert.equal(met.state, 'met');
  assert.equal(met.over, 0);
  assert.equal(over.state, 'exceeded');
  assert.equal(over.over, 6);
  // Both are "done"; only one is worth celebrating differently.
  assert.equal(met.met, true);
  assert.equal(over.met, true);
});

test('behind is judged on PACE, not on the raw fraction', () => {
  // 10 of 20 is on track on Wednesday and behind on Friday. A ring that cannot
  // tell those apart is decoration.
  const midweek = summarise({ week: 'w', target: 20, done: 10, known: true, expectedByNow: 8 });
  const friday = summarise({ week: 'w', target: 20, done: 10, known: true, expectedByNow: 16 });
  assert.equal(midweek.state, 'on-track');
  assert.equal(friday.state, 'behind');
});

test('remaining never goes negative', () => {
  const s = summarise({ week: 'w', target: 10, done: 14, known: true });
  assert.equal(s.remaining, 0);
  assert.equal(s.over, 4);
});

// ── Pace ────────────────────────────────────────────────────────────────────

test('pace is spread across the WORKING week, not seven days', () => {
  // Monday morning expects nothing; by the end of Friday it expects all of it.
  const mondayAM = expectedByNow(20, new Date('2026-08-31T08:00:00'));
  const fridayPM = expectedByNow(20, new Date('2026-09-04T18:00:00'));
  assert.ok(mondayAM < 2, `Monday morning should expect almost nothing, got ${mondayAM}`);
  assert.ok(fridayPM >= 19, `Friday evening should expect nearly all, got ${fridayPM}`);
});

test('the weekend does not keep raising the bar', () => {
  // Saturday and Sunday are not working days, so nothing more is expected than
  // was expected at the end of Friday — otherwise a quiet weekend would make
  // Nick look progressively more behind for doing exactly what he should.
  const friday = expectedByNow(20, new Date('2026-09-04T23:00:00'));
  const sunday = expectedByNow(20, new Date('2026-09-06T23:00:00'));
  // Friday 23:00 still has an hour of Friday left in it, so it asks for nearly
  // all rather than all — correct, not a rounding slip.
  assert.ok(friday >= 19.5, `Friday evening should expect nearly all, got ${friday}`);
  assert.equal(sunday, 20, 'the weekend caps at the full target');
  assert.ok(sunday >= friday, 'the bar must never fall back over the weekend');
});

test('no target means no pace to be behind', () => {
  assert.equal(expectedByNow(null, new Date('2026-09-04T18:00:00')), null);
});
