'use strict';

/**
 * `/api/vault-hygiene/fix/*` over real HTTP — the two calls Brain Health makes.
 *
 * A green service suite says NOTHING about routing, and this pair had no UI at
 * all until 7 Sep: `fixPlan`/`fixApply` were built, routed and reachable only
 * from the MCP tool, so nothing had ever driven them from a screen.
 *
 * ⚠ The load-bearing assertion is that `only` SURVIVES THE ROUTE. A handler
 * that dropped it would still answer 200 and still repoint links — just the
 * tier's, not the ones ticked — which is indistinguishable from working unless
 * the test checks WHICH link moved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vh-route-'));
process.env.OBSIDIAN_VAULT_PATH = root;   // read at module load, so set it first

let server;
let base;

const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
};

function seed() {
  const files = {
    'Notes/Close.md': 'See [[2026-04-30 Meeting Financial Impact and Cost Saving]].',
    'Meetings/2026-04-30 Meeting Financial Impact and Cost Savings.md': '# close',
    'Notes/Guess.md': 'See [[NOVA_REVIEW_2026-04-27]].',
    'Reviews/W24-2026-review.md': '# a different note entirely',
  };
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const links = (rel, target) => read(rel).includes('[[' + target + ']]');

test.before(async () => {
  seed();
  const app = express();
  app.use(express.json());
  app.use('/api/vault-hygiene', require('./vault-hygiene'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('the preview returns the shape the panel reads', async () => {
  const r = await post('/api/vault-hygiene/fix/plan');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // The panel renders `summary.links.*`, `summary.missing` and `summary.archivedLinks`
  // in its one-line result; a missing branch there throws inside render.
  assert.equal(typeof r.body.summary.links.conservative, 'number');
  assert.equal(typeof r.body.summary.links.moderate, 'number');
  assert.equal(typeof r.body.summary.links.aggressive, 'number');
  assert.equal(typeof r.body.summary.missing, 'number');
  assert.equal(typeof r.body.summary.archivedLinks, 'number');

  // ⚠ Without `key` on every proposal there is nothing for a tick to name, and
  // the pick list would silently degrade to "apply the tier".
  assert.ok(r.body.linkFixes.length > 0);
  for (const f of r.body.linkFixes) {
    assert.match(f.key, /^[0-9a-f]{12}$/);
    assert.equal(typeof f.oldTarget, 'string');
    assert.equal(typeof f.newBase, 'string');
    assert.equal(typeof f.sim, 'number');
  }
});

test('a ticked guess reaches the service — `only` is not dropped in transit', async () => {
  const plan = await post('/api/vault-hygiene/fix/plan');
  const guess = plan.body.linkFixes.find((f) => f.tier === 'aggressive');
  assert.ok(guess, 'fixture must offer an aggressive proposal or this proves nothing');

  const r = await post('/api/vault-hygiene/fix/apply', { links: 'skip', only: [guess.key] });

  assert.equal(r.status, 200);
  assert.equal(r.body.repointed, 1);
  assert.deepEqual(r.body.onlyUnmatched, []);
  assert.ok(links('Notes/Guess.md', guess.newBase), 'the ticked guess must have been applied');
  assert.ok(
    links('Notes/Close.md', '2026-04-30 Meeting Financial Impact and Cost Saving'),
    'skip means skip — the tier must not have run just because a pick list was sent',
  );
});

test('a stale tick comes back named, not silently ignored', async () => {
  const r = await post('/api/vault-hygiene/fix/apply', { links: 'skip', only: ['deadbeef0000'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.repointed, 0);
  assert.deepEqual(r.body.onlyUnmatched, ['deadbeef0000']);
});

test('the tier alone never sweeps in a best guess', async () => {
  // Re-seed: the previous test applied the guess.
  seed();
  const r = await post('/api/vault-hygiene/fix/apply', { links: 'moderate' });

  assert.equal(r.status, 200);
  assert.ok(r.body.repointed >= 1);
  assert.ok(links('Notes/Guess.md', 'NOVA_REVIEW_2026-04-27'), 'the guess must survive a run nobody ticked it in');
  assert.ok(r.body.backupDir, 'the panel prints this; a write with no backup path is a write with no way back');
});

test('an unconfigured vault refuses rather than resolving against the process cwd', async () => {
  // The capture drop-box wrote into the repo for exactly this reason: a relative
  // join does not fail, it succeeds somewhere nobody is looking.
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  try {
    delete require.cache[require.resolve('./vault-hygiene')];
    process.env.OBSIDIAN_VAULT_PATH = '';
    const app = express();
    app.use(express.json());
    app.use('/api/vault-hygiene', require('./vault-hygiene'));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/vault-hygiene/fix/plan`, { method: 'POST' });
    assert.equal(res.status, 503);
    srv.close();
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = saved;
    delete require.cache[require.resolve('./vault-hygiene')];
  }
});
