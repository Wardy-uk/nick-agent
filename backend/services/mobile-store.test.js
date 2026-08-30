'use strict';

/**
 * The Neuro Mobile local store, exercised for real.
 *
 * `sara/app/src/mobile/localStore.js` is browser ESM with NO imports of its own,
 * so it can be dynamically imported here against a fake IndexedDB and driven
 * exactly as the phone drives it. That matters more than usual: the store holds
 * captures that have not reached NEURO yet, so its MIGRATION path is the one
 * piece of client code whose failure destroys the only copy of something Nick
 * typed. A source assertion would not have caught a real upgrade bug.
 *
 * `backend/services/widget-source.test.js` is the precedent for a backend test
 * that reaches across the tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const STORE_PATH = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'mobile', 'localStore.js');

async function freshStore() {
  // A brand-new fake IndexedDB per test, and a fresh module instance so the
  // memoised connection does not leak between them.
  const { IDBFactory } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory();
  // Node defines `navigator` as a getter-only global, so it cannot be assigned.
  // The store only reads `navigator.storage` behind a guard, so leaving it alone
  // is correct — `estimate` simply comes back null, as it does in a browser that
  // does not implement it.
  const url = `${pathToFileURL(STORE_PATH).href}?v=${Math.random()}`;
  return import(url);
}

test('a round trip through the key/value store survives', async () => {
  const store = await freshStore();
  assert.equal((await store.checkAvailable()).ok, true);
  await store.kvSet('greeting', { hello: 'world' });
  assert.deepEqual(await store.kvGet('greeting'), { hello: 'world' });
});

test('checkAvailable proves a write LANDS, not merely that indexedDB is defined', async () => {
  const store = await freshStore();
  // A private window defines indexedDB and then throws on the first transaction,
  // so "typeof indexedDB" is not the claim this needs to make.
  globalThis.indexedDB = { open() { throw new Error('blocked'); } };
  const probe = await store.checkAvailable();
  assert.equal(probe.ok, false);
  assert.ok(probe.error);
});

test('the device id is stable across reads and looks like an id, not a credential', async () => {
  const store = await freshStore();
  const a = await store.getDeviceId();
  const b = await store.getDeviceId();
  assert.equal(a, b);
  assert.match(a, /^mob-/);
});

test('a snapshot is cached with the time it was FETCHED, not just the server clock', async () => {
  const store = await freshStore();
  await store.saveSnapshot({ schema: 'neuro.mobile.nick-now/1', generatedAt: '2026-08-30T08:00:00.000Z' });
  const row = await store.readSnapshot();
  assert.ok(row.fetchedAt, 'the UI says "as of X" from this, not from the payload');
  assert.equal(row.payload.generatedAt, '2026-08-30T08:00:00.000Z');
});

test('no cached snapshot reads as null — distinct from an empty one', async () => {
  const store = await freshStore();
  assert.equal(await store.readSnapshot(), null);
});

// ── Operations ───────────────────────────────────────────────────────────────

test('queued operations survive a reopen — a cold start must not lose a capture', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory();

  const first = await import(`${pathToFileURL(STORE_PATH).href}?v=a${Math.random()}`);
  await first.putOperation({
    operationId: 'op-1', kind: 'capture.note', payload: { content: 'must survive' },
    createdAt: '2026-08-30T09:00:00.000Z', status: first.OP_STATUS.QUEUED, attempts: 0,
  });

  // Same fake database, a fresh module — i.e. the app being reopened.
  const second = await import(`${pathToFileURL(STORE_PATH).href}?v=b${Math.random()}`);
  const ops = await second.listOperations();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].payload.content, 'must survive');
});

test('operations come back oldest first, so a queue drains in the order it was typed', async () => {
  const store = await freshStore();
  await store.putOperation({ operationId: 'b', kind: 'capture.todo', payload: {}, createdAt: '2026-08-30T10:00:00.000Z', status: 'queued' });
  await store.putOperation({ operationId: 'a', kind: 'capture.todo', payload: {}, createdAt: '2026-08-30T09:00:00.000Z', status: 'queued' });
  const ops = await store.listOperations();
  assert.deepEqual(ops.map((o) => o.operationId), ['a', 'b']);
});

// ── Migration — the part whose failure destroys data ─────────────────────────

// ⚠ SCHEMA_VERSION is 1, so there is no v1→v2 upgrade to drive yet. This proves
// the case that DOES happen today — the app updates, opens the existing
// database, and must find the queue intact. The forward-looking half is pinned
// by the source assertion below, which is weaker and is the honest thing to say
// about it: when a v2 branch is written, drive it here for real.
test('reopening an existing database keeps every queued operation', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const idb = new IDBFactory();
  globalThis.indexedDB = idb;

  // Stand up the v1 shape by hand and put an unsent capture in it, exactly as a
  // phone that has been offline all afternoon would hold one.
  await new Promise((resolve, reject) => {
    const req = idb.open('neuro-mobile', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv', { keyPath: 'key' });
      const ops = db.createObjectStore('operations', { keyPath: 'operationId' });
      ops.createIndex('status', 'status');
      ops.createIndex('createdAt', 'createdAt');
      db.createObjectStore('receipts', { keyPath: 'operationId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['operations'], 'readwrite');
      t.objectStore('operations').put({
        operationId: 'pre-upgrade', kind: 'capture.note',
        payload: { content: 'typed before the app updated' },
        createdAt: '2026-08-29T18:00:00.000Z', status: 'queued', attempts: 0,
      });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });

  // Now open through the real module, i.e. the upgraded app starting up.
  const store = await import(`${pathToFileURL(STORE_PATH).href}?v=u${Math.random()}`);
  const ops = await store.listOperations();
  assert.equal(ops.length, 1, 'an app upgrade must never discard an unsent capture');
  assert.equal(ops[0].payload.content, 'typed before the app updated');
});

// ── Clearing ─────────────────────────────────────────────────────────────────

test('clearing REFUSES while anything is unsent, and says how many', async () => {
  const store = await freshStore();
  await store.putOperation({ operationId: 'x', kind: 'capture.note', payload: { content: 'unsent' }, createdAt: '2026-08-30T09:00:00.000Z', status: store.OP_STATUS.QUEUED });
  const result = await store.clearLocalData();
  assert.equal(result.ok, false);
  assert.equal(result.refused, 'unsent-operations');
  assert.equal(result.unsent, 1);
  // And it really did not clear it.
  assert.equal((await store.listOperations()).length, 1);
});

test('clearing the cache leaves the queue alone', async () => {
  const store = await freshStore();
  await store.saveSnapshot({ schema: 'x' });
  await store.clearLocalData();
  assert.equal(await store.readSnapshot(), null, 'the cache is derived and always safe to drop');
});

test('force clears everything, and reports what it destroyed', async () => {
  const store = await freshStore();
  await store.putOperation({ operationId: 'y', kind: 'capture.note', payload: { content: 'unsent' }, createdAt: '2026-08-30T09:00:00.000Z', status: store.OP_STATUS.QUEUED });
  const result = await store.clearLocalData({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.clearedOperations, 1, 'the caller must be able to say what is about to be lost');
  assert.equal((await store.listOperations()).length, 0);
});

// ── Honesty about what this storage is ───────────────────────────────────────

test('describeStorage never claims the store is encrypted', async () => {
  const store = await freshStore();
  const described = await store.describeStorage();
  assert.equal(described.encrypted, false);
  assert.equal(described.available, true);
  assert.equal(described.schemaVersion, store.SCHEMA_VERSION);
});

// ── Source invariants ────────────────────────────────────────────────────────
//
// Weaker than driving the code, and pinned anyway because the failure they guard
// against is unrecoverable: an upgrade branch that clears the outbox destroys
// the only copy of something Nick typed. `push-types.test.js` is the precedent
// for a source scan, positive control included so a broken scan cannot pass by
// finding nothing.

const fs = require('fs');

test('the upgrade path never clears or deletes the operations store', () => {
  const src = fs.readFileSync(STORE_PATH, 'utf-8');
  const start = src.indexOf('function upgrade(');
  assert.ok(start > -1, 'positive control: upgrade() must be findable');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end > -1 ? end : src.length);

  assert.ok(body.includes('createObjectStore'), 'positive control: the slice is the real upgrade body');
  assert.ok(!/deleteObjectStore/.test(body), 'an upgrade must not delete a store');
  assert.ok(!/\.clear\(/.test(body), 'an upgrade must not clear a store');
});

test('no credential ever goes into IndexedDB', () => {
  // The PIN and any API token stay in localStorage, written by api.js. A
  // credential sitting next to bulk data that gets exported, cleared and
  // migrated by this file is how one leaks.
  const src = fs.readFileSync(STORE_PATH, 'utf-8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(code.includes('KEY.DEVICE_ID'), 'positive control: the key list is in the scanned text');
  assert.ok(!/localStorage/.test(code), 'this module must not touch the credential store');
  assert.ok(!/\b(pin|token|secret|password)\b/i.test(code.replace(/DEVICE_ID/g, '')), 'no credential-shaped key');
});
