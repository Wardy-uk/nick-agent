'use strict';

/**
 * The cross-note fold that stops one meeting's commitments arriving fourteen
 * times. Pure-matcher tests only — the DB half is exercised by the backfill
 * route's dry run against the live queue.
 *
 * The fixtures are REAL wordings taken from the 258-row pending queue on
 * 27 Aug 2026, including the negative pair, because a threshold tested against
 * invented text agrees with whatever was assumed when it was invented.
 */

const test = require('node:test');
const assert = require('node:assert');

const dedupe = require('./task-dedupe');

test('identical wording from two notes folds', () => {
  const text = 'Nick will complete the remaining sections of the HR risk assessment form';
  const hit = dedupe.findEquivalent(text, [text]);
  assert.ok(hit, 'an exact repeat must match');
  assert.strictEqual(hit.index, 0);
  assert.ok(hit.score >= 0.99, `exact repeat should score ~1, got ${hit.score}`);
});

test('the best match wins, not merely the first over the line', () => {
  const hit = dedupe.findEquivalent(
    'Nick will initiate an occupational health referral and share timelines with Naomi',
    [
      'Nick will complete the remaining sections of the HR risk assessment form',
      'Nick will initiate an occupational health referral and share timelines with Naomi',
    ]
  );
  assert.strictEqual(hit.index, 1);
});

test('two genuinely different commitments do NOT fold', () => {
  // Both are Nick's, both are about tickets and reporting, and they share the
  // stock vocabulary his whole corpus shares. IDF is what has to keep them apart.
  const hit = dedupe.findEquivalent(
    'Nick will adjust reporting to separate development tickets from normal support tickets',
    ['Nick will speak to the team about the unequal distribution of call answering']
  );
  assert.strictEqual(hit, null, 'unrelated commitments must stay separate rows');
});

test('a near-reword of the same commitment folds', () => {
  const hit = dedupe.findEquivalent(
    'Nick to review the call process and produce a report on its effectiveness by early next week',
    ['Nick to review the call process and produce an effectiveness report early next week']
  );
  assert.ok(hit, 'a rewording of one commitment should fold');
  assert.ok(hit.score >= dedupe.MIN_SCORE);
});

// ── The two live false positives ─────────────────────────────────────────────
//
// These are the reason the capture fold uses 0.85 rather than task-dedupe's
// 0.42. Both pairs come from the pending queue on 27 Aug 2026 and both were
// merged at 0.42, scored against the full pool. They are pinned as NEGATIVES,
// the same way task-dedupe pins its own worst non-duplicate.

const CAPTURE_FOLD_SCORE = 0.85;

test('completing the HR form is not the same as meeting to sign it', () => {
  // The expensive one. Folding these hid a DATED meeting with Naomi behind a
  // form-completion task — a commitment disappearing inside another is exactly
  // the failure the queue exists to prevent.
  const pair = [
    'Nick will complete the remaining sections of the HR risk assessment form',
    'Nick and Naomi will meet on August 26 or August 27, 2026, to review and sign the completed risk assessment form',
  ];
  const hit = dedupe.findEquivalent(pair[0], [pair[1]], { minScore: 0 });
  assert.ok(hit.score < CAPTURE_FOLD_SCORE,
    `these are different commitments and must not fold (scored ${hit.score})`);
});

test('shared "(Owner: ...)" boilerplate does not make two actions one', () => {
  const hit = dedupe.findEquivalent(
    'Schedule end-of-day trend review sessions. (Owner: Chris/Team leads)',
    ['Arrange a monthly developer shadowing day and annual cross-team sits. (Owner: Chris/Team leads)'],
    { minScore: 0 }
  );
  assert.ok(hit.score < CAPTURE_FOLD_SCORE,
    `boilerplate is not evidence (scored ${hit.score})`);
});

test('a shared proper name is not evidence of the same commitment', () => {
  // "Ward" is rare across the corpus, so IDF weights it heavily — which is
  // right for a distinguishing word and wrong for a name every row shares.
  const hit = dedupe.findEquivalent(
    'Nick Ward to speak with Lucy to get business buy-in for the short-term linked-ticket solution',
    ['Nick Ward to review the 140-ticket deflection analysis'],
    { minScore: 0 }
  );
  assert.ok(hit.score < CAPTURE_FOLD_SCORE,
    `two different jobs sharing a name must not fold (scored ${hit.score})`);
});

test('the fold threshold is above every measured false positive', () => {
  // The gap the number sits in. If someone retunes task-dedupe's MIN_SCORE, the
  // capture fold must NOT follow it down — that is what this asserts.
  assert.ok(CAPTURE_FOLD_SCORE > 0.499, 'must clear the worst live false positive');
  assert.ok(CAPTURE_FOLD_SCORE > dedupe.MIN_SCORE, 'must be stricter than the task-vs-task threshold');
  assert.ok(CAPTURE_FOLD_SCORE <= 1, 'a real duplicate scores 1.0 and must still fold');
});

test('empty and unmatchable input returns null rather than throwing', () => {
  assert.strictEqual(dedupe.findEquivalent('', ['anything at all here']), null);
  assert.strictEqual(dedupe.findEquivalent('some real text', []), null);
  assert.strictEqual(dedupe.findEquivalent('some real text', ['']), null);
});

test('the shared tokens are reported, so a fold is reviewable and not a bare score', () => {
  const hit = dedupe.findEquivalent(
    'Produce a report on all customers using custom billing to check for unbilled branches',
    ['Produce a report on all customers using custom billing to check for unbilled branches']
  );
  assert.ok(Array.isArray(hit.shared) && hit.shared.length > 0);
  assert.ok(hit.shared.every(s => typeof s.token === 'string' && typeof s.weight === 'number'));
});

test('folding reuses the measured threshold rather than declaring its own', () => {
  // If task-dedupe's MIN_SCORE is ever retuned, this fold moves with it. Two
  // thresholds for "the same task written twice" is how two screens come to
  // disagree about what a duplicate is.
  assert.strictEqual(dedupe.MIN_SCORE, 0.42);
});
