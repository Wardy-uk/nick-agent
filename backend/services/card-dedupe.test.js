'use strict';

/**
 * One commitment, one line on the People card (fix a).
 *
 * The card deduped by NOVA id and the task store dedupes by normalised text, so
 * two NOVA sessions producing the same commitment wrote two lines while Nick's
 * task list folded them into one. The fixture below is Maria Pappa's real card:
 * `nova:17` and `nova:7`, byte-identical, same due date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { existingCommitmentKeys } = require('./nova-121-writeback');
const { dedupeKey } = require('./task-store');
const { plan } = require('../scripts/dedupe-people-card-actions');

const DUP = 'Work with the rest of customer care to identify what the twelve customer-facing knowledge base articles should be';

/** Maria Pappa's card, verbatim from the live vault. */
const CARD = [
  '- [ ] Work with the rest of customer care to identify what the twelve customer-facing knowledge base articles should be 👤 [[People/Maria Pappa|Maria Pappa]] 📅 2026-08-21 <!-- nova:17 -->',
  '- [ ] Produce a plan on who\'s going to do what when for the twelve knowledge base articles 👤 [[People/Maria Pappa|Maria Pappa]] 📅 2026-08-21 <!-- nova:18 -->',
  '- [ ] Start making personal notes again to fill knowledge gaps, categorizing notes as needed 👤 [[People/Maria Pappa|Maria Pappa]] <!-- nova:4 -->',
  '- [ ] Work with the rest of customer care to identify what the twelve customer-facing knowledge base articles should be 👤 [[People/Maria Pappa|Maria Pappa]] 📅 2026-08-21 <!-- nova:7 -->',
].join('\n');

// ---------------------------------------------------------------------------
// The writer will not do it again
// ---------------------------------------------------------------------------

test('a commitment already on the card is recognised under a different NOVA id', () => {
  const keys = existingCommitmentKeys(CARD);
  assert.equal(keys.has(dedupeKey(DUP)), true,
    'nova:7 arriving fresh must be seen as already present');
});

test('the key ignores the owner link, the date and the id comment', () => {
  // Otherwise every line is unique by construction and nothing ever dedupes.
  const a = existingCommitmentKeys('- [ ] Do the thing 👤 [[People/A|A]] 📅 2026-08-21 <!-- nova:1 -->');
  const b = existingCommitmentKeys('- [ ] Do the thing 👤 [[People/B|B]] <!-- nova:99 -->');
  assert.deepEqual([...a], [...b]);
});

test('genuinely different commitments are not folded', () => {
  const keys = existingCommitmentKeys(CARD);
  assert.equal(keys.size, 3, 'three distinct commitments across four lines');
});

test('the card keys the same way the task store does', () => {
  // One rule, not two — which is the whole fix. If these ever disagree the card
  // and the task list are back to two different ideas of "the same thing".
  const [key] = [...existingCommitmentKeys(`- [ ] ${DUP} <!-- nova:1 -->`)];
  assert.equal(key, dedupeKey(DUP));
});

// ---------------------------------------------------------------------------
// The cleanup of what was already written
// ---------------------------------------------------------------------------

test('the cleanup drops the later duplicate and keeps the first', () => {
  const result = plan(CARD);
  assert.ok(result, 'the real card has a duplicate to remove');
  assert.equal(result.drop.length, 1);
  assert.equal(result.drop[0].id, '7', 'the later line goes');
  assert.equal(result.drop[0].keptId, '17', 'the one that has been there longest stays');

  assert.equal(result.next.includes('nova:17'), true);
  assert.equal(result.next.includes('nova:7 '), false);
  // And nothing else moved.
  assert.equal(result.next.includes('nova:18'), true);
  assert.equal(result.next.includes('nova:4'), true);
  assert.equal(result.next.split('\n').length, 3);
});

test('it is idempotent — a second pass finds nothing', () => {
  const once = plan(CARD);
  assert.equal(plan(once.next), null);
});

test('a card with no duplicates is left completely alone', () => {
  assert.equal(plan('- [ ] One thing <!-- nova:1 -->\n- [ ] Another thing <!-- nova:2 -->'), null);
});

test('⚠ a TICKED duplicate is never removed', () => {
  // A ticked line records that the work was done. Removing it erases evidence
  // rather than a duplicate — the one case where the two lines are not
  // interchangeable.
  const card = [
    `- [x] ${DUP} <!-- nova:17 -->`,
    `- [ ] ${DUP} <!-- nova:7 -->`,
  ].join('\n');
  assert.equal(plan(card), null);
});

test('non-task lines are untouched', () => {
  const card = ['## 1-2-1 Actions', '', 'Some prose about the same thing.', `- [ ] ${DUP} <!-- nova:1 -->`].join('\n');
  assert.equal(plan(card), null);
});
