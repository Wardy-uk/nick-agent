'use strict';

/**
 * The internal-duplicate routes actually resolve, over real HTTP.
 *
 * A green service suite says nothing about routing (the repo has been bitten
 * twice: `/triage/feedback` read as an email id, and the MCP `get_queue` calling
 * a path that never existed and 404ing for months). Four routes were added to
 * this router in one go; this drives them through Express with a real body and a
 * real status code, including the refusal path — a merge that comes back 200 with
 * `ok:false` would render on the card as a merge that happened.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-dedupe-route-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const express = require('express');
const db = require('../db/database');
const taskStore = require('../services/task-store');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/task-dedupe', require('./task-dedupe'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(r => server.close(r)));

async function call(pathname, body) {
  const res = await fetch(base + pathname, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('GET /candidates carries the internal half and says what it compared', async () => {
  taskStore.createTask({ text: 'Consult Annabelle for insights' });
  taskStore.createTask({ text: 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights' });

  const { status, json } = await call('/api/task-dedupe/candidates');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.internal), 'internal must be present, not undefined');
  assert.equal(json.internal.length, 1);
  assert.equal(json.defaultInternalMinScore, 0.65);
  assert.ok(json.compared.internalPairs > 0, 'an empty list must be readable as "nothing matched", not "nothing compared"');
  assert.ok(Array.isArray(json.merges));
});

test('POST /merge merges, and /unmerge puts it back', async () => {
  const keep = taskStore.createTask({ text: 'Continue phone-answering coaching with the remaining team member' });
  const drop = taskStore.createTask({ text: 'Continue coaching on phone answering; complete the planned session with the remaining team member' });

  const merged = await call('/api/task-dedupe/merge', { keepId: keep.id, dropId: drop.id });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.ok, true);
  assert.equal(taskStore.getTask(drop.id).status, 'dropped');

  const undone = await call('/api/task-dedupe/unmerge', { dropId: drop.id });
  assert.equal(undone.status, 200);
  assert.equal(taskStore.getTask(drop.id).status, 'open');
});

test('a refused merge is a 409, never a 200 carrying ok:false', async () => {
  const t = taskStore.createTask({ text: 'Renew the wildcard certificate for the portal' });
  const { status, json } = await call('/api/task-dedupe/merge', { keepId: t.id, dropId: 999999 });
  assert.equal(status, 409, 'a 200 here renders on the card as a merge that happened');
  assert.equal(json.reason, 'drop_not_found');
});

test('POST /internal-dismiss takes a pair out and /internal-undismiss puts it back', async () => {
  const a = taskStore.createTask({ text: 'Draft the incident comms template for major outages' });
  const b = taskStore.createTask({ text: 'Draft an incident comms template covering major outages' });

  assert.equal((await call('/api/task-dedupe/internal-dismiss', { aId: a.id, bId: b.id })).status, 200);
  const after = await call('/api/task-dedupe/candidates');
  assert.equal(after.json.internal.some(p => [p.keep.id, p.drop.id].includes(a.id)), false);

  assert.equal((await call('/api/task-dedupe/internal-undismiss', { aId: a.id, bId: b.id })).status, 200);
  const back = await call('/api/task-dedupe/candidates');
  assert.equal(back.json.internal.some(p => [p.keep.id, p.drop.id].includes(a.id)), true);
});

test('the four new literal paths did not shadow the ones already here', async () => {
  const router = require('./task-dedupe');
  for (const [url, method, expected] of [
    ['/candidates', 'get', '/candidates'],
    ['/match', 'post', '/match'],
    ['/link', 'post', '/link'],
    ['/dismiss', 'post', '/dismiss'],
    ['/merge', 'post', '/merge'],
    ['/internal-dismiss', 'post', '/internal-dismiss'],
  ]) {
    const hits = router.stack.filter(l => l.route && l.regexp.test(url) && l.route.methods[method]);
    assert.ok(hits.length > 0, `no ${method.toUpperCase()} layer matches ${url}`);
    assert.equal(hits[0].route.path, expected);
  }
});
