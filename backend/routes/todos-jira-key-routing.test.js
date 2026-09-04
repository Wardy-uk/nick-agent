'use strict';

/**
 * The ticket that closes a task survives the trip to the screen.
 *
 * ⚠ This test exists because the first cut of the feature shipped and did
 * nothing. `task-store.toTodoShape` carried `jiraKey`, `activeTodos()` returned
 * it, the service suite asserted it and passed — and `/api/todos` maps its
 * response through an explicit WHITELIST, so the field was dropped in silence
 * somewhere none of those tests were looking. The route's own comment already
 * warns about exactly this ("a field missing from it is dropped IN SILENCE —
 * the way estimateMinutes vanished"), and it happened anyway, because every
 * assertion was made a layer below the drop.
 *
 * So: real HTTP, and the claim is the one the card actually depends on — a
 * linked task arrives at the client carrying its ticket, and an unlinked one
 * does not. Both routes that render task cards are checked, because the second
 * whitelist was missing it too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-jirakey-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const taskStore = require('../services/task-store');
const jiraTasks = require('../services/jira-tasks');
const router = require('./todos');

let server;
let base;
let linkedId;
let plainId;

test.before(async () => {
  await db.init();

  linkedId = taskStore.createTask({
    text: 'NT-27530: ESCALATION - NT-23869 - No response since 7th July',
    source: jiraTasks.SOURCE,
    skipExport: true,
  }).id;
  plainId = taskStore.createTask({
    text: 'A task Nick owns and can close himself',
    source: 'manual',
    skipExport: true,
  }).id;

  // The ledger is what makes a task Jira's to close — not the `source` column,
  // which stays behind as provenance when a ticket is taken off Nick.
  db.setState('jira_task_links', JSON.stringify({ 'NT-27530': linkedId }));

  const app = express();
  app.use(express.json());
  app.use('/api/todos', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (url) => fetch(`${base}${url}`).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

function rowsFrom(json) {
  // Three keys, because the two routes answer under different names: `todos` on
  // the list, `items` on Focus. Reading only one is how a test passes by finding
  // nothing at all.
  return [].concat(json.todos || [], json.items || [], json.tasks || []);
}

test('GET /api/todos hands the card its ticket', async () => {
  const res = await get('/api/todos');
  assert.equal(res.status, 200);
  const rows = rowsFrom(res.json);
  const linked = rows.find(r => r.task_id === linkedId);
  assert.ok(linked, 'the linked task should be in the open list');
  assert.equal(linked.jiraKey, 'NT-27530');
});

test('an unlinked task carries NO ticket — the field is never decoration', async () => {
  // The negative half, and the expensive direction: a truthy value here takes
  // the tick away from a task Nick owns.
  const res = await get('/api/todos');
  const plain = rowsFrom(res.json).find(r => r.task_id === plainId);
  assert.ok(plain, 'the plain task should be in the open list');
  assert.equal(plain.jiraKey, null);
});

test('GET /api/todos/focus carries it too — the second whitelist', async () => {
  const res = await get('/api/todos/focus?filter=all&showAll=true');
  assert.equal(res.status, 200);
  const rows = rowsFrom(res.json);
  const linked = rows.find(r => r.task_id === linkedId);
  assert.ok(linked, 'the linked task should reach Focus');
  assert.equal(linked.jiraKey, 'NT-27530');
});

test('the route agrees with the store about who closes what', async () => {
  // Two answers to one question is how a screen comes to contradict the refusal
  // it exists to explain.
  const res = await get('/api/todos');
  for (const row of rowsFrom(res.json)) {
    if (!row.task_id) continue;
    assert.equal(
      row.jiraKey || null,
      jiraTasks.keyForTask(row.task_id),
      `row ${row.task_id} disagrees with the link ledger`,
    );
  }
});
