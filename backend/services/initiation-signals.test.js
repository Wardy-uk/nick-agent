'use strict';

/**
 * Initiation signals — the rules about what may and may not be counted.
 *
 * `assess()` is pure, so what is under test here IS the product: which acts
 * earn a number, what that number is allowed to claim, and — the important
 * half — what it refuses to count. This surface exists to reward STARTING, so
 * the expensive failure is one that quietly reverts to rewarding finishing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const signals = require('./initiation-signals');

// A Thursday, so the ISO week has Mon–Wed behind it and the weekend rules bite.
const NOW = new Date('2026-09-03T14:00:00');
const at = (daysAgo, hour = 9) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function session(over = {}) {
  return {
    id: over.id || `fs_${Math.random()}`,
    taskId: null,
    text: 'a thing',
    startedAt: at(0),
    endedAt: at(0, 10),
    plannedMinutes: 30,
    plannedAssumed: true,
    actualMinutes: 30,
    endedReason: 'completed',
    shrinks: 0,
    finalStep: null,
    originalText: null,
    ...over,
  };
}

// ── Rule 1: a start counts even if it went nowhere ───────────────────────────

test('an abandoned session counts as a start', () => {
  const r = signals.assess({
    history: [session({ id: 'a', endedReason: 'abandoned', actualMinutes: 3 })],
    anchor: NOW,
  });
  assert.equal(r.starts.today, 1);
});

test('an expired session counts as a start', () => {
  const r = signals.assess({
    history: [session({ id: 'a', endedReason: 'expired' })],
    anchor: NOW,
  });
  assert.equal(r.starts.today, 1);
});

test('starts are never filtered by outcome — the whole point of the surface', () => {
  const history = [
    session({ id: 'a', endedReason: 'completed' }),
    session({ id: 'b', endedReason: 'abandoned' }),
    session({ id: 'c', endedReason: 'expired' }),
  ];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.starts.today, 3, 'completing is not what is being counted');
});

// ── Rule 2: the live session counts ──────────────────────────────────────────

test('a running session counts as a start and is flagged live', () => {
  const r = signals.assess({
    history: [],
    live: { id: 'fs_live', startedAt: at(0), text: 'the thing', plannedMinutes: 45 },
    anchor: NOW,
  });
  assert.equal(r.starts.today, 1);
  assert.equal(r.starts.live, true);
});

test('a session readable as both live and archived is counted once', () => {
  // The switch-over window: _archive has run, a caller still holds the live view.
  const r = signals.assess({
    history: [session({ id: 'fs_dupe' })],
    live: { id: 'fs_dupe', startedAt: at(0), text: 'a thing' },
    anchor: NOW,
  });
  assert.equal(r.starts.today, 1, 'the id is what stops the double-count');
});

// ── Rule 3: you cannot beat an estimate you did not make ─────────────────────

test('assumed estimates are excluded from the estimate read and reported', () => {
  const history = [
    session({ id: 'a', plannedAssumed: true, plannedMinutes: 30, actualMinutes: 90 }),
    session({ id: 'b', plannedAssumed: true, plannedMinutes: 30, actualMinutes: 80 }),
    session({ id: 'c', plannedAssumed: true, plannedMinutes: 30, actualMinutes: 70 }),
  ];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.estimates.known, false, 'nothing here was Nick’s estimate');
  assert.equal(r.estimates.judged, 0);
  assert.equal(r.estimates.assumedExcluded, 3, 'the exclusion is stated, not silent');
  assert.equal(r.estimates.over, 0, 'a 3x overrun on an assumed 30 is not a miss he made');
});

test('estimates Nick set are judged, and mixed history keeps the two apart', () => {
  const history = [
    session({ id: 'a', plannedAssumed: false, plannedMinutes: 60, actualMinutes: 45 }),
    session({ id: 'b', plannedAssumed: false, plannedMinutes: 60, actualMinutes: 62 }),
    session({ id: 'c', plannedAssumed: false, plannedMinutes: 30, actualMinutes: 90 }),
    session({ id: 'd', plannedAssumed: true, plannedMinutes: 30, actualMinutes: 120 }),
  ];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.estimates.known, true);
  assert.equal(r.estimates.judged, 3);
  assert.equal(r.estimates.assumedExcluded, 1);
  assert.equal(r.estimates.under, 1);
  assert.equal(r.estimates.close, 1, 'two minutes over is not a miss');
  assert.equal(r.estimates.over, 1);
});

test('too few real estimates refuses rather than reporting a thin split', () => {
  const history = [
    session({ id: 'a', plannedAssumed: false, plannedMinutes: 60, actualMinutes: 45 }),
    session({ id: 'b', plannedAssumed: false, plannedMinutes: 60, actualMinutes: 45 }),
  ];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.estimates.known, false);
  assert.match(r.estimates.reason, /too few/);
});

test('a running session contributes no actual', () => {
  const r = signals.assess({
    history: [],
    live: { id: 'l', startedAt: at(0), text: 'x', plannedMinutes: 60, plannedAssumed: false },
    anchor: NOW,
  });
  assert.equal(r.estimates.judged, 0, 'elapsed is still moving; it is not an actual');
});

// ── Rule 4: no streaks, no scores ────────────────────────────────────────────

test('the read exposes no streak and no score', () => {
  const r = signals.assess({ history: [session({ id: 'a' })], anchor: NOW });
  const flat = JSON.stringify(r);
  for (const banned of ['streak', 'score', 'points', 'grade', 'level', 'xp']) {
    assert.ok(!flat.toLowerCase().includes(banned), `must not expose "${banned}"`);
  }
});

test('typical is the median of covered weekdays, not of days he started something', () => {
  // Two busy days, one quiet one at each end of the covered window, and five
  // weekdays with nothing at all. Those five are real zeros and the median must
  // see them: over the nine covered days the answer is 0, where counting only
  // the days he already started something gives 2. That gap is the whole rule —
  // dropping the zeros flatters every ordinary day into reading as below par.
  const history = [
    session({ id: 'a', startedAt: at(1) }),
    session({ id: 'b', startedAt: at(1, 11) }),
    session({ id: 'c', startedAt: at(1, 15) }),
    session({ id: 'd', startedAt: at(2) }),
    session({ id: 'e', startedAt: at(2, 11) }),
    session({ id: 'f', startedAt: at(2, 15) }),
    session({ id: 'g', startedAt: at(10) }),
    session({ id: 'h', startedAt: at(13) }),
  ];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.starts.typical, 0, 'most weekdays in the window had no start at all');
  assert.match(r.starts.typicalBasis, /median of 9 weekdays/);
});

test('days before the history begins are unknown, never zero', () => {
  const history = [session({ id: 'a', startedAt: at(1) })];
  const r = signals.assess({ history, anchor: NOW });
  // One weekday covered — below the floor, so no median is offered at all.
  assert.equal(r.starts.typical, null);
  assert.match(r.starts.typicalBasis, /too few/);
});

// ── Rule 5: shrinking is evidence about the work ─────────────────────────────

test('a shrink ladder carries both ends', () => {
  const history = [session({
    id: 'a',
    shrinks: 2,
    originalText: 'rewrite the escalation policy',
    finalStep: 'open the doc and list the headings',
  })];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.shrinks.today, 2);
  assert.equal(r.shrinks.ladder.length, 1);
  assert.equal(r.shrinks.ladder[0].from, 'rewrite the escalation policy');
  assert.equal(r.shrinks.ladder[0].to, 'open the doc and list the headings');
});

test('a shrink with no named step is counted but has no ladder to show', () => {
  const history = [session({ id: 'a', shrinks: 1, originalText: 'big thing', finalStep: null })];
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.shrinks.today, 1);
  assert.equal(r.shrinks.ladder.length, 0, 'half a ladder is a number about a person');
});

test('the ladder is bounded', () => {
  const history = Array.from({ length: 10 }, (_, i) => session({
    id: `s${i}`, shrinks: 1, originalText: `from ${i}`, finalStep: `to ${i}`,
  }));
  const r = signals.assess({ history, anchor: NOW });
  assert.equal(r.shrinks.ladder.length, signals.MAX_LADDER);
  assert.equal(r.shrinks.today, 10, 'the count is not bounded by the display cap');
});

// ── Rule 6: the cap is declared ──────────────────────────────────────────────

test('a full history reports its counts as a floor', () => {
  const history = Array.from({ length: 50 }, (_, i) => session({ id: `s${i}`, startedAt: at(1) }));
  const r = signals.assess({ history, anchor: NOW, historyLimit: 50 });
  assert.equal(r.starts.complete, false);
  assert.match(r.starts.incompleteWhy, /floor/);
});

test('a short history is complete', () => {
  const r = signals.assess({ history: [session({ id: 'a' })], anchor: NOW, historyLimit: 50 });
  assert.equal(r.starts.complete, true);
  assert.equal(r.starts.incompleteWhy, null);
});

// ── Gaps ─────────────────────────────────────────────────────────────────────

test('an unreadable source is a named gap, never a confident zero', () => {
  const r = signals.assess({ history: [], gaps: [{ source: 'focus-session', why: 'db down' }], anchor: NOW });
  assert.equal(r.known, false);
  assert.equal(r.starts.today, 0);
  assert.equal(r.gaps[0].source, 'focus-session');
});

test('a genuinely empty day is known and empty', () => {
  const r = signals.assess({ history: [], anchor: NOW });
  assert.equal(r.known, true, 'nothing started is a real answer, not a failure to look');
  assert.equal(r.starts.today, 0);
});

// ── Triage: the act of deciding a task's shape ───────────────────────────────

const triageEvent = (over = {}) => ({
  at: at(0),
  taskId: 1,
  fields: ['due_date'],
  estimateWasSet: false,
  ...over,
});

test('triage is counted per task, never per field-write', () => {
  // Set a due date, clear it, set it again — one task triaged, not three.
  const triage = [
    triageEvent({ taskId: 7, fields: ['due_date'] }),
    triageEvent({ taskId: 7, fields: ['due_date'] }),
    triageEvent({ taskId: 7, fields: ['due_date'] }),
  ];
  const r = signals.assess({ triage, anchor: NOW });
  assert.equal(r.triage.today, 1, 'a count of writes is trivially gameable');
});

test('several fields decided at once is still one task triaged', () => {
  const triage = [triageEvent({ taskId: 3, fields: ['due_date', 'estimate_minutes', 'moscow'] })];
  const r = signals.assess({ triage, anchor: NOW });
  assert.equal(r.triage.today, 1);
  assert.equal(r.triage.byField.due_date, 1);
  assert.equal(r.triage.byField.moscow, 1);
});

test('a first estimate is counted separately from a re-estimate', () => {
  const triage = [
    triageEvent({ taskId: 1, fields: ['estimate_minutes'], estimateWasSet: false }),
    triageEvent({ taskId: 2, fields: ['estimate_minutes'], estimateWasSet: false }),
    triageEvent({ taskId: 3, fields: ['estimate_minutes'], estimateWasSet: true }),
  ];
  const r = signals.assess({ triage, anchor: NOW });
  assert.equal(r.triage.today, 3, 'a re-estimate is still real triage');
  assert.equal(r.triage.firstEstimatesToday, 2, 'only the ones the planner did not have');
});

test('a triage event with no task cannot be counted', () => {
  const r = signals.assess({ triage: [triageEvent({ taskId: null })], anchor: NOW });
  assert.equal(r.triage.today, 0, 'an invented key is not evidence');
});

test('the triage week is the calendar week', () => {
  const triage = [
    triageEvent({ taskId: 1, at: new Date('2026-08-28T09:00:00').toISOString() }), // week before
    triageEvent({ taskId: 2, at: at(1) }),
  ];
  const r = signals.assess({ triage, anchor: NOW });
  assert.equal(r.triage.week, 1);
});

test('an empty triage day is zero, and an unreadable source is a gap', () => {
  const clean = signals.assess({ triage: [], anchor: NOW });
  assert.equal(clean.triage.today, 0);
  assert.equal(clean.known, true);

  const broken = signals.assess({ triage: [], gaps: [{ source: 'task-triage', why: 'db down' }], anchor: NOW });
  assert.equal(broken.known, false);
});

// ── Close-out ────────────────────────────────────────────────────────────────

test('an assumed plan is never reported as a miss', () => {
  const out = signals.estimateCloseout({ plannedMinutes: 30, plannedAssumed: true, actualMinutes: 115 });
  assert.equal(out.kind, 'no-estimate');
  assert.equal(out.diffMinutes, null, 'there is no difference to state — the 30 was not his');
  assert.ok(!/over|under|miss/i.test(out.say), `must not grade an assumption: ${out.say}`);
});

test('a plan Nick set is compared, in both directions, without praise or reproach', () => {
  const under = signals.estimateCloseout({ plannedMinutes: 60, plannedAssumed: false, actualMinutes: 40 });
  const over = signals.estimateCloseout({ plannedMinutes: 30, plannedAssumed: false, actualMinutes: 75 });
  assert.equal(under.kind, 'under');
  assert.equal(under.diffMinutes, -20);
  assert.equal(over.kind, 'over');
  assert.equal(over.diffMinutes, 45);
  for (const out of [under, over]) {
    assert.ok(!/well done|great|failed|should have|too slow/i.test(out.say), `graded: ${out.say}`);
  }
});

test('landing within a few minutes is its own outcome', () => {
  const out = signals.estimateCloseout({ plannedMinutes: 60, plannedAssumed: false, actualMinutes: 62 });
  assert.equal(out.kind, 'close');
});

test('a sub-minute session is measured, not treated as unknown', () => {
  // Zero is a real duration and this surface exists to make small starts count.
  // Dropping the close-out here would silence it on exactly the shortest ones.
  const out = signals.estimateCloseout({ plannedMinutes: 25, plannedAssumed: false, actualMinutes: 0 });
  assert.ok(out, 'a measured zero must still produce a close-out');
  assert.equal(out.diffMinutes, -25);
  assert.match(out.say, /Under a minute/, '"0 min" reads as a bug rather than a fact');
});

test('an unreadable duration says nothing', () => {
  assert.equal(signals.estimateCloseout({ plannedMinutes: 60, plannedAssumed: false, actualMinutes: null }), null);
  assert.equal(signals.estimateCloseout({ plannedMinutes: 60, plannedAssumed: false }), null);
});

// ── Weeks ────────────────────────────────────────────────────────────────────

test('the week is the calendar week and resets on Monday', () => {
  const monday = new Date('2026-09-07T09:00:00'); // the Monday after NOW
  const history = [
    session({ id: 'a', startedAt: new Date('2026-09-04T09:00:00').toISOString() }), // last Friday
    session({ id: 'b', startedAt: new Date('2026-09-07T08:00:00').toISOString() }), // this Monday
  ];
  const r = signals.assess({ history, anchor: monday });
  assert.equal(r.starts.week, 1, 'Friday belongs to the week before');
});

test('weekStart handles Sunday without walking forward into a week that has not begun', () => {
  const sunday = new Date('2026-09-06T12:00:00');
  const ws = signals.weekStart(sunday);
  assert.equal(signals.dateKey(ws), '2026-08-31', 'Sunday belongs to the week that is ending');
});
