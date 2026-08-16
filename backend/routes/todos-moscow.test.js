'use strict';

/**
 * #50 — POST /api/todos/moscow refuses a line NEURO does not own.
 *
 * The route used to fall through to a legacy path-keyed `task_moscow` row when
 * no taskId was given. Nothing read those back for anything editable, so rating
 * a file-backed mirror returned `{ok:true}` and changed nothing a user could
 * ever see. Measured before removing: one row written in the system's life.
 *
 * This mounts the real router and calls it over HTTP rather than reaching into
 * a handler, because a green unit test says nothing about whether Express will
 * route to it — the lesson from the `/triage/feedback` shadowing bug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-moscow-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
// Point the vault somewhere empty and disposable: requiring this router pulls
// in the task store, and #119's rule is that the suite never touches the real
// vault. An empty dir is a valid vault as far as these paths are concerned.
process.env.OBSIDIAN_VAULT_PATH = tmp;

const express = require('express');
const router = require('./todos');

let base;
let server;

test.before(async () => {
  // A scratch DB, schema and all — the two guard tests below short-circuit
  // before touching it, but the 404 needs a real (empty) tasks table.
  await require('../db/database').init();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

const post = (body) => fetch(`${base}/api/todos/moscow`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a rating with no taskId is refused, with a reason', async () => {
  const res = await post({ filePath: '/vault/Tasks/Microsoft Tasks.md', lineNumber: 4, text: 'Succession plan', moscow: 'must' });
  assert.equal(res.status, 400, 'never a cheerful ok into a place with no readers');
  const body = await res.json();
  assert.match(body.error, /taskId is required/);
  // The refusal must say WHY, or it reads as a validation nit rather than a
  // statement about what can hold a rating.
  assert.match(body.error, /file-backed|NEURO owns/i);
});

test('an unknown MoSCoW value is still rejected before anything else', async () => {
  const res = await post({ taskId: 1, moscow: 'maybe' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must, should, could, wont/);
});

test('a taskId that does not exist is a 404, not a silent success', async () => {
  const res = await post({ taskId: 999999, moscow: 'must' });
  assert.equal(res.status, 404);
});
