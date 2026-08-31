'use strict';

/**
 * `/api/catalogues` over real HTTP — the calls `CataloguesPanel` actually makes.
 *
 * A green service suite says NOTHING about routing, and this route had no UI at
 * all until 31 Aug, so nothing had ever driven it end to end. The assertions
 * here are deliberately the SHAPE the panel reads (`items` keyed by lower-cased
 * section, `count`, `already`), because a component reading a key the route does
 * not send renders empty and looks like an empty catalogue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cat-route-'));
process.env.OBSIDIAN_VAULT_PATH = root;

let server;
let base;

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

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/catalogues', require('./catalogue'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('a catalogue is created PRIVATE and shows up in the list', async () => {
  const made = await post('/api/catalogues', { title: 'Kitchen', sections: ['Fridge', 'Freezer'] });
  assert.equal(made.status, 200);
  assert.equal(made.body.slug, 'kitchen');
  // ⚠ The panel never sends `shared` on create. Fail closed is the whole point:
  // VESTA is on the public internet, so a new list must not arrive there.
  assert.equal(made.body.shared, false);

  const listed = await get('/api/catalogues');
  assert.equal(listed.status, 200);
  const row = listed.body.catalogues.find((c) => c.slug === 'kitchen');
  assert.ok(row, 'the catalogue the panel just created must appear in the list it re-reads');
  assert.equal(row.shared, false);
  assert.equal(row.count, 0);
  assert.deepEqual(row.sections, ['Fridge', 'Freezer']);
});

test('the detail response is keyed the way the panel reads it', async () => {
  await post('/api/catalogues/kitchen/add', { section: 'Fridge', name: 'milk' });
  const { status, body } = await get('/api/catalogues/kitchen');
  assert.equal(status, 200);
  assert.equal(body.title, 'Kitchen');
  // `sections` carries the DISPLAY name and `items` is keyed by its lower-cased
  // form — the panel does `items[section.toLowerCase()]`, so if these ever part
  // company every section renders empty and nothing errors.
  assert.deepEqual(body.sections, ['Fridge', 'Freezer']);
  assert.equal(body.items.fridge.length, 1);
  assert.equal(body.items.fridge[0].name, 'milk');
  assert.ok(body.items.fridge[0].added, 'an item records the day it went in');
  assert.equal(body.count, 1);
});

test('the same wording twice folds, and says it folded', async () => {
  const again = await post('/api/catalogues/kitchen/add', { section: 'Fridge', name: 'Milk' });
  assert.equal(again.status, 200);
  // Without `already` the second tap changes nothing and looks broken.
  assert.equal(again.body.already, true);
  const { body } = await get('/api/catalogues/kitchen');
  assert.equal(body.count, 1);
});

test('removing something that is not there is a miss, not a silent success', async () => {
  const miss = await post('/api/catalogues/kitchen/remove', { section: 'Fridge', name: 'kippers' });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.ok, false);

  const hit = await post('/api/catalogues/kitchen/remove', { section: 'Fridge', name: 'milk' });
  assert.equal(hit.status, 200);
  const { body } = await get('/api/catalogues/kitchen');
  assert.equal(body.count, 0);
});

test('adding to a section that does not exist is refused, not invented', async () => {
  const res = await post('/api/catalogues/kitchen/add', { section: 'Larder', name: 'flour' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Larder/);
});

test('sharing is its own route, and only a literal true shares', async () => {
  const on = await post('/api/catalogues/kitchen/shared', { shared: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.shared, true);
  assert.equal((await get('/api/catalogues/kitchen')).body.shared, true);

  // The string "true" is not true. Anything that is not the boolean fails
  // closed, so a client sending a form value cannot share by accident.
  const sloppy = await post('/api/catalogues/kitchen/shared', { shared: 'true' });
  assert.equal(sloppy.body.shared, false);

  const off = await post('/api/catalogues/kitchen/shared', { shared: false });
  assert.equal(off.body.shared, false);
});

test('a catalogue that does not exist says so rather than answering empty', async () => {
  const missing = await get('/api/catalogues/vinyl');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  // ⚠ Positive control: a 404 here must mean "no such catalogue", not "the
  // route is not mounted" — the one above proves the same path answers 200.
  assert.equal((await get('/api/catalogues/kitchen')).status, 200);
});

test('a second catalogue with the same name is refused', async () => {
  const dupe = await post('/api/catalogues', { title: 'Kitchen' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /already exists/);
});

test('an EMPTY section does not grow the file every time the panel writes', async () => {
  // The panel writes on every add and every remove, and a brand-new catalogue
  // is all empty sections — so this is the path that would have appended a
  // `*(empty)*` line to the file for ever. Asserted on DISK, end to end.
  const file = path.join(root, 'Catalogues', 'kitchen.md');
  await post('/api/catalogues/kitchen/add', { section: 'Fridge', name: 'butter' });
  const after = fs.readFileSync(file, 'utf-8');
  for (let i = 0; i < 4; i += 1) {
    await post('/api/catalogues/kitchen/add', { section: 'Fridge', name: `thing ${i}` });
    await post('/api/catalogues/kitchen/remove', { section: 'Fridge', name: `thing ${i}` });
  }
  const later = fs.readFileSync(file, 'utf-8');
  const count = (text) => (text.match(/\*\(empty\)\*/g) || []).length;
  assert.equal(count(after), 1, 'positive control: the placeholder IS written for the empty Freezer');
  assert.equal(count(later), count(after));
});
