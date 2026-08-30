'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTIONS, decide } = require('./reconcile');

const V = (hash) => ({ hash, path: 'Projects/Notion/Thing.md' });
const N = (lastEdited, extra = {}) => ({ id: 'page-1', lastEdited, archived: false, ...extra });
const LAST = (vaultHash, notionLastEdited) => ({ vaultHash, notionLastEdited });

test('unchanged on both sides does nothing', () => {
  const r = decide({ vault: V('a'), notion: N('t1'), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.NOOP);
});

test('a vault-only change pushes', () => {
  const r = decide({ vault: V('b'), notion: N('t1'), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.PUSH);
});

test('a Notion-only change pulls', () => {
  const r = decide({ vault: V('a'), notion: N('t2'), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.PULL);
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusals. Each of these is a place where the obvious behaviour silently
// destroys work, so they are pinned as the product rather than as edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('BOTH sides changed is a conflict and is never resolved by picking a winner', () => {
  const r = decide({ vault: V('b'), notion: N('t2'), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.CONFLICT);
  assert.match(r.reason, /BOTH sides/);
});

test('two sides that exist but have never been synced together is a conflict, not an adoption', () => {
  // State loss must not silently overwrite a week of edits in whichever
  // direction happens to run first.
  const r = decide({ vault: V('a'), notion: N('t1'), last: null });
  assert.equal(r.action, ACTIONS.CONFLICT);
});

test('a deleted vault file never deletes the Notion page', () => {
  const r = decide({ vault: null, notion: N('t1'), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.ORPHAN_VAULT);
});

test('a deleted Notion page never deletes the vault file', () => {
  const r = decide({ vault: V('a'), notion: null, last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.ORPHAN_NOTION);
  assert.match(r.reason, /vault copy kept/);
});

test('an ARCHIVED Notion page keeps the vault copy rather than mirroring the delete', () => {
  const r = decide({ vault: V('a'), notion: N('t1', { archived: true }), last: LAST('a', 't1') });
  assert.equal(r.action, ACTIONS.ORPHAN_VAULT);
  assert.match(r.reason, /trash/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation — and the distinction that decides it.
// ─────────────────────────────────────────────────────────────────────────────

test('an unseen vault file creates a Notion page; a SEEN one that lost its page does not', () => {
  assert.equal(decide({ vault: V('a'), notion: null, last: null }).action, ACTIONS.CREATE_IN_NOTION);
  assert.equal(decide({ vault: V('a'), notion: null, last: LAST('a', 't1') }).action, ACTIONS.ORPHAN_NOTION);
});

test('an unseen Notion page creates a vault file; a SEEN one whose file went does not', () => {
  assert.equal(decide({ vault: null, notion: N('t1'), last: null }).action, ACTIONS.CREATE_IN_VAULT);
  assert.equal(decide({ vault: null, notion: N('t1'), last: LAST('a', 't1') }).action, ACTIONS.ORPHAN_VAULT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Direction gating — a refused direction is REPORTED, never silently dropped.
// ─────────────────────────────────────────────────────────────────────────────

test('pull-only refuses a push and says why', () => {
  const r = decide({ vault: V('b'), notion: N('t1'), last: LAST('a', 't1'), mode: 'pull-only' });
  assert.equal(r.action, ACTIONS.SKIP);
  assert.match(r.reason, /pull-only/);
  assert.match(r.reason, /changed in the vault/, 'the skip must still name what it saw');
});

test('push-only refuses a pull and says why', () => {
  const r = decide({ vault: V('a'), notion: N('t2'), last: LAST('a', 't1'), mode: 'push-only' });
  assert.equal(r.action, ACTIONS.SKIP);
  assert.match(r.reason, /push-only/);
});

test('a one-way mapping still reports a conflict rather than hiding it', () => {
  // The gate narrows what may be WRITTEN; it must not suppress the finding that
  // both sides moved, or a pull-only mapping quietly overwrites vault edits.
  const r = decide({ vault: V('b'), notion: N('t2'), last: LAST('a', 't1'), mode: 'pull-only' });
  assert.equal(r.action, ACTIONS.CONFLICT);
});

test('nothing on either side is a noop, not a creation', () => {
  assert.equal(decide({ vault: null, notion: null, last: null }).action, ACTIONS.NOOP);
});

test('every decision carries a reason', () => {
  const inputs = [
    { vault: V('a'), notion: N('t1'), last: LAST('a', 't1') },
    { vault: V('b'), notion: N('t2'), last: LAST('a', 't1') },
    { vault: null, notion: N('t1'), last: null },
    { vault: V('a'), notion: null, last: LAST('a', 't1') },
  ];
  for (const input of inputs) {
    const r = decide(input);
    assert.ok(r.reason && r.reason.length > 5, `bare reason for ${JSON.stringify(input)}`);
  }
});
