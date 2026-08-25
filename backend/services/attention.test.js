'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { gate, SECONDARY_MAX } = require('./attention');
const { ACTIVITY } = require('./context-state');

// A context of the shape resolveContext returns. Confidence is stated per-test
// because it decides whether the gate is allowed to hide anything.
function ctx(activity, over = {}) {
  return {
    activity,
    label: 'Label',
    summary: 'Summary.',
    quiet: activity === ACTIVITY.IN_MEETING || activity === ACTIVITY.OFF,
    confidence: { score: 0.8, level: 'high', basis: [], rationale: '' },
    reasons: [],
    contradictions: [],
    unknowns: [],
    ...over,
  };
}

function item(over = {}) {
  return {
    id: 'item-1', type: 'todo', title: 'Do the thing', reason: 'Overdue',
    score: 60, tier: 2, urgency: 'medium', meta: {}, ...over,
  };
}

const ESCALATION = item({ id: 'escalations-unseen', type: 'escalation', title: 'NT-1 — broken', tier: 1, score: 95, _unsuppressable: true });
const STANDUP = item({ id: 'nudge-1', type: 'nudge', title: 'Standup', tier: 1, score: 93, meta: { type: 'standup' } });
const MEETING = item({ id: 'meeting-1', type: 'meeting', title: '1-2-1 with Hope', tier: 1, score: 88 });

// ── Silence is a correct answer ──────────────────────────────────────────────

test('in a meeting: nothing is surfaced and nothing is spoken', () => {
  const g = gate(ctx(ACTIVITY.IN_MEETING), [ESCALATION, item()]);
  assert.equal(g.primary.kind, 'context');
  assert.deepEqual(g.secondary, []);
  assert.equal(g.speech, null);
  assert.equal(g.quiet, true);
  assert.equal(g.dropped.length, 2, 'everything is held, and named');
});

test('nothing is ever dropped silently', () => {
  const g = gate(ctx(ACTIVITY.IN_MEETING), [ESCALATION]);
  assert.equal(g.dropped[0].id, 'escalations-unseen');
  assert.ok(g.dropped[0].why);
});

test('an empty pool on a calm day is a null primary, not an invented card', () => {
  const g = gate(ctx(ACTIVITY.STEADY), []);
  assert.equal(g.primary, null);
  assert.equal(g.speech, null);
});

test('a context card is never spoken aloud', () => {
  // "You're in a focus session" said to someone in a focus session is pure
  // interruption. Only a real candidate earns speech.
  const g = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), []);
  assert.equal(g.primary.kind, 'context');
  assert.equal(g.speech, null);
});

// ── Confidence decides how much may be HIDDEN ────────────────────────────────

test('a low-confidence read may re-order but must never hide work', () => {
  const low = ctx(ACTIVITY.IN_FOCUS_SESSION, { confidence: { level: 'low', score: 0.3 } });
  const g = gate(low, [item({ id: 'a', tier: 2 }), item({ id: 'b', tier: 3 })]);
  assert.equal(g.dropped.length, 0, 'a bad read must not remove anything');
  assert.match(g.rationale, /nothing was hidden/);

  const high = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), [item({ id: 'a', tier: 2 }), item({ id: 'b', tier: 3 })]);
  assert.equal(high.dropped.length, 2, 'a confident read may protect the session');
});

test('quiet still applies at low confidence — silence fails safe', () => {
  const low = ctx(ACTIVITY.IN_MEETING, { confidence: { level: 'low', score: 0.3 } });
  const g = gate(low, [ESCALATION]);
  assert.equal(g.quiet, true);
  assert.equal(g.speech, null);
  assert.equal(g.dropped.length, 0, 'but nothing is hidden on a read we do not trust');
});

test('an unreadable context filters nothing at all', () => {
  const g = gate(ctx(ACTIVITY.UNKNOWN, { confidence: { level: 'low', score: 0.2 } }), [item({ id: 'a', tier: 3 })]);
  assert.equal(g.dropped.length, 0);
  assert.equal(g.primary.id, 'a');
  assert.match(g.rationale, /must not hide work/);
});

// ── Re-ranking, never adding ─────────────────────────────────────────────────

test('context re-ranks the pool — it never invents a candidate', () => {
  const g = gate(ctx(ACTIVITY.FIREFIGHTING), [item({ id: 'todo-a' }), ESCALATION]);
  assert.equal(g.primary.kind, 'item');
  assert.equal(g.primary.id, 'escalations-unseen', 'the queue leads, though the todo was first in');
  assert.equal(g.secondary[0].id, 'todo-a', 'the rest stays, in order');
});

test('a context primary is used only when the pool has no matching candidate', () => {
  const withItem = gate(ctx(ACTIVITY.PRE_MEETING), [MEETING, item()]);
  assert.equal(withItem.primary.kind, 'item');
  assert.equal(withItem.primary.id, 'meeting-1');

  const withoutItem = gate(ctx(ACTIVITY.PRE_MEETING), [item()]);
  assert.equal(withoutItem.primary.kind, 'context');
  assert.equal(withoutItem.secondary[0].id, 'item-1', 'the pool is untouched by the fallback');
});

test('a ritual leads only when its own nudge is in the pool', () => {
  const g = gate(ctx(ACTIVITY.RITUAL), [item({ id: 'other' }), STANDUP]);
  assert.equal(g.primary.id, 'nudge-1');

  const eod = gate(ctx(ACTIVITY.RITUAL), [item({ id: 'nudge-9', type: 'nudge', meta: { type: 'journal' } })]);
  assert.equal(eod.primary.kind, 'context', 'a journal nudge is not the ritual that is due');
});

test('a focus session lets a tier-1 interruption through and holds the rest', () => {
  const g = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), [item({ id: 'b', tier: 2 }), ESCALATION]);
  assert.equal(g.primary.id, 'escalations-unseen');
  assert.deepEqual(g.dropped.map((d) => d.id), ['b']);
});

test('a non-working day keeps only what the engine marked unsuppressable', () => {
  const g = gate(ctx(ACTIVITY.OFF), [item({ id: 'todo-a' }), ESCALATION]);
  assert.equal(g.primary.id, 'escalations-unseen');
  assert.deepEqual(g.dropped.map((d) => d.id), ['todo-a']);
  assert.equal(g.speech, null, 'a day off is not spoken into');
});

test('away leaves the ranking alone — it is a reason not to speak, not to demote', () => {
  const items = [item({ id: 'a', score: 70 }), item({ id: 'b', score: 60 })];
  const away = gate(ctx(ACTIVITY.AWAY, { quiet: false }), items);
  const steady = gate(ctx(ACTIVITY.STEADY), items);
  assert.equal(away.primary.id, steady.primary.id);
  assert.deepEqual(away.secondary.map((s) => s.id), steady.secondary.map((s) => s.id));
  assert.equal(away.dropped.length, 0);
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('secondary is capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ id: `i${i}` }));
  const g = gate(ctx(ACTIVITY.STEADY), many);
  assert.equal(g.secondary.length, SECONDARY_MAX);
});

test('item and context cards are distinguishable by kind', () => {
  assert.equal(gate(ctx(ACTIVITY.STEADY), [item()]).primary.kind, 'item');
  assert.equal(gate(ctx(ACTIVITY.IN_MEETING), []).primary.kind, 'context');
});

test('speech reads as one sentence and never doubles its full stop', () => {
  const g = gate(ctx(ACTIVITY.STEADY), [item({ title: 'Do the thing', reason: 'Overdue' })]);
  assert.equal(g.speech, 'Do the thing. Overdue.');
  const noReason = gate(ctx(ACTIVITY.STEADY), [item({ reason: null })]);
  assert.equal(noReason.speech, 'Do the thing.');
});

test('pure: a garbage context degrades to no filtering rather than throwing', () => {
  const g = gate(null, [item()]);
  assert.equal(g.dropped.length, 0);
  assert.equal(g.primary.id, 'item-1');
});

test('pure: the pool is not mutated', () => {
  const items = [item({ id: 'a' }), ESCALATION];
  const before = JSON.stringify(items);
  gate(ctx(ACTIVITY.FIREFIGHTING), items);
  assert.equal(JSON.stringify(items), before);
});
