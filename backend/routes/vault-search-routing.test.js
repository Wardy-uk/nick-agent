'use strict';

/**
 * `/api/vault/search` over real HTTP.
 *
 * ⚠ This route was a THIRD substring walker with its own copy of every bug
 * `services/retrieval.js` had — depth capped at 4, an early stop at 20 results
 * in filesystem order, no ranking, no semantic arm. It is what the MCP
 * `search_vault` tool calls, so every external Claude Code session searching
 * this vault got the crudest of the three answers and could not tell, because
 * a substring walk always returns something.
 *
 * It runs on the unified retrieval now. What is under test is that the
 * migration kept the response shape two existing consumers already depend on —
 * `VaultBrowser` renders `matches[].text`, the MCP tool reads either that or
 * `excerpts` — and that `dir` is a real scope rather than a hint.
 *
 * ⚠ `/search` is a literal sitting beside `/search/temporal`. Express matches
 * in registration order, which is exactly the shape that once made
 * `/api/email/triage/feedback` answer "Email not found" for a fortnight.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vaultsearch-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
// The whole router sits behind `requireApiKey`, which refuses everything with a
// 503 when `VAULT_API_KEY` is unset — a deliberate fail-closed default. Without
// this the suite would test the guard rather than the route.
process.env.VAULT_API_KEY = 'test-vault-key';

const db = require('../db/database');

function write(rel, body) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

let server;
let base;

test.before(async () => {
  await db.init();
  write('Meetings/2026/08/standup.md', 'The succession plan was discussed with the team.');
  // Five levels down — past the depth-4 cap the old walker had.
  write('Meetings/2026/08/deep/deeper/deepest/buried.md', 'Succession plan detail buried five levels down.');
  write('Projects/elsewhere.md', 'Succession plan for the wider business.');

  const app = express();
  app.use(express.json());
  app.use('/api/vault', require('./vault'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function get(p) {
  const res = await fetch(`${base}${p}`, { headers: { 'x-api-key': process.env.VAULT_API_KEY } });
  return { status: res.status, body: await res.json() };
}

test('it answers, and keeps the shape VaultBrowser and the MCP tool already read', async () => {
  const { status, body } = await get('/api/vault/search?query=succession%20plan');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.length > 0);
  const first = body.results[0];
  assert.ok(first.path && first.name);
  // `VaultBrowser` renders `matches[].text`; the MCP tool reads either.
  assert.ok(Array.isArray(first.matches));
  assert.ok(Array.isArray(first.excerpts));
  assert.equal(typeof first.matches[0].text, 'string');
  // `line` is null rather than invented — a fabricated line number is worse
  // than none on a screen that offers to jump to it.
  assert.equal(first.matches[0].line, null);
});

test('`dir` is a real SCOPE, not a hint', async () => {
  const { body } = await get('/api/vault/search?query=succession%20plan&dir=Meetings');
  assert.ok(body.results.length > 0);
  for (const r of body.results) {
    assert.ok(r.path.startsWith('Meetings/'), `out-of-scope result leaked: ${r.path}`);
  }
});

test('a deep but permitted path is searched', async () => {
  const { body } = await get('/api/vault/search?query=buried%20five%20levels');
  assert.ok(
    body.results.some((r) => r.path === 'Meetings/2026/08/deep/deeper/deepest/buried.md'),
    'the old walker stopped at depth 4 and could never have reached this'
  );
});

test('the index health rides back, so a thin result can say why', async () => {
  const { body } = await get('/api/vault/search?query=succession%20plan');
  assert.ok(body.health, 'no caller should have to guess why a result set is thin');
  assert.equal(typeof body.health.semanticAvailable, 'boolean');
});

test('a traversal attempt is refused before it can become a scope', async () => {
  const { status } = await get('/api/vault/search?query=x&dir=..%2F..%2Fetc');
  assert.equal(status, 400);
});

test('a missing query is a 400, never an empty result set', async () => {
  // An empty list here would read as "the vault has nothing", which is a
  // statement about the vault rather than about the request.
  const { status } = await get('/api/vault/search');
  assert.equal(status, 400);
});

test('/search does not swallow /search/temporal', async () => {
  const { status, body } = await get('/api/vault/search/temporal?query=succession&from=2020-01-01');
  assert.equal(status, 200);
  // ⚠ The discriminator used to be "temporal returns no `health`". It now
  // returns one — that was the whole point of retiring its bespoke walker — so
  // the marker had to change or this test would have gone on passing for the
  // wrong reason. The range is the thing only the temporal route answers with.
  assert.ok(body && Object.prototype.hasOwnProperty.call(body, 'from'), 'temporal echoes its range');
  assert.ok(body && Object.prototype.hasOwnProperty.call(body, 'to'));
  // And it is still a real answer, not `/search` matching the literal path.
  assert.equal(body.health.temporalComplete, true, 'the temporal arm actually ran');
});
