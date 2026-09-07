'use strict';

/**
 * Routing for the competency-4 baseline.
 *
 * ⚠ `/baseline` is a literal on a router that also carries `/log/:id`,
 * `/markdown` and `/manual`. This repo has shipped a literal path swallowed by
 * a sibling parameterised one more than once, and a green service suite says
 * nothing about it. Mutation check: rename the path and these fail.
 *
 * The other job is the one the pure suite cannot do — proving the stored figure
 * actually reaches `status().baseline`. Storing it and reading it back through
 * a different code path is precisely where a fix like this quietly does
 * nothing, and the failure looks identical to the bug it replaced: a confident
 * number about 27 July that nothing measured.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-baseline-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(scratch, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');

let server;
let base;

before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/weekly-risk', require('./weekly-risk'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
};
const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('GET /baseline resolves to the baseline, not to a log row named "baseline"', async () => {
  const { status, body } = await get('/api/weekly-risk/baseline');
  assert.equal(status, 200);
  assert.ok(body.baseline, 'no baseline block — something else answered');
  assert.equal(body.baseline.date, '2026-07-27');
});

test('an empty log answers NOT RECORDED, never zero', async () => {
  const { body } = await get('/api/weekly-risk/baseline');
  assert.equal(body.baseline.known, false);
  assert.equal(body.baseline.count, null, 'null, never 0 — the bug of 7 Sep 2026');
  assert.equal(body.agreed, null);
  assert.match(body.baseline.reason, /2026-07-27/);
});

test('an agreed figure is stored and reaches the assessment', async () => {
  const saved = await post('/api/weekly-risk/baseline', { count: 6, agreedOn: '2026-09-08', note: 'Agreed at the 1-2-1.' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.baseline.count, 6);
  assert.equal(saved.body.baseline.source, 'agreed');

  // Read back through the other route, so a write that only decorated its own
  // response cannot pass.
  const { body } = await get('/api/weekly-risk/baseline');
  assert.equal(body.baseline.known, true);
  assert.equal(body.baseline.count, 6);
  assert.equal(body.agreed.agreedOn, '2026-09-08');
});

test('an agreed ZERO survives — it is a claim somebody made', async () => {
  await post('/api/weekly-risk/baseline', { count: 0 });
  const { body } = await get('/api/weekly-risk/baseline');
  assert.equal(body.baseline.known, true);
  assert.equal(body.baseline.source, 'agreed');
  assert.equal(body.baseline.count, 0);
});

test('omitting the count is a 400, and is NOT the same as sending zero', async () => {
  const { status, body } = await post('/api/weekly-risk/baseline', { note: 'no number' });
  assert.equal(status, 400);
  assert.match(body.error, /not the same as zero/i);
  // And the stored figure is untouched by the refusal.
  const after = await get('/api/weekly-risk/baseline');
  assert.equal(after.body.baseline.count, 0);
});

test('null clears it back to unrecorded rather than to zero', async () => {
  const cleared = await post('/api/weekly-risk/baseline', { count: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.agreed, null);
  const { body } = await get('/api/weekly-risk/baseline');
  assert.equal(body.baseline.known, false);
  assert.equal(body.baseline.count, null);
});
