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
