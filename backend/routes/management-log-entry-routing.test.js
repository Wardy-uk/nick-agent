'use strict';

/**
 * Logging a management conversation, end to end over real HTTP.
 *
 * ⚠ `POST /api/weekly-risk/log` had shipped with **no caller in either
 * frontend** — reachable from the seed script and a curl and nowhere else, the
 * same species as `setScopes` shipping without a route. So this suite exists as
 * much to pin that the entry path WORKS as to pin what it refuses.
 *
 * The load-bearing test is the last one: `logged_at` must not be settable from
 * a manual entry. The gap between when a conversation HAPPENED and when it was
 * WRITTEN DOWN is the whole of competency 3, and a freely backdatable stamp
 * makes that measurement unfalsifiable — a self-report wearing the clothes of
 * evidence.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mlentry-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(scratch, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');

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
const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** Today, local — the service stamps local dates, never toISOString(). */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('a conversation logged from the panel lands on the log and reads back', async () => {
  const { status, body } = await post('/api/weekly-risk/log', {
    type: 'conversation',
    person: 'Naomi',
    summary: 'Risk assessment sections — agreed the remaining two',
    owner: 'Nick',
    entryDate: todayLocal(),
    dueDate: '2026-09-30',
  });
  assert.equal(status, 201);
  assert.ok(body.id, 'the created row carries an id — the receipt is built on it');

  // ⚠ Read back through the ASSESSMENT, not the create response. A write that
  // only decorated its own reply would pass any check made on its own output.
  const { body: log } = await get('/api/weekly-risk/log');
  const row = log.rows.find(r => r.id === body.id);
  assert.ok(row, 'the row is on the log the compliance figures are built from');
  assert.equal(row.person, 'Naomi');
  assert.equal(row.type, 'conversation');
});

test('a summary is required — an entry nobody can follow to resolution is refused', async () => {
  const { status, body } = await post('/api/weekly-risk/log', { type: 'conversation', person: 'Naomi' });
  assert.equal(status, 400);
  assert.match(body.error, /summary/i);
});

test('an unknown kind is refused rather than normalised into something else', async () => {
  const { status } = await post('/api/weekly-risk/log', { type: 'chinwag', summary: 'x' });
  assert.equal(status, 400);
});

test('a conversation logged today is not reported as logged late', async () => {
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'conversation', summary: 'Same-day entry', owner: 'Nick', entryDate: todayLocal(),
  });
  const { body: log } = await get('/api/weekly-risk/log');
  assert.ok(!log.lateLogged.some(l => l.id === created.id), 'nothing to report — it was written down the day it happened');
});

test('an open item with no owner or due date is reported as a gap in the log itself', async () => {
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'concern', summary: 'Raised with no follow-through recorded', entryDate: todayLocal(),
    owner: null, dueDate: null,
  });
  const { body: log } = await get('/api/weekly-risk/log');
  assert.ok(log.missingOwner.some(m => m.id === created.id), 'competency 3 needs an owner');
  assert.ok(log.missingDue.some(m => m.id === created.id), 'and a due date');
  // ⚠ And People HR is a QUESTION, never an accusation. A brand-new concern is
  // unanswered, so it must sit in hrUnknown and not in the hrGap that reaches
  // Chris as a finding.
  assert.ok(log.hrUnknown.some(h => h.id === created.id));
  assert.ok(!log.hrGap.some(h => h.id === created.id), 'unanswered is not a confirmed gap');
});

test('a manual entry CANNOT forge when it was logged', async () => {
  // The whole of competency 3 is the gap between happening and being written
  // down. If the panel could send its own `loggedAt`, a late entry would look
  // punctual and the measurement would mean nothing.
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'conversation',
    summary: 'Backdated attempt',
    owner: 'Nick',
    entryDate: '2026-07-01',
    loggedAt: '2026-07-01T09:00:00.000Z',
  });
  const { body: log } = await get('/api/weekly-risk/log');
  const row = log.rows.find(r => r.id === created.id);
  assert.notEqual(String(row.logged_at).slice(0, 10), '2026-07-01', 'the server clock wins over anything sent');
  assert.equal(String(row.logged_at).slice(0, 10), todayLocal());
  // And the entry is therefore correctly reported as logged late — which is the
  // true record, not a failure of the form.
  const late = log.lateLogged.find(l => l.id === created.id);
  assert.ok(late, 'a conversation from July written up today IS logged late');
  assert.ok(late.workingDays > 2);
});

// ── Editing and closing, added with the standalone view (7 Sep 2026) ────────

test('closing an item stamps a resolved date and stops it counting as overdue', async () => {
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'action', summary: 'Something that got done', owner: 'Nick',
    entryDate: todayLocal(), dueDate: '2026-01-05',
  });
  const before = await get('/api/weekly-risk/log');
  assert.ok(before.body.overdue.some(o => o.id === created.id), 'due in January, so it is overdue now');

  const res = await fetch(`${base}/api/weekly-risk/log/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(res.status, 200);
  const row = await res.json();
  // ⚠ Competency 4 measures how long things stayed open, so an item closed with
  // no date is uncountable. The server stamps it rather than trusting a caller
  // to remember.
  assert.ok(row.resolved_date, 'closing stamps a resolved date');

  const after = await get('/api/weekly-risk/log');
  assert.ok(!after.body.overdue.some(o => o.id === created.id), 'and it leaves the overdue count');
});

test('correcting when a conversation happened is allowed; forging when it was logged is not', async () => {
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'conversation', summary: 'Date typed wrong first time', owner: 'Nick', entryDate: todayLocal(),
  });
  const stampBefore = (await get('/api/weekly-risk/log')).body.rows.find(r => r.id === created.id).logged_at;

  const res = await fetch(`${base}/api/weekly-risk/log/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // The panel never sends this; a hand-rolled client might. The API must
    // refuse it either way, or competency 3 is unfalsifiable.
    body: JSON.stringify({ entryDate: '2026-08-03', loggedAt: '2026-08-03T09:00:00.000Z' }),
  });
  assert.equal(res.status, 200);

  const row = (await get('/api/weekly-risk/log')).body.rows.find(r => r.id === created.id);
  assert.equal(row.entry_date, '2026-08-03', 'the date it happened is correctable');
  assert.equal(row.logged_at, stampBefore, 'the stamp is untouched — it is not a caller-settable field');
});

test('a bad status is ignored rather than written — the row keeps a state that means something', async () => {
  const { body: created } = await post('/api/weekly-risk/log', {
    type: 'action', summary: 'Status guard', owner: 'Nick', entryDate: todayLocal(),
  });
  await fetch(`${base}/api/weekly-risk/log/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'nearly' }),
  });
  const row = (await get('/api/weekly-risk/log')).body.rows.find(r => r.id === created.id);
  assert.equal(row.status, 'open', 'unrecognised statuses do not become data');
});
