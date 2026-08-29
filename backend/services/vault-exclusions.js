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

// ── Sensitive, and why it is NOT the same as "personal" ──────────────────────
//
// ⚠ `Personal/` in this vault does NOT mean personal life. Read before changing:
// it holds Nick's disciplinary prep and the fraud investigation, his GP
// appointment notes (anxiety, depression, ADHD) and three Occupational Health
// documents naming the external assessor and the HR contact. It is the most
// sensitive content in the vault and it is WORK material, not home life.
//
// That distinction is load-bearing in both directions. Treating this folder as
// "personal life" would have hidden his OH and disciplinary history from the
// work surfaces where it is genuinely relevant, AND left actual family notes
// indexed — wrong twice from one wrong assumption.
//
// What sensitive buys: excluded from ENTITY EXTRACTION, so an HR officer, an
// occupational health assessor and a GP do not enter the person graph, get
// ranked on somebody's mentions page, or become a `people-gap` stub proposing a
// People note for the person who handled Nick's disciplinary.
//
// What it deliberately does NOT buy: exclusion from embeddings. This is Nick's
// own brain and he must be able to ask it about his own OH report; removing it
// from search would be a real loss for a threat that is largely internal. The
// outbound guards are what stop it leaving the building.
// ⚠ BOTH names are listed, and that is not indecision — it is what makes the
// folder rename safe to do in either order. If the code said only 'Personal'
// and Nick renamed the folder first, `Private/` would be unprotected until the
// next deploy: entity extraction would walk it again and the HR officer, the OH
// assessor and his GP would re-enter the person graph, silently, exactly as they
// had been. This guard fails OPEN, so there must be no window where the folder
// is not covered by whatever name it currently has.
//
// The old name can be dropped once the rename has actually happened — but a
// stale entry here costs nothing, and removing it early costs everything.
const SENSITIVE_DIRS = (process.env.VAULT_SENSITIVE_DIRS || 'Private,Personal')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── Personal life ────────────────────────────────────────────────────────────
//
// Home life, as opposed to the sensitive-work material above. DEFAULT EMPTY, on
// purpose: `Personal/` is already taken and means something else, and there is
// no other folder in this vault that is unambiguously home life. Guessing would
// silently change what the index holds and what the person graph learns, which
// is exactly the class of change that should be a decision.
//
// Set VAULT_PERSONAL_DIRS once such a folder exists. Excluded from entity
// extraction (family names must not enter a roster that feeds team-health, the
// 1-2-1 tracker and people-gap) and KEPT in embeddings, because "when is the
// car booked in" is precisely what a second brain is for.
const PERSONAL_DIRS = (process.env.VAULT_PERSONAL_DIRS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

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

// The shared base: never content, for any consumer.
const INDEX_EXCLUDED_DIRS = new Set([
  ...INFRA_DIRS, ...GENERATED_DIRS, ...RETIRED_DIRS, ...TRANSIENT_DIRS,
]);

// ⚠ The two sets below are NO LONGER one a superset of the other, and that is
// the point of this change. They used to differ only by `Daily/`, so anything
// added to the base was excluded from both — which would have removed the
// sensitive folder from search as well as from the person graph. They now
// diverge deliberately, each naming what its own consumer must not read.

// Entity extraction: the base, plus everything that must not enter the person
// graph. An HR officer, an OH assessor, a GP or a family member appearing in
// `extracted_entities` gets ranked on mentions pages and can become a
// `people-gap` stub proposing a People note.
const ENTITY_EXCLUDED_DIRS = new Set([
  ...INDEX_EXCLUDED_DIRS, ...SENSITIVE_DIRS, ...PERSONAL_DIRS,
]);

// Embeddings: the base, plus `Daily/` — a daily note is a scratchpad and there
// are hundreds of them. Sensitive and personal notes ARE indexed: this is Nick's
// own brain, and the guards that matter for them are the outbound ones.
const EMBEDDING_EXCLUDED_DIRS = new Set([...INDEX_EXCLUDED_DIRS, 'Daily']);

/** Should this directory NAME be walked into? */
function isExcludedDir(name, { forEmbeddings = false } = {}) {
  if (!name) return false;
  const set = forEmbeddings ? EMBEDDING_EXCLUDED_DIRS : ENTITY_EXCLUDED_DIRS;
  return set.has(name);
}

/** Does any segment of this path name one of `dirs`? */
function _underAny(relativePath, dirs) {
  if (!relativePath || !dirs.length) return false;
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).some((seg) => dirs.includes(seg));
}

/**
 * Sensitive work material — HR, disciplinary, occupational health, medical.
 *
 * Kept separate from `isExcludedPath` so a caller can ask the question directly:
 * "may this note's CONTENT leave the building?" is a different question from
 * "should this note be indexed", and conflating them is how one guard ends up
 * doing two jobs badly.
 */
function isSensitivePath(relativePath) {
  return _underAny(relativePath, SENSITIVE_DIRS);
}

/** Home life, as opposed to work. Empty by default — see PERSONAL_DIRS. */
function isPersonalPath(relativePath) {
  return _underAny(relativePath, PERSONAL_DIRS);
}

/**
 * Which part of Nick's life a note belongs to.
 *
 * Frontmatter WINS over the path, because a single note can legitimately sit in
 * the wrong folder and it is the only way to mark one before a folder exists.
 * Anything unmarked is work — the same asymmetry `shared/task-domain.cjs`
 * argues: a personal note mis-read as work is visible, the reverse is silent.
 */
function noteDomain(relativePath, frontmatter) {
  const declared = frontmatter && String(frontmatter.domain || '').trim().toLowerCase();
  if (declared === 'personal' || declared === 'work') return declared;
  return isPersonalPath(relativePath) ? 'personal' : 'work';
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
  SENSITIVE_DIRS,
  PERSONAL_DIRS,
  GENERATED_FILE_PATTERNS,
  INDEX_EXCLUDED_DIRS,
  ENTITY_EXCLUDED_DIRS,
  EMBEDDING_EXCLUDED_DIRS,
  isExcludedDir,
  isExcludedPath,
  isSensitivePath,
  isPersonalPath,
  noteDomain,
};
