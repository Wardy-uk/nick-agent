'use strict';

/**
 * `/api/1to1/open-actions` resolves, and answers honestly when NOVA does not.
 *
 * Real HTTP, because a service test proves the mapping and not the wiring, and this
 * route's whole job is to be a number on a card about a named colleague.
 *
 * The three answers it must keep apart:
 *   - a count NOVA gave us,
 *   - a person NOVA does not track (ABSENT from the map, never 0),
 *   - and "we could not ask" (`ok:false`, never an empty map read as a clean slate).
 *
 * The last one is the one that matters. The card renders a count only when it has one,
 * so an outage that came back `ok:true, agents:{}` would silently clear every badge and
 * read exactly like a team that owes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-121actions-')), 'a.db');

const db = require('../db/database');
const nova = require('../services/nova-client');
const router = require('./one-to-one');

let server, base, realConfigured, realState;

test.before(async () => {
  await db.init();
  realConfigured = nova.isConfigured;
  realState = nova.get121State;
  const app = express();
  app.use(express.json());
  app.use('/api/1to1', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  nova.isConfigured = realConfigured;
  nova.get121State = realState;
  server && server.close();
});

const get = (url) => fetch(`${base}${url}`).then(async r => ({ status: r.status, json: await r.json() }));

test('counts come back keyed by name, and zero is a real answer', async () => {
  nova.isConfigured = () => true;
  nova.get121State = async () => ({
    agents: [
      { agentName: 'Maria Pappa', openActions: 2 },
      { agentName: 'Zoe Rees', openActions: 0 },
    ],
  });
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.agents['Maria Pappa'], 2);
  // NOVA knows her and she owes nothing. Distinct from the next test.
  assert.equal(res.json.agents['Zoe Rees'], 0);
});

test('a person NOVA does not track is absent, not zero', async () => {
  nova.isConfigured = () => true;
  nova.get121State = async () => ({ agents: [{ agentName: 'Maria Pappa', openActions: 2 }] });
  const res = await get('/api/1to1/open-actions');
  assert.ok(!('Nathan Button' in res.json.agents), 'an untracked name must not appear at all');
});

test('an unreachable NOVA is ok:false, never an empty all-clear', async () => {
  nova.isConfigured = () => true;
  nova.get121State = async () => { throw new Error('bridge down'); };
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /bridge down/);
});

test('a roster NOVA could not read is ok:false, not an empty roster', async () => {
  nova.isConfigured = () => true;
  // The bridge answers `agents: null` behind a 503 rather than [] for exactly this
  // reason; an array-shape check is what stops it reading as "nobody owes anything".
  nova.get121State = async () => ({ agents: null });
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.json.ok, false);
});

test('an unconfigured bridge refuses before the network', async () => {
  nova.isConfigured = () => false;
  let called = false;
  nova.get121State = async () => { called = true; return { agents: [] }; };
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.json.ok, false);
  assert.equal(called, false, 'must not call out when there is nowhere to call');
});

test('a NOVA that predates the count is ok:false, not a team owing nothing', async () => {
  nova.isConfigured = () => true;
  // Exactly what the old bridge returns: a perfectly good roster with no `openActions`.
  nova.get121State = async () => ({ agents: [{ agentName: 'Maria Pappa', booked: '2026-09-16' }] });
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /predates/);
});

test('a genuinely empty roster is still ok', async () => {
  // The guard above must key on "names but no counts", not on emptiness — NOVA with no
  // 1-2-1 plans at all is an honest empty answer, not an old build.
  nova.isConfigured = () => true;
  nova.get121State = async () => ({ agents: [] });
  const res = await get('/api/1to1/open-actions');
  assert.equal(res.json.ok, true);
});

test('the literal path is not swallowed by a sibling parameter', async () => {
  nova.isConfigured = () => true;
  nova.get121State = async () => ({ agents: [] });
  const res = await get('/api/1to1/open-actions');
  // `/find/:person` and `/moves/:person` are two segments, so they cannot collide —
  // but this repo has shipped a literal path read as a parameter before, and the
  // positive control is that we reached THIS handler rather than any other 200.
  assert.equal(res.status, 200);
  assert.ok('agents' in res.json, 'reached the open-actions handler, not a sibling');
});
