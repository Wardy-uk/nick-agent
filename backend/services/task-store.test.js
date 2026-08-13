'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB and scratch vault — set before anything requires the db module, since
// database.js reads NEURO_DB_PATH at load time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tasks-'));
process.env.NEURO_DB_PATH = path.join(root, 'tasks.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const taskExport = require('./task-export');
const drain = require('./task-capture-drain');

test.before(async () => { await db.init(); });

test('dedupeKey survives the ways the same action gets rewritten', () => {
  const a = taskStore.dedupeKey('- Review top ticket types **bi-monthly** 📅 2026-08-20 #mustdo');
  const b = taskStore.dedupeKey('Review top ticket types bi-monthly');
  assert.equal(a, b);
});

test('createTask folds a second sighting instead of duplicating, and fills blanks only', () => {
  const first = taskStore.createTask({ text: 'Suppress CSAT on handoff resolutions', moscow: 'must', source: 'capture' });
  assert.equal(first.created, true);

  const second = taskStore.createTask({
    text: 'Suppress CSAT on handoff resolutions!',
    moscow: 'could',                 // must not overwrite the decision already made
    due_date: '2026-08-20',          // but an empty field is fair game
    source: 'meeting-promotion',
  });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.task.moscow, 'must');
  assert.equal(second.task.due_date, '2026-08-20');
});

test('priority accepts 1-3 and the legacy high/normal/low strings', () => {
  assert.equal(taskStore.normPriority(3), 3);
  assert.equal(taskStore.normPriority('2'), 2);
  assert.equal(taskStore.normPriority('high'), 3);
  assert.equal(taskStore.normPriority('nonsense'), null);
  assert.equal(taskStore.normPriority(9), null);
});

test('capture lines give up their inline hints', () => {
  const parsed = drain.parseCaptureLine('Chase Maria about the Krista issue !must p3 @2026-08-20');
  assert.equal(parsed.text, 'Chase Maria about the Krista issue');
  assert.equal(parsed.moscow, 'must');
  assert.equal(parsed.priority, 3);
  assert.equal(parsed.due, '2026-08-20');
});

test('export round-trips: every open task appears once and verify agrees', () => {
  taskStore.createTask({ text: 'Untriaged thing with no bucket', source: 'manual' });
  const written = taskExport.writeExport();
  assert.equal(written.ok, true);

  const verify = taskExport.verifyExport();
  assert.equal(verify.ok, true, JSON.stringify(verify));
  assert.equal(verify.fileCount, verify.dbCount);
  assert.deepEqual(verify.missing, []);
  assert.deepEqual(verify.extra, []);
});

test('verify catches a task the export has not caught up with', () => {
  taskStore.createTask({ text: 'Added after the last export ran', source: 'manual', skipExport: true });
  const verify = taskExport.verifyExport();
  assert.equal(verify.ok, false);
  assert.equal(verify.missing.length, 1);
});

test('drain clears the file — a capture line must never linger as a second store', () => {
  drain.ensureCaptureFile();
  fs.appendFileSync(drain.capturePath(), '- [ ] Book the quiet-room walkthrough\n- [x] already done\n', 'utf-8');

  const result = drain.drainCaptureFile({ force: true });
  assert.equal(result.created, 1);          // the ticked line is dropped, not imported
  assert.equal(fs.readFileSync(drain.capturePath(), 'utf-8'), drain.TEMPLATE);

  // Second drain of an empty file is a no-op rather than a duplicate.
  assert.equal(drain.drainCaptureFile({ force: true }).drained, 0);
});
