'use strict';

// The pick list on "Apply link repairs" (7 Sep 2026).
//
// `fixApply` could only ever be told a TIER, and a tier is the wrong shape for
// this vault: measured on the live one, `conservative` proposes NOTHING while
// `aggressive` offers real mislinks — `NOVA_REVIEW_2026-04-27` scores 0.706
// against `W24-2026-review`, which is plainly wrong. So repairing the broken
// links was all-or-nothing over a set containing known-bad guesses.
//
// `only` is a list of `fixKey`s, and these pin the three rules that make it
// safe: a guess is NEVER swept in by a tier, a pick is ADDITIVE, and a pick
// matching nothing is REPORTED rather than passing as a clean, smaller run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hygiene = require('./vault-hygiene');

function mkVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-only-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

// One near-identical break (moderate) and one real-world bad guess (aggressive),
// both lifted from the live vault rather than invented — a fixture containing
// only obvious cases proves nothing about the ones that need a human tick.
function fixtureVault() {
  return mkVault({
    'Notes/Close.md': 'See [[2026-04-30 Meeting Financial Impact and Cost Saving]].',
    'Meetings/2026-04-30 Meeting Financial Impact and Cost Savings.md': '# close',

    'Notes/Guess.md': 'See [[NOVA_REVIEW_2026-04-27]].',
    'Reviews/W24-2026-review.md': '# a different note entirely',
  });
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// A wikilink is a literal. Building a regex out of a filename means escaping a
// filename, which is a second thing to get wrong inside the assertion itself.
const links = (root, rel, target) => read(root, rel).includes('[[' + target + ']]');

test('the fixture is the two tiers this feature exists to tell apart', () => {
  const plan = hygiene.fixPlan(fixtureVault(), { write: false });
  const tiers = plan.linkFixes.map((f) => f.tier).sort();
  assert.deepStrictEqual(tiers, ['aggressive', 'moderate'],
    'every test below is meaningless if the fixture stops producing one of each');
});

test('every proposed repair carries a key, and the key is stable across runs', () => {
  const root = fixtureVault();
  const a = hygiene.fixPlan(root, { write: false });
  const b = hygiene.fixPlan(root, { write: false });

  for (const f of a.linkFixes) assert.match(f.key, /^[0-9a-f]{12}$/, 'key must be a short hex handle');
  assert.deepStrictEqual(
    a.linkFixes.map((f) => f.key),
    b.linkFixes.map((f) => f.key),
    'the same vault must yield the same keys — a pick made against a preview has to survive to the apply',
  );
  assert.strictEqual(new Set(a.linkFixes.map((f) => f.key)).size, a.linkFixes.length, 'keys must be unique');
});

test('a best guess is NEVER applied by a tier — only by being ticked', () => {
  const root = fixtureVault();
  hygiene.fixApply(root, { links: 'moderate' });

  assert.ok(links(root, 'Notes/Guess.md', 'NOVA_REVIEW_2026-04-27'),
    'the best guess must be untouched by the moderate tier');
  assert.ok(!links(root, 'Notes/Close.md', '2026-04-30 Meeting Financial Impact and Cost Saving'),
    'the close match must have been repaired, or the tier did nothing at all');
});

test('a pick is ADDITIVE — it widens the tier, never narrows it', () => {
  const root = fixtureVault();
  const plan = hygiene.fixPlan(root, { write: false });
  const guess = plan.linkFixes.find((f) => f.tier === 'aggressive');
  const byTier = plan.linkFixes.filter((f) => f.tier !== 'aggressive');

  const r = hygiene.fixApply(root, { links: 'moderate', only: [guess.key] });

  assert.strictEqual(r.repointed, byTier.length + 1, 'the tier set PLUS the pick, not one instead of the other');
  assert.ok(!links(root, 'Notes/Guess.md', 'NOVA_REVIEW_2026-04-27'), 'the ticked guess must be applied');
  for (const f of byTier) {
    assert.ok(!links(root, f.from, f.oldTarget), 'a pick list must not suppress what the tier already covered');
  }
});

test('picks alone, with no tier, apply exactly what was ticked and nothing else', () => {
  const root = fixtureVault();
  const plan = hygiene.fixPlan(root, { write: false });
  const guess = plan.linkFixes.find((f) => f.tier === 'aggressive');

  const r = hygiene.fixApply(root, { links: 'skip', only: [guess.key] });

  assert.strictEqual(r.repointed, 1);
  assert.deepStrictEqual(r.onlyUnmatched, []);
  assert.ok(links(root, 'Notes/Guess.md', guess.newBase));
  assert.ok(links(root, 'Notes/Close.md', '2026-04-30 Meeting Financial Impact and Cost Saving'),
    'what the tier would have covered must be left standing when no tier was chosen');
});

test('a pick that matches nothing is REPORTED, never swallowed', () => {
  // The preview a caller holds can go stale — a note renamed underneath it
  // changes the key. Applying fewer links than were ticked must never read as a
  // clean run: silence there is indistinguishable from success.
  const root = fixtureVault();
  const r = hygiene.fixApply(root, { links: 'skip', only: ['deadbeef0000', 'cafebabe1111'] });

  assert.strictEqual(r.repointed, 0);
  assert.deepStrictEqual(r.onlyUnmatched.sort(), ['cafebabe1111', 'deadbeef0000']);
});

test('no pick list at all reports no unmatched picks — absence is not a failure', () => {
  const r = hygiene.fixApply(fixtureVault(), { links: 'moderate' });
  assert.deepStrictEqual(r.onlyUnmatched, [], 'a caller that ticked nothing has nothing unmatched');
});

test('an applied repair is backed up first, and rewrites only the link target', () => {
  const root = fixtureVault();
  const before = read(root, 'Notes/Close.md');

  const r = hygiene.fixApply(root, { links: 'moderate' });

  assert.ok(r.repointed >= 1);
  const backup = path.join(root, r.backupDir, 'Notes', 'Close.md');
  assert.ok(fs.existsSync(backup), 'every touched file must be copied before it is edited');
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), before, 'the backup must hold the pre-edit content');

  const after = read(root, 'Notes/Close.md');
  const outside = (t) => t.slice(0, t.indexOf('[')) + t.slice(t.indexOf(']') + 2);
  assert.notStrictEqual(after, before, 'the link itself must have changed');
  assert.strictEqual(outside(after), outside(before), 'nothing outside the link may change');
});
