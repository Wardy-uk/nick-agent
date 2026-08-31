'use strict';

/**
 * Changing what a VESTA account may see, over real HTTP.
 *
 * ⚠ `setScopes` shipped in the service the day scopes were introduced and had
 * NO ROUTE — reachable from the test suite and nowhere else. So the only way to
 * widen an account was to delete it and create another, which means handing the
 * person a new PIN over a change that is none of their business. This is that
 * route, and these are the tests that say what it may and may not do.
 *
 * Real HTTP because a green service suite says nothing about routing, and this
 * router registers a LITERAL `/scopes` alongside a PARAMETERISED
 * `/:username/scopes` — the exact shape that has bitten this codebase before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-scopes-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';

const express = require('express');
const db = require('../db/database');
const capture = require('../services/capture-links');

let server, base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/capture-links', require('./capture-links'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  capture.create({ label: 'Her', username: 'her', pin: '135790', scopes: ['tasks'] });
});

test.after(() => new Promise(r => server.close(r)));

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('an account can be widened without deleting it', async () => {
  const before = capture.list().find(a => a.username === 'her');
  assert.deepEqual(before.scopes, ['tasks'], 'starts closed');

  const r = await call('/api/capture-links/her/scopes', {
    method: 'POST', body: { scopes: ['tasks', 'calendar', 'kitchen'] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.scopes, ['tasks', 'calendar', 'kitchen']);

  // The PIN is untouched — that is the whole reason this route exists.
  const after = capture.list().find(a => a.username === 'her');
  assert.deepEqual(after.scopes, ['tasks', 'calendar', 'kitchen']);
  assert.equal(capture.login('her', '135790').ok, true, 'she can still sign in with the same PIN');
});

test('an account can be narrowed again, and tasks always survives', async () => {
  const r = await call('/api/capture-links/her/scopes', { method: 'POST', body: { scopes: [] } });
  assert.equal(r.status, 200);
  // An account with no scopes at all is a login that can do nothing, which is a
  // confusing way to spell "disabled".
  assert.deepEqual(r.json.scopes, ['tasks']);
});

/**
 * ⚠ A typo must never become a permission, and a scope invented by an old or
 * hostile client must not be grantable.
 */
test('an unknown scope is DROPPED, not stored', async () => {
  const r = await call('/api/capture-links/her/scopes', {
    method: 'POST', body: { scopes: ['tasks', 'kitchn', 'admin', 'calendar'] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.scopes, ['tasks', 'calendar'], 'kitchn and admin are gone');
});

/**
 * ⚠ Omitting the field is malformed, and is NOT the same as sending `[]`.
 * Treating a missing field as "the defaults" would silently narrow an account
 * nobody asked to change.
 */
test('a missing scopes field is refused, an empty array is honoured', async () => {
  const missing = await call('/api/capture-links/her/scopes', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);

  const empty = await call('/api/capture-links/her/scopes', { method: 'POST', body: { scopes: [] } });
  assert.equal(empty.status, 200);
});

test('an unknown account is a 404, not a silent success', async () => {
  const r = await call('/api/capture-links/nobody/scopes', { method: 'POST', body: { scopes: ['tasks'] } });
  assert.equal(r.status, 404);
});

/**
 * ⚠ THE routing test. `/scopes` is a literal path on a router that also has the
 * parameterised `/:username/pin` and `/:username/scopes`. Express matches in
 * registration order, and this codebase has twice shipped a literal path that
 * was swallowed as a parameter. Assert it returns the SCOPE LIST, not an
 * account named "scopes".
 */
test('GET /scopes returns the scope vocabulary, not an account called "scopes"', async () => {
  const r = await call('/api/capture-links/scopes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.scopes, capture.SCOPES);
  // The list the UI offers comes from the service, never a copy — a second list
  // is how a screen offers a permission that does not exist.
  assert.ok(r.json.scopes.includes('kitchen'));
  assert.equal(r.json.username, undefined, 'this is not an account');
});

test('the account list still works and never leaks a PIN', async () => {
  const r = await call('/api/capture-links');
  assert.equal(r.status, 200);
  const her = r.json.accounts.find(a => a.username === 'her');
  assert.ok(her, 'she is listed');
  for (const key of ['pin', 'pinHash', 'salt']) {
    assert.equal(key in her, false, `${key} must never reach a client`);
  }
});
