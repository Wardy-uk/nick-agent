'use strict';

/**
 * The snooze routes resolve, and — the half worth a real HTTP test — a sleeping
 * card is hidden from the SCREEN while staying in the POOL.
 *
 * That second one is the whole design. `suggestion-engine` dedupes against
 * pending to decide whether to create another card; if a snooze took the row
 * out of that pool, NEURO would regenerate the identical one within the minute.
 * A pure test cannot see it, because the pool is a database read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-snooze-')), 'a.db');

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
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

function queue(type = 'capture_todo', payload = { text: 'Resend the risk assessment' }) {
  return db.createSaraAction(type, payload, 0.8, 'test', null);
}

const snooze = (id, minutes) =>
  fetch(`${base}/api/actions/${id}/snooze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  });

test('a pending action can be snoozed', async () => {
  const id = queue();
  const res = await snooze(id, 60);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(Date.parse(json.until) > Date.now(), 'and it comes back in the future');
});

test('it leaves the screen and says where it went', async () => {
  const json = await (await fetch(`${base}/api/actions`)).json();
  assert.equal(json.pending.length, 0, 'nothing is waiting on Nick');
  assert.equal(json.snoozedTotal, 1);
  assert.equal(json.snoozed.length, 1, 'asleep is not gone - it is still reachable');
  assert.ok(json.snoozed[0].snoozed_until, 'and it carries when it wakes');
});

// ⚠ THE ONE THAT MATTERS. The 7 Sep offered-once fix dedupes against the
// PENDING pool. A snooze that emptied that pool would have the engine build the
// same card again immediately - a button meaning "leave me alone" causing more
// cards, not fewer.
test('it stays in the pending POOL, or the engine would build it again', () => {
  const pool = db.getPendingSaraActions(1000);
  assert.equal(pool.length, 1, 'still pending as far as every dedupe pass is concerned');
  assert.equal(pool[0].status, 'pending', 'a snooze is not a decision');
  assert.ok(pool[0].snoozed_until);
});

test('snoozing is not a rejection, so nothing is resolved', () => {
  const row = db.getSaraAction(db.getPendingSaraActions(1000)[0].id);
  assert.equal(row.resolved_at, null, 'saying "later" must not read as a verdict');
});

test('there is a way back, and it puts the card straight back on the screen', async () => {
  const id = db.getPendingSaraActions(1000)[0].id;
  const res = await fetch(`${base}/api/actions/${id}/snooze`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const json = await (await fetch(`${base}/api/actions`)).json();
  assert.equal(json.pending.length, 1);
  assert.equal(json.snoozedTotal, 0);
});

test('nonsense minutes are refused, not defaulted', async () => {
  const id = db.getPendingSaraActions(1000)[0].id;
  const res = await snooze(id, -5);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('an action that is already decided cannot be snoozed', async () => {
  const id = queue('draft_reply', { emailId: 'x' });
  db.updateSaraActionStatus(id, 'rejected');
  const res = await snooze(id, 60);
  assert.equal(res.status, 400);
  assert.match((await res.json()).reason, /already rejected/);
});

test('an action that does not exist is a 404, not a silent no-op', async () => {
  const res = await snooze(999999, 60);
  assert.equal(res.status, 404);
});

test('waking something that is not asleep is refused rather than reported done', async () => {
  const id = db.getPendingSaraActions(1000).find(a => !a.snoozed_until).id;
  const res = await fetch(`${base}/api/actions/${id}/snooze`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).reason, /not snoozed/);
});
