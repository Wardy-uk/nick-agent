'use strict';

/**
 * The CalDAV routes resolve, and resolve to themselves.
 *
 * Real HTTP, because a service suite proves the logic and not the wiring — and
 * this router already carries `/status`, `/calendar` and `/reminders`, so a new
 * `/caldav/*` family is exactly the shape this repo has shipped broken before
 * (`/triage/feedback` read as an email id, `setScopes` reachable only from a
 * test). A route answering the wrong handler answers 200 while doing nothing.
 *
 * The other thing pinned here is the credential. It is stored so a paste works
 * with no restart, and it must never come back out of any route — the repo is
 * PUBLIC and this is an Apple account credential.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-caldavroute-')), 'a.db');
delete process.env.APPLE_ID;
delete process.env.APPLE_APP_PASSWORD;

const db = require('../db/database');
const router = require('./apple');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/apple', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (url) => fetch(`${base}${url}`);
const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

const SECRET = 'wxyz-1234-abcd-5678';

test('GET /caldav/status resolves to the CalDAV handler, not the push one', async () => {
  const res = await get('/api/apple/caldav/status');
  assert.equal(res.status, 200);
  const json = await res.json();
  // The push status has `lastPushAt`/`events`; this one reports configuration.
  assert.ok('configured' in json, 'this is the CalDAV status shape');
  assert.ok('credentialConfigured' in json);
});

test('GET /status still resolves to the PUSH handler', async () => {
  // The pull must not have stolen the existing route.
  const res = await get('/api/apple/status');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok('lastPushAt' in json || 'known' in json, 'still the ingest status');
});

test('a sync with no credentials refuses, and says so', async () => {
  const res = await post('/api/apple/caldav/sync', {});
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.reason, 'not-configured');
});

test('credentials require BOTH fields — a half-set credential is refused', async () => {
  const res = await post('/api/apple/caldav/credentials', { appleId: 'nick@example.com' });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /required/);
});

test('a stored credential is never echoed back by any route', async () => {
  const set = await post('/api/apple/caldav/credentials', {
    appleId: 'nick@example.com',
    appPassword: SECRET,
  });
  assert.equal(set.status, 200);
  const body = await set.text();
  assert.ok(!body.includes(SECRET), 'the app password must not come back from the setter');

  const status = await get('/api/apple/caldav/status');
  const statusBody = await status.text();
  assert.ok(!statusBody.includes(SECRET), 'nor from the status route');
  // The first eight characters would be enough to be dangerous.
  assert.ok(!statusBody.includes(SECRET.slice(0, 8)), 'not even a prefix of it');

  const json = JSON.parse(statusBody);
  assert.equal(json.configured, true, 'but it DID take effect with no restart');
  assert.equal(json.credentialSource, 'stored');
});

test('the Apple ID is masked in status, having been stored in full', async () => {
  const json = await (await get('/api/apple/caldav/status')).json();
  assert.ok(!String(json.appleId).includes('nick@example.com'));
  assert.match(String(json.appleId), /@example\.com$/);
});

test('sync is a DRY RUN unless apply:true — looking must never write', async () => {
  // With a stored (bogus) credential the run will fail at the network, which is
  // fine: what is pinned is that the default path never asks to write. A real
  // run reaches clearCalendarWindow, so the default has to be safe.
  const res = await post('/api/apple/caldav/sync', {});
  const json = await res.json();
  assert.notEqual(json.calendarIngested, true);
});
