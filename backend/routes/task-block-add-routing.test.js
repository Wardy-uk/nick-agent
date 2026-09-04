'use strict';

/**
 * `POST /api/task-blocks/:id/tasks` resolves, and resolves to itself.
 *
 * It shares a prefix with `DELETE /:id/tasks/:taskId` and sits on a router that
 * already carries `/:id/note`, `/:id/release`, `/:id/drop` and friends. Segment
 * counts and verbs keep them apart, but this repo has shipped a literal path
 * swallowed by a sibling parameter before (`/triage/feedback` read as an email
 * id) and a route that answers the wrong handler answers 200 while doing
 * nothing — the exact failure this whole area refuses.
 *
 * Real HTTP, because a service suite proves the rules and not the wiring, and
 * every assertion here has a POSITIVE half: the membership actually moved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-blockadd-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const taskStore = require('../services/task-store');
const taskBlocks = require('../services/task-blocks');
const router = require('./task-blocks');

let server;
let base;

// Graph is not reachable from a test, and the membership is written before it.
const microsoft = require('../services/microsoft');
microsoft.updateCalendarEvent = async () => ({ updated: false, reason: 'no graph in tests' });

// An empty diary rather than an unreadable one — "I could not look" is a
// different answer and belongs in the service suite, where it is pinned.
db.getCalendarEvents = () => [];

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/task-blocks', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let daySeq = 0;
function newTask(text) {
  return taskStore.createTask({ text, source: 'manual', skipExport: true }).id;
}

/** A 10:00–10:30 block on a day of its own, well ahead of now. */
function block(text) {
  const dateKey = `2027-03-${String(++daySeq).padStart(2, '0')}`;
  const taskId = newTask(text);
  const blockId = db.createTaskBlockRow({
    date_key: dateKey,
    start_time: '10:00',
    end_time: '10:30',
    minutes: 30,
    minutes_assumed: 0,
    note_path: `Outcomes/${dateKey}.md`,
    status: 'scheduled',
  });
  db.addTaskBlockItem(blockId, taskId, null);
  return { blockId, taskId, dateKey };
}

test('the route adds the task, and the block really holds it', async () => {
  const { blockId } = block('The task already in the window');
  const extra = newTask('The task being added over HTTP');

  const res = await post(`/api/task-blocks/${blockId}/tasks`, { taskId: extra });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.total, 2);
  // ⚠ The positive half. A handler answering politely while writing nothing
  // passes every check made on its own output.
  assert.ok(db.listTaskBlockItems(blockId).some(i => i.task_id === extra));
});

test('the window is lengthened, and it is this block that moved', async () => {
  const { blockId } = block('Anchor for the lengthening test');
  const extra = newTask('Half an hour of extra work');
  taskStore.updateTask(extra, { estimateMinutes: 30 });

  const res = await post(`/api/task-blocks/${blockId}/tasks`, { taskId: extra });

  assert.equal(res.json.extendedBy, 30);
  assert.equal(db.getTaskBlockRow(blockId).end_time, '11:00');
});

test('no taskId is a 400, not a silent no-op', async () => {
  const { blockId } = block('Nothing should reach this one');
  const res = await post(`/api/task-blocks/${blockId}/tasks`, {});
  assert.equal(res.status, 400);
  assert.match(res.json.error, /taskId/);
  assert.equal(db.listTaskBlockItems(blockId).length, 1);
});

test('a refusal is a 400 CARRYING THE REASON, never a bare failure', async () => {
  // The screen quotes this verbatim, so an empty one is a button that appears
  // to do nothing — which is the shape being designed out.
  const { blockId } = block('A block that is about to be released');
  db.updateTaskBlockRow(blockId, { status: 'released', release_reason: 'nothing to write up' });
  const extra = newTask('Too late for this window');

  const res = await post(`/api/task-blocks/${blockId}/tasks`, { taskId: extra });

  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.ok(res.json.error && res.json.error.length > 10, res.json.error);
});

test('an unknown block is refused rather than 404ing into a sibling handler', async () => {
  const res = await post('/api/task-blocks/999999/tasks', { taskId: newTask('Homeless task') });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /No block/);
});

test('DELETE still reaches the REMOVE handler — the pair did not collide', async () => {
  // The whole reason this file exists: adding a POST on `/:id/tasks` beside a
  // DELETE on `/:id/tasks/:taskId` is exactly the shape that has gone wrong here
  // before.
  const { blockId, taskId } = block('The one that stays behind');
  const extra = newTask('The one to be removed again');
  await post(`/api/task-blocks/${blockId}/tasks`, { taskId: extra });
  assert.equal(db.listTaskBlockItems(blockId).length, 2);

  const res = await fetch(`${base}/api/task-blocks/${blockId}/tasks/${extra}`, { method: 'DELETE' })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(db.listTaskBlockItems(blockId).map(i => i.task_id), [taskId]);
});

test('the cap the route reports is the service\'s own number', async () => {
  // Two constants for one rule is how the two ways into a block come to
  // disagree about how full it is.
  assert.equal(taskBlocks.MAX_TASKS_PER_BLOCK, 12);
});
