'use strict';

/**
 * The "I've read it" routes resolve, and the refusal is a refusal.
 *
 * Real HTTP, because a green service suite says nothing about routing and this
 * router already carries `/signals` beside `/signals/:id/ack`. The finding ids
 * carry a COLON (`quiet:dietary_water`), which is exactly the shape most likely
 * to be mangled by a path parser or an over-eager encoder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hsack-')), 'a.db');

const db = require('../db/database');
const signals = require('../services/health-signals');
const router = require('./health');

let server;
let base;

// A REAL finding, seeded rather than stubbed. `acknowledge` resolves the
// current pass through the service's own snapshot, so a stubbed export would
// not be the thing the route calls - and the refusal below ("not in the current
// findings") is only worth testing if the pass is genuinely computed.
//
// 40 daily readings that stop 200 days ago: past QUIET_MIN_SAMPLES (30),
// QUIET_MIN_SPAN_DAYS (30) and well past QUIET_FLOOR_DAYS (14).
const REAL_ID = 'quiet:dietary_water';

const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function seedStoppedMetric() {
  const stopped = Date.now() - 200 * 86400000;
  for (let i = 0; i < 40; i++) {
    db.insertHealthSample('dietary_water', 1500 + i,
      // SQLite's own format, which is what ingest writes and what
      // sensorsQuiet parses. An ISO string with a trailing Z parses to NaN
      // there and the metric is skipped in silence - a fixture in the wrong
      // shape would have made this test pass for the wrong reason.
      sqlTime(stopped - i * 86400000), 'test');
  }
}

test.before(async () => {
  await db.init();
  seedStoppedMetric();
  const app = express();
  app.use(express.json());
  app.use('/api/health', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const ack = (id, method = 'POST') =>
  fetch(`${base}/api/health/signals/${encodeURIComponent(id)}/ack`, { method });

test('the literal /signals GET is not swallowed by the ack path', async () => {
  const res = await fetch(`${base}/api/health/signals`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.findings), 'the signals block, not an ack for a finding called "signals"');
  assert.ok(json.findings.some(f => f.id === REAL_ID), 'and the seeded metric really does read as quiet');
});

test('a finding in the current pass can be acknowledged, colon and all', async () => {
  const res = await ack(REAL_ID);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.id, REAL_ID, 'the id survived the round trip intact');
  assert.equal(db.getState(signals.ACK_KEY).includes(REAL_ID), true, 'and it was actually stored');
});

test('acknowledging twice folds rather than erroring', async () => {
  const json = await (await ack(REAL_ID)).json();
  assert.equal(json.ok, true);
  assert.equal(json.already, true);
});

// The expensive failure: a stale screen acking something that has already
// cleared would pre-emptively silence the NEXT occurrence, which is the one
// thing "until it reoccurs" promises not to do.
test('a finding not in the current pass is REFUSED, not stored', async () => {
  const res = await ack('quiet:something-that-cleared');
  assert.equal(res.status, 400, 'a refusal must not answer 200');
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.match(json.reason, /not in the current findings/);
  assert.equal(db.getState(signals.ACK_KEY).includes('something-that-cleared'), false);
});

test('there is a way back', async () => {
  const json = await (await ack(REAL_ID, 'DELETE')).json();
  assert.equal(json.ok, true);
  assert.equal(db.getState(signals.ACK_KEY).includes(REAL_ID), false);
});

test('un-acknowledging something that was never acknowledged is refused', async () => {
  const res = await ack(REAL_ID, 'DELETE');
  assert.equal(res.status, 400);
  assert.match((await res.json()).reason, /not acknowledged/);
});
