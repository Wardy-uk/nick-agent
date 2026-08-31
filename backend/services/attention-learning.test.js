'use strict';

/**
 * What SARA learns from whether her prompts helped.
 *
 * The load-bearing test is `unmeasurable is not ignored`. Everything else here
 * is arithmetic; that one is the difference between a system that learns and a
 * system that mutes the water prompt for the exact reason it is working.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-learn-')), 'a.db');

const db = require('../db/database');
const learning = require('./attention-learning');

test.before(async () => { await db.init(); });

const entries = (spec) => spec.map(outcome => ({ kind: 'low-water', at: '2026-08-01T10:00:00Z', outcome }));

// ── The rule the file turns on ───────────────────────────────────────────────

test('UNMEASURABLE is not ignored — it counts for nothing, in either direction', () => {
  // He gets a glass of water and does not log it. "Ignored" and "acted on and
  // never told me" are indistinguishable, so neither is claimed.
  const stats = learning.rate(entries(['unmeasurable', 'unmeasurable', 'unmeasurable', 'worked']));
  assert.equal(stats.judged, 1, 'only the one we could see counts as judged');
  assert.equal(stats.rate, 1, 'and the rate is over what was judged, not over what was sent');
  assert.equal(stats.unmeasured, 3);
});

test('nothing judged yet is a NULL rate, never zero', () => {
  // "Nothing judged" and "judged and never worked" are opposite facts about
  // whether SARA is allowed to have an opinion at all.
  const stats = learning.rate(entries(['pending', 'unmeasurable']));
  assert.equal(stats.rate, null);
  assert.equal(learning.shouldMute('low-water', stats).mute, false);
});

// ── Muting is conservative ───────────────────────────────────────────────────

test('a handful of failures is not enough to mute', () => {
  const stats = learning.rate(entries(['no-change', 'no-change', 'no-change']));
  const verdict = learning.shouldMute('sedentary', stats);
  assert.equal(verdict.mute, false);
  assert.match(verdict.why, /of 8 judged so far/);
});

test('a long run of making no difference DOES mute, and says the number', () => {
  const stats = learning.rate(entries(Array.from({ length: 10 }, () => 'no-change')));
  const verdict = learning.shouldMute('sedentary', stats);
  assert.equal(verdict.mute, true);
  // The number is read aloud in the EOD — a mute he cannot hear the reason for
  // is one he cannot sensibly overrule.
  assert.match(verdict.why, /0 of 10/);
});

test('a prompt that works even sometimes is kept', () => {
  // One time in three is still worth keeping: the times it works are the point,
  // and the cost of the others is one line on a lock screen.
  const stats = learning.rate(entries(['worked', 'no-change', 'no-change', 'worked', 'no-change',
    'no-change', 'worked', 'no-change', 'no-change', 'no-change']));
  assert.equal(learning.shouldMute('sedentary', stats).mute, false);
});

test('a health finding is NEVER muted on outcomes', () => {
  // "Your resting heart rate has been up for three days" is not a prompt with an
  // action attached. Scoring it on whether anything changed would mute the one
  // signal most worth interrupting for.
  const stats = learning.rate(entries(Array.from({ length: 40 }, () => 'no-change')));
  const verdict = learning.shouldMute('health-signal', stats);
  assert.equal(verdict.mute, false);
  assert.match(verdict.why, /never judged/);
});

test('an unknown kind is never muted on a guess', () => {
  const stats = learning.rate(entries(Array.from({ length: 40 }, () => 'no-change')));
  assert.equal(learning.shouldMute('something-new', stats).mute, false);
});

// ── The window ───────────────────────────────────────────────────────────────

test('each kind gets its own window — an hour for standing, two days for exercise', () => {
  const at = '2026-09-01T10:00:00.000Z';
  assert.equal(learning.outcomeWindow('sedentary', at), '2026-09-01T11:00:00.000Z');
  assert.equal(learning.outcomeWindow('no-exercise', at), '2026-09-03T10:00:00.000Z');
  assert.equal(learning.outcomeWindow('health-signal', at), null, 'nothing to wait for');
});

// ── State ────────────────────────────────────────────────────────────────────

test('a mute round-trips, and stops the push without hiding anything', () => {
  learning.mute('low-water', 'it never changed anything');
  assert.equal(learning.isMuted('low-water'), true);

  const listed = learning.mutedList();
  const water = listed.find(m => m.kind === 'low-water');
  assert.equal(water.why, 'it never changed anything');
  assert.equal(water.by, 'sara');
});

test('⚠ unmuting CLEARS THE HISTORY, or his instruction lasts one night', () => {
  // The sweep would otherwise re-mute it on the same evidence at the next pass.
  // An escape hatch that does not let you out is not one — task-blocks.release()'s
  // rule.
  db.setState('attention_learning', JSON.stringify({
    deliveries: Array.from({ length: 20 }, () => ({ kind: 'sedentary', at: '2026-08-01T10:00:00Z', outcome: 'no-change' })),
    muted: { sedentary: { why: 'never worked', at: '2026-08-30T18:00:00Z', by: 'sara' } },
  }));

  assert.equal(learning.isMuted('sedentary'), true);
  assert.equal(learning.unmute('sedentary').ok, true);
  assert.equal(learning.isMuted('sedentary'), false);

  // The evidence is gone too, so the next sweep starts from nothing.
  const after = learning.sweep(new Date('2026-09-01T12:00:00Z'));
  assert.equal(after.muted.length, 0, 'it must not be re-muted on the evidence he just overruled');
  assert.equal(learning.isMuted('sedentary'), false);
});

test('unmuting something that was not muted says so', () => {
  assert.equal(learning.unmute('never-touched').ok, false);
});

test('the sweep leaves a delivery alone until its window has closed', () => {
  db.setState('attention_learning', JSON.stringify({
    deliveries: [{
      kind: 'sedentary',
      at: '2026-09-01T10:00:00.000Z',
      outcome: 'pending',
      judgeAfter: '2026-09-01T11:00:00.000Z',
    }],
    muted: {},
  }));

  const early = learning.sweep(new Date('2026-09-01T10:30:00Z'));
  assert.equal(early.judged, 0, 'the hour is not up');

  const later = learning.sweep(new Date('2026-09-01T12:00:00Z'));
  assert.equal(later.judged, 1);
});

test('a delivery it cannot judge is recorded as unmeasurable, never as failure', () => {
  // A reading we could not take must not count against the prompt.
  db.setState('attention_learning', JSON.stringify({
    deliveries: [{
      kind: 'health-signal',
      at: '2026-09-01T10:00:00.000Z',
      outcome: 'pending',
      judgeAfter: '2026-09-01T11:00:00.000Z',
    }],
    muted: {},
  }));
  learning.sweep(new Date('2026-09-01T12:00:00Z'));
  const summary = learning.summary().find(s => s.kind === 'health-signal');
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.judged, 0);
});
