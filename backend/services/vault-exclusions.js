'use strict';

// One exclude list, because there were at least three and they disagreed.
//
// `embeddings.js` skipped Daily/Scripts/Templates/Imports and NOT Archive, so
// 24% of the retrieval index was bin: 709 Archive files, 43 _toDelete, and 128
// chunks of NEURO's own generated reports — the system indexing its own logs.
// `entities.js` skipped even less, which is why Hope's person page ranked
// `Master Todo`, `NEURO Tasks (export)` and a `.backup-` copy of a MoSCoW
// worksheet above the meetings that are the actual point.
//
// Two separate ideas, deliberately kept apart:
//   GENERATED  — output NEURO itself wrote. Always noise to read back; a system
//                that indexes its own reports starts citing them as sources.
//   RETIRED    — content deliberately put out of the way (Archive, _toDelete).
//                Excluded from indexing, but a linker resolving link TARGETS
//                still needs to see it (see #81) — hence the separate export.

// Directories that are never content, wherever they appear in the tree.
const INFRA_DIRS = [
  '.obsidian', '.git', '.trash', '.stfolder', '.stversions', '.sync', '.claude',
  'node_modules', '.lint-backups',
];

// NEURO's own output. Indexing this is the system talking to itself.
const GENERATED_DIRS = [
  'Vault Audit',
  'SARA Import Reports',
  'Exports',
];

// Deliberately retired content.
const RETIRED_DIRS = [
  'Archive',
  '_toDelete',
  '_Staging',
];

// Working areas that are not notes of record.
const TRANSIENT_DIRS = [
  'Scripts',
  'Templates',
  'Imports',
];

// Generated FILES, matched on basename. The task export and the superseded
// MoSCoW worksheets name every person and every project, so they outrank real
// notes on any "who is mentioned where" query while saying nothing.
const GENERATED_FILE_PATTERNS = [
  /^NEURO Tasks \(export\)\.md$/i,
  /^Master Todo\.md$/i,
  /^MoSCoW - Open Actions.*\.md$/i,
  // The 1-2-1 tracker became generated in #31. Measured before adding it: it
  // was already holding 37 extracted_entities rows (16 person, 18 mention) and
  // 3 embedding chunks — a table naming all 13 reports outranks their actual
  // meetings on any "who is mentioned where" query while saying nothing, which
  // is exactly what #34 removed for the MoSCoW worksheets.
  /^1-2-1 Tracker\.md$/i,
  /\.backup-/i,
  /\.sync-conflict-/i,
];

const INDEX_EXCLUDED_DIRS = new Set([
  ...INFRA_DIRS, ...GENERATED_DIRS, ...RETIRED_DIRS, ...TRANSIENT_DIRS,
]);

// `Daily/` is excluded from the semantic index (a daily note is a scratchpad and
// there are hundreds of them) but NOT from entity extraction, where "who did I
// mention on Tuesday" is exactly the question being asked.
const EMBEDDING_EXCLUDED_DIRS = new Set([...INDEX_EXCLUDED_DIRS, 'Daily']);

/** Should this directory NAME be walked into? */
function isExcludedDir(name, { forEmbeddings = false } = {}) {
  if (!name) return false;
  const set = forEmbeddings ? EMBEDDING_EXCLUDED_DIRS : INDEX_EXCLUDED_DIRS;
  return set.has(name);
}

/** Is this vault-relative path excluded — by any segment, or by filename? */
function isExcludedPath(relativePath, options = {}) {
  if (!relativePath) return true;
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1];
  for (const seg of parts.slice(0, -1)) {
    if (isExcludedDir(seg, options)) return true;
  }
  return GENERATED_FILE_PATTERNS.some(re => re.test(file));
}

module.exports = {
  INFRA_DIRS,
  GENERATED_DIRS,
  RETIRED_DIRS,
  TRANSIENT_DIRS,
  GENERATED_FILE_PATTERNS,
  INDEX_EXCLUDED_DIRS,
  EMBEDDING_EXCLUDED_DIRS,
  isExcludedDir,
  isExcludedPath,
};
