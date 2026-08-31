'use strict';

/**
 * Friction — the rules about what may and may not be said.
 *
 * `assess()` is pure, so what is under test here IS the product: which facts
 * earn a sentence, what that sentence is allowed to claim, and — the important
 * half — what NEURO refuses to infer. A wrong number on this surface is a
 * nuisance; a wrong claim about how someone works is the thing that gets a
 * feature switched off and never switched back on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const friction = require('./friction');

const NOW = new Date('2026-08-30T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();

// Language this surface must never produce. Each one is either a claim about
// Nick rather than about the work, or a number that only goes one way.
const FORBIDDEN = [
  /avoid/i,
  /procrastin/i,
  /streak/i,
  /you failed/i,
  /you should have/i,
  /discipline/i,
  /lazy/i,
  /score/i,
];

function assertNeutral(result) {
  for (const insight of result.insights) {
    const text = `${insight.text} ${insight.because}`;
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(text), `wording matched ${pattern}: "${text}"`);
    }
    // Every insight must be able to show its working.
    assert.ok(insight.because, 'an insight with no stated basis is an assertion');
    assert.ok(Array.isArray(insight.evidence), 'every insight carries its evidence');
  }
}

test('no evidence means no insight — and no consolation line in its place', () => {
  const result = friction.assess({ defers: [], history: [], waiting: [], session: null }, NOW);
  assert.deepEqual(result.insights, []);
  assert.equal(result.evidenceCount, 0);
});

test('an insight Nick has noted stops being said — until the evidence grows', () => {
  const shrunk = (count) => ({
    history: [{ text: 'GATE3 VERIFY', originalText: 'GATE3 VERIFY', shrinks: count, endedAt: ago(1) }],
  });

  const first = friction.assess(shrunk(2), NOW);
  assert.equal(first.insights.length, 1);
  const { id, signature } = first.insights[0];
  assert.ok(id, 'an insight with no id cannot be answered, which is the bug');

  // Noted at that signature: not repeated, and the surface is told it was held
  // back rather than the section quietly shrinking.
  const noted = friction.assess({ ...shrunk(2), dismissed: { [id]: signature } }, NOW);
  assert.deepEqual(noted.insights, []);
  assert.equal(noted.noted, 1);

  // ⚠ The load-bearing half. A THIRD shrink is a stronger statement than the
  // one he took on board, so it is made again — a permanent hide would silence
  // a pattern precisely as it got worse.
  const worse = friction.assess({ ...shrunk(3), dismissed: { [id]: signature } }, NOW);
  assert.equal(worse.insights.length, 1);
  assert.equal(worse.noted, 0);
  assert.equal(worse.insights[0].id, id, 'the identity is stable across the evidence changing');
  assert.notEqual(worse.insights[0].signature, signature);
});

test('a dismissal for one insight never silences another', () => {
  const result = friction.assess({
    history: [{ text: 'GATE3 VERIFY', originalText: 'GATE3 VERIFY', shrinks: 2, endedAt: ago(1) }],
    defers: [
      { dedupeKey: 'todo:risk-assessment', title: 'Risk assessment', reason: 'no-context', at: ago(1) },
      { dedupeKey: 'todo:risk-assessment', title: 'Risk assessment', reason: 'no-context', at: ago(3) },
    ],
    dismissed: { 'shrunk:gate3-verify': '2' },
  }, NOW);
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].kind, 'deferred');
});

test('one deferral is a Tuesday, not a pattern', () => {
  const result = friction.assess({
    defers: [{ dedupeKey: 'todo:risk-assessment', title: 'Risk assessment', reason: 'no-context', at: ago(1) }],
  }, NOW);
  assert.equal(result.insights.length, 0);
});

test('repeated deferrals name the reason, and only when it dominates', () => {
  const result = friction.assess({
    defers: [
      { dedupeKey: 'todo:risk-assessment', title: 'Risk assessment', reason: 'no-context', at: ago(1) },
      { dedupeKey: 'todo:risk-assessment', title: 'Risk assessment', reason: 'no-context', at: ago(3) },
    ],
  }, NOW);
  assert.equal(result.insights.length, 1);
  assert.match(result.insights[0].text, /put off twice because it needs context/);
  assert.equal(result.insights[0].evidence.length, 2);
  assertNeutral(result);
});

test('deferrals older than the window are history, not friction', () => {
  const result = friction.assess({
    defers: [
      { dedupeKey: 'todo:old', title: 'Old thing', reason: 'not-now', at: ago(40) },
      { dedupeKey: 'todo:old', title: 'Old thing', reason: 'not-now', at: ago(35) },
    ],
  }, NOW);
  assert.equal(result.insights.length, 0);
});

test('a task made smaller repeatedly is a finding about the WORK', () => {
  const result = friction.assess({
    session: {
      text: 'open the doc', originalText: 'Rewrite the onboarding pack',
      shrinks: 3, status: 'active', startedAt: ago(0),
    },
  }, NOW);
  const shrunk = result.insights.find((i) => i.kind === 'shrunk');
  assert.ok(shrunk);
  assert.match(shrunk.text, /different shape/);
  // Never phrased or counted as failure.
  assert.ok(!/fail|again and again|still/i.test(shrunk.text));
  assertNeutral(result);
});

test('being parked as too big is its own state, with the way back in', () => {
  const result = friction.assess({
    session: { text: 'Rewrite the onboarding pack', status: 'needs-smaller', shrinks: 1, startedAt: ago(0) },
  }, NOW);
  const stuck = result.insights.find((i) => i.kind === 'needs-smaller');
  assert.ok(stuck);
  assert.match(stuck.text, /smallest next bit/);
});

test('a missed check-in creates NOTHING — being heads-down is why one gets skipped', () => {
  const withCheckIns = friction.assess({
    session: { text: 'Deep work', status: 'active', shrinks: 0, checkIns: 4, minutesSinceCheckIn: 5, startedAt: ago(0) },
  }, NOW);
  const withoutCheckIns = friction.assess({
    session: { text: 'Deep work', status: 'active', shrinks: 0, checkIns: 0, minutesSinceCheckIn: 240, dueCheckIn: true, startedAt: ago(0) },
  }, NOW);
  // Four hours with no check-in must read exactly the same as four check-ins.
  assert.deepEqual(withoutCheckIns.insights, withCheckIns.insights);
  assert.equal(withoutCheckIns.insights.length, 0);
});

test('only step-aways Nick RECORDED count — arrivals are not evidence he switched', () => {
  // `interruptions` also holds pauses and things that merely landed. Reading it
  // here would build a claim about his attention out of other people's timing.
  const arrivalsOnly = friction.assess({
    session: { text: 'Deep work', status: 'active', shrinks: 0, interruptions: 6, steppedAway: 0, startedAt: ago(0) },
  }, NOW);
  assert.equal(arrivalsOnly.insights.length, 0);

  const saidSo = friction.assess({
    session: { text: 'Deep work', status: 'interrupted', shrinks: 0, interruptions: 6, steppedAway: 2, startedAt: ago(0) },
  }, NOW);
  const pulled = saidSo.insights.find((i) => i.kind === 'stepped-away');
  assert.ok(pulled);
  assert.match(pulled.text, /pulled away/);
  assertNeutral(saidSo);
});

test('what someone ELSE owes Nick is never friction, however well evidenced', () => {
  // Removed 31 Aug 2026. This used to produce an insight when the row carried a
  // source note, and on the live Now page that meant FOUR "Naomi to ..." lines
  // under a heading reading "Friction noticed" — 316 open rows feeding a
  // five-slot list, two of them 123 days old.
  //
  // The bar is not attribution, it is WHOSE ACT the evidence records. A
  // waiting_on row evidences that somebody said they would do something; nothing
  // anywhere records that Nick is blocked on it. So the whole signal goes, at any
  // age and with any amount of provenance — which is what these three assertions
  // pin, because "fixed" here would otherwise mean "raised the threshold".
  const ungrounded = friction.assess({
    waiting: [{ status: 'open', person: 'Naomi', text: 'the risk assessment', askedAt: ago(30), sourcePath: null }],
  }, NOW);
  assert.equal(ungrounded.insights.length, 0);

  const grounded = friction.assess({
    waiting: [{ status: 'open', person: 'Naomi', text: 'the risk assessment', askedAt: ago(30), sourcePath: 'Meetings/2026/07/1-2-1.md', sourceDate: ago(30) }],
  }, NOW);
  assert.equal(grounded.insights.length, 0, 'a sourced row is still not a claim about what got in Nick\'s way');

  const ancient = friction.assess({
    waiting: [{ status: 'open', person: 'Naomi', text: 'the Confluence article', askedAt: ago(123), sourcePath: 'Meetings/2026/04/1-2-1.md' }],
  }, NOW);
  assert.equal(ancient.insights.length, 0, 'and age never converts one into friction');

  // Nor may a colleague's name reach the section by any route at all.
  for (const r of [ungrounded, grounded, ancient]) {
    assert.equal(r.sources.waiting, undefined, 'waiting is no longer even counted as a source');
    assert.ok(!JSON.stringify(r).includes('Naomi'));
  }
});

test('but Nick saying HE is blocked still counts — it is his own recorded act', () => {
  // The distinction the removal above rests on. `waiting-on-someone` is a defer
  // reason Nick chose, so it is evidence about his work; the waiting_on row is
  // evidence about someone else's.
  const result = friction.assess({
    defers: [
      { dedupeKey: 'todo:risk', title: 'Sign off the risk assessment', reason: 'waiting-on-someone', at: ago(3) },
      { dedupeKey: 'todo:risk', title: 'Sign off the risk assessment', reason: 'waiting-on-someone', at: ago(9) },
    ],
  }, NOW);
  assert.equal(result.insights.length, 1);
  assert.match(result.insights[0].text, /waiting on someone/);
});

test('the list is bounded, most-supported first', () => {
  const defers = [];
  for (let i = 0; i < 10; i += 1) {
    defers.push({ dedupeKey: `todo:${i}`, title: `Thing ${i}`, reason: 'not-now', at: ago(1) });
    defers.push({ dedupeKey: `todo:${i}`, title: `Thing ${i}`, reason: 'not-now', at: ago(2) });
  }
  // One with more behind it than any other.
  defers.push({ dedupeKey: 'todo:0', title: 'Thing 0', reason: 'not-now', at: ago(3) });

  const result = friction.assess({ defers }, NOW);
  assert.equal(result.insights.length, friction.MAX_INSIGHTS);
  assert.match(result.insights[0].text, /Thing 0/);
});

test('build() names a source it could not read rather than reporting a clear week', () => {
  const result = friction.build(new Date());
  assert.ok(Array.isArray(result.insights));
  assert.ok(Array.isArray(result.gaps));
  // `complete` is what keeps "nothing in your way" apart from "I could not look".
  assert.equal(result.complete, result.gaps.length === 0);
});
