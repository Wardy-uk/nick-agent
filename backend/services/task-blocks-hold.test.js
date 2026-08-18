'use strict';

/**
 * The hold — a task blocked into the calendar does not go done until it has been
 * written up (18 Aug 2026).
 *
 * Separate from task-blocks.test.js because these need a real DB and a real
 * vault on disk, where that file is pure. The properties pinned here are the
 * ones that decide whether the feature is trustworthy rather than merely
 * present:
 *
 *   - ticking done HOLDS rather than completing, and says so
 *   - the tick is not thrown away (held at in-progress, so Nick ticks once)
 *   - writing the note releases it, on the sweep, with no further tick
 *   - an unreadable vault fails OPEN — the evidence rule is worth enforcing
 *     against forgetfulness, not against an unmounted disk
 *   - release() needs a reason, and records it
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hold-'));
process.env.NEURO_DB_PATH = path.join(root, 'hold.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const taskBlocks = require('./task-blocks');

test.before(async () => { await db.init(); });

/** A task with a block already scheduled, and its stub on disk. */
function blockedTask(text, { dateKey = '2026-08-19' } = {}) {
  const { id } = taskStore.createTask({ text, source: 'manual', skipExport: true });
  const task = db.getTaskRow(id);
  const notePath = taskBlocks.outcomeNotePath(task, dateKey);
  const blockId = db.createTaskBlockRow({
    task_id: id,
    date_key: dateKey,
    start_time: '14:00',
    end_time: '15:00',
    minutes: 60,
    minutes_assumed: 1,
    note_path: notePath,
    status: 'scheduled',
  });
  const full = path.join(process.env.OBSIDIAN_VAULT_PATH, notePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, taskBlocks.renderStub(task, db.getTaskBlockRow(blockId)), 'utf8');
  return { taskId: id, blockId, notePath, full };
}

function writeUp(full) {
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '## What came of it\n',
      '## What came of it\nDrafted the cover matrix and sent it to Chris for review on Friday.\n'
    ),
    'utf8'
  );
}

test('ticking a blocked task done holds it, and says why', () => {
  const { taskId, blockId, notePath } = blockedTask('Build the succession cover matrix');

  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.status, 'in-progress',
    'the tick was thrown away or let through — either way Nick loses');
  assert.ok(result.held, 'a silent hold is the worst outcome: the task stays open and nothing says why');
  assert.equal(result.held.blockId, blockId);
  assert.equal(result.held.notePath, notePath);

  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');
});

test('a held task is not logged as a completion', () => {
  const { taskId } = blockedTask('Write the Tier 2 ageing note');
  taskStore.updateTask(taskId, { status: 'done' });
  // A win the work has not evidenced is exactly what "a win is detected, not
  // declared" exists to stop.
  assert.equal(db.getTaskRow(taskId).completed_at, null);
});

test('writing the note releases it on the sweep — no second tick needed', () => {
  const { taskId, blockId, full } = blockedTask('Draft the headcount split for production ops');
  taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(db.getTaskRow(taskId).status, 'in-progress');

  writeUp(full);
  const swept = taskBlocks.sweep();

  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete');
  assert.deepEqual(swept.gaps, []);
  assert.ok(swept.completed.some(c => c.blockId === blockId));
});

test('a task written up BEFORE the tick completes straight away', () => {
  const { taskId, full } = blockedTask('Review the escalation reason codes');
  writeUp(full);
  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.status, 'done');
  assert.equal(result.held, undefined);
});

test('the sweep leaves an un-written block alone and counts it', () => {
  const { blockId } = blockedTask('Chase the Sandford renewal');
  const swept = taskBlocks.sweep();
  assert.ok(swept.stillOpen >= 1);
  assert.ok(!swept.completed.some(c => c.blockId === blockId));
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
});

test('a note Nick renamed is still found, by the task id in its frontmatter', () => {
  const { taskId, blockId, full } = blockedTask('Book the Q4 planning session');
  writeUp(full);
  fs.renameSync(full, path.join(path.dirname(full), 'Renamed by Nick.md'));

  taskBlocks.sweep();
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.match(db.getTaskBlockRow(blockId).note_path, /Renamed by Nick\.md$/,
    'the record must follow the note, or it points at a file that no longer exists');
});

test('an unreadable vault does not hold the task', () => {
  // The one place this fails OPEN, deliberately. A Syncthing hiccup would
  // otherwise refuse every completion Nick made, in the single screen he uses to
  // find what he owes.
  const { taskId } = blockedTask('Write up the Tier 1 handover');
  const real = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'nowhere');
  try {
    assert.equal(taskStore.updateTask(taskId, { status: 'done' }).status, 'done');
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = real;
  }
});

test('dropping a task is never held — abandoning is not a claim needing proof', () => {
  const { taskId } = blockedTask('Something that turned out not to matter');
  assert.equal(taskStore.updateTask(taskId, { status: 'dropped' }).status, 'dropped');
});

test('release needs a reason, and stores it', () => {
  const { taskId, blockId } = blockedTask('Sit in on the SMT update');

  const refused = taskBlocks.release(blockId, '   ');
  assert.equal(refused.ok, false, 'a reasonless release is a second, quieter way of saying done');
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');

  const done = taskBlocks.release(blockId, 'Meeting was cancelled, nothing to write up');
  assert.equal(done.ok, true);
  const block = db.getTaskBlockRow(blockId);
  assert.equal(block.status, 'released');
  assert.match(block.release_reason, /cancelled/);
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('a released block stays distinguishable from one that earned its note', () => {
  const { blockId: releasedId } = blockedTask('Released work');
  taskBlocks.release(releasedId, 'no outcome worth writing');

  const { taskId, blockId: completedId, full } = blockedTask('Completed work');
  writeUp(full);
  taskBlocks.sweep();

  assert.equal(db.getTaskBlockRow(releasedId).status, 'released');
  assert.equal(db.getTaskBlockRow(completedId).status, 'complete');
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('the same task cannot be blocked twice into the same slot', () => {
  const { taskId } = blockedTask('Only once please');
  assert.throws(() => db.createTaskBlockRow({
    task_id: taskId,
    date_key: '2026-08-19', start_time: '14:00', end_time: '15:00',
    minutes: 60, minutes_assumed: 0, note_path: 'x.md', status: 'scheduled',
  }), /UNIQUE/);
});

test('a block still in the future is not listed as outstanding', () => {
  const { blockId } = blockedTask('Tomorrow work', { dateKey: '2099-01-05' });
  const { rows } = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 9, 0) });
  assert.ok(!rows.some(r => r.blockId === blockId),
    'a 2pm block is not outstanding at 9am — listing it makes the panel a second, worse calendar');

  const later = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 16, 0) });
  assert.ok(later.rows.some(r => r.blockId === blockId));
});
