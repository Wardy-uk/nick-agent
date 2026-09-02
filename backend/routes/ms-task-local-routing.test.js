'use strict';

/**
 * The local-annotation route resolves, and resolves to itself.
 *
 * `/ms/:msId/local` sits on a router that already has `/ms/:msId`. The two
 * differ in segment count so they cannot collide, but this repo has shipped a
 * literal path swallowed by a sibling parameter before (`/triage/feedback` read
 * as an email id), and a route that answers the wrong handler answers 200 while
 * doing nothing — the exact failure shape this codebase refuses everywhere.
 *
 * Real HTTP, because a layer test proves the table and not the wiring.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mslocalroute-')), 'a.db');

const db = require('../db/database');
const router = require('./todos');
const msLocal = require('../services/ms-task-local');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const patch = (url, body) => fetch(`${base}${url}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

test('a state is stored, and it is the local route that stored it', async () => {
  const res = await patch('/api/todos/ms/AAkALgAAA/local', { state: 'blocked' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.local.state, 'blocked');
  // The POSITIVE half: the store actually moved. A route answering politely
  // while writing nothing passes any check made on its own output.
  assert.equal(msLocal.get('AAkALgAAA').state, 'blocked');
});

test('MoSCoW and priority reach the same entry without clearing the state', async () => {
  await patch('/api/todos/ms/BBB/local', { state: 'working' });
  await patch('/api/todos/ms/BBB/local', { moscow: 'must' });
  await patch('/api/todos/ms/BBB/local', { priority: 3 });
  const entry = msLocal.get('BBB');
  assert.equal(entry.state, 'working');
  assert.equal(entry.moscow, 'must');
  assert.equal(entry.priority, 3);
});

test('an unrecognised state is REFUSED, not normalised into a clear', async () => {
  await patch('/api/todos/ms/CCC/local', { state: 'working' });
  const res = await patch('/api/todos/ms/CCC/local', { state: 'on fire' });
  assert.equal(res.status, 400);
  // Still working — the refusal changed nothing, which is the point.
  assert.equal(msLocal.get('CCC').state, 'working');
});

test('an empty body is a 400, not a silent no-op reported as success', async () => {
  const res = await patch('/api/todos/ms/DDD/local', {});
  assert.equal(res.status, 400);
});

test('the local route did not shadow the Graph editor beside it', () => {
  const layersFor = (url, method) => router.stack
    .filter(l => l.route && l.regexp.test(url) && l.route.methods[method]);
  assert.equal(layersFor('/ms/AAkALgAAA', 'patch')[0].route.path, '/ms/:msId');
  assert.equal(layersFor('/ms/AAkALgAAA', 'get')[0].route.path, '/ms/:msId');
  assert.equal(layersFor('/ms/AAkALgAAA/local', 'patch')[0].route.path, '/ms/:msId/local');
});
