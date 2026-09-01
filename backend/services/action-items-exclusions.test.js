'use strict';

/**
 * Pins the exclusion list onto `/api/vault-actions`.
 *
 * It scanned Meetings/, Tasks/, Documents/HR/ and People/ and applied NO
 * exclusions, so it read files the vault had deliberately retired and files
 * NEURO itself generates. Measured live on 1 Sep 2026: 3,218 open action items,
 * 307 of them past a due date — and only 84 real. The rest came from
 * Tasks/Archive (1,055 rows), the read-only task export and a Syncthing
 * conflict copy of it (233), and five `.sync-conflict-` copies of the Microsoft
 * mirror counting the same tasks five times over.
 *
 * `fileIsRecent` cannot catch any of it, because Syncthing rewrites mtimes: a
 * note retired in July looks like it was touched this morning. And no consumer
 * could tell — VANTAGE's radar was reporting the 307 to Nick as commitments he
 * had broken.
 *
 * The fixtures are the real filenames that leaked, not invented ones.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findActionItems } = require('./action-items');

const LINE = '- [ ] a thing that is not done 📅 2020-01-01';

function scratchVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-actions-'));
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `# note\n\n${LINE}\n`);
  }
  return root;
}

function scan(files) {
  const root = scratchVault(files);
  const before = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    return findActionItems({ status: 'open', daysBack: 0 }).map(i => i.file);
  } finally {
    if (before === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a real meeting note is still read', () => {
  const found = scan(['Meetings/2026/09/2026-09-01 Team catch-up.md']);
  assert.deepEqual(found, ['Meetings/2026/09/2026-09-01 Team catch-up.md']);
});

test('a retired file under Tasks/Archive is not an outstanding commitment', () => {
  // 1,055 live rows came from here. Archiving is how this vault says "done
  // with"; reading it back turns a decision into a backlog.
  assert.deepEqual(scan(['Tasks/Archive/Master Todo (retired 2026-08-16).md']), []);
});

test('the read-only task export is not a second copy of every task', () => {
  assert.deepEqual(scan(['Tasks/NEURO Tasks (export).md']), []);
});

test('a Syncthing conflict copy is not another set of commitments', () => {
  // The exact filenames that were being counted, five of them for one file.
  assert.deepEqual(scan([
    'Tasks/NEURO Tasks (export).sync-conflict-20260816-192001-FSW6YOT.md',
    'Tasks/Microsoft Tasks.sync-conflict-20260818-081819-FSW6YOT.md',
    'Tasks/Microsoft Tasks.sync-conflict-20260826-083240-FSW6YOT.md',
  ]), []);
});

test('the retired Master Todo is excluded wherever it sits', () => {
  assert.deepEqual(scan(['Tasks/Master Todo.md']), []);
});

test('one real note among the noise is found, and only it', () => {
  // The whole shape of the bug in one assertion: a genuine commitment
  // outnumbered five to one by copies of itself.
  const found = scan([
    'Meetings/2026/09/2026-09-01 1-2-1.md',
    'Tasks/Archive/All Tasks.md',
    'Tasks/NEURO Tasks (export).md',
    'Tasks/NEURO Tasks (export).sync-conflict-20260816-192001-FSW6YOT.md',
    'Tasks/Microsoft Tasks.sync-conflict-20260820-084241-FSW6YOT.md',
    'Tasks/Master Todo.md',
  ]);
  assert.deepEqual(found, ['Meetings/2026/09/2026-09-01 1-2-1.md']);
});

test('the live Microsoft mirror itself is still read — only its conflict copies are dropped', () => {
  // Deliberate: that file is Microsoft's own open tasks, not a retired or
  // generated artefact. Dropping it would be a separate decision, and this
  // change is only "apply the exclusions that already exist".
  assert.deepEqual(scan(['Tasks/Microsoft Tasks.md']), ['Tasks/Microsoft Tasks.md']);
});
