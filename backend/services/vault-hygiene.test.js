'use strict';

// #81 — archiving a note is correct behaviour, and the linter used to call every
// inbound link to it a defect. On 14 Aug that was 69 of 228 reported "broken"
// links: 54 pointing at `90 Day Plan`, 6 at `Evidence Register` (both deliberately
// retired to `Projects/Archive/...`) and 9 at `[[_about]]`, which `walk()` skips by
// design. These pin the distinction, not the numbers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hygiene = require('./vault-hygiene');
const { collectArchiveDirs, buildArchiveIndex } = hygiene._internal;

function mkVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

test('a link to an archived note is NOT broken — it gets its own class', () => {
  const root = mkVault({
    'Projects/Live.md': 'See [[Head of Technical Support - 90 Day Plan]] for detail.',
    'Projects/Archive/90 Day Plan (retired 2026-08-12)/Head of Technical Support - 90 Day Plan.md': '# retired',
  });
  const r = hygiene.lint(root, { write: false });

  assert.strictEqual(r.broken.length, 0, 'archived target must not be reported broken');
  assert.strictEqual(r.archivedTargets.length, 1);
  assert.strictEqual(r.archivedTargets[0].target, 'Head of Technical Support - 90 Day Plan');
  assert.match(r.archivedTargets[0].archivePath, /^Projects\/Archive\//);
});

test('NESTED Archive folders are found, not just the top-level one', () => {
  // The real false positives lived in `Projects/Archive/...`, and the previous
  // archive lookup only ever walked `<root>/Archive` — so they read as missing.
  const root = mkVault({
    'Note.md': '[[Deep One]] and [[Top One]]',
    'Projects/Archive/Sub/Deep One.md': 'x',
    'Archive/Top One.md': 'x',
  });
  const dirs = collectArchiveDirs(root).map((d) => path.relative(root, d).split(path.sep).join('/'));
  assert.ok(dirs.includes('Projects/Archive'), 'nested Archive must be discovered');
  assert.ok(dirs.includes('Archive'), 'top-level Archive must still be discovered');

  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 0);
  assert.strictEqual(r.archivedTargets.length, 2);
});

test('a genuinely missing target is still broken', () => {
  const root = mkVault({ 'Note.md': '[[Does Not Exist Anywhere]]' });
  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 1);
  assert.strictEqual(r.broken[0].target, 'Does Not Exist Anywhere');
  assert.strictEqual(r.archivedTargets.length, 0);
});

test('[[_about]] is never broken — walk() skips _about.md by design', () => {
  const root = mkVault({
    'Tasks/_about.md': '# index',
    'Tasks/Thing.md': 'Back to [[_about]] and [[Tasks/_about]].',
  });
  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 0, '_about is unresolvable by construction, not by content');
  assert.strictEqual(r.archivedTargets.length, 0);
});

test('an active note wins over an archived one of the same name', () => {
  // Restoring a note leaves the archived copy in place; the live one must win or
  // lint would report a healthy link as pointing into the bin.
  const root = mkVault({
    'Note.md': '[[Evidence Register]]',
    'Projects/Evidence Register.md': 'live',
    'Projects/Archive/Evidence Register.md': 'retired',
  });
  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 0);
  assert.strictEqual(r.archivedTargets.length, 0, 'resolves to the ACTIVE note');
});

test('Archive-shaped junk outside the vault proper is not treated as archive', () => {
  // `.stversions` (Syncthing) and `Scripts/.lint-backups` both contain full
  // Archive-shaped copies. Indexing them would resolve dead links against
  // backups and hide real breakage.
  const root = mkVault({
    'Note.md': '[[Ghost]]',
    '.stversions/Archive/Ghost.md': 'syncthing version',
    'Scripts/.lint-backups/2026-01-01/Archive/Ghost.md': 'lint backup',
  });
  assert.strictEqual(collectArchiveDirs(root).length, 0);
  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 1, 'still broken — backups are not a resolution source');
  assert.strictEqual(r.archivedTargets.length, 0);
});

test('the archive index matches case-insensitively but keeps first-wins', () => {
  const root = mkVault({
    'Archive/Alpha.md': 'first',
    'Projects/Archive/alpha.md': 'second',
  });
  const idx = buildArchiveIndex(root, (s) => s.toLowerCase());
  assert.strictEqual(idx.size, 1);
  assert.ok(path.isAbsolute(idx.get('alpha')), 'index stores ABSOLUTE paths (fixApply re-joins against root)');
});

test('everything below an Archive folder counts, including a nested Archive', () => {
  const root = mkVault({
    'Note.md': '[[Buried]]',
    'Archive/_toDelete/Archive/Buried.md': 'x',
  });
  const r = hygiene.lint(root, { write: false });
  assert.strictEqual(r.broken.length, 0);
  assert.strictEqual(r.archivedTargets.length, 1);
});

// An escaped alias pipe is not part of the link target (7 Sep 2026).
//
// Inside a markdown TABLE the alias pipe has to be escaped, so
// `one-to-one-tracker` correctly writes `[[People/Abdi Mohamed\\|Abdi Mohamed]]`.
// `extractLinks` split on `|` and kept the escape, so the target read as
// `People/Abdi Mohamed\\` and every row of the generated 1-2-1 Tracker was
// reported broken. Measured on the live vault: 19 of 80 — a quarter of the
// headline count was an artefact of links that resolve perfectly well.
test('an escaped alias pipe in a table is not a broken link', () => {
  const root = mkVault({
    'Areas/Tracker.md': '| [[People/Abdi Mohamed\\|Abdi Mohamed]] | fortnightly |',
    'People/Abdi Mohamed.md': '# person',
  });
  const r = hygiene.lint(root, { write: false });

  assert.strictEqual(r.broken.length, 0, 'the link resolves in Obsidian and must resolve here');
  // ⚠ Positive control: the person must be seen as LINKED, or this could pass
  // merely by the target being dropped rather than parsed.
  assert.ok(!r.orphans.includes('People/Abdi Mohamed.md'), 'the inbound link must still count');
});

test('an unescaped alias pipe still works, and a real break is still reported', () => {
  const root = mkVault({
    'Note.md': '[[People/Zoe Rees|Zoe]] and [[Nobody At All]]',
    'People/Zoe Rees.md': '# person',
  });
  const r = hygiene.lint(root, { write: false });

  assert.strictEqual(r.broken.length, 1, 'the fix must not swallow genuine breaks');
  assert.strictEqual(r.broken[0].target, 'Nobody At All');
});

// Contextual linking: which folders, and the two it must never enter (7 Sep 2026).

test('the forbidden roots are REFUSED by name, never quietly skipped', () => {
  const root = mkVault({ 'Tasks/Outcomes/2026/09/x.md': '# x', 'Notion/Hiking/Routes.md': '# r' });

  // ⚠ Both append REAL PROSE, and that is what makes them dangerous:
  // `Tasks/Outcomes` reads appended text as a write-up and would release every
  // held task; a `Notion/` mirror hashes its body and would push the block back
  // into Notion. A silent skip would look like a folder with nothing to link.
  assert.throws(() => hygiene.contextualLinkPlan(root, { roots: ['Tasks'], write: false }), /Tasks/);
  assert.throws(() => hygiene.contextualLinkApply(root, { roots: ['Notion'] }), /Notion/);
  // A nested path must not slip past a head-only check.
  assert.throws(() => hygiene.contextualLinkPlan(root, { roots: ['Tasks/Outcomes'], write: false }), /Tasks/);
});

test('the default roots exclude the forbidden ones', () => {
  for (const forbidden of Object.keys(hygiene.CTX_FORBIDDEN_ROOTS)) {
    assert.ok(!hygiene.DEFAULT_CTX_ROOTS.includes(forbidden),
      forbidden + ' must never be a default root');
  }
  // Positive control: the widened set must actually be wider than the original
  // four, which measured ZERO proposals on the live vault.
  assert.ok(hygiene.DEFAULT_CTX_ROOTS.length > 4);
  assert.ok(hygiene.DEFAULT_CTX_ROOTS.includes('Ideas'));
});

test('a permitted root still plans normally', () => {
  const root = mkVault({
    'People/Naomi Wentworth.md': '# Naomi',
    'Ideas/thought.md': 'Naomi Wentworth mentioned the SLA rework again.',
  });
  const p = hygiene.contextualLinkPlan(root, { roots: ['Ideas'], write: false });
  assert.ok(p.total >= 1, 'a full-name prose mention must still be proposed');
});
