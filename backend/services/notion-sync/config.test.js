'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A scratch vault, so the guard is exercised against real directories and the
// suite never touches the live one (#119 — `npm test` must not reach the vault).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-sync-cfg-'));
for (const dir of ['Projects', 'Projects/Notion', 'Areas', 'Personal', 'Archive', 'Templates']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
process.env.OBSIDIAN_VAULT_PATH = root;

const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Page id normalisation — Nick will paste a URL, not a uuid.
// ─────────────────────────────────────────────────────────────────────────────

test('a pasted Notion URL yields the page id, taking the LAST 32-hex run', () => {
  const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const dashed = 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90';
  assert.equal(config.normalisePageId(`https://www.notion.so/Team-Handbook-${id}`), dashed);
  assert.equal(config.normalisePageId(id), dashed);
  assert.equal(config.normalisePageId(dashed), dashed);
});

test('a URL carrying two ids takes the page, not the leading workspace slug', () => {
  const workspace = '00000000000000000000000000000001';
  const page = '00000000000000000000000000000002';
  assert.equal(
    config.normalisePageId(`https://notion.so/${workspace}/Page-${page}`),
    '00000000-0000-0000-0000-000000000002',
  );
});

test('something that is not an id is null, never a guess', () => {
  assert.equal(config.normalisePageId('not-a-page'), null);
  assert.equal(config.normalisePageId(''), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusals. These are the safety model, not edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('the sensitive folder is REFUSED outright, not warned about', () => {
  // Personal/ holds HR, disciplinary, occupational health and GP material. A
  // mapping is the most complete possible exfiltration of a folder, and Notion
  // is an external service.
  const refusal = config.folderRefusal('Personal');
  assert.ok(refusal, 'Personal must be refused');
  assert.match(refusal, /occupational health|HR|medical/i);
  assert.ok(config.folderRefusal('Personal/Sub'), 'a subfolder must be refused too');
});

test('excluded folders (retired, generated, transient) are refused', () => {
  assert.ok(config.folderRefusal('Archive'));
  assert.ok(config.folderRefusal('Templates'));
  assert.ok(config.folderRefusal('Projects/Archive'));
});

test('a path escaping the vault is refused', () => {
  assert.ok(config.folderRefusal('../elsewhere'));
  assert.ok(config.folderRefusal('Projects/../../etc'));
});

test('an ordinary folder is allowed', () => {
  assert.equal(config.folderRefusal('Projects/Notion'), null);
  assert.equal(config.folderRefusal('Areas'), null);
});

test('an unreadable vault fails CLOSED, so the guard cannot be bypassed', () => {
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = '';
  try {
    assert.ok(config.folderRefusal('Projects'), 'no vault must refuse, not allow');
  } finally { process.env.OBSIDIAN_VAULT_PATH = saved; }
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-table rules — relationships between rows.
// ─────────────────────────────────────────────────────────────────────────────

const row = (over = {}) => ({
  notionPageId: '00000000000000000000000000000001',
  vaultFolder: 'Projects/Notion',
  mode: 'two-way',
  enabled: true,
  ...over,
});

test('overlapping vault folders are rejected in BOTH nesting directions', () => {
  const parentFirst = config.validate([
    row({ vaultFolder: 'Projects' }),
    row({ vaultFolder: 'Projects/Notion', notionPageId: '00000000000000000000000000000002' }),
  ].map((r, i) => ({ ...r, id: `r${i}` })));
  assert.ok(parentFirst.some((e) => /overlap/i.test(e)));

  const childFirst = config.validate([
    row({ vaultFolder: 'Projects/Notion' }),
    row({ vaultFolder: 'Projects', notionPageId: '00000000000000000000000000000002' }),
  ].map((r, i) => ({ ...r, id: `r${i}` })));
  assert.ok(childFirst.some((e) => /overlap/i.test(e)),
    'a parent added after its child must be caught too');
});

test('one Notion page cannot be mapped to two folders', () => {
  const errors = config.validate([
    row({ vaultFolder: 'Projects/Notion' }),
    row({ vaultFolder: 'Areas' }),
  ].map((r, i) => ({ ...r, id: `r${i}` })));
  assert.ok(errors.some((e) => /already mapped/i.test(e)));
});

test('an unknown mode is rejected rather than silently defaulted at validate time', () => {
  const errors = config.validate([{ ...row(), mode: 'merge', id: 'r0' }]);
  assert.ok(errors.some((e) => /mode/i.test(e)));
});

test('two distinct, non-overlapping mappings validate clean', () => {
  const errors = config.validate([
    { ...row({ vaultFolder: 'Projects/Notion' }), id: 'r0' },
    { ...row({ vaultFolder: 'Areas', notionPageId: '00000000000000000000000000000002' }), id: 'r1' },
  ]);
  assert.deepEqual(errors, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The picker.
// ─────────────────────────────────────────────────────────────────────────────

test('the folder picker omits sensitive and excluded folders entirely', () => {
  const { known, folders } = config.vaultFolders();
  assert.equal(known, true);
  assert.ok(folders.includes('Projects'));
  assert.ok(folders.includes('Projects/Notion'));
  // Offered-then-refused invites the question of why; the answer is not one to
  // put in a tooltip.
  assert.ok(!folders.includes('Personal'), 'Personal must not be offered');
  assert.ok(!folders.includes('Archive'), 'Archive must not be offered');
  assert.ok(!folders.includes('Templates'));
});

test('an unreadable vault reports known:false, not an empty folder list', () => {
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'does-not-exist');
  try {
    const result = config.vaultFolders();
    assert.equal(result.known, false);
    assert.ok(result.reason);
  } finally { process.env.OBSIDIAN_VAULT_PATH = saved; }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
