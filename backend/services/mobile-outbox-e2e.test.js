'use strict';

/**
 * The Definition of Done, end to end:
 *
 *   a mobile note/todo captured OFFLINE survives a reload and is eventually
 *   written to NEURO EXACTLY ONCE.
 *
 * The two halves are pinned separately elsewhere — the device store keeps the
 * queue across a reopen (`mobile-store.test.js`), and the server applies a
 * replayed operation once (`mobile-sync.test.js`). This drives the GLUE, which
 * is where a promise like that usually breaks: `sara/app/src/mobile/outbox.js`
 * against a real HTTP NEURO and a real (fake-backed) IndexedDB.
 *
 * The only shims are the two things a browser supplies and node does not:
 * `localStorage` (which `api.js` reads the PIN from) and a `fetch` that
 * understands the app's relative URLs. Nothing about the outbox itself is
 * stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-e2e-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-e2e-vault-'));

const db = require('../db/database');

const APP_SRC = path.join(__dirname, '..', '..', 'sara', 'app', 'src');
const OUTBOX = path.join(APP_SRC, 'mobile', 'outbox.js');
const STORE = path.join(APP_SRC, 'mobile', 'localStore.js');

let server;
let base;
let realFetch;

/** Offline: every request fails the way a dead radio fails. */
let online = true;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', require('../routes/mobile'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (!online) return Promise.reject(new TypeError('Failed to fetch'));
    const target = String(url).startsWith('http') ? String(url) : `${base}${url}`;
    return realFetch(target, init);
  };
  // api.js reads the PIN from localStorage; the app-level auth middleware is not
  // mounted here, so an empty store is fine — what matters is that it exists.
  globalThis.localStorage = {
    _v: {},
    getItem(k) { return this._v[k] ?? null; },
    setItem(k, v) { this._v[k] = String(v); },
    removeItem(k) { delete this._v[k]; },
  };
  // The outbox wires window/document listeners in startAutoFlush only, which
  // these tests do not call — but `flush()` reads navigator.onLine.
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

  const { IDBFactory } = await import('fake-indexeddb');
  globalThis.indexedDB = new IDBFactory();
  store = await import(pathToFileURL(STORE).href);
  outbox = await import(pathToFileURL(OUTBOX).href);
});

test.beforeEach(async () => {
  online = true;
  await resetDevice();
});

test.after(() => {
  if (server) server.close();
  if (realFetch) globalThis.fetch = realFetch;
});

// ⚠ ONE localStore instance, and it must be the CANONICAL url.
//
// `outbox.js` imports './localStore.js' with no query string, so a test that
// imports the store as `localStore.js?v=123` gets a SECOND module instance with
// its own memoised connection — the outbox then reads and writes a different
// database from the one the test is inspecting. That is what made three of these
// tests fail against perfectly correct code, and it is the same species as any
// two-copies-of-one-store bug: both halves work, and they disagree.
let store;
let outbox;

/** Wipe the device between tests, through the store's own public door. */
async function resetDevice() {
  await store.clearLocalData({ force: true });
}

/**
 * Reload the APP CODE against the SAME device database — a fresh outbox module
 * instance (new in-memory state, new listeners) over the data that is already on
 * disk. That is what an app restart looks like from the outbox's point of view;
 * that the IndexedDB rows themselves survive a full reopen is pinned separately
 * in `mobile-store.test.js`.
 */
async function reopenApp() {
  return import(`${pathToFileURL(OUTBOX).href}?reload=${Math.random()}`);
}

function taskCount() {
  return db.get('SELECT COUNT(*) AS n FROM tasks').n;
}

test('a todo captured OFFLINE survives an app reload and reaches NEURO exactly once', async () => {
  const text = 'E2E: ring the dentist about the crown';
  const before = taskCount();

  // ── Offline. Capture. ──────────────────────────────────────────────────────
  online = false;
  await outbox.enqueue('capture.todo', { text });

  const attempt = await outbox.flush({ force: true });
  assert.equal(attempt.confirmed, 0, 'nothing can be confirmed with no connection');
  assert.equal(taskCount(), before, 'and nothing reached NEURO');

  let queued = await outbox.pending();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.text, text, 'the words are intact on the device');

  // ── The app is closed and reopened, still offline. ─────────────────────────
  const reloaded = await reopenApp();
  queued = await reloaded.pending();
  assert.equal(queued.length, 1, 'a reload must not lose a queued capture');
  assert.equal(queued[0].payload.text, text);

  // ── Signal comes back. ────────────────────────────────────────────────────
  online = true;
  const result = await reloaded.flush();
  assert.equal(result.confirmed, 1);
  assert.equal(taskCount(), before + 1, 'written to NEURO');
  assert.equal((await reloaded.pending()).length, 0, 'and dropped from the outbox');

  // ── Flushing again, and after another reload, must not write a second. ────
  await reloaded.flush();
  await (await reopenApp()).flush();
  assert.equal(taskCount(), before + 1, 'exactly once');
});

test('a note captured offline lands as ONE file, however many flushes happen', async () => {
  const dir = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Imports');
  const countFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0);
  const before = countFiles();

  online = false;
  await outbox.enqueue('capture.note', { title: 'E2E', content: 'A thought captured on a train.' });
  await outbox.flush({ force: true });
  assert.equal(countFiles(), before, 'offline writes nothing to the vault');

  online = true;
  await outbox.flush();
  await outbox.flush();
  await outbox.flush();
  assert.equal(countFiles(), before + 1, 'exactly one file, three flushes');
});

test('a failed send leaves the capture queued with its text, never discarded', async () => {
  online = false;
  await outbox.enqueue('capture.note', { content: 'Must not evaporate' });
  await outbox.flush({ force: true });

  const [op] = await outbox.pending();
  assert.equal(op.status, 'failed');
  assert.equal(op.attempts, 1);
  assert.equal(op.payload.content, 'Must not evaporate');
  assert.ok(op.lastError, 'and it can say what went wrong');
});

test('a server REJECTION moves to needs-attention and is not retried on a loop', async () => {
  // An unsupported kind is refused identically every time; retrying is pointless
  // and a queue that never drains is a queue that never says so.
  await outbox.enqueue('vault.delete', { path: 'anything' });
  const result = await outbox.flush();
  assert.equal(result.needsAttention, 1);

  const [op] = await outbox.pending();
  assert.equal(op.status, 'needs-attention');
  assert.match(op.lastError, /unsupported kind/);

  // A further flush leaves it exactly where it is.
  const again = await outbox.flush();
  assert.equal(again.confirmed, 0);
  assert.equal((await outbox.pending())[0].status, 'needs-attention');
});

test('an explicit retry puts a stuck item back in play', async () => {
  online = false;
  const op = await outbox.enqueue('capture.todo', { text: 'E2E retry path task' });
  await outbox.flush({ force: true });
  assert.equal((await outbox.pending())[0].status, 'failed');

  online = true;
  await outbox.retry(op.operationId);
  assert.equal((await outbox.pending()).length, 0, 'retry drains it');
});

test('discard is the only way an unconfirmed capture leaves the device', async () => {
  online = false;
  const op = await outbox.enqueue('capture.note', { content: 'Changed my mind' });
  await outbox.flush({ force: true });
  assert.equal((await outbox.pending()).length, 1);

  await outbox.discard(op.operationId);
  assert.equal((await outbox.pending()).length, 0);
});

test('flush is a no-op while offline unless forced, so nothing burns attempts in a tunnel', async () => {
  await outbox.enqueue('capture.todo', { text: 'E2E tunnel task' });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    const result = await outbox.flush();
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'offline');
    assert.equal((await outbox.pending())[0].attempts, 0, 'no attempt was spent');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
  }
});
