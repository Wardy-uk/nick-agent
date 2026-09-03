'use strict';

/**
 * Email extraction (item 2).
 *
 * The load-bearing tests here are the negative ones. This is the first thing in
 * NEURO that turns somebody else's wording into a proposed task, and the two
 * ways it can fail are not symmetric: a missed obligation leaves an email in a
 * lane Nick is already looking at, while a false one puts a fabricated
 * commitment in the queue he uses to decide what he owes. So the rules that
 * must hold are "it never promotes", "it never guesses a date", "a failure is
 * never silence", and "the lanes triage has already dismissed are never read".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ea = require('./email-actions');
const { AUTO_PROMOTE_CONFIDENCE } = require('./action-candidates');

const email = (over = {}) => ({
  id: 'AAMkAGI1', from: 'Chris Middleton', fromEmail: 'chris@nurtur.tech',
  subject: 'Headcount for the board pack', preview: 'Nick, can you get me the headcount numbers by Friday please',
  lane: 'reply', received: '2026-09-01T09:00:00Z', ...over,
});

// ---------------------------------------------------------------------------
// It cannot promote, by construction
// ---------------------------------------------------------------------------

test('a candidate is review-only and can never be auto-promoted', () => {
  const c = ea.buildCandidate(email(), 'Send Chris the headcount numbers');
  assert.equal(c.autoPromote, false);
  assert.ok(ea.CONFIDENCE < AUTO_PROMOTE_CONFIDENCE,
    'an email guess must stay below the auto-promote line even if that line moves');
});

test('nothing in this file can reach the task store', () => {
  // The source is the assertion. A future edit that wires this straight into
  // `task-store` would defeat every runtime guard above it, and would look
  // entirely reasonable in a diff.
  const raw = fs.readFileSync(path.join(__dirname, 'email-actions.js'), 'utf-8');
  // Comments stripped, or the header explaining the rule trips the rule.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(['"]\.\/task-store['"]\)/);
  assert.doesNotMatch(src, /createTask\s*\(/);
  // And it must not execute an action either — approving is Nick's.
  assert.doesNotMatch(src, /executeAction/);
  // Positive control: the scan is looking at real code, not an empty string.
  assert.match(src, /createSaraAction/);
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

test('only the two lanes where Nick owes something are read', () => {
  assert.deepEqual([...ea.LANES].sort(), ['reply', 'urgent']);
  for (const lane of ['fyi', 'ignore', 'delegate']) {
    assert.equal(ea.LANES.has(lane), false, `${lane} is triage's decision and must not be re-litigated`);
  }
});

test('a dismissed or out-of-lane email is never asked about', async () => {
  // No model is stubbed, so reaching one would throw or spend. Both failures
  // are visible: `asked` must be zero.
  const res = await ea.extractFromTriage([
    email({ id: 'a', lane: 'fyi' }),
    email({ id: 'b', lane: 'ignore' }),
    email({ id: 'c', lane: 'reply', dismissed: true }),
  ]);
  assert.equal(res.considered, 0);
  assert.equal(res.asked, 0);
  assert.equal(res.created, 0);
});

// ---------------------------------------------------------------------------
// Parsing — a non-answer is not "nothing owed"
// ---------------------------------------------------------------------------

test('null, and the words models use for null, all mean nothing owed', () => {
  const out = ea.parseAnswer('[{"index":0,"action":null},{"index":1,"action":"none"},{"index":2,"action":""}]', 3);
  assert.equal(out.get(0), null);
  assert.equal(out.get(1), null);
  assert.equal(out.get(2), null);
  // All three were ANSWERED — which is what stops them being re-bought.
  assert.equal(out.size, 3);
});

test('a truncated answer throws rather than reading as an empty inbox', () => {
  // The token-budget shape that has cost this repo whole triage runs: valid
  // prose, no closing bracket. Silently returning nothing would mark every
  // email in the batch as carrying no obligation.
  assert.throws(() => ea.parseAnswer('[{"index":0,"action":"Send the numbers"}', 2), /unparseable/);
  assert.throws(() => ea.parseAnswer('', 2), /unparseable/);
  assert.throws(() => ea.parseAnswer('{"index":0}', 2), /unparseable/);
});

test('an index the batch does not have is dropped, not mapped onto a neighbour', () => {
  // Getting this wrong lands one email's obligation on a different email.
  const out = ea.parseAnswer('[{"index":9,"action":"Do a thing"},{"index":0,"action":"Send the numbers"}]', 2);
  assert.equal(out.size, 1);
  assert.equal(out.get(0), 'Send the numbers');
});

test('an unanswered row stays unanswered', () => {
  const out = ea.parseAnswer('[{"index":0,"action":"Send the numbers"}]', 3);
  assert.equal(out.has(1), false);
  assert.equal(out.has(2), false);
});

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

test('a candidate carries the same fields the vault extractor emits', () => {
  const c = ea.buildCandidate(email(), 'Send Chris the headcount numbers');
  assert.equal(c.type, 'capture_todo');
  for (const f of ['text', 'confidence', 'reason', 'sourcePath', 'focusItemId', 'semanticSignature', 'payload']) {
    assert.ok(c[f] != null, `missing ${f} — the existing queue reads it`);
  }
  assert.equal(c.payload.semanticSignature, c.semanticSignature);
});

test('the source is namespaced so it can never read as a vault note', () => {
  const c = ea.buildCandidate(email(), 'Send Chris the headcount numbers');
  assert.equal(c.sourcePath, 'email:AAMkAGI1');
  assert.doesNotMatch(c.sourcePath, /\.md$/);
});

test('promotion will stamp email provenance, not meeting-promotion', () => {
  // `suggestion-engine` reads `payload.source`; without it an email task would
  // claim it came from a meeting note, and `inferOrigin` reads that field.
  const c = ea.buildCandidate(email(), 'Send Chris the headcount numbers');
  assert.equal(c.payload.source, 'email-promotion');
  assert.equal(c.payload.extractedFrom, 'email');
});

test('no due date is ever invented, however loudly the email says Friday', () => {
  const c = ea.buildCandidate(email({ preview: 'I need this by Friday at the latest' }), 'Send Chris the headcount numbers');
  assert.equal(c.payload.dueDate, undefined);
  assert.equal(c.payload.metadata?.dueDate ?? null, null);
});

test('the reason names the person who asked, so the card is checkable', () => {
  const c = ea.buildCandidate(email(), 'Send Chris the headcount numbers');
  assert.match(c.reason, /Chris Middleton/);
});

test('a fragment and an essay are both refused', () => {
  assert.equal(ea.usable('Reply'), false);
  assert.equal(ea.usable(''), false);
  assert.equal(ea.usable(null), false);
  assert.equal(ea.usable('Send Chris the headcount numbers'), true);
  assert.equal(ea.usable('x'.repeat(400)), false);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test('the ledger forgets emails triage no longer holds', () => {
  const kept = ea.pruneLedger({ a: { obligation: false }, b: { obligation: true } }, new Set(['a']));
  assert.deepEqual(Object.keys(kept), ['a']);
});

test('the prompt tells the model that null is the expected answer', () => {
  // Without this the model produces a task for every marketing email, and the
  // queue Nick reads to find what he owes fills with things he does not.
  const p = ea.buildPrompt([email()]);
  assert.match(p, /null/);
  assert.match(p, /Most email is null/);
  // And that it is told not to date it (rule 4).
  assert.match(p, /Do not invent a deadline or a date/);
});
