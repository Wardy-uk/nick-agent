'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

function freshRoute(vaultPath, apiKey) {
  process.env.OBSIDIAN_VAULT_PATH = vaultPath;
  process.env.DND_VAULT_ROOT = 'Projects/D&D';
  process.env.DND_VAULT_API_KEY = apiKey;
  delete require.cache[require.resolve('./vault-dnd')];
  return require('./vault-dnd');
}

async function withServer(route, fn) {
  const app = express();
  app.use(express.json());
  app.use(route);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('D&D vault route blocks missing or wrong keys', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vault-dnd-auth-'));
  fs.mkdirSync(path.join(vaultPath, 'Projects', 'D&D'), { recursive: true });
  const route = freshRoute(vaultPath, 'test-key');

  await withServer(route, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/list`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${baseUrl}/list`, { headers: { 'X-Api-Key': 'wrong-key' } });
    assert.equal(wrong.status, 401);
  });
});

test('D&D vault route lists and writes only inside Projects/D&D', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vault-dnd-write-'));
  fs.mkdirSync(path.join(vaultPath, 'Projects', 'D&D', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, 'Projects', 'D&D', 'Campaign.md'), '# Campaign\n', 'utf8');
  const route = freshRoute(vaultPath, 'test-key');

  await withServer(route, async (baseUrl) => {
    const listRes = await fetch(`${baseUrl}/list`, { headers: { 'X-Api-Key': 'test-key' } });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.deepEqual(listData.dir, '');
    assert.ok(listData.files.some(f => f.name === 'Campaign.md'));

    const writeRes = await fetch(`${baseUrl}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'test-key' },
      body: JSON.stringify({ path: 'Sessions/Session 01.md', content: '# Session 01\n' }),
    });
    assert.equal(writeRes.status, 200);
    assert.equal(
      fs.existsSync(path.join(vaultPath, 'Projects', 'D&D', 'Sessions', 'Session 01.md')),
      true
    );

    const outsideRes = await fetch(`${baseUrl}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'test-key' },
      body: JSON.stringify({ path: '../People/Nope.md', content: 'x' }),
    });
    assert.equal(outsideRes.status, 400);
    assert.equal(fs.existsSync(path.join(vaultPath, 'Projects', 'People', 'Nope.md')), false);
  });
});

test('D&D vault route search returns D&D-relative paths', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vault-dnd-search-'));
  fs.mkdirSync(path.join(vaultPath, 'Projects', 'D&D', 'NPCs'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, 'Projects', 'D&D', 'NPCs', 'Bob.md'), 'Bob guards the bridge.\n', 'utf8');
  const route = freshRoute(vaultPath, 'test-key');

  await withServer(route, async (baseUrl) => {
    const searchRes = await fetch(`${baseUrl}/search?query=bridge`, { headers: { 'X-Api-Key': 'test-key' } });
    assert.equal(searchRes.status, 200);
    const data = await searchRes.json();
    assert.deepEqual(data.results.map(r => r.path), ['NPCs/Bob.md']);
  });
});
