'use strict';

/**
 * The low-criticality intake (items 15-17), end to end.
 *
 * Real HTTP, because a green service suite says nothing about routing — and
 * this router already has `/:id/approve`, `/:id/reject`, `/batch` and
 * `/bulk-reject`, so a bare `POST /` is exactly the shape this repo has seen
 * swallowed by a sibling before.
 *
 * The round trip is the point: a suggestion posted by a machine client must
 * arrive as PENDING, present itself with a `basis` a human can judge, and only
 * become a task when somebody approves it. Each half is easy to get right on
 * its own and useless without the others.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-intake-')), 'a.db');

const db = require('../db/database');
const router = require('./actions');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/actions', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const SUGGESTION = {
  type: 'vantage_suggestion',
  text: 'Chase the Tier 2 ageing before it reaches the report',
  source: 'vantage-finding',
  criticality: 'medium',
  basis: 'medium severity and already live — worth deciding on soon',
};

test('a machine client can queue a suggestion, and it arrives PENDING', async () => {
  const res = await post('/api/actions', SUGGESTION);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'pending');

  const action = db.getSaraAction(body.id);
  assert.equal(action.type, 'vantage_suggestion');
  assert.equal(action.status, 'pending');
  // Verbatim, both of them. NEURO records the claim and derives nothing.
  assert.equal(action.payload.criticality, 'medium');
  assert.equal(action.payload.source, 'vantage-finding');
  assert.equal(action.payload.basis, SUGGESTION.basis);
});

test('the card says who suggested it, how they rated it and why', async () => {
  const list = await (await fetch(`${base}/api/actions`)).json();
  const card = list.pending.find((a) => a.type === 'vantage_suggestion');
  assert.ok(card, 'the suggestion must appear in the pending queue');
  const p = card.presentation;
  assert.ok(p, 'a type with no presenter renders as a bare card');
  assert.match(p.summary, /vantage-finding/);
  const rendered = JSON.stringify(p.fields);
  assert.match(rendered, /medium/);
  assert.match(rendered, /worth deciding on soon/);
  assert.deepEqual(p.blockers, []);
});

test('approving it creates the task, carrying what VANTAGE claimed', async () => {
  const list = await (await fetch(`${base}/api/actions`)).json();
  const card = list.pending.find((a) => a.type === 'vantage_suggestion');

  const res = await post(`/api/actions/${card.id}/approve`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const row = db.listTaskRows({ status: 'all' }).find((t) => t.text === SUGGESTION.text);
  assert.ok(row, 'approving must actually create the task');
  assert.equal(row.criticality, 'medium', 'the claim is stored as provenance');
  assert.equal(row.origin, 'commitment');
  assert.equal(row.source, 'vantage-finding');
  assert.match(row.notes, /worth deciding on soon/);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('an unattributable suggestion is refused', async () => {
  // The only route by which something outside NEURO proposes work to Nick. A
  // suggestion he cannot attribute is one he cannot judge.
  const res = await post('/api/actions', { ...SUGGESTION, source: undefined });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /source is required/);
});

test('an unknown action type is refused rather than queued', async () => {
  // A type with no presenter and no executor renders as a bare card and then
  // fails on approval — a queue entry that cannot be acted on.
  const res = await post('/api/actions', { ...SUGGESTION, type: 'reply_email' });
  assert.equal(res.status, 400);
});

test('an empty suggestion is refused', async () => {
  const res = await post('/api/actions', { ...SUGGESTION, text: '   ' });
  assert.equal(res.status, 400);
});

test('a missing criticality stays null and is never read as low', async () => {
  const res = await post('/api/actions', { ...SUGGESTION, text: 'Something nobody rated', criticality: undefined });
  const { id } = await res.json();
  assert.equal(db.getSaraAction(id).payload.criticality, null);
});

test('the intake cannot execute anything — approval is a separate call', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'actions.js'), 'utf-8');
  const intake = src.slice(src.indexOf("router.post('/',"), src.indexOf("router.post('/:id/approve'"));
  assert.doesNotMatch(intake, /executeAction/);
  assert.doesNotMatch(intake, /approveAction/);
  // Positive control: the slice really is the intake handler.
  assert.match(intake, /createSaraAction/);
});
