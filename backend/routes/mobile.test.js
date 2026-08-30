'use strict';

/**
 * The mobile contract over real HTTP.
 *
 * A green service suite says NOTHING about routing (16 Aug — a literal path
 * registered after a parameterised sibling was read as the parameter, and the
 * suite stayed green the whole time). So these tests stand up an actual Express
 * app, make actual requests and read actual responses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mobroute-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mobroute-vault-'));

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', require('./mobile'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function get(p) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
}

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Routing ──────────────────────────────────────────────────────────────────

test('GET /api/mobile/v1/nick-now resolves and returns the versioned schema', async () => {
  const { status, body } = await get('/api/mobile/v1/nick-now');
  assert.equal(status, 200);
  assert.equal(body.schema, 'neuro.mobile.nick-now/1');
  assert.ok(body.generatedAt);
});

test('GET /api/mobile/v1/readiness resolves and reports what was OBSERVED', async () => {
  const { status, body } = await get('/api/mobile/v1/readiness');
  assert.equal(status, 200);
  assert.equal(typeof body.ready, 'boolean');
  assert.ok(body.contract);
  assert.ok(body.supportedKinds.includes('capture.note'));
  // #65's rule — a boolean saying "configured" is not the same claim as "works".
  assert.equal(typeof body.checks.vault.reachable, 'boolean');
});

test('GET /api/mobile/v1/sync/diagnostics resolves and is not parsed as an operation', async () => {
  const { status, body } = await get('/api/mobile/v1/sync/diagnostics');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.recent));
});

// ── The sync contract ────────────────────────────────────────────────────────

test('POST sync/operations returns a receipt per operationId', async () => {
  const { status, body } = await post('/api/mobile/v1/sync/operations', {
    deviceId: 'route-test-device',
    clientSchema: 'neuro.mobile.client/1',
    operations: [
      { operationId: 'r-1', kind: 'capture.todo', createdAt: new Date().toISOString(), payload: { text: 'Routing test task alpha' } },
      { operationId: 'r-2', kind: 'capture.note', createdAt: new Date().toISOString(), payload: { content: 'Routing test note alpha' } },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.receipts.length, 2);
  assert.ok(body.receipts.every((r) => r.status === 'applied' && r.canonicalId));
});

test('replaying the identical request over HTTP produces duplicates, not new records', async () => {
  const payload = {
    deviceId: 'route-test-device',
    operations: [
      { operationId: 'r-3', kind: 'capture.todo', payload: { text: 'Routing replay guard task' } },
    ],
  };
  const first = await post('/api/mobile/v1/sync/operations', payload);
  const second = await post('/api/mobile/v1/sync/operations', payload);
  assert.equal(first.body.receipts[0].status, 'applied');
  assert.equal(second.body.receipts[0].status, 'duplicate');
  assert.equal(second.body.receipts[0].canonicalId, first.body.receipts[0].canonicalId);
});

test('a batch containing a rejection still answers 200 with receipts', async () => {
  // A non-2xx here would make the client discard the receipts it needs in order
  // to STOP retrying a rejection.
  const { status, body } = await post('/api/mobile/v1/sync/operations', {
    deviceId: 'route-test-device',
    operations: [{ operationId: 'r-4', kind: 'not.a.kind', payload: {} }],
  });
  assert.equal(status, 200);
  assert.equal(body.receipts[0].status, 'rejected');
  assert.match(body.receipts[0].detail, /unsupported kind/);
});

test('a malformed batch is refused with 400, not silently accepted', async () => {
  const { status, body } = await post('/api/mobile/v1/sync/operations', { operations: [] });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

// ── The route is behind auth ─────────────────────────────────────────────────

test('/api/mobile is NOT in server.js\'s auth exemption list', () => {
  // The exemptions are narrow and deliberate (push, SSE, Strava, /c/, /v1/).
  // Mobile carries the PIN like every other client, so it must not appear here.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  const authBlock = src.slice(src.indexOf("app.use('/api', (req, res, next)"), src.indexOf("const providedPin"));
  assert.ok(!authBlock.includes('/mobile'), 'the mobile contract must stay behind auth');
  // A positive control, so a broken slice cannot pass by absence.
  assert.ok(authBlock.includes('/push/'), 'the slice must actually contain the exemption list');
});
