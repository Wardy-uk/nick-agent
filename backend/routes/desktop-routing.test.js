'use strict';

/**
 * The desktop routes resolve, and resolve to themselves.
 *
 * `/daily` and `/daily/sync` were added beside `/activity` on a router that had
 * only ever had one path. Nothing here uses a parameter, so there is no sibling
 * to be swallowed by — but a green service suite says nothing about wiring, and
 * this repo has shipped a route that existed and answered the wrong handler more
 * than once. The rollup route in particular answers 200 with an empty list when
 * it is working AND when it is not reaching the service at all, so a layer test
 * is exactly the thing that would not notice.
 *
 * Real HTTP.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-deskroute-')), 'a.db');

const db = require('../db/database');
const router = require('./desktop');
const desk = require('../services/desktop-activity');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/desktop', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = url => fetch(`${base}${url}`).then(async r => ({ status: r.status, body: await r.json() }));
const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('a sample posts, and comes back sanitised so the reporter can tell', async () => {
  const r = await post('/api/desktop/activity', {
    app: 'NT-14855 Sandford escalation - Outlook', idleSeconds: 3, locked: false, host: 'LAPTOP',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sample.app, 'NT',
    'a leaked window title is cut at the first separator BEFORE it is stored — the customer name never lands');
  assert.equal(r.body.sample.host, 'LAPTOP');
});

test('GET /activity names the machines that are reporting', async () => {
  const r = await get('/api/desktop/activity');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.hosts), 'hosts is a list');
  assert.ok(r.body.hosts.some(h => h.host === 'LAPTOP'), 'and the machine that posted is in it');
  // ⚠ The raw samples must never be served: they are a minute-by-minute record
  // of which app was in front of him.
  assert.equal(r.body.samples, undefined);
  assert.equal(typeof r.body.sampleCount, 'number');
});

test('/daily reaches the rollup rather than answering an empty list by accident', async () => {
  const now = new Date();
  const at = i => new Date(now.getTime() - (60 + i) * 60000).toISOString();
  for (let i = 0; i < 20; i += 1) {
    await post('/api/desktop/activity', { app: 'Code', idleSeconds: 2, host: 'LAPTOP', at: at(i * 2) });
  }

  const sync = await post('/api/desktop/daily/sync', {});
  assert.equal(sync.status, 200);
  assert.ok(sync.body.written >= 1, 'the sync route actually wrote something');
  assert.deepEqual(sync.body.gaps, []);

  const r = await get('/api/desktop/daily?days=7');
  assert.equal(r.status, 200);
  assert.ok(r.body.days.length >= 1, 'and the read route returns it');
  const row = r.body.days[0];
  assert.equal(row.host, 'LAPTOP');
  assert.equal(typeof row.apps, 'object', 'apps is hydrated from JSON, not handed back as a string');
  assert.ok(row.present_minutes > 0);
});

test('the days parameter is bounded rather than trusted', async () => {
  for (const q of ['?days=abc', '?days=-5', '?days=99999']) {
    const r = await get(`/api/desktop/daily${q}`);
    assert.equal(r.status, 200, `${q} must not 500`);
    assert.ok(Array.isArray(r.body.days));
  }
});

test('an unknown desktop path is a 404, not a silent 200 from a sibling', async () => {
  const r = await fetch(`${base}/api/desktop/nonsense`);
  assert.equal(r.status, 404);
});
