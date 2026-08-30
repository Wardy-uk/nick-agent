'use strict';

/**
 * The attention control surface over real HTTP.
 *
 * A green service suite says NOTHING about routing. On 16 Aug a literal path
 * registered after a parameterised sibling was read as that parameter and
 * answered "Email not found" for a fortnight, with the suite green throughout —
 * so these tests stand up an actual Express app and make actual requests.
 *
 * `/records`, `/history` and `/settings` are all literals sitting beside
 * `/records/:id/act`, which is exactly the shape that went wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attroute-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const lifecycle = require('../services/attention-lifecycle');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function req(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function seed(title) {
  const [rec] = lifecycle.reconcile([{
    kind: 'item', id: 'todo-overdue-top', type: 'todo', title,
    urgency: 'medium', tier: 2, source: 'vault', meta: { dueDate: '2026-08-29', overdueCount: 1 },
  }], { now: new Date() });
  return rec;
}

test('the literal paths are not swallowed by /records/:id/act', async () => {
  const records = await req('GET', '/api/attention/records');
  assert.equal(records.status, 200);
  assert.ok(Array.isArray(records.body.records));

  const history = await req('GET', '/api/attention/history');
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.body.events));

  const settings = await req('GET', '/api/attention/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.settings.enabled, true);
  assert.ok(settings.body.deferReasons.includes('too-big'));
});

test('a record can be acknowledged over HTTP and stays visible', async () => {
  const rec = seed('Acknowledge me over HTTP');
  const res = await req('POST', `/api/attention/records/${rec.id}/act`, { action: 'acknowledge' });
  assert.equal(res.status, 200);
  assert.equal(res.body.record.state, 'acknowledged');

  // Acknowledged is NOT hidden — that distinction is the whole reason this
  // state exists, and it has to survive the round trip.
  const list = await req('GET', '/api/attention/records');
  assert.ok(list.body.records.some((r) => r.recordId === rec.id));
});

test('a defer with no duration is refused in words, not accepted silently', async () => {
  const rec = seed('Defer me badly');
  const res = await req('POST', `/api/attention/records/${rec.id}/act`, { action: 'defer' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /minutes/);
  // A success the surface would render as a change that did not happen is the
  // failure mode here (`action-presenter`'s blockers rule).
  assert.equal(db.getAttentionRecord(rec.id).state, 'active');
});

test('an unknown record 400s rather than 500ing or inventing one', async () => {
  const res = await req('POST', '/api/attention/records/att_nope/act', { action: 'acknowledge' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no such attention record/);
});

test('settings PATCH round-trips and ignores unknown keys', async () => {
  const res = await req('PATCH', '/api/attention/settings', { interruptionLevel: 'critical-only', bogus: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.interruptionLevel, 'critical-only');
  assert.equal(res.body.settings.bogus, undefined);
  await req('PATCH', '/api/attention/settings', { interruptionLevel: 'normal' });
});

test('the history names the reason a card was surfaced', async () => {
  const rec = seed('History me');
  await req('POST', `/api/attention/records/${rec.id}/act`, { action: 'defer', minutes: 15, reason: 'too-big' });
  const { body } = await req('GET', '/api/attention/history?limit=100');
  const mine = body.events.filter((e) => e.record_id === rec.id);
  const deferred = mine.find((e) => e.event === 'deferred');
  assert.ok(deferred, 'the deferral is in the history');
  assert.match(deferred.detail, /too-big/);
});
