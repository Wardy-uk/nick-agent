'use strict';

/**
 * Saying "not today" to a Must Move row.
 *
 * The lane recomputes its membership on every read, so before this there was
 * nothing to disagree with — and the indirect levers do not work either:
 * dropping the MoSCoW leaves `overdue` carrying `needsToday` on its own, so the
 * only exit for an overdue task was to move its due date, which is a lie about
 * when it was committed to.
 *
 * Real HTTP, because a green service suite says nothing about routing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-lane-')), 'a.db');

const db = require('../db/database');
const router = require('./todos');
const lifecycle = require('../services/attention-lifecycle');

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

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

const keyOf = (text) => lifecycle.dedupeKeyFor({ type: 'todo', title: text });

test('a defer opens a record, snoozes it, and the lane read sees it', async () => {
  const text = 'Brief TPJ and Dev teams on the escalation standard';
  const res = await post('/api/todos/lane/defer', { text, reason: 'too-big' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.reason, 'too-big');

  // The POSITIVE half — a route that answered politely while writing nothing
  // passes any check made on its own output.
  const snoozed = lifecycle.deferredKeys();
  assert.ok(snoozed.has(keyOf(text)), 'the lane filter will not see this deferral');
  assert.equal(snoozed.get(keyOf(text)).reason, 'too-big');
});

test('the key is the SAME one the decision engine uses for that task', async () => {
  // The whole reason for reusing the lifecycle rather than adding a second
  // suppression map: "not today" here is the same statement as deferring the
  // task on the Now page, and two stores would let one surface contradict the
  // other about a decision made once.
  const text = 'Consider options for a daily cross-team huddle';
  await post('/api/todos/lane/defer', { text, reason: 'not-now' });
  const fromEngineShape = lifecycle.dedupeKeyFor({ type: 'todo', title: text, id: 'todo-overdue-top' });
  assert.ok(lifecycle.deferredKeys().has(fromEngineShape));
});

test('the deferral is recorded as EVIDENCE the friction read can count', async () => {
  // friction.js parses `deferred` events for "<minutes>m — <reason>". A defer
  // that stored only the current state would lose the history the moment Nick
  // deferred the same task again for a different reason.
  const text = 'Define and pilot a single named case owner model';
  await post('/api/todos/lane/defer', { text, reason: 'waiting-on-someone' });
  const events = db.getAttentionHistory(200).filter(e => e.event === 'deferred');
  const mine = events.find(e => e.dedupe_key === keyOf(text));
  assert.ok(mine, 'no deferred event was written');
  assert.match(String(mine.detail), /—\s*waiting-on-someone$/);
});

test('an unrecognised reason is REFUSED, not stored as "unspecified"', async () => {
  // The reasons ARE the payoff. Quietly downgrading a typo to "no reason given"
  // loses exactly the signal this exists to collect.
  const res = await post('/api/todos/lane/defer', { text: 'Some task', reason: 'because-i-say-so' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unknown reason/);
  assert.ok(!lifecycle.deferredKeys().has(keyOf('Some task')), 'a refused defer still snoozed it');
});

test('missing text is a 400, never a record keyed on nothing', async () => {
  assert.equal((await post('/api/todos/lane/defer', {})).status, 400);
  assert.equal((await post('/api/todos/lane/undefer', {})).status, 400);
});

test('undefer brings it back WITHOUT erasing that it was put off', async () => {
  const text = 'Get the ring-every-ticket trial results from Zoe';
  await post('/api/todos/lane/defer', { text, reason: 'no-context' });
  assert.ok(lifecycle.deferredKeys().has(keyOf(text)));

  const res = await post('/api/todos/lane/undefer', { text });
  assert.equal(res.status, 200);
  assert.ok(!lifecycle.deferredKeys().has(keyOf(text)), 'still snoozed after undefer');

  // ⚠ The evidence survives. Cancelling a snooze is Nick changing his mind
  // about WHEN, not a claim that he never put it off — and the friction read
  // counts what he said at the time.
  const stillThere = db.getAttentionHistory(200)
    .some(e => e.event === 'deferred' && e.dedupe_key === keyOf(text));
  assert.ok(stillThere, 'undefer erased the deferral from the history');
});

test('undeferring something that is not snoozed is a named 404', async () => {
  const res = await post('/api/todos/lane/undefer', { text: 'Never deferred at all' });
  assert.equal(res.status, 404);
  assert.match(res.json.error, /Nothing is snoozed/);
});

test('the lane routes did not shadow the routes already on this router', () => {
  const layersFor = (url, method) => router.stack
    .filter(l => l.route && l.regexp.test(url) && l.route.methods[method]);
  assert.equal(layersFor('/lane/defer', 'post')[0].route.path, '/lane/defer');
  assert.equal(layersFor('/lane/undefer', 'post')[0].route.path, '/lane/undefer');
  for (const [url, method, expected] of [
    ['/focus', 'get', '/focus'],
    ['/wip-ms', 'post', '/wip-ms'],
    ['/complete-ms', 'post', '/complete-ms'],
    ['/ms/AAA', 'patch', '/ms/:msId'],
    ['/ms/AAA/local', 'patch', '/ms/:msId/local'],
  ]) {
    const hits = layersFor(url, method);
    assert.ok(hits.length, `${method.toUpperCase()} ${url} matches nothing`);
    assert.equal(hits[0].route.path, expected, `${url} is handled by ${hits[0].route.path}`);
  }
});
