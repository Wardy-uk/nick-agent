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
