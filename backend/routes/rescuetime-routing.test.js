'use strict';

/**
 * The RescueTime routes resolve, and the key never comes back out.
 *
 * The second half is the one worth a real HTTP test: the repo is PUBLIC and the
 * PIN has already leaked once through a tracked file. A route that echoes a
 * credential answers 200 and looks perfect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-rtroute-')), 'a.db');
delete process.env.RESCUETIME_API_KEY;

const db = require('../db/database');
const router = require('./rescuetime');

const SECRET = 'B63PBB1TtWWBQtz0rpoP9yes8ZrXNjAXk9tHGB9a';
let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/rescuetime', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const req = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
};

test('status answers before a key exists, and says it is not configured', async () => {
  const r = await req('GET', '/api/rescuetime/status');
  assert.equal(r.status, 200, 'an unconfigured integration is a normal state, not an error');
  assert.equal(r.body.configured, false);
  assert.equal(r.body.credentialSource, null);
});

test('a malformed key is refused with a reason', async () => {
  const r = await req('POST', '/api/rescuetime/key', { key: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /RescueTime API key/);
});

test('the key is accepted and NEVER returned by any route', async () => {
  const set = await req('POST', '/api/rescuetime/key', { key: SECRET });
  assert.equal(set.status, 200);
  assert.equal(set.body.configured, true);
  assert.equal(set.body.credentialSource, 'stored');
  assert.ok(!set.text.includes(SECRET), 'the setter echoed the key back');

  for (const url of ['/api/rescuetime/status', '/api/rescuetime/daily?days=7']) {
    const r = await req('GET', url);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECRET), `${url} leaked the key`);
    // Not even a masked fragment.
    assert.ok(!r.text.includes(SECRET.slice(0, 8)), `${url} leaked part of the key`);
  }
});

test('status reports whether RescueTime AGREES, not whether it answered', async () => {
  const r = await req('GET', '/api/rescuetime/status');
  // With no overlapping days yet it must say it cannot tell, and never claim a
  // green light it has not earned.
  assert.equal(r.body.state, 'calibrating');
  assert.equal(r.body.needed, 7);
  assert.ok(Array.isArray(r.body.pairs));
});

test('the key can be forgotten', async () => {
  const r = await req('DELETE', '/api/rescuetime/key');
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.credentialSource, null);
});

test('sync without a key answers 503 and names the reason', async () => {
  const r = await req('POST', '/api/rescuetime/sync');
  assert.equal(r.status, 503, 'not a 200 with an empty result — that is the failure being designed out');
  assert.equal(r.body.gaps[0].why, 'not-configured');
});

test('days is bounded rather than trusted', async () => {
  for (const q of ['?days=abc', '?days=-5', '?days=99999']) {
    const r = await req('GET', `/api/rescuetime/daily${q}`);
    assert.equal(r.status, 200, `${q} must not 500`);
  }
});
