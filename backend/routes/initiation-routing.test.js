'use strict';

/**
 * Routing for the initiation-signals read and the finish close-out.
 *
 * A green service suite says nothing about routing — this repo has shipped a
 * literal path swallowed by a sibling parameterised one more than once. These
 * drive real HTTP against the real router.
 *
 * ⚠ `/signals` is a literal on a router that also carries `/history` and a
 * dozen POSTs. It is mounted ABOVE `/start` deliberately; the mutation check
 * for these tests is to rename the path and watch them fail.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Scratch DB before anything requires the database module.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-signals-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(scratch, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');
const router = require('./focus-session');
const focusSession = require('../services/focus-session');

let server;
let base;

before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/session', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
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
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
};

test('GET /signals resolves to the signals read, not to a session named "signals"', async () => {
  const { status, body } = await get('/api/session/signals');
  assert.equal(status, 200);
  // The shape is the assertion: a route swallowed by a sibling would answer
  // with a session view, which has none of these.
  assert.ok(body.starts, 'no starts block — something else answered');
  assert.ok(body.shrinks, 'no shrinks block');
  assert.ok(body.estimates, 'no estimates block');
  assert.equal(typeof body.starts.today, 'number');
});

test('GET /signals is read-only — it starts nothing', async () => {
  await get('/api/session/signals');
  const { body } = await get('/api/session');
  assert.equal(body.session, null, 'a read must never create a session');
});

test('a running session shows up in the signals count while it is running', async () => {
  const started = await post('/api/session/start', { text: 'signals routing probe', minutes: 25 });
  assert.equal(started.status, 200);

  const { body } = await get('/api/session/signals');
  assert.equal(body.starts.today, 1, 'the live session is not in history yet and must still count');
  assert.equal(body.starts.live, true);
});

test('finishing carries a close-out line built from the estimate Nick set', async () => {
  const { status, body } = await post('/api/session/finish', {});
  assert.equal(status, 200);
  assert.ok(body.closeout, 'no close-out on a session with a real estimate');
  // 25 minutes planned, finished immediately — under, and stated as a fact.
  assert.equal(body.closeout.kind, 'under');
  assert.match(body.closeout.say, /25/);
});

test('a finished session stays counted as a start', async () => {
  const { body } = await get('/api/session/signals');
  assert.equal(body.starts.today, 1, 'the start survives the session ending');
  assert.equal(body.starts.live, false);
});

test('a session with no estimate of Nick’s gets no comparison', async () => {
  await post('/api/session/start', { text: 'no estimate probe', force: true });
  const { body } = await post('/api/session/finish', {});
  assert.equal(body.closeout.kind, 'no-estimate');
  assert.equal(body.closeout.diffMinutes, null);
});

test('an abandoned session still counts as a start', async () => {
  const before = (await get('/api/session/signals')).body.starts.today;
  await post('/api/session/start', { text: 'abandon probe', force: true });
  await post('/api/session/abandon', {});
  const after = (await get('/api/session/signals')).body.starts.today;
  assert.equal(after, before + 1, 'rewarding only completions is the surface this replaces');
});

test('shrinking is recorded and surfaces as a ladder, not as a failure', async () => {
  await post('/api/session/start', { text: 'rewrite the escalation policy', force: true, minutes: 60 });
  await post('/api/session/shrink', { step: 'open the doc and list the headings' });
  await post('/api/session/finish', {});

  const { body } = await get('/api/session/signals');
  assert.ok(body.shrinks.today >= 1);
  const rung = body.shrinks.ladder.find((l) => l.from === 'rewrite the escalation policy');
  assert.ok(rung, 'the ladder must carry the wording he started with');
  assert.equal(rung.to, 'open the doc and list the headings');
});

test('the payload exposes no streak, score or grade', async () => {
  const { body } = await get('/api/session/signals');
  const flat = JSON.stringify(body).toLowerCase();
  for (const banned of ['streak', 'score', 'points', 'grade', ' xp']) {
    assert.ok(!flat.includes(banned), `must not expose "${banned}"`);
  }
});

// ── Triage, end to end ───────────────────────────────────────────────────────
//
// The service suite proves the counting rules against plain data. These prove
// the link that suite cannot see: that `task-store.updateTask` actually writes
// `task_triaged`, and that `build()` actually reads it back. A wrong event name
// or a missed field would leave both halves green and the number permanently 0.

test('deciding a task’s shape is counted as triage', async () => {
  const taskStore = require('../services/task-store');
  const signalsSvc = require('../services/initiation-signals');

  const task = taskStore.createTask({ text: 'triage probe one', source: 'manual' });
  const before = signalsSvc.build().triage.today;

  taskStore.updateTask(task.id, { due_date: '2026-09-30' });

  const after = signalsSvc.build();
  assert.equal(after.triage.today, before + 1, 'setting a due date is triage');
  assert.ok(after.triage.byField.due_date >= 1);
});

test('re-saving the same values records nothing', async () => {
  const taskStore = require('../services/task-store');
  const signalsSvc = require('../services/initiation-signals');

  const task = taskStore.createTask({ text: 'triage probe two', source: 'manual' });
  taskStore.updateTask(task.id, { moscow: 'must' });
  const after = signalsSvc.build().triage.today;

  // The TaskEditPanel save sends every field every time; pressing Save twice
  // must not read as two decisions.
  taskStore.updateTask(task.id, { moscow: 'must' });
  assert.equal(signalsSvc.build().triage.today, after, 'no change is not a decision');
});

test('a first estimate is distinguished from a re-estimate', async () => {
  const taskStore = require('../services/task-store');
  const signalsSvc = require('../services/initiation-signals');

  const task = taskStore.createTask({ text: 'triage probe three', source: 'manual' });
  const before = signalsSvc.build().triage.firstEstimatesToday;

  taskStore.updateTask(task.id, { estimateMinutes: 60 });
  const afterFirst = signalsSvc.build().triage.firstEstimatesToday;
  assert.equal(afterFirst, before + 1, 'the planner did not have this estimate before');

  taskStore.updateTask(task.id, { estimateMinutes: 120 });
  assert.equal(
    signalsSvc.build().triage.firstEstimatesToday,
    afterFirst,
    're-estimating is real triage but not a first estimate',
  );
});

test('finishing a task is not counted as triage', async () => {
  const taskStore = require('../services/task-store');
  const signalsSvc = require('../services/initiation-signals');

  const task = taskStore.createTask({ text: 'triage probe four', source: 'manual' });
  const before = signalsSvc.build().triage.today;
  taskStore.updateTask(task.id, { status: 'done' });
  assert.equal(signalsSvc.build().triage.today, before, 'completion is already counted elsewhere');
});

test('history is left as the source of truth — signals stores nothing of its own', async () => {
  const before = focusSession.history().length;
  await get('/api/session/signals');
  assert.equal(focusSession.history().length, before, 'the read must not write');
});
