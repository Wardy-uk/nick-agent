'use strict';

/**
 * The muted-sender routes resolve, and resolve to themselves.
 *
 * `GET /triage/muted` sits on a router that already has `GET /triage/:emailId`,
 * and Express matches in REGISTRATION ORDER. Declared after it — which is
 * exactly where it was first written — "muted" is read as an email id and the
 * request 404s (or worse, answers about a message that does not exist). That is
 * #70's bug verbatim, where "feedback" was parsed the same way.
 *
 * Real HTTP, because a service suite proves the functions and not the wiring.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mutedroute-')), 'a.db');

const db = require('../db/database');
const router = require('./email-triage');
const emailTriage = require('../services/email-triage');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/email', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = url => fetch(`${base}${url}`)
  .then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

test('GET /triage/muted returns the rules, not an email called "muted"', async () => {
  emailTriage.muteSender('news@nationalclubgolfer.com', {
    name: 'National Club Golfer',
    subject: 'My ball is covered in animal droppings',
  });

  const res = await get('/api/email/triage/muted');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // The POSITIVE half: it is the muted list, not a politely-shaped 200 from the
  // `:emailId` handler that happens to carry an ok flag.
  assert.equal(res.json.senders.length, 1);
  assert.equal(res.json.senders[0].address, 'news@nationalclubgolfer.com');
  assert.equal(res.json.senders[0].name, 'National Club Golfer');
});

test('DELETE un-mutes, and the list moves', async () => {
  emailTriage.muteSender('news@nationalclubgolfer.com', {});
  const res = await fetch(
    `${base}/api/email/triage/muted/${encodeURIComponent('news@nationalclubgolfer.com')}`,
    { method: 'DELETE' },
  ).then(async r => ({ status: r.status, json: await r.json() }));

  assert.equal(res.status, 200);
  assert.equal(res.json.unmuted, 'news@nationalclubgolfer.com');
  assert.deepEqual((await get('/api/email/triage/muted')).json.senders, []);
});

test('un-muting something that is not muted says so rather than reporting success', async () => {
  const res = await fetch(`${base}/api/email/triage/muted/${encodeURIComponent('nobody@example.com')}`,
    { method: 'DELETE' }).then(async r => ({ status: r.status, json: await r.json() }));

  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
  assert.ok(res.json.error);
});
