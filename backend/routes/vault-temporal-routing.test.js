'use strict';

/**
 * `/api/vault/search/temporal` over real HTTP.
 *
 * ⚠ This was the LAST bespoke walker in the codebase, and it carried every bug
 * `/api/vault/search` was rebuilt to remove: depth capped at 4, an early stop
 * at `limit * 3` in raw filesystem order, no ranking, no semantic arm, no
 * scope — and no way at all for a caller to tell a complete answer from a
 * partial one. A date-bounded search is the single easiest result in NEURO to
 * misread as proof: "nothing came back for last week" reads as "nothing
 * happened last week".
 *
 * ⚠ A green service suite says nothing about routing, and `/search/temporal`
 * sits beside the literal `/search`. Express matches in registration order,
 * which is the shape that once made `/api/email/triage/feedback` answer
 * "Email not found" for a fortnight — so this runs against a real server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vaulttemporal-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
// The whole router fails closed without this — the suite would test the guard.
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
  // ⚠ Five levels down — unreachable to the old depth-4 walker, and the whole
  // reason a "nothing happened that week" answer could be wrong.
  write('Meetings/2026/08/deep/deeper/deepest/buried.md', 'Succession plan detail buried five levels down.');
  write('Projects/elsewhere.md', 'Succession plan for the wider business, outside Meetings.');

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

// A window wide enough that mtime (which is "just now" for these fixtures)
// always falls inside it.
const RANGE = 'from=2000-01-01&to=2099-01-01';

test('it finds a note FIVE levels deep — the depth-4 walker is gone', async () => {
  const { status, body } = await get(`/api/vault/search/temporal?query=succession%20plan&${RANGE}&limit=20`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.results));
  assert.ok(
    body.results.some(r => r.path === 'Meetings/2026/08/deep/deeper/deepest/buried.md'),
    'the buried note must be reachable',
  );
});

test('it returns health, so a thin week is never mistaken for a quiet one', async () => {
  const { body } = await get(`/api/vault/search/temporal?query=succession&${RANGE}`);
  assert.ok(body.health, 'health must ride along');
  assert.equal(typeof body.health.truncated, 'boolean');
  assert.ok(Array.isArray(body.health.truncationReasons));
  assert.equal(typeof body.health.keywordComplete, 'boolean');
  // Temporal WAS requested here, so this is a boolean rather than null.
  assert.equal(typeof body.health.temporalComplete, 'boolean');
});

test('it keeps the compatibility shape: results, excerpts, matches, and the range', async () => {
  const { body } = await get(`/api/vault/search/temporal?query=succession&${RANGE}&limit=20`);
  const hit = body.results.find(r => r.path === 'Meetings/2026/08/standup.md');
  assert.ok(hit, 'the shallow note is found');
  assert.ok(Array.isArray(hit.excerpts));
  assert.ok(Array.isArray(hit.matches));
  // `line` is null rather than invented — same rule as /search.
  if (hit.matches.length) assert.equal(hit.matches[0].line, null);
  assert.ok(body.from && body.to, 'the requested range comes back');
});

test('dir is a real scope — temporal results obey it exactly as /search does', async () => {
  const { body } = await get(`/api/vault/search/temporal?query=succession&${RANGE}&limit=20&dir=Meetings`);
  assert.ok(body.results.length > 0, 'the scope is not empty');
  assert.ok(
    body.results.every(r => r.path.startsWith('Meetings/')),
    'nothing outside Meetings/ may appear in a Meetings-scoped search',
  );
  assert.ok(!body.results.some(r => r.path === 'Projects/elsewhere.md'));
  assert.equal(body.health.scope.kind, 'folder');
  assert.equal(body.health.scope.value, 'Meetings');
});

test('a traversal attempt in dir is refused, not normalised', async () => {
  const { status, body } = await get(`/api/vault/search/temporal?query=succession&${RANGE}&dir=${encodeURIComponent('../../etc')}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid path/);
});

test('a missing query is a 400, not an empty week', async () => {
  const { status } = await get(`/api/vault/search/temporal?${RANGE}`);
  assert.equal(status, 400);
});

test('the API key guard still holds on the temporal route', async () => {
  const res = await fetch(`${base}/api/vault/search/temporal?query=succession&${RANGE}`);
  assert.equal(res.status, 401);
});

test('the range is a BOUND, not a ranking hint — no out-of-range note leaks in', async () => {
  // ⚠ Caught on the first run of this suite. Routing temporal through the fused
  // retrieval mixed in keyword and semantic hits that never saw the range, so a
  // search for last week returned a note from March, ranked above the ones from
  // last week. Notes that match the query perfectly but sit outside the window
  // must not appear at all.
  const { body } = await get('/api/vault/search/temporal?query=succession%20plan&from=1990-01-01&to=1990-01-02&limit=20');
  assert.deepEqual(body.results, [], 'a well-matching note outside the window is still outside the window');
});

test('a date range that excludes everything returns an empty list, not an error', async () => {
  const { status, body } = await get('/api/vault/search/temporal?query=succession&from=1990-01-01&to=1990-01-02');
  assert.equal(status, 200);
  assert.deepEqual(body.results, []);
  // ⚠ And it is honest about which kind of empty this is: the walk completed,
  // so the emptiness IS evidence — about that range.
  assert.equal(body.health.temporalComplete, true);
});
