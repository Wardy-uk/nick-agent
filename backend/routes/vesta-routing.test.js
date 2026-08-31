'use strict';

/**
 * VESTA's public boundary, over real HTTP.
 *
 * This is the one part of NEURO deliberately open to the internet, so the
 * boundary is proved rather than asserted. A green service suite says nothing
 * about what an unauthenticated request can actually reach.
 *
 * The important tests here are the ones that FAIL to get things.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vesta-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
// The session signer needs one of these; without it login refuses outright.
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';

const express = require('express');
const db = require('../db/database');
const capture = require('../services/capture-links');
const catalogue = require('../services/catalogue');

let server;
let base;

test.before(async () => {
  await db.init();

  const app = express();
  app.use(express.json());
  app.use('/api/v', require('./vesta'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(r => server.close(r)));

async function call(pathname, { token, body, method } = {}) {
  const res = await fetch(base + pathname, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function signIn(username, pin) {
  const r = await call('/api/v/login', { body: { username, pin } });
  return r.json.token;
}

// ── The boundary ─────────────────────────────────────────────────────────────

test('no token reaches nothing', async () => {
  for (const p of ['/api/v/home', '/api/v/tasks', '/api/v/catalogue/kitchen/add']) {
    const r = await call(p, { body: p === '/api/v/home' ? null : { text: 'x' } });
    assert.equal(r.status, 401, `${p} must refuse an unauthenticated caller`);
  }
});

test('a forged token reaches nothing', async () => {
  const r = await call('/api/v/home', { token: 'not.a.real.token' });
  assert.equal(r.status, 401);
});

// ── Scopes default closed ────────────────────────────────────────────────────

test('an account with no scopes granted sees ONLY its own tasks', async () => {
  capture.create({ label: 'Legacy', username: 'legacy', pin: '246810' });
  const token = await signIn('legacy', '246810');
  assert.ok(token, 'sign-in should work');

  const { status, json } = await call('/api/v/home', { token });
  assert.equal(status, 200);
  assert.deepEqual(json.scopes, ['tasks']);
  assert.ok(Array.isArray(json.tasks), 'its own submissions are the one thing it gets');
  // The two that matter. Absent, not empty.
  assert.equal('calendar' in json, false, 'no calendar block at all for an account without the scope');
  assert.equal('kitchen' in json, false, 'nor a kitchen block');
});

test('the kitchen refuses to be written by an account without the scope', async () => {
  const token = await signIn('legacy', '246810');
  const r = await call('/api/v/catalogue/kitchen/add', { token, body: { section: 'Fridge', name: 'milk' } });
  assert.equal(r.status, 403);
});

// ── A granted account ────────────────────────────────────────────────────────

test('a granted account gets the calendar, REDACTED', async () => {
  capture.create({ label: 'Partner', username: 'partner', pin: '135790', scopes: ['tasks', 'calendar', 'kitchen'] });

  const p = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  // ⚠ The writer's field names are camelCase (`id`/`start`/`end`/`showAs`), NOT
  // the snake_case COLUMN names. Guessing the input shape from the schema wrote
  // a row of nulls, and the negative assertions below all passed on it — an
  // empty calendar contains no customer names either. That is why the positive
  // assertion is here: without it this test is green and proves nothing.
  db.upsertCalendarEvent({
    id: 'work-1',
    subject: 'Sandford escalation with Chancellors',
    location: "Chancellors' Offices",
    start: `${today}T10:00:00`,
    end: `${today}T11:00:00`,
    showAs: 'busy',
    source: 'graph',
  });
  db.upsertCalendarEvent({
    id: 'personal-1',
    subject: 'Dentist',
    start: `${today}T15:00:00`,
    end: `${today}T15:30:00`,
    showAs: 'busy',
    source: 'apple',
  });

  const token = await signIn('partner', '135790');
  const { status, json } = await call('/api/v/home', { token });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.calendar), 'the calendar block is present for a granted account');

  const blob = JSON.stringify(json);
  // THE test. Over real HTTP, end to end, out of a real database row.
  assert.ok(!blob.includes('Sandford'), 'the work subject must not cross the wire');
  assert.ok(!blob.includes('Chancellors'), 'nor the location');
  assert.ok(blob.includes('Busy'), 'it is there as a time block');
  assert.ok(blob.includes('Dentist'), 'and his personal event shows properly');
});

test('the kitchen round-trips through the vault file', async () => {
  catalogue.create({ title: 'Kitchen', sections: ['Fridge', 'Freezer'], shared: true });
  const token = await signIn('partner', '135790');

  const added = await call('/api/v/catalogue/kitchen/add', { token, body: { section: 'Freezer', name: '4 chicken thighs' } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.items.freezer.map(i => i.name), ['4 chicken thighs']);

  // It really is a file in the vault, not a hidden table.
  const file = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Catalogues', 'kitchen.md');
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf-8'), /4 chicken thighs/);

  const used = await call('/api/v/catalogue/kitchen/used', { token, body: { section: 'Freezer', name: '4 chicken thighs' } });
  assert.equal(used.status, 200);
  assert.deepEqual(used.json.items.freezer, []);
});

test('⚠ a PRIVATE catalogue is invisible even to a granted account', () => {
  // The whole reason `shared` exists. A scope grants the SHARED catalogues,
  // never a slug of the caller's choosing.
  catalogue.create({ title: 'Vinyl', sections: ['Jazz'] });   // shared defaults false
  catalogue.addItem('vinyl', 'Jazz', 'Kind of Blue');
  return signIn('partner', '135790').then(async (token) => {
    const home = await call('/api/v/home', { token });
    assert.ok(!JSON.stringify(home.json).includes('Vinyl'), 'it is not in the shared list');

    // And naming it directly gets the same answer a missing one would, so this
    // cannot be used to enumerate what he owns.
    const poke = await call('/api/v/catalogue/vinyl/add', { token, body: { section: 'Jazz', name: 'x' } });
    assert.equal(poke.status, 404);
    assert.match(poke.json.error, /no such catalogue/);
  });
});

test('eating something that is not there is a 404, not a silent success', async () => {
  const token = await signIn('partner', '135790');
  const r = await call('/api/v/catalogue/kitchen/used', { token, body: { section: 'Fridge', name: 'caviar' } });
  assert.equal(r.status, 404);
});

test('an unknown section is refused rather than silently created', async () => {
  const token = await signIn('partner', '135790');
  const r = await call('/api/v/catalogue/kitchen/add', { token, body: { section: 'garage', name: 'antifreeze' } });
  assert.equal(r.status, 400);
});

test('narrowing an account takes effect on the NEXT request, not in twelve hours', async () => {
  // The session is re-resolved every request rather than trusted from the token,
  // which is what makes revocation mean anything on a public door.
  const token = await signIn('partner', '135790');
  assert.ok((await call('/api/v/home', { token })).json.calendar, 'granted first');

  capture.setScopes('partner', ['tasks']);
  const after = await call('/api/v/home', { token });
  assert.equal('calendar' in after.json, false, 'the same token no longer sees the diary');
});
