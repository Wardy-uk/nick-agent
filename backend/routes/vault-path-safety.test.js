'use strict';

/**
 * Vault path containment, over real HTTP.
 *
 * ⚠ THE BUG. Containment was `resolved.startsWith(path.resolve(VAULT_PATH))` —
 * a STRING prefix test, and a SIBLING DIRECTORY SHARES THE PREFIX. With the
 * vault at `C:\Vault`, the path `../Vault-old/secret.md` resolves to
 * `C:\Vault-old\secret.md`, which starts with `C:\Vault`. It passed. Every
 * route that reads, writes, appends, lists or DELETES would then operate
 * outside the vault, on a path the guard had just approved.
 *
 * This is not theoretical here: `nuero-vault` sits beside plenty of siblings on
 * the Pi, and Nick's vault has a `Personal/` folder holding disciplinary prep,
 * a fraud investigation and OH documents. A stale sibling copy of that is
 * exactly what must not be reachable.
 *
 * The fix asks the path library rather than the string. These tests run against
 * a real server because a green service suite says nothing about routing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

// ⚠ The vault and its evil twin are deliberately SIBLINGS sharing a prefix —
// `<base>/Vault` and `<base>/Vault-old`. That is the whole shape of the bug.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pathsafety-'));
const VAULT = path.join(base, 'Vault');
const SIBLING = path.join(base, 'Vault-old');
fs.mkdirSync(VAULT, { recursive: true });
fs.mkdirSync(SIBLING, { recursive: true });

process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_DB_PATH = path.join(base, 'scratch.db');
process.env.VAULT_API_KEY = 'test-vault-key';

const db = require('../db/database');

let server;
let origin;

const SECRET = 'THE SIBLING VAULT MUST NEVER BE READABLE';

test.before(async () => {
  await db.init();
  fs.writeFileSync(path.join(SIBLING, 'secret.md'), SECRET, 'utf-8');
  fs.mkdirSync(path.join(VAULT, 'Meetings', '2026', '08'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'Meetings', '2026', '08', 'note.md'), 'A legitimate nested note.', 'utf-8');

  const app = express();
  app.use(express.json());
  app.use('/api/vault', require('./vault'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

function call(method, p, body) {
  return fetch(`${origin}${p}`, {
    method,
    headers: { 'x-api-key': process.env.VAULT_API_KEY, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

// The two escapes: the sibling-prefix one the old guard let through, and the
// ordinary traversal it did catch. Both must be refused.
const SIBLING_ESCAPE = '../Vault-old/secret.md';
const PLAIN_ESCAPE = '../../etc/passwd';

// ── The unit the whole thing rests on ───────────────────────────────────────

test('safePath rejects a sibling-prefix escape', () => {
  const { _safePath } = require('./vault');
  assert.equal(_safePath(SIBLING_ESCAPE), null, 'the sibling vault is not inside the vault');
  assert.equal(_safePath(PLAIN_ESCAPE), null);
  assert.equal(_safePath('..'), null);
  // ⚠ The exact string that used to pass: resolved path starts with the vault
  // path, and is not inside it.
  const resolved = path.resolve(VAULT, SIBLING_ESCAPE);
  assert.ok(resolved.startsWith(VAULT), 'the old prefix test would have said yes');
  assert.equal(_safePath(SIBLING_ESCAPE), null, 'the new test says no');
});

test('safePath still allows legitimate nested paths, and the root itself', () => {
  const { _safePath } = require('./vault');
  assert.ok(_safePath('Meetings/2026/08/note.md'));
  assert.ok(_safePath('Meetings/2026/08/does-not-exist-yet.md'), 'a new file is not an escape');
  assert.ok(_safePath(''), 'the vault root resolves');
  assert.ok(_safePath('Meetings'));
});

test('safePath refuses when the vault root is unreadable', () => {
  const { _safePath } = require('./vault');
  const realpath = fs.realpathSync;
  try {
    fs.realpathSync = () => { throw new Error('ENOENT'); };
    assert.equal(_safePath('Meetings/note.md'), null, 'no verified root, no answer');
  } finally {
    fs.realpathSync = realpath;
  }
});

// ── Every route that resolves a path ────────────────────────────────────────

for (const escape of [SIBLING_ESCAPE, PLAIN_ESCAPE]) {
  const label = escape === SIBLING_ESCAPE ? 'sibling-prefix' : 'plain traversal';

  test(`read refuses a ${label} escape`, async () => {
    const { status, body } = await call('GET', `/api/vault/read?path=${encodeURIComponent(escape)}`);
    assert.equal(status, 400);
    assert.ok(!JSON.stringify(body).includes(SECRET), 'the sibling file must not be served');
  });

  test(`write refuses a ${label} escape`, async () => {
    const target = escape.replace('secret.md', 'written.md').replace('passwd', 'written.md');
    const { status } = await call('POST', '/api/vault/write', { path: target, content: 'should never land' });
    assert.equal(status, 400);
    assert.equal(fs.existsSync(path.join(SIBLING, 'written.md')), false, 'nothing may be written outside');
  });

  test(`append refuses a ${label} escape`, async () => {
    const { status } = await call('POST', '/api/vault/append', { path: escape, content: 'appended' });
    assert.equal(status, 400);
    assert.equal(fs.readFileSync(path.join(SIBLING, 'secret.md'), 'utf-8'), SECRET, 'the sibling file is untouched');
  });

  test(`list refuses a ${label} escape`, async () => {
    const dir = escape === SIBLING_ESCAPE ? '../Vault-old' : '../..';
    const { status, body } = await call('GET', `/api/vault/list?dir=${encodeURIComponent(dir)}`);
    assert.equal(status, 400);
    assert.ok(!JSON.stringify(body).includes('secret.md'));
  });

  test(`delete refuses a ${label} escape`, async () => {
    const { status } = await call('DELETE', `/api/vault/delete?path=${encodeURIComponent(escape)}`);
    assert.equal(status, 400);
    assert.equal(fs.existsSync(path.join(SIBLING, 'secret.md')), true, 'the sibling file survives');
  });

  test(`search refuses a ${label} escape in dir`, async () => {
    const dir = escape === SIBLING_ESCAPE ? '../Vault-old' : '../..';
    const { status } = await call('GET', `/api/vault/search?query=sibling&dir=${encodeURIComponent(dir)}`);
    assert.equal(status, 400);
  });

  test(`export-docx refuses a ${label} escape in subdir`, async () => {
    const dir = escape === SIBLING_ESCAPE ? '../Vault-old' : '../..';
    const { status } = await call('POST', '/api/vault/export-docx', { content: 'x', filename: 'esc', subdir: dir });
    assert.equal(status, 400);
    assert.equal(fs.existsSync(path.join(SIBLING, 'esc.md')), false);
  });
}

// ── And the legitimate cases still work ─────────────────────────────────────

test('a legitimate nested read still works', async () => {
  const { status, body } = await call('GET', '/api/vault/read?path=Meetings%2F2026%2F08%2Fnote.md');
  assert.equal(status, 200);
  assert.match(body.content, /legitimate nested note/);
});

test('creating a new note deep inside the vault still works', async () => {
  const rel = 'Meetings/2026/08/deep/deeper/created.md';
  const { status } = await call('POST', '/api/vault/write', { path: rel, content: 'new note' });
  assert.equal(status, 200);
  assert.equal(fs.readFileSync(path.join(VAULT, rel), 'utf-8'), 'new note');
});

test('a legitimate nested list still works', async () => {
  const { status, body } = await call('GET', '/api/vault/list?dir=Meetings%2F2026');
  assert.equal(status, 200);
  assert.ok(body.files.some(f => f.name === '08'));
});

// ── Symlink escape ──────────────────────────────────────────────────────────

test('a symlink inside the vault pointing outside it is refused', (t) => {
  const linkPath = path.join(VAULT, 'escape-link.md');
  try {
    fs.symlinkSync(path.join(SIBLING, 'secret.md'), linkPath, 'file');
  } catch {
    // Windows needs elevation or developer mode for symlinks. Skipping is
    // honest; claiming a pass here would be the opposite.
    t.skip('symlinks not creatable in this environment');
    return;
  }
  try {
    const { _safePath } = require('./vault');
    // ⚠ Textually this is `<vault>/escape-link.md` — inside by every string
    // test there is. Only resolving it says otherwise.
    assert.equal(_safePath('escape-link.md'), null, 'a link out of the vault is out of the vault');
  } finally {
    fs.unlinkSync(linkPath);
  }
});
