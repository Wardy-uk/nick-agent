'use strict';

// What should happen to ONE note. Pure — no DB, no network, no clock, no fs.
//
// The `pi-health.assess()` / `context-state` split: the decision is the product,
// so it is testable without a Notion workspace or a vault. Everything about
// applying the decision lives in index.js.
//
// ── Why three-way and not "newest wins" ─────────────────────────────────────
// The obvious rule is to compare the vault mtime against Notion's
// `last_edited_time` and take the later one. It is wrong in the direction that
// costs work: Syncthing rewrites mtimes on delivery, NEURO's own vault-hooks
// touch files, and Notion stamps `last_edited_time` when anyone opens a page and
// nudges a block. So "newest" regularly names a side that did not actually
// change, and a spurious win OVERWRITES the side that did.
//
// Instead each side is compared against what it looked like at the END OF THE
// LAST SUCCESSFUL SYNC — the vault by content hash (mtime is not evidence of a
// change), Notion by `last_edited_time` (the only change token the API gives).
// That answers "did THIS side move", which is the question, and it makes
// "both moved" detectable rather than silently resolved.

/** Both sides moved since the last sync. Never merged — see CONFLICT below. */
const CONFLICT = 'conflict';

const ACTIONS = Object.freeze({
  NOOP: 'noop',
  PULL: 'pull',                   // Notion -> vault
  PUSH: 'push',                   // vault -> Notion
  CREATE_IN_VAULT: 'create-in-vault',
  CREATE_IN_NOTION: 'create-in-notion',
  CONFLICT,
  ORPHAN_VAULT: 'orphan-vault',   // Notion page gone; vault file kept, reported
  ORPHAN_NOTION: 'orphan-notion', // vault file gone; Notion page kept, reported
  SKIP: 'skip',
});

/**
 * @param {object} input
 * @param {?object} input.vault    `{ hash, path }`, or null if there is no file.
 * @param {?object} input.notion   `{ id, lastEdited, archived }`, or null.
 * @param {?object} input.last     Sync state: `{ vaultHash, notionLastEdited }`.
 * @param {string} [input.mode]    'two-way' | 'pull-only' | 'push-only'.
 * @returns {{action: string, reason: string}}
 */
function decide({ vault = null, notion = null, last = null, mode = 'two-way' } = {}) {
  const seen = Boolean(last);
  const vaultChanged = Boolean(vault) && (!seen || vault.hash !== last.vaultHash);
  const notionChanged = Boolean(notion) && (!seen || notion.lastEdited !== last.notionLastEdited);

  const gate = (action, reason) => {
    // A direction the mapping does not allow is reported as skipped WITH the
    // reason, never silently dropped — "nothing happened" and "we refused to do
    // it" are different facts, and only one of them needs Nick to act.
    if (mode === 'pull-only' && (action === ACTIONS.PUSH || action === ACTIONS.CREATE_IN_NOTION)) {
      return { action: ACTIONS.SKIP, reason: `${reason}, but this mapping is pull-only` };
    }
    if (mode === 'push-only' && (action === ACTIONS.PULL || action === ACTIONS.CREATE_IN_VAULT)) {
      return { action: ACTIONS.SKIP, reason: `${reason}, but this mapping is push-only` };
    }
    return { action, reason };
  };

  // ── Neither side exists ────────────────────────────────────────────────────
  if (!vault && !notion) return { action: ACTIONS.NOOP, reason: 'nothing on either side' };

  // ── An archived Notion page is a DELETE we never mirror ─────────────────────
  // Notion's trash is recoverable and a vault file is the thing Nick actually
  // relies on, so deleting it to match would be the one irreversible move this
  // sync could make. Reported instead, so it stays visible rather than becoming
  // a file that quietly stops updating.
  if (notion && notion.archived) {
    return vault
      ? { action: ACTIONS.ORPHAN_VAULT, reason: 'Notion page is in the trash; vault copy kept' }
      : { action: ACTIONS.NOOP, reason: 'Notion page is in the trash and there is no vault copy' };
  }

  // ── One side missing ───────────────────────────────────────────────────────
  if (vault && !notion) {
    // Never seen before => a new note Nick wrote in Obsidian. Seen before => the
    // page it was paired with has gone, which is a deletion, not a creation.
    return seen
      ? { action: ACTIONS.ORPHAN_NOTION, reason: 'paired Notion page no longer exists; vault copy kept' }
      : gate(ACTIONS.CREATE_IN_NOTION, 'new note in the vault');
  }
  if (!vault && notion) {
    return seen
      ? { action: ACTIONS.ORPHAN_VAULT, reason: 'vault file was deleted; Notion page kept' }
      : gate(ACTIONS.CREATE_IN_VAULT, 'new page in Notion');
  }

  // ── Both exist ─────────────────────────────────────────────────────────────
  if (!seen) {
    // Both sides exist but we have no record of pairing them — a first run after
    // a manual link, or state loss. We cannot tell which is newer in any way we
    // trust, so this is a conflict, not a guess. Adopting one side here is how a
    // state-file loss silently overwrites a week of edits.
    return { action: CONFLICT, reason: 'both sides exist but have never been synced together' };
  }

  if (!vaultChanged && !notionChanged) return { action: ACTIONS.NOOP, reason: 'unchanged on both sides' };
  if (vaultChanged && !notionChanged) return gate(ACTIONS.PUSH, 'changed in the vault only');
  if (!vaultChanged && notionChanged) return gate(ACTIONS.PULL, 'changed in Notion only');

  // ⚠ Both moved. NEVER merged, and never resolved by picking a winner.
  //
  // A merge needs a common ancestor and a block identity that survives editing,
  // and Notion gives neither — block ids are stable but markdown editing in
  // Obsidian destroys the mapping to them. Any automatic resolution here throws
  // away one side's work silently, in the one place Nick would not think to
  // look. The conflict copy costs him a two-minute read; a wrong merge costs him
  // the edit he made and no way to know it happened.
  return { action: CONFLICT, reason: 'changed on BOTH sides since the last sync' };
}

/** Would this action write to Notion? Used to gate a dry run and the push guard. */
function writesToNotion(action) {
  return action === ACTIONS.PUSH || action === ACTIONS.CREATE_IN_NOTION;
}

/** Would this action write to the vault? */
function writesToVault(action) {
  return action === ACTIONS.PULL || action === ACTIONS.CREATE_IN_VAULT || action === CONFLICT;
}

module.exports = { ACTIONS, decide, writesToNotion, writesToVault };
