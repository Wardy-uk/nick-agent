'use strict';

/**
 * Completing a Microsoft-owned attention card, over real HTTP.
 *
 * The service suite proves `lifecycle.act` hands the push back. It says nothing
 * about whether anybody PICKS IT UP — and the whole bug was a completion that
 * stopped one layer short of the work while reporting itself as done. So this
 * drives the actual route and asserts Graph was actually called with the id the
 * card was carrying.
 *
 * A green service suite says nothing about routing; a green routing suite says
 * nothing about a handler that awaits nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attcompl-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
// No vault: the mirror flip is skipped and the push still has to happen. That is
// the documented refusal — an unreadable vault must not cost the completion.
delete process.env.OBSIDIAN_VAULT_PATH;

const db = require('../db/database');
const lifecycle = require('../services/attention-lifecycle');
const microsoft = require('../services/microsoft');

let server;
let base;
let calls = [];
let answer = { completed: true, kind: 'todo' };
const realComplete = microsoft.completeMicrosoftTask;

test.before(async () => {
  await db.init();
  microsoft.completeMicrosoftTask = async (msId, source, listId) => {
    calls.push({ msId, source, listId });
    return answer;
  };
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  microsoft.completeMicrosoftTask = realComplete;
  if (server) server.close();
});

test.beforeEach(() => { calls = []; answer = { completed: true, kind: 'todo' }; });

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
function seed(owner) {
  seq += 1;
  const [rec] = lifecycle.reconcile([{
    kind: 'item',
    id: `todo-overdue-top-${seq}`,
    type: 'todo',
    title: `Stand up a temporary single view #${seq}`,
    urgency: 'medium',
    tier: 2,
    source: 'MS ToDo',
    meta: { dueDate: '2026-09-04', overdueCount: 8, owner },
  }], { now: new Date() });
  return rec;
}

const MS = { kind: 'microsoft', msId: 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy', msSource: 'MS ToDo' };

test('Done on a Microsoft card actually reaches Graph, with the id from the card', async () => {
  const rec = seed(MS);
  const { status, body } = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });

  assert.equal(status, 200);
  assert.equal(calls.length, 1, 'the route must await the push, not merely resolve the record');
  assert.equal(calls[0].msId, 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy');
  assert.equal(calls[0].source, 'MS ToDo');
  assert.equal(body.taskCompleted, true);
  assert.equal(body.msPush.pushed, 'todo');
});

test('a push Microsoft refuses is reported as NOT completed, and never as cleared', async () => {
  answer = { completed: false, reason: 'auth' };
  const rec = seed(MS);
  const { body } = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });

  assert.equal(body.msPush.pushed, 'none');
  // No vault here, so the mirror could not be flipped either: nothing was closed
  // ANYWHERE, and that must not report a completion. (With a vault the mirror
  // flip is what NEURO reads, and a held push still counts as closed.)
  assert.equal(body.taskCompleted, false);
  // The ticket is still open on somebody's board. The sentence has to say so.
  assert.match(body.taskWhy, /would not take it/);
  assert.equal(body.msPush.held, true, 'and it must be held for retry, not dropped');
});

test('a recurrence is a completion that says the task comes back — not a failure', async () => {
  // Microsoft closes the occurrence and rolls the SAME task id forward. Reported
  // as a failure it reads exactly like a lost tick, which is how three recurring
  // tasks got ticked over and over.
  answer = { completed: true, kind: 'todo', rolled: { nextDue: '2026-10-04' } };
  const rec = seed(MS);
  const { body } = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });

  assert.equal(body.taskCompleted, true);
  assert.match(body.taskWhy, /rolled the task forward/);
  assert.equal(body.msPush.rolled.nextDue, '2026-10-04');
});

test('a NEURO-owned card never touches Microsoft', async () => {
  const taskStore = require('../services/task-store');
  const { id } = taskStore.createTask({ text: 'A task NEURO owns outright', source: 'test' });
  const rec = seed({ kind: 'neuro', taskId: id });

  const { body } = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });
  assert.equal(calls.length, 0);
  assert.equal(body.taskCompleted, true);
  assert.equal(body.msPush, null);
});

test('deferring a Microsoft card touches nothing outbound', async () => {
  // The card is about somebody else's board. "Not now" is a statement about
  // Nick's day and must never reach it.
  const rec = seed(MS);
  const { status, body } = await post(`/api/attention/records/${rec.id}/act`, { action: 'defer', minutes: 60, reason: 'not-now' });
  assert.equal(status, 200);
  assert.equal(calls.length, 0);
  assert.equal(body.record.state, 'deferred');
});
