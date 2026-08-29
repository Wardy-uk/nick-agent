'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ex = require('./vault-exclusions');

test('the retrieval index does not read the bin', () => {
  // 709 Archive files and 43 _toDelete were 24% of the index.
  assert.equal(ex.isExcludedPath('Archive/2026/old meeting.md'), true);
  assert.equal(ex.isExcludedPath('_toDelete/whatever.md'), true);
  assert.equal(ex.isExcludedPath('Meetings/2026/08/2026-08-14 standup.md'), false);
});

test('NEURO does not index its own reports', () => {
  // The system citing its own hygiene logs as a source is a loop, not a search.
  assert.equal(ex.isExcludedPath('Documents/System/Vault Audit/lint-2026-08-14.md'), true);
  assert.equal(ex.isExcludedPath('Documents/System/SARA Import Reports/2026-08-14.md'), true);
});

test('generated task lists are excluded by FILENAME, wherever they sit', () => {
  // These are why Hope's person page ranked a MoSCoW worksheet and a .backup-
  // copy of it above her actual meetings: they name everyone, so they match
  // every person query while saying nothing about anyone.
  assert.equal(ex.isExcludedPath('Tasks/NEURO Tasks (export).md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Master Todo.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/MoSCoW - Open Actions 2026-08-12.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Master Todo.backup-2026-08-12.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Microsoft Tasks.sync-conflict-20260812.md'), true);
  // A real note that merely lives in Tasks/ is still a note.
  assert.equal(ex.isExcludedPath('Tasks/Task System Boundary.md'), false);
});

test('Daily/ is excluded from embeddings and kept for entity extraction', () => {
  // "Who did I mention on Tuesday" is exactly what daily notes answer, and
  // exactly what a semantic index of hundreds of scratchpads ruins.
  assert.equal(ex.isExcludedPath('Daily/2026-08-14.md', { forEmbeddings: true }), true);
  assert.equal(ex.isExcludedPath('Daily/2026-08-14.md'), false);
});

test('a lint backup is never content', () => {
  assert.equal(ex.isExcludedPath('Scripts/.lint-backups/2026-08-14/People/Hope.md'), true);
});

// ── Sensitive ────────────────────────────────────────────────────────────────

test('⚠ Personal/ is kept OUT of the person graph and IN the search index', () => {
  // `Personal/` holds Nick's disciplinary prep, the fraud investigation, his GP
  // notes and three Occupational Health documents. Two different answers for two
  // different consumers, and getting either backwards is a real harm:
  //
  //  • entity extraction MUST skip it, or the HR officer who handled his
  //    disciplinary, the external OH assessor and his GP enter the person graph,
  //    get ranked on mentions pages, and become people-gap stubs.
  //  • embeddings MUST NOT skip it. This is Nick's own brain and he has to be
  //    able to ask it about his own OH report; the guards that matter for this
  //    material are the outbound ones, not the index.
  assert.equal(ex.isExcludedPath('Personal/Occupational Health Debrief - 15 July 2026.md'), true);
  assert.equal(
    ex.isExcludedPath('Personal/Occupational Health Debrief - 15 July 2026.md', { forEmbeddings: true }),
    false,
  );
  assert.equal(ex.isSensitivePath('Personal/GP Appointment Prep - 16 July 2026.md'), true);
  assert.equal(ex.isSensitivePath('Meetings/2026/08/standup.md'), false);
});

test('the two exclusion sets are NOT one a superset of the other', () => {
  // They used to differ only by Daily/, so anything added to the base was
  // excluded from both — which would have removed the sensitive folder from
  // search as well as from the person graph. The divergence is the fix, and a
  // future tidy-up that "unifies" them would silently undo it.
  assert.equal(ex.ENTITY_EXCLUDED_DIRS.has('Personal'), true);
  assert.equal(ex.EMBEDDING_EXCLUDED_DIRS.has('Personal'), false);
  assert.equal(ex.EMBEDDING_EXCLUDED_DIRS.has('Daily'), true);
  assert.equal(ex.ENTITY_EXCLUDED_DIRS.has('Daily'), false);
});

test('⚠ Personal/ is sensitive WORK material, not personal life', () => {
  // The distinction is load-bearing in both directions. Reading this folder as
  // "personal life" would hide Nick's OH and disciplinary history from the work
  // surfaces where it is genuinely relevant, AND leave actual family notes
  // indexed — wrong twice from one wrong assumption.
  assert.equal(ex.noteDomain('Personal/Investigation Prep.md'), 'work');
  assert.equal(ex.isPersonalPath('Personal/Investigation Prep.md'), false);
});

test('personal life is empty by default and must be declared', () => {
  // `Personal/` is already taken and means something else, and no other folder
  // in this vault is unambiguously home life. Guessing would silently change
  // what the index holds and what the person graph learns.
  assert.deepEqual(ex.PERSONAL_DIRS, []);
  assert.equal(ex.noteDomain('Meetings/2026/08/standup.md'), 'work');
});

test('frontmatter beats the path, and unmarked is work', () => {
  // A single note can legitimately sit in the wrong folder, and frontmatter is
  // the only way to mark one before a folder exists. Unmarked is work, the same
  // asymmetry shared/task-domain.cjs argues: a personal note read as work is
  // visible, the reverse is silent.
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'personal' }), 'personal');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'PERSONAL' }), 'personal');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', {}), 'work');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'nonsense' }), 'work');
});
