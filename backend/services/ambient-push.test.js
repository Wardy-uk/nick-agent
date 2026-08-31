'use strict';

/**
 * When an ambient observation is worth interrupting for.
 *
 * The correction this file exists to hold: whether something is worth saying is
 * a property of the MOMENT, not of the signal. I had said water should never
 * push; Nick's answer was *"if I'm sat in the office and haven't recorded a
 * drink in hours, that should be called out — if I'm in a meeting, or hiking,
 * then not."*
 *
 * So the tests are moments, and most of them are moments where SARA should say
 * nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const push = require('./ambient-push');

const NOW = new Date('2026-09-01T14:00:00');

/** A confident read of a working afternoon at a desk. */
const atDesk = (over = {}) => push.momentFrom({
  context: {
    activity: 'steady',
    quiet: false,
    duty: { onDuty: true, known: true },
    confidence: { level: 'high' },
    ...(over.context || {}),
  },
  phone: { activity: 'Still', focusMode: false, ...(over.phone || {}) },
  desktop: { known: true, app: 'Code', label: 'VS Code', ...(over.desktop || {}) },
  now: over.now || NOW,
});

const WATER = { kind: 'low-water', text: 'No water logged today.', suggestion: 'Have a glass.' };
const SEDENTARY = { kind: 'sedentary', text: "You've been sitting for 2 hours.", suggestion: 'Worth standing up.' };
const HEALTH = { kind: 'health-signal', text: 'Resting heart rate up for 3 days', detail: '82bpm.', caveat: 'Could be many things.' };

// ── Nick's own example, both halves ──────────────────────────────────────────

test('at a desk with no drink logged — SAY IT', () => {
  const v = push.worthInterrupting(WATER, atDesk());
  assert.equal(v.push, true);
  assert.match(v.message.body, /drink/i);
});

test('in a meeting — say nothing', () => {
  const v = push.worthInterrupting(WATER, atDesk({ context: { activity: 'in-meeting', quiet: true } }));
  assert.equal(v.push, false);
  assert.equal(v.why, 'in a meeting');
});

test('hiking — say nothing, and WITHOUT needing to know what hiking is', () => {
  // The test of the design. There is no hiking rule anywhere: he is walking, so
  // `atDesk` is false and the phone is not on a desk. A moment described
  // honestly out of the signals SARA already has needs no list of activities.
  const hiking = push.momentFrom({
    context: { activity: 'steady', duty: { onDuty: false }, confidence: { level: 'high' } },
    phone: { activity: 'Walking', focusMode: false },
    desktop: { known: false },
    now: NOW,
  });
  const v = push.worthInterrupting(WATER, hiking);
  assert.equal(v.push, false);
  assert.match(v.why, /not the moment/);
});

// ── The universal vetoes ─────────────────────────────────────────────────────

test('an unconfident read NEVER pushes', () => {
  // Every other part of the system may act on a low-confidence read, because the
  // cost is a slightly wrong screen. Here the cost is his phone going off in a
  // room where it should not.
  const v = push.worthInterrupting(HEALTH, atDesk({ context: { confidence: { level: 'low' } } }));
  assert.equal(v.push, false);
  assert.match(v.why, /not confident enough/);
});

test('Focus mode beats everything, including a health finding', () => {
  const v = push.worthInterrupting(HEALTH, atDesk({ phone: { activity: 'Still', focusMode: true } }));
  assert.equal(v.push, false);
  assert.equal(v.why, 'Focus mode is on');
});

test('driving is never the moment', () => {
  const v = push.worthInterrupting(SEDENTARY, atDesk({ phone: { activity: 'Automotive' } }));
  assert.equal(v.push, false);
  assert.equal(v.why, 'driving');
});

test('a focus session is protected from everything except his body', () => {
  const inSession = atDesk({ context: { activity: 'in-focus-session' } });
  assert.equal(push.worthInterrupting(WATER, inSession).push, false);
  assert.equal(push.worthInterrupting(SEDENTARY, inSession).push, false);
  // A health finding still gets through — it is the one thing a focus session is
  // not more important than.
  assert.equal(push.worthInterrupting(HEALTH, inSession).push, true);
});

test('the brain calling it quiet is HONOURED, not re-derived', () => {
  // A second opinion about the same question is what state/inference.js was
  // retired for.
  const v = push.worthInterrupting(WATER, atDesk({ context: { quiet: true } }));
  assert.equal(v.push, false);
  assert.match(v.why, /quiet moment/);
});

// ── Per-kind judgement ───────────────────────────────────────────────────────

test('"you have not exercised in 3 days" is not delivered mid-morning', () => {
  // A prompt he can do nothing about right now is the fastest way to teach him
  // to ignore the channel.
  const morning = atDesk({ now: new Date('2026-09-01T10:30:00') });
  const v = push.worthInterrupting({ kind: 'no-exercise', text: 'No real exercise for 3 days.' }, morning);
  assert.equal(v.push, false);

  const evening = atDesk({ now: new Date('2026-09-01T18:30:00') });
  assert.equal(push.worthInterrupting({ kind: 'no-exercise', text: 'x' }, evening).push, true);
});

test('sitting is only worth saying if he is still there to hear it', () => {
  const away = push.momentFrom({
    context: { activity: 'steady', confidence: { level: 'high' }, duty: { onDuty: true } },
    phone: { activity: 'Walking' },
    desktop: { known: true, app: null, why: 'idle' },
    now: NOW,
  });
  assert.equal(push.worthInterrupting(SEDENTARY, away).push, false);
});

test('a health finding carries its CAVEAT onto the lock screen', () => {
  // Dropping it turns a reading into a diagnosis, on a lock screen, where there
  // is no room to go and check.
  const v = push.worthInterrupting(HEALTH, atDesk());
  assert.match(v.message.body, /Could be many things/);
});

test('an unknown observation kind is not pushed on a guess', () => {
  const v = push.worthInterrupting({ kind: 'something-new', text: 'x' }, atDesk());
  assert.equal(v.push, false);
  assert.match(v.why, /no push rule/);
});

test('every refusal gives a REASON', () => {
  // A channel that silently decides not to speak is indistinguishable from a
  // broken one, and that ambiguity is what NEURO Health exists to remove.
  const moments = [
    atDesk({ context: { activity: 'in-meeting' } }),
    atDesk({ phone: { activity: 'Still', focusMode: true } }),
    atDesk({ context: { confidence: { level: 'low' } } }),
  ];
  for (const m of moments) {
    const v = push.worthInterrupting(WATER, m);
    assert.equal(v.push, false);
    assert.ok(v.why && v.why.length > 3, 'a refusal without a reason is not reviewable');
  }
});

// ── The moment itself ────────────────────────────────────────────────────────

test('the laptop is a stronger desk signal than a motionless phone', () => {
  const m = push.momentFrom({
    context: { confidence: { level: 'high' } },
    phone: { activity: 'Walking' },     // phone in his pocket, moving
    desktop: { known: true, app: 'Code' },
    now: NOW,
  });
  assert.equal(m.atLaptop, true);
  assert.equal(m.atDesk, true, 'the machine he is typing on wins over the phone in his pocket');
});

test('nothing readable means not confident, and therefore silent', () => {
  const blind = push.momentFrom({});
  assert.equal(blind.known, false);
  assert.equal(push.worthInterrupting(WATER, blind).push, false);
});
