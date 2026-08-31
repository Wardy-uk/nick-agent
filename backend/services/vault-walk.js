'use strict';

/**
 * ONE walk of the vault, shared by retrieval and the embeddings index.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `retrieval.js` and `embeddings.js` each had their own walker, and they
 * disagreed about how much of the vault exists. Retrieval was fixed to depth
 * 12 with a reported cap; the embeddings inventory was still hard-coded at
 * **depth 4** — so `Meetings/2026/08/deep/note.md` was searchable by keyword and
 * **could never be indexed for semantic search**, silently and permanently.
 * A note the index cannot see returns three keyword hits and looks exactly like
 * a note that was read in full, which is the failure this whole area exists to
 * prevent, one layer down.
 *
 * The TRAVERSAL POLICY is shared here — depth, the file cap, and what counts as
 * unreadable. The EXCLUSION POLICY stays with each caller and is passed in,
 * deliberately: `Daily/` is excluded from embeddings and KEPT for entity
 * extraction, and retrieval additionally drops `Templates` and `Vault Audit`
 * because they match every query. Those differences are considered decisions,
 * not drift, so this module takes them as arguments rather than picking one.
 *
 * ── Unreadable is RECORDED, never skipped ───────────────────────────────────
 * ⚠ Both old walkers did `try { readdirSync } catch { continue }`. A folder
 * whose permissions broke, or a disk that unmounted mid-walk, therefore
 * produced a smaller answer that called itself complete. Every failure is now
 * collected in `inaccessible`, and an inaccessible entry makes the walk
 * `truncated` — "I could not read it" is a form of not knowing, and must never
 * be reported as "it is not there".
 *
 * PURE apart from the filesystem reads it is entirely about. CommonJS.
 */

const fs = require('fs');
const path = require('path');

// Generous, and a backstop against a symlink loop rather than a content
// decision. `Meetings/2026/08/note.md` is depth 3; the retired limit of 4 left
// one level of headroom for a vault that already nests deeper than that.
const MAX_DEPTH = 12;

// A hard bound on how many files one walk will read, so a pathological vault
// cannot wedge a request. Hitting it is REPORTED, never silent.
const MAX_FILES_SCANNED = 5000;

// How many inaccessible paths are kept by name. The count is always exact; the
// list is bounded so one broken mount cannot produce a megabyte of health.
const MAX_INACCESSIBLE_LISTED = 50;

/**
 * Walk a vault root.
 *
 * @param {string} root                       absolute vault path
 * @param {object} options
 * @param {(name:string)=>boolean} [options.skipDir]      by directory NAME
 * @param {(rel:string)=>boolean}  [options.skipFile]     by vault-relative PATH
 * @param {(relDir:string)=>boolean} [options.pruneDir]   false = do not descend
 *                                   (used to prune to a `folder:` scope)
 * @param {(rel:string, full:string)=>void} options.visit
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxFiles]
 * @returns {{scanned:number, truncated:boolean, why:(string|null),
 *            reasons:string[], inaccessible:Array<{path:string,error:string}>,
 *            inaccessibleCount:number, excluded:number}}
 */
function walk(root, options = {}) {
  const {
    skipDir = () => false,
    skipFile = () => false,
    pruneDir = () => true,
    visit = () => {},
    maxDepth = MAX_DEPTH,
    maxFiles = MAX_FILES_SCANNED,
  } = options;

  const state = {
    scanned: 0,
    truncated: false,
    why: null,
    reasons: [],
    inaccessible: [],
    inaccessibleCount: 0,
    excluded: 0,
  };

  const note = (reason) => {
    state.truncated = true;
    if (!state.reasons.includes(reason)) state.reasons.push(reason);
    // `why` keeps the FIRST reason, which is the long-standing single-string
    // field consumers already read. `reasons` is the complete list.
    if (!state.why) state.why = reason;
  };

  const unreadable = (target, error) => {
    state.inaccessibleCount += 1;
    if (state.inaccessible.length < MAX_INACCESSIBLE_LISTED) {
      state.inaccessible.push({ path: target, error });
    }
    // ⚠ An unreadable path makes the whole answer partial. It is not a smaller
    // vault, it is a vault we could not finish reading.
    note('some files or folders could not be read');
  };

  if (!root) return { ...state, truncated: true, why: 'vault path is not configured', reasons: ['vault path is not configured'] };
  if (!fs.existsSync(root)) {
    return { ...state, truncated: true, why: 'vault path is not readable', reasons: ['vault path is not readable'] };
  }

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (state.scanned >= maxFiles) {
      note(`scan capped at ${maxFiles} files`);
      break;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      unreadable(relOf(root, dir), e.message);
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relOf(root, full);

      let isDir;
      try {
        // `withFileTypes` gives a Dirent, but a SYMLINK reports neither
        // directory nor file, so it needs a stat to be classified. An
        // unresolvable link is recorded rather than dropped.
        isDir = entry.isSymbolicLink() ? fs.statSync(full).isDirectory() : entry.isDirectory();
      } catch (e) {
        unreadable(rel, e.message);
        continue;
      }

      if (isDir) {
        if (skipDir(entry.name)) { state.excluded += 1; continue; }
        if (!pruneDir(rel)) continue;          // out of scope, not a gap
        if (depth + 1 > maxDepth) {
          note(`directories deeper than ${maxDepth} levels were not searched`);
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (!entry.name.endsWith('.md')) continue;
      if (skipFile(rel)) { state.excluded += 1; continue; }
      state.scanned += 1;
      visit(rel, full);
    }
  }

  return state;
}

function relOf(root, full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

/**
 * The traversal record for a walk that never happened.
 *
 * ⚠ It is `truncated: true`, always. "We could not look" is a form of
 * incompleteness, and the one this whole area exists to keep apart from
 * "we looked and there was nothing".
 */
function noWalk(why) {
  return { scanned: 0, truncated: true, why, reasons: [why], inaccessible: [], inaccessibleCount: 0, excluded: 0 };
}

module.exports = {
  walk,
  noWalk,
  MAX_DEPTH,
  MAX_FILES_SCANNED,
  MAX_INACCESSIBLE_LISTED,
};
