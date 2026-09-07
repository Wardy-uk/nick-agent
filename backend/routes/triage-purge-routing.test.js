'use strict';

/**
 * `POST /triage/purge-fyi` resolves, and resolves to itself.
 *
 * Real HTTP, because a service suite proves the rule and not the wiring — this
 * router has shipped a literal path swallowed by a sibling parameter twice
 * (`/triage/feedback`, then `/triage/muted`), and both were only ever found by
 * calling them.
 *
 * MEASURED, not assumed: moving this route below `/triage/:emailId` does NOT
 * break it today, because every parameterised POST on this router carries a
 * second segment. So the registration order above is defence against a future
 * `POST /triage/:emailId`, and what these tests actually pin is that the route
 * is reachable, that it sweeps the section rather than the category, and that a
 * nonsense window is refused rather than applied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-purgeroute-')), 'a.db');

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

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();

function seed() {
  db.setState('email_triage', JSON.stringify([
    { id: 'old-fyi', category: 'FYI', lane: 'fyi', received: daysAgo(12), dismissed: false },
    { id: 'old-ignore', category: 'IGNORE', lane: 'ignore', received: daysAgo(20), dismissed: false },
    { id: 'new-fyi', category: 'FYI', lane: 'fyi', received: daysAgo(2), dismissed: false },
    { id: 'old-action', category: 'ACTION', lane: 'reply', received: daysAgo(40), dismissed: false },
  ]));
}

test('the route is reached, and does the sweep', async () => {
  seed();
  const res = await post('/api/email/triage/purge-fyi');
  assert.equal(res.status, 200);
  // The POSITIVE half: a real count from the purge, not a politely-shaped 200
  // from a handler that thought "purge-fyi" was an email id.
  assert.equal(res.json.aged, 2);
  assert.equal(res.json.days, 7);

  const live = emailTriage.getStoredTriage().filter(e => !e.dismissed).map(e => e.id).sort();
  assert.deepEqual(live, ['new-fyi', 'old-action']);
});

test('dryRun previews and writes nothing', async () => {
  seed();
  const res = await post('/api/email/triage/purge-fyi', { dryRun: true });
  assert.equal(res.json.aged, 2);
  assert.equal(res.json.dryRun, true);
  assert.equal(emailTriage.getStoredTriage().filter(e => e.dismissed).length, 0);
});

test('a nonsense window is refused rather than applied', async () => {
  seed();
  for (const days of [0, -3, 'soon']) {
    const res = await post('/api/email/triage/purge-fyi', { days });
    assert.equal(res.status, 400, `days=${days}`);
    assert.equal(res.json.ok, false);
  }
  assert.equal(emailTriage.getStoredTriage().filter(e => e.dismissed).length, 0);
});

test('POST /triage/clear-fyi clears the section and nothing else', async () => {
  seed();
  const preview = await post('/api/email/triage/clear-fyi', { dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.cleared, 3);
  assert.equal(emailTriage.getStoredTriage().filter(e => e.dismissed).length, 0);

  const res = await post('/api/email/triage/clear-fyi');
  assert.equal(res.json.cleared, 3);
  // The POSITIVE half: the ACTION email is still standing, so the button
  // reached the clear handler rather than something that swept the store.
  const live = emailTriage.getStoredTriage().filter(e => !e.dismissed).map(e => e.id);
  assert.deepEqual(live, ['old-action']);
});
