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

test('an estimate snaps UP to a bucket, and never past the top one', () => {
  assert.equal(taskStore.normEstimate(20), 30);
  assert.equal(taskStore.normEstimate(240), 240);
  assert.equal(taskStore.normEstimate('60'), 60);
  assert.equal(taskStore.normEstimate(0), null);
  assert.equal(taskStore.normEstimate('nonsense'), null);
});

// The bug: the top bucket was 240 and everything above it was CLAMPED to 240,
// so a two-day job was silently recorded as half a day and then offered up as
// something that fits in an afternoon.
test('a task longer than the longest bucket is not rewritten as half a day', () => {
  assert.equal(taskStore.normEstimate(300), 360);
  assert.equal(taskStore.normEstimate(480), 480);
  assert.equal(taskStore.normEstimate(600), 600);   // rounds up by the hour, never down
  assert.equal(taskStore.normEstimate(601), 660);
  assert.equal(taskStore.normEstimate(9000), null); // past a working week is a typo, not an estimate
});

// A preset is a guess and gets rounded; a number Nick typed is not.
test('an exact estimate is honoured as given', () => {
  assert.equal(taskStore.normEstimate(270, { exact: true }), 270);
  assert.equal(taskStore.normEstimate(270), 360);
  assert.equal(taskStore.normEstimate(37, { exact: true }), 37);
  assert.equal(taskStore.normEstimate(0, { exact: true }), null);
});

test('exactness survives the write, both on create and on patch', () => {
  const { id } = taskStore.createTask({
    text: 'Rebuild the KPI pack from source', estimateMinutes: 450, estimateExact: true, skipExport: true,
  });
  assert.equal(db.getTaskRow(id).estimate_minutes, 450);

  taskStore.updateTask(id, { estimateMinutes: 450 });          // no flag → a preset → snaps
  assert.equal(db.getTaskRow(id).estimate_minutes, 480);
  taskStore.updateTask(id, { estimateMinutes: 450, estimateExact: true });
  assert.equal(db.getTaskRow(id).estimate_minutes, 450);
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

// ── findSimilar — the gap dedupe_key cannot close ────────────────────────────
//
// `dedupe_key` is the first 80 characters of normalised text, so it folds a
// re-import of identical wording and nothing else. These pairs are verbatim from
// the live list on 31 Aug 2026, where eleven of them were standing open.

test('a reworded second capture of the same job is reported, not folded', () => {
  const first = taskStore.createTask({ text: 'Consult Annabelle for insights' });
  const second = taskStore.createTask({
    text: 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights',
    checkSimilar: true,
  });

  assert.equal(second.created, true, 'the capture is ALWAYS saved — refusing loses a commitment');
  assert.notEqual(second.id, first.id, 'and it is a real second row, not a silent fold');
  assert.ok(second.similar, 'but the caller is told');
  assert.equal(second.similar.id, first.id);
  assert.ok(second.similar.score >= 0.65);
});

test('the check is opt-in — bulk paths pay nothing and get nothing', () => {
  taskStore.createTask({ text: 'Send current slides to Damon Bullimore' });
  const bulk = taskStore.createTask({ text: 'Nick Ward will send the current slides to Damon Bullimore' });
  assert.equal(bulk.similar, null, 'no checkSimilar, no check');
});

test('an unrelated task reports nothing rather than the nearest thing', () => {
  taskStore.createTask({ text: 'Rebuild the SLA dashboard for the leadership pack' });
  const other = taskStore.createTask({ text: 'Book the dentist', checkSimilar: true });
  assert.equal(other.similar, null);
});

test('findSimilar can be asked directly, and never matches a task against itself', () => {
  const t = taskStore.createTask({ text: 'Reconcile the accumulated task list and produce a definitive to-do list' });
  assert.equal(taskStore.findSimilar(t.task.text, { excludeId: t.id }), null,
    'with itself excluded and nothing else like it, there is no match');
  assert.equal(taskStore.findSimilar('', {}), null, 'empty text is not a query');
});

test('a done task is not offered as the duplicate of a new one', () => {
  const done = taskStore.createTask({ text: 'Publish the Q3 support capacity review to the leadership channel' });
  taskStore.updateTask(done.id, { status: 'done' });
  const fresh = taskStore.createTask({
    text: 'Publish a Q3 support capacity review to the leadership channel',
    checkSimilar: true,
  });
  assert.equal(fresh.similar, null, 'finished work is not a duplicate — it is finished');
});
