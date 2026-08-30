'use strict';

/**
 * Obsidian first: a captured task reaches the vault before anything says it was
 * captured.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `POST /api/capture/todo` created a task row and nothing else. The vault only
 * heard about it when `task-export` next regenerated
 * `Tasks/NEURO Tasks (export).md`, up to an hour later — and that file is a
 * READ-ONLY projection nothing parses back. So for up to an hour the only copy
 * of the thought lived in a SQLite file the vault knew nothing about, while the
 * UI had already said "Added to todos".
 *
 * The order is the fix: vault record first, task row second. A crash between
 * the two loses the projection, which is rebuildable, and never the words.
 *
 * Runs against a REAL temp vault and a scratch DB, and over real HTTP for the
 * route — a green service suite says nothing about routing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capdur-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(vault, { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const captureStore = require('./capture-store');
const taskExport = require('./task-export');
const mobileSync = require('./mobile-sync');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/capture', require('../routes/capture'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function captureLog(now = new Date()) {
  const rel = captureStore.taskCaptureRelativePath(now);
  const full = path.join(vault, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
}

test('a todo capture writes a durable vault record BEFORE it reports success', async () => {
  const text = 'Draft the succession cover note';
  const { status, body } = await post('/api/capture/todo', { text });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  // The vault half is REPORTED, not assumed, and the response says which.
  assert.equal(body.vault.written, true);
  assert.deepEqual(body.steps, { vault: 'saved', task: 'created' });

  const log = captureLog();
  assert.ok(log.includes(text), 'the words must be on disk in the vault');
  // Provenance both ways: the line carries the task id, the row carries the path.
  assert.ok(log.includes(`<!--neuro-task:${body.taskId}-->`));
  assert.equal(db.getTaskRow(body.taskId).origin_path, body.vault.path);
});

test('the vault record is append-only — a second capture never overwrites the first', async () => {
  const a = await post('/api/capture/todo', { text: 'First thing in the same second' });
  const b = await post('/api/capture/todo', { text: 'Second thing in the same second' });
  assert.equal(a.body.success, true);
  assert.equal(b.body.success, true);

  const log = captureLog();
  assert.ok(log.includes('First thing in the same second'));
  assert.ok(log.includes('Second thing in the same second'));
});

test('the same capture replayed offline produces ONE vault record and ONE task', () => {
  // The mobile outbox replays operations it is not sure landed. Exactly-once is
  // the LEDGER's job — `applyOperation` is synchronous from the ledger read to
  // the ledger write — so the replay must never reach the vault writer twice.
  const op = {
    operationId: 'op-capture-once',
    kind: 'capture.todo',
    payload: { text: 'Something captured on a train with no signal' },
  };

  const first = mobileSync.applyBatch({ deviceId: 'device-A', operations: [op] });
  const second = mobileSync.applyBatch({ deviceId: 'device-A', operations: [op] });

  assert.equal(first.receipts[0].status, 'applied');
  // A replay is acknowledged as a duplicate, never re-run.
  assert.equal(second.receipts[0].status, 'duplicate');
  assert.equal(second.receipts[0].canonicalId, first.receipts[0].canonicalId);

  const log = captureLog();
  const occurrences = log.split('Something captured on a train with no signal').length - 1;
  assert.equal(occurrences, 1, 'a replayed capture must not append a second line');
});

test('a vault failure and a task failure are distinguishable, and neither is silent', async () => {
  // No vault configured is the honest version of "the disk went away".
  const realVault = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = '';
  try {
    const { status, body } = await post('/api/capture/todo', { text: 'Captured while the vault was unreachable' });
    // ⚠ Still a success: refusing the capture is the one failure this whole
    // area exists to prevent. What it must never do is CLAIM a vault record.
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.vault.written, false);
    assert.ok(body.vault.why, 'a vault miss must name itself');
    assert.equal(body.steps.vault, 'failed');
    assert.equal(body.steps.task, 'created');
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = realVault;
  }
});

test('the generated export is a projection, never an editable task source', () => {
  taskExport.writeExport();
  const exported = fs.readFileSync(path.join(vault, 'Tasks', 'NEURO Tasks (export).md'), 'utf-8');

  // It says what it is, and where the durable record actually lives.
  assert.match(exported, /Generated file\. Do not edit\./);
  assert.match(exported, /Tasks\/Captured\/Task Captures/);
  assert.match(exported, /read-only VIEW/);

  // And nothing parses it back. `parseVaultTodos` reads Master Todo, the
  // Microsoft mirror and the daily notes — the export is not among them, so a
  // task edited there can never re-enter the store.
  const obsidianSource = fs.readFileSync(path.join(__dirname, 'obsidian.js'), 'utf-8');
  assert.ok(
    !obsidianSource.includes('NEURO Tasks (export)'),
    'nothing may read tasks back out of the generated export'
  );
});

test('the capture log is not itself scanned for action candidates', () => {
  // It is full of `- [ ]` lines by construction. If the sweep read it, every
  // captured task would come back as a candidate to capture again.
  const candidates = require('./action-candidates');
  const rel = captureStore.taskCaptureRelativePath(new Date());
  const scanned = fs.readFileSync(path.join(__dirname, 'action-candidates.js'), 'utf-8');
  assert.ok(scanned.includes("value.startsWith('Tasks/')"), 'Tasks/ must stay in the skip list');
  assert.ok(rel.startsWith('Tasks/'), 'the capture log must live under Tasks/ so that skip covers it');
  assert.ok(candidates, 'positive control: the module loads');
});
