'use strict';

/**
 * Time awareness (#87) — the accommodation nothing else in the system
 * substitutes for. Every other one is about WHAT to do; none was about whether
 * it fits in the time there is.
 *
 * The two properties worth defending are both about honesty: never claim
 * something fits when the duration was assumed rather than known, and never let
 * "I can't see the calendar" look like "you're free".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-timefit-')), 'a.db');

const { nextGap, whatFits, ASSUMED_MINUTES, BUFFER_MINUTES, minutesIntoDay } = require('./time-fit');

const DAY = '2026-08-17';
const at = (hh, mm) => new Date(2026, 7, 17, hh, mm, 0, 0);
const ev = (over = {}) => ({
  date: DAY, start: `${DAY}T14:00:00`, end: `${DAY}T15:00:00`,
  subject: 'Weekly SMT', isAllDay: false, showAs: 'busy', ...over,
});

// ── The gap ─────────────────────────────────────────────────────────────────

test('the gap is measured to the next meeting, less a buffer', () => {
  const gap = nextGap([ev()], at(13, 0));
  assert.equal(gap.minutes, 60 - BUFFER_MINUTES);
  assert.equal(gap.until, '14:00');
  assert.equal(gap.nextEvent.subject, 'Weekly SMT');
});

test('a buffer is left so a task cannot run right up to the door', () => {
  // An estimate that exactly fills the gap has no room to be slightly wrong,
  // which it always is — and arriving with the last thing still in your head is
  // the cost this is protecting against.
  assert.ok(BUFFER_MINUTES > 0);
});

test('a meeting already passed does not count as the next one', () => {
  const gap = nextGap([ev({ start: `${DAY}T09:00:00` }), ev({ start: `${DAY}T16:00:00`, subject: 'Later' })], at(13, 0));
  assert.equal(gap.nextEvent.subject, 'Later');
});

test('an all-day marker is not a wall you hit at a time', () => {
  const gap = nextGap([ev({ isAllDay: true, start: `${DAY}T00:00:00` })], at(13, 0));
  assert.equal(gap.openEnded, true);
});

test('cancelled and free-marked events are not walls either', () => {
  assert.equal(nextGap([ev({ showAs: 'cancelled' })], at(13, 0)).openEnded, true);
  assert.equal(nextGap([ev({ showAs: 'free' })], at(13, 0)).openEnded, true);
});

test('a tentative block still counts — it is time you may not have', () => {
  assert.equal(nextGap([ev({ showAs: 'tentative' })], at(13, 0)).openEnded, false);
});

test('nothing ahead is open-ended, which is a different answer from no time', () => {
  const gap = nextGap([], at(13, 0));
  assert.equal(gap.openEnded, true);
  assert.equal(gap.minutes, null);
});

test('a meeting that has already started leaves no gap', () => {
  const gap = nextGap([ev()], at(14, 30));
  assert.equal(gap.openEnded, true, 'the 14:00 is behind us; nothing else today');
});

test('minutesIntoDay reads the naive wall-clock string Graph returns', () => {
  assert.equal(minutesIntoDay('2026-08-17T14:30:00'), 14 * 60 + 30);
  assert.equal(minutesIntoDay('nonsense'), null);
});

// ── What fits ───────────────────────────────────────────────────────────────

const task = (over = {}) => ({ task_id: 1, text: 'A thing', status: 'open', estimateMinutes: null, ...over });

test('an un-estimated task is offered, but flagged as an assumption', () => {
  // This is the property that decides whether the feature stays trusted. A
  // "this fits" that turns out to be a guess is the answer you stop believing
  // the second time it is wrong.
  const r = whatFits([task()], 60);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].assumed, true);
  assert.equal(r.items[0].minutes, ASSUMED_MINUTES);
  assert.equal(r.assumedCount, 1);
});

test('a known estimate is never flagged as assumed', () => {
  const r = whatFits([task({ estimateMinutes: 15 })], 60);
  assert.equal(r.items[0].assumed, false);
  assert.equal(r.items[0].minutes, 15);
  assert.equal(r.assumedCount, 0);
});

test('anything longer than the gap is left out', () => {
  const r = whatFits([task({ task_id: 1, estimateMinutes: 120 }), task({ task_id: 2, estimateMinutes: 15 })], 30);
  assert.deepEqual(r.items.map(i => i.task_id), [2]);
});

test('the assumption is conservative enough to exclude from a short gap', () => {
  // 10 minutes free and nothing estimated: the honest answer is "nothing I can
  // promise", not a half-hour task squeezed in.
  assert.equal(whatFits([task()], 10).items.length, 0);
});

test('ranking order is preserved — this cuts the list, it does not re-sort it', () => {
  // Offering the shortest thing first would quietly turn this into the
  // quick-wins list that already exists, and the ADHD panel is explicit that a
  // smaller task is not always the right answer.
  const r = whatFits([
    task({ task_id: 1, text: 'Important', estimateMinutes: 30 }),
    task({ task_id: 2, text: 'Tiny', estimateMinutes: 5 }),
  ], 60);
  assert.deepEqual(r.items.map(i => i.text), ['Important', 'Tiny']);
});

test('done and dropped tasks never appear', () => {
  const r = whatFits([task({ status: 'done' }), task({ task_id: 2, status: 'dropped' })], 60);
  assert.equal(r.items.length, 0);
});

test('an open-ended gap returns nothing rather than the whole list', () => {
  // With no wall ahead, "here is what fits" is noise — that is the ordinary
  // task list's job.
  const r = whatFits([task({ estimateMinutes: 5 })], null);
  assert.equal(r.openEnded, true);
  assert.equal(r.items.length, 0);
});
