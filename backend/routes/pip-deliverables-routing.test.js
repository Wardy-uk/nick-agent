'use strict';

/**
 * Routing for the PIP deliverable tracker.
 *
 * ⚠ `/deliverables` is a literal on a router that also carries `/log/:id` and
 * `/markdown`. This repo has shipped a literal path swallowed by a sibling
 * parameterised one more than once, and a green service suite says nothing
 * about it. Mutation check: rename the path and these fail.
 *
 * The second job here is the one the pure suite cannot do — proving the tracker
 * reads weekly-risk's REAL stores. A wrong state key would return a payload of
 * perfectly-shaped zeroes, which reads as "you have produced nothing" against a
 * full record: the exact accusation this service is built not to make.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pip-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(scratch, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');
const pip = require('../services/pip-deliverables');

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

test('GET /deliverables resolves to the tracker, not to a log row named "deliverables"', async () => {
  const { status, body } = await get('/api/weekly-risk/deliverables');
  assert.equal(status, 200);
  assert.ok(body.window, 'no window block — something else answered');
  assert.ok(body.weekly, 'no weekly block');
  assert.equal(body.window.end, '2026-10-11');
});

test('it reads weekly-risk’s real stores, not a shape of zeroes', async () => {
  const weeklyRisk = require('../services/weekly-risk');
  const week = pip.weekCommencing(pip.dateKey(new Date()));

  // ⚠ The key is weekly-risk's (`weekly_risk_published_<week>`) and is written
  // here directly rather than by calling publish(), which builds a whole report
  // and writes a vault note. The setup is then CHECKED through the service's own
  // reader before the assertion that matters — so if the key format ever changes
  // this fails at the check with "stale test", not at the tracker with "produced
  // nothing". Distinguishing those two is the whole reason for the extra line.
  db.setState(`weekly_risk_published_${week}`, JSON.stringify({ path: 'x.md', publishedAt: new Date().toISOString() }));
  assert.ok(weeklyRisk.publishedAt(week), 'setup is stale — the publish key has moved');

  const { body } = await get('/api/weekly-risk/deliverables');
  assert.ok(
    body.weekly.producedNotSent.includes(week),
    `a published week must be read back as written-not-sent — got ${JSON.stringify(body.weekly)}`,
  );
  assert.equal(body.weekly.current.state, 'written-not-sent');
});

test('a published week is never reported as sent', async () => {
  const { body } = await get('/api/weekly-risk/deliverables');
  assert.equal(body.weekly.sent, 0, 'nothing has been sent in this scratch DB');
});

test('the payload carries no score, percentage or grade', async () => {
  const { body } = await get('/api/weekly-risk/deliverables');
  const flat = JSON.stringify(body).toLowerCase();
  for (const banned of ['percent', 'score', 'grade', 'rating', 'completion']) {
    assert.ok(!flat.includes(banned), `must not expose "${banned}"`);
  }
});

test('it is read-only — asking does not publish, send or write a report', async () => {
  const before = db.getState('weekly_risk_sent_2026-08-31');
  await get('/api/weekly-risk/deliverables');
  assert.equal(db.getState('weekly_risk_sent_2026-08-31'), before, 'a read must not mark anything sent');
});

test('the management-log half answers with real competency figures', async () => {
  const { body } = await get('/api/weekly-risk/deliverables');
  // The log is readable in this scratch DB, so it must be an object of numbers
  // rather than null — null is reserved for "could not be read".
  assert.ok(body.log, 'log could not be read in a healthy scratch DB');
  assert.equal(typeof body.log.baselineStillOpen, 'number');
  assert.equal(typeof body.log.lateLogged, 'number');
});
