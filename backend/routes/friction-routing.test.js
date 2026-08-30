'use strict';

/**
 * `/api/friction` over real HTTP.
 *
 * A green service suite says NOTHING about routing — on 16 Aug a literal path
 * registered after a parameterised sibling was read as that parameter and
 * answered "Email not found" for a fortnight with the suite green throughout.
 * So the route gets stood up and actually called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-friction-route-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/friction', require('./friction'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('GET /api/friction answers with insights, gaps and a completeness flag', async () => {
  const res = await fetch(`${base}/api/friction`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.insights));
  assert.ok(Array.isArray(body.gaps));
  // The distinction that keeps "nothing in your way" apart from "I could not
  // look" has to survive the route, not just the service.
  assert.equal(typeof body.complete, 'boolean');
  assert.ok(body.generatedAt);
});

test('it is READ-ONLY — there is no way to write anything through it', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const res = await fetch(`${base}/api/friction`, { method });
    assert.notEqual(res.status, 200, `${method} must not be handled — this surface is polled, and must never be why something changed`);
  }
});
