'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB and an EMPTY scratch vault, both set before anything is required.
// #119 exists because a test once created notes in the real vault.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mobile-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mobile-vault-'));

const db = require('../db/database');
const mobileSync = require('./mobile-sync');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

let n = 0;
function opId(prefix) { return `${prefix}-${++n}`; }

// ── Validation (pure — no DB, no clock) ──────────────────────────────────────

test('an operation without an operationId is rejected, and says why', () => {
  const r = mobileSync.validateOperation({ kind: 'capture.note', payload: { content: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /operationId/);
});

test('an unknown kind is refused locally, not passed through', () => {
  const r = mobileSync.validateOperation({
    operationId: 'a', kind: 'vault.delete', payload: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported kind/);
});

test('capture.note requires content; whitespace is not content', () => {
  assert.equal(mobileSync.validateOperation({
    operationId: 'a', kind: 'capture.note', payload: { content: '   ' },
  }).ok, false);
  assert.equal(mobileSync.validateOperation({
    operationId: 'a', kind: 'capture.note', payload: { content: 'real' },
  }).ok, true);
});

test('todo.complete takes a NEURO task id only — a file path is not an owner it will accept', () => {
  // The other two owners a mobile tick can have are deliberately NOT offline-
  // replayable: a lineNumber recorded hours ago can name a different row.
  assert.equal(mobileSync.validateOperation({
    operationId: 'a', kind: 'todo.complete', payload: { filePath: 'Tasks/x.md', lineNumber: 11 },
  }).ok, false);
  assert.equal(mobileSync.validateOperation({
    operationId: 'a', kind: 'todo.complete', payload: { taskId: 7 },
  }).ok, true);
});

test('a malformed createdAt is rejected rather than silently dropped', () => {
  const r = mobileSync.validateOperation({
    operationId: 'a', kind: 'capture.note', createdAt: 'yesterday', payload: { content: 'x' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ISO/);
});

// ── Idempotency — the central promise ────────────────────────────────────────

test('replaying a capture.todo produces ONE canonical record', () => {
  const op = {
    operationId: opId('todo'),
    kind: 'capture.todo',
    createdAt: new Date().toISOString(),
    payload: { text: 'Replay guard: book the dentist' },
  };

  const first = mobileSync.applyOperation('device-A', op);
  assert.equal(first.status, 'applied');
  assert.match(first.canonicalId, /^task:\d+$/);

  const second = mobileSync.applyOperation('device-A', op);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.canonicalId, first.canonicalId, 'a replay must name the SAME record');

  const third = mobileSync.applyOperation('device-A', op);
  assert.equal(third.status, 'duplicate');
  assert.equal(third.canonicalId, first.canonicalId);

  const rows = db.all(
    'SELECT COUNT(*) AS n FROM mobile_sync_operations WHERE device_id = ? AND operation_id = ?',
    ['device-A', op.operationId]
  );
  assert.equal(rows[0].n, 1, 'the ledger holds one row per operation, not one per attempt');
});

test('replaying a capture.note does NOT write a second file', () => {
  const op = {
    operationId: opId('note'),
    kind: 'capture.note',
    payload: { title: 'Replay guard', content: 'This must exist exactly once.' },
  };
  const dir = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Imports');

  const first = mobileSync.applyOperation('device-A', op);
  assert.equal(first.status, 'applied');
  const afterFirst = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;

  const second = mobileSync.applyOperation('device-A', op);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.canonicalId, first.canonicalId);

  const afterSecond = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  assert.equal(afterSecond, afterFirst, 'a replayed note must not create a second file');
});

test('the SAME operationId from a DIFFERENT device is a different operation', () => {
  // Ids are generated on-device, so uniqueness is only promised per device.
  const shared = opId('shared');
  const make = (text) => ({ operationId: shared, kind: 'capture.todo', payload: { text } });

  const a = mobileSync.applyOperation('device-A', make('Device A distinct task text here'));
  const b = mobileSync.applyOperation('device-B', make('Device B distinct task text here'));
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied');
  assert.notEqual(a.canonicalId, b.canonicalId);
});

test('a rejected operation stays rejected on replay — the device must stop retrying', () => {
  const op = { operationId: opId('bad'), kind: 'capture.note', payload: { content: '' } };
  assert.equal(mobileSync.applyOperation('device-A', op).status, 'rejected');
  assert.equal(mobileSync.applyOperation('device-A', op).status, 'rejected');
});

// ── Conflict rule ────────────────────────────────────────────────────────────

test('completing a task the server does not have is needs-attention, not a silent failure', () => {
  const r = mobileSync.applyOperation('device-A', {
    operationId: opId('ghost'),
    kind: 'todo.complete',
    payload: { taskId: 999999 },
  });
  assert.equal(r.status, 'needs-attention');
  assert.match(r.detail, /not found/);
  // And a replay must not quietly become a success.
  assert.equal(mobileSync.applyOperation('device-A', {
    operationId: r.operationId, kind: 'todo.complete', payload: { taskId: 999999 },
  }).status, 'needs-attention');
});

test('todo.complete is idempotent against a task already done by another route', () => {
  const { id } = taskStore.createTask({ text: 'Already finished elsewhere, mobile ticks late' });
  taskStore.updateTask(id, { status: 'done', force: true });

  const r = mobileSync.applyOperation('device-A', {
    operationId: opId('late'), kind: 'todo.complete', payload: { taskId: id },
  });
  assert.equal(r.status, 'applied');
  assert.equal(r.canonicalId, `task:${id}`);
  assert.equal(JSON.parse(r.detail).alreadyDone, true);
});

test('a second sighting of the same task TEXT folds, and says so rather than claiming a new task', () => {
  const text = 'Fold guard: chase the supplier about the invoice';
  const a = mobileSync.applyOperation('device-A', {
    operationId: opId('fold'), kind: 'capture.todo', payload: { text },
  });
  const b = mobileSync.applyOperation('device-A', {
    operationId: opId('fold'), kind: 'capture.todo', payload: { text },
  });
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied', 'a different intent is a different operation');
  assert.equal(b.canonicalId, a.canonicalId, 'but it reached the SAME record');
  assert.equal(JSON.parse(b.detail).created, false, 'and the device must be able to say "already on your list"');
});

// ── Batch ────────────────────────────────────────────────────────────────────

test('a batch is fault-isolated — one bad operation does not abandon the queue', () => {
  const result = mobileSync.applyBatch({
    deviceId: 'device-A',
    clientSchema: 'neuro.mobile.client/1',
    operations: [
      { operationId: opId('b'), kind: 'capture.todo', payload: { text: 'Batch item one survives' } },
      { operationId: opId('b'), kind: 'nonsense.kind', payload: {} },
      { operationId: opId('b'), kind: 'capture.todo', payload: { text: 'Batch item three survives' } },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.receipts.length, 3);
  assert.equal(result.receipts[0].status, 'applied');
  assert.equal(result.receipts[1].status, 'rejected');
  assert.equal(result.receipts[2].status, 'applied');
  assert.equal(result.counts.applied, 2);
});

test('every operation gets a receipt, in the order it arrived', () => {
  const ids = [opId('o'), opId('o'), opId('o')];
  const result = mobileSync.applyBatch({
    deviceId: 'device-C',
    operations: ids.map((id, i) => ({
      operationId: id, kind: 'capture.todo', payload: { text: `Ordered receipt check number ${i}` },
    })),
  });
  assert.deepEqual(result.receipts.map((r) => r.operationId), ids);
});

test('a batch with no deviceId is refused outright', () => {
  const r = mobileSync.applyBatch({ operations: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /deviceId/);
});

test('an oversized batch is refused rather than silently truncated', () => {
  const ops = Array.from({ length: mobileSync.MAX_OPERATIONS_PER_REQUEST + 1 }, (_, i) => ({
    operationId: `over-${i}`, kind: 'capture.todo', payload: { text: `x${i}` },
  }));
  const r = mobileSync.applyBatch({ deviceId: 'device-A', operations: ops });
  assert.equal(r.ok, false);
  assert.match(r.error, /at most/);
});

// ── Diagnostics carry no secrets ─────────────────────────────────────────────

test('diagnostics report ids, kinds and statuses — never payload text', () => {
  const secret = 'Sensitive capture text that must never leave in diagnostics';
  mobileSync.applyOperation('device-D', {
    operationId: opId('secret'), kind: 'capture.note', payload: { content: secret },
  });
  const diag = mobileSync.diagnostics({ deviceId: 'device-D' });
  const blob = JSON.stringify(diag);
  assert.ok(!blob.includes(secret), 'diagnostics must not carry capture text');
  assert.ok(diag.recent.length >= 1);
  assert.ok(diag.supportedKinds.includes('capture.note'));
});

// ── The ledger stores no capture text at all ─────────────────────────────────

test('the ledger itself holds no capture text', () => {
  const secret = 'Ledger leak canary phrase for the mobile outbox';
  mobileSync.applyOperation('device-E', {
    operationId: opId('canary'), kind: 'capture.note', payload: { content: secret },
  });
  const rows = db.all('SELECT * FROM mobile_sync_operations WHERE device_id = ?', ['device-E']);
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(secret));
});
