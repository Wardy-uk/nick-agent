'use strict';

/**
 * One recording, extracted once (item 21).
 *
 * The nightly sweep has asked NOVA which 1-2-1 recordings it owns since the
 * feature shipped, and skips those notes — NOVA extracts their actions itself.
 * The write-hook path never did, so a NOVA-owned 1-2-1 routed into `Meetings/`
 * by `imports` was extracted by NEURO through the hook AND by NOVA: one
 * conversation, two systems, the same commitment in front of Nick twice.
 *
 * The load-bearing tests are the fail-open ones. A duplicate candidate is
 * visible and cheap; a commitment nobody ever sees is neither, so every path
 * that cannot answer confidently must still extract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-nova-hook-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(vault, 'agent.db');

const db = require('../db/database');
const ac = require('./action-candidates');

const NOTE = 'Meetings/2026/09/2026-09-01 - 1-2-1 with Zoe Rees.md';

function writeNote(plaudId) {
  const abs = path.join(vault, NOTE);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    '---',
    'type: meeting',
    `plaud_id: "${plaudId}"`,
    '---',
    '',
    '## Actions',
    '',
    '- [ ] Send Zoe the QA calibration pack',
    '',
  ].join('\n'), 'utf-8');
  return abs;
}


test.before(async () => {
  await db.init();
  writeNote('PLAUD123');
});

test('nothing cached means nothing excluded — it extracts as before', () => {
  // The first write after a restart. "We have never asked NOVA" and "NOVA owns
  // nothing" are different facts, and only one of them justifies skipping.
  assert.equal(ac.novaClaimedCached(), null);
  const out = ac.syncNoteActionCandidatesUnlessNova(NOTE);
  assert.notEqual(out.novaOwned, true);
});

test('a note NOVA owns is left to NOVA, and says so', () => {
  ac._novaInternals.seedClaimCache(['PLAUD123']);
  const out = ac.syncNoteActionCandidatesUnlessNova(NOTE);
  assert.equal(out.novaOwned, true);
  assert.equal(out.created, 0);
  assert.equal(out.candidates.length, 0);
});

test('a note NOVA does not own is still extracted, even with a warm claim set', () => {
  // The failure that would matter most: a working exclusion that excludes
  // everything.
  ac._novaInternals.seedClaimCache(['SOMEBODY-ELSES-RECORDING']);
  const out = ac.syncNoteActionCandidatesUnlessNova(NOTE);
  assert.notEqual(out.novaOwned, true);
});

test('a note NOVA does not own is extracted here', () => {
  const abs = path.join(vault, NOTE);
  assert.equal(ac._novaInternals.novaClaimedNote(abs, new Set(['SOMETHING-ELSE'])), false);
});

test('an unreadable note is not treated as claimed', () => {
  // Fail open: if we cannot read the frontmatter we cannot know NOVA owns it,
  // and skipping on that basis loses the commitment entirely.
  assert.equal(ac._novaInternals.novaClaimedNote(path.join(vault, 'nope.md'), new Set(['PLAUD123'])), false);
});

test('the exclusion only ever applies to meeting notes', () => {
  // A People card or a daily note carrying a `plaud_id` is not a 1-2-1
  // recording NOVA extracted, and skipping one would silently stop a whole
  // folder being read.
  const src = fs.readFileSync(path.join(__dirname, 'action-candidates.js'), 'utf-8');
  const fn = src.slice(src.indexOf('function syncNoteActionCandidatesUnlessNova'));
  assert.match(fn, /isMeetingNote\(relativePath\)/);
});

test('the hook calls the excluding variant, not the bare one', () => {
  // The whole bug was one call site using the wrong function.
  const src = fs.readFileSync(path.join(__dirname, 'vault-hooks.js'), 'utf-8');
  assert.match(src, /syncNoteActionCandidatesUnlessNova\(relativePath\)/);
  assert.doesNotMatch(src, /actionCandidates\.syncNoteActionCandidates\(relativePath\)/);
});

test('the sync path never awaits a network call', () => {
  // `onVaultWrite` is sync and is called fire-and-forget from a dozen places
  // that do not await it. The claim set is a cache read; the refresh is fired
  // behind it. (The `team-availability` live-vs-cache split.)
  const src = fs.readFileSync(path.join(__dirname, 'action-candidates.js'), 'utf-8');
  const fn = src.slice(
    src.indexOf('function syncNoteActionCandidatesUnlessNova'),
    src.indexOf('module.exports = {'),
  );
  // Comments stripped — the one above the call says "not awaited".
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /await/);
  assert.match(fn, /refreshNovaClaimed\(\)/);
});
