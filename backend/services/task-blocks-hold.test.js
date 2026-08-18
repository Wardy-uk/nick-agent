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

// Each fixture gets its own slot: the uniqueness guard is on (date, start_time)
// now, because a block holds many tasks and the thing to prevent is two events
// landing on top of each other.
let slotSeq = 0;
function nextSlot() {
  const start = 9 * 60 + (slotSeq++ * 15);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(start / 60))}:${p(start % 60)}`;
}

/** Tasks with a block already scheduled, and its stub on disk. */
function blockedTasks(texts, { dateKey = '2026-08-19', startTime = null } = {}) {
  startTime = startTime || nextSlot();
  const list = Array.isArray(texts) ? texts : [texts];
  const tasks = list.map(text => {
    const { id } = taskStore.createTask({ text, source: 'manual', skipExport: true });
    return db.getTaskRow(id);
  });
  const notePath = taskBlocks.outcomeNotePath(tasks, dateKey, startTime);
  const blockId = db.createTaskBlockRow({
    date_key: dateKey,
    start_time: startTime,
    end_time: '15:00',
    minutes: 60,
    minutes_assumed: 1,
    note_path: notePath,
    status: 'scheduled',
  });
  for (const t of tasks) db.addTaskBlockItem(blockId, t.id, null);

  const full = path.join(process.env.OBSIDIAN_VAULT_PATH, notePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, taskBlocks.renderStub(tasks, db.getTaskBlockRow(blockId)), 'utf8');
  return { taskIds: tasks.map(t => t.id), taskId: tasks[0].id, blockId, notePath, full };
}

/** Back-compat shim so the single-task tests below read unchanged. */
function blockedTask(text, opts = {}) { return blockedTasks(text, opts); }

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
  taskStore.updateTask(taskId, { status: 'done' });   // ticked, so it is owed a note
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
  taskStore.updateTask(taskId, { status: 'done' });   // ticked, then held

  const refused = taskBlocks.release(blockId, '   ');
  assert.equal(refused.ok, false, 'a reasonless release is a second, quieter way of saying done');
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup',
    'a refused release must leave the block exactly as it was');

  const done = taskBlocks.release(blockId, 'Meeting was cancelled, nothing to write up');
  assert.equal(done.ok, true);
  const block = db.getTaskBlockRow(blockId);
  assert.equal(block.status, 'released');
  assert.match(block.release_reason, /cancelled/);
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.deepEqual(done.completedTaskIds, [taskId]);
});

test('a released block stays distinguishable from one that earned its note', () => {
  const { blockId: releasedId } = blockedTask('Released work');
  taskBlocks.release(releasedId, 'no outcome worth writing');

  const { taskId, blockId: completedId, full } = blockedTask('Completed work');
  taskStore.updateTask(taskId, { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  assert.equal(db.getTaskBlockRow(releasedId).status, 'released');
  assert.equal(db.getTaskBlockRow(completedId).status, 'complete');
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('two blocks cannot occupy the same slot', () => {
  // The guard is on the SLOT now, not the task: a block holds many tasks, and
  // the failure to prevent is two events landing on top of each other.
  // A date of its own, so the auto-assigned fixture slots cannot collide here.
  blockedTask('Only once please', { dateKey: '2026-07-01', startTime: '11:00' });
  assert.throws(() => db.createTaskBlockRow({
    date_key: '2026-07-01', start_time: '11:00', end_time: '12:00',
    minutes: 60, minutes_assumed: 0, note_path: 'x.md', status: 'scheduled',
  }), /UNIQUE/);
});

test('a future block is listed, but flagged as not yet owing a write-up', () => {
  // This replaces an earlier rule that HID upcoming blocks ("a 2pm block is not
  // outstanding at 9am"). That was right about the words and wrong about the
  // screen: once tasks are grouped into a window, the grouping is the thing to
  // work through, and hiding it meant the batch vanished from the screen it was
  // made on. So it is listed, and `passed` carries the distinction instead.
  const { blockId } = blockedTask('Tomorrow work', { dateKey: '2099-01-05', startTime: '14:00' });

  const early = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 9, 0) });
  const earlyRow = early.rows.find(r => r.blockId === blockId);
  assert.ok(earlyRow, 'the block must be visible as a group before its slot');
  assert.equal(earlyRow.passed, false);

  const later = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 16, 0) });
  assert.equal(later.rows.find(r => r.blockId === blockId).passed, true,
    'once the slot is behind us it owes a write-up');

  // The old behaviour is still reachable for a caller that wants only what is
  // owed — the nudge path cares about that, not about the diary.
  const owedOnly = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 9, 0), includeUpcoming: false });
  assert.ok(!owedOnly.rows.some(r => r.blockId === blockId));
});

// ── Batching: several tasks in one window ────────────────────────────────────

test('a batch holds every task in it, on one note', () => {
  const { taskIds, blockId, notePath } = blockedTasks([
    'Approve the Sandford refund',
    'Reply to Chris about headcount',
    'File the FOC report',
  ]);

  for (const id of taskIds) {
    const held = taskStore.updateTask(id, { status: 'done' }).held;
    assert.ok(held, `task #${id} was not held by its block`);
    assert.equal(held.blockId, blockId);
    // One note between them. Three notes for one sitting is friction that would
    // stop the write-up happening at all.
    assert.equal(held.notePath, notePath);
  }
});

test('writing up a batch completes ONLY the tasks that were ticked', () => {
  // The rule the whole batch design turns on. A window of four routinely
  // finishes three; completing the fourth because a note exists would put work
  // in the ledger that nobody did — the exact failure "a win is detected, not
  // declared" exists to stop.
  const { taskIds, blockId, full } = blockedTasks([
    'Cancel the duplicate licence',
    'Send the Tier 2 ageing figures',
    'Read the incident postmortem',
  ]);
  const [ticked1, ticked2, never] = taskIds;

  taskStore.updateTask(ticked1, { status: 'done' });
  taskStore.updateTask(ticked2, { status: 'done' });

  writeUp(full);
  const swept = taskBlocks.sweep();

  assert.equal(db.getTaskRow(ticked1).status, 'done');
  assert.equal(db.getTaskRow(ticked2).status, 'done');
  assert.equal(db.getTaskRow(never).status, 'open',
    'a task nobody ticked was marked done because someone wrote a note');

  const entry = swept.completed.find(c => c.blockId === blockId);
  assert.deepEqual(entry.taskIds, [ticked1, ticked2]);
  // Reported, not hidden: "you wrote it up and one is still open" is information.
  assert.deepEqual(entry.stillOpenTaskIds, [never]);
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete');
});

test('a task left open by a batch can still be ticked afterwards', () => {
  // Once the block is complete it owes nothing, so the second tick must land
  // rather than hold against a block that is already written up.
  const { taskIds, full } = blockedTasks(['Do the first thing', 'Do the second thing']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const after = taskStore.updateTask(taskIds[1], { status: 'done' });
  assert.equal(after.status, 'done');
  assert.equal(after.held, undefined, 'a written-up block must not keep holding');
});

test('releasing a batch closes the block without completing untouched work', () => {
  const { taskIds, blockId } = blockedTasks(['Abandoned one', 'Abandoned two']);
  const result = taskBlocks.release(blockId, 'Day got eaten by an escalation');

  assert.equal(result.ok, true);
  assert.deepEqual(result.completedTaskIds, []);
  for (const id of taskIds) assert.equal(db.getTaskRow(id).status, 'open');
  assert.equal(db.getTaskBlockRow(blockId).status, 'released');
});

test('the outstanding list names every task in the block and which are ticked', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked job', 'Untouched job'], { dateKey: '2026-01-05' });
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const { rows } = taskBlocks.listOutstanding({ now: new Date(2026, 0, 5, 18, 0) });
  const row = rows.find(r => r.blockId === blockId);
  assert.ok(row, 'a passed block owing a write-up must be listed');
  assert.equal(row.tasks.length, 2);
  assert.equal(row.tasks.find(t => t.taskId === taskIds[0]).awaiting, true);
  assert.equal(row.tasks.find(t => t.taskId === taskIds[1]).awaiting, false);
});

test('a second block does not land on the first — even before any calendar sync', () => {
  // calendar_cache only refreshes on a sync, so a block created a moment ago is
  // not in it; if Graph refused the event it never will be. Without counting
  // NEURO's own blocks the slot search hands out the same gap every time, which
  // is one-to-one-booking.planAll()'s lesson word for word.
  const { id } = taskStore.createTask({ text: 'First of two back to back', skipExport: true });
  const { id: id2 } = taskStore.createTask({ text: 'Second of two back to back', skipExport: true });

  const now = new Date(2026, 8, 2, 7, 0);          // Wed 2 Sep 2026, empty diary
  const first = taskBlocks.plan(id, { now, minutes: 30 });
  assert.equal(first.ok, true);

  db.createTaskBlockRow({
    date_key: first.slot.date, start_time: first.slot.startTime, end_time: first.slot.endTime,
    minutes: 30, minutes_assumed: 0, note_path: 'x.md', status: 'scheduled',
  });

  const second = taskBlocks.plan(id2, { now, minutes: 30 });
  assert.equal(second.ok, true);
  assert.notEqual(
    `${second.slot.date} ${second.slot.startTime}`,
    `${first.slot.date} ${first.slot.startTime}`,
    'the second block was offered the slot the first already holds'
  );
});

test('a dropped block frees its slot again', () => {
  const { id } = taskStore.createTask({ text: 'Slot freed by dropping', skipExport: true });
  const now = new Date(2026, 8, 3, 7, 0);          // Thu 3 Sep 2026

  const first = taskBlocks.plan(id, { now, minutes: 30 });
  const blockId = db.createTaskBlockRow({
    date_key: first.slot.date, start_time: first.slot.startTime, end_time: first.slot.endTime,
    minutes: 30, minutes_assumed: 0, note_path: 'y.md', status: 'scheduled',
  });
  taskBlocks.drop(blockId);

  const again = taskBlocks.plan(id, { now, minutes: 30 });
  assert.equal(again.slot.startTime, first.slot.startTime,
    'dropping a block is a decision that the time is no longer spoken for');
});

// ── Taking a task back out of a block ────────────────────────────────────────

test('removing a task drops its membership and its hold, not the task', async () => {
  const { taskIds, blockId } = blockedTasks(['Stays in the block', 'Comes back out']);
  const [stays, leaves] = taskIds;

  const result = await taskBlocks.removeTask(blockId, leaves);
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 1);

  // The task is untouched and ordinary again — so it completes normally, with
  // no hold, because it is no longer in any block.
  assert.equal(db.getTaskRow(leaves).status, 'open');
  assert.equal(taskStore.updateTask(leaves, { status: 'done' }).status, 'done');

  // The one left behind is still held.
  assert.ok(taskStore.updateTask(stays, { status: 'done' }).held);
});

test('removing the last task is refused — drop the block instead', async () => {
  const { taskIds, blockId } = blockedTasks(['The only one']);
  const result = await taskBlocks.removeTask(blockId, taskIds[0]);

  assert.equal(result.ok, false);
  assert.equal(result.lastTask, true);
  assert.match(result.error, /drop the block/);
  // An empty block is a window in the diary for nothing, and a note nobody can
  // write. Nothing was removed.
  assert.equal(db.listTaskBlockItems(blockId).length, 1);
});

test('removing the last ticked task stops the block holding anyone', async () => {
  const { taskIds, blockId } = blockedTasks(['Ticked then removed', 'Never ticked']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');

  await taskBlocks.removeTask(blockId, taskIds[0]);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled',
    'the block kept claiming to be waiting on a write-up for a hold that no longer exists');
});

test('a task cannot be removed from a block that is already finished', async () => {
  const { taskIds, blockId, full } = blockedTasks(['One', 'Two']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const result = await taskBlocks.removeTask(blockId, taskIds[1]);
  assert.equal(result.ok, false);
  assert.match(result.error, /complete/);
});

test('removing a task that is not in the block says so', async () => {
  const { blockId } = blockedTasks(['In the block', 'Also in it']);
  const { id: outsider } = taskStore.createTask({ text: 'Not in any block', skipExport: true });
  const result = await taskBlocks.removeTask(blockId, outsider);
  assert.equal(result.ok, false);
  assert.match(result.error, /not in this block/);
});

test('an upcoming block is listed, so a batch does not vanish when you make it', () => {
  // The earlier cut hid future blocks as "not outstanding yet", which meant the
  // batch Nick had just created disappeared from the screen he created it on.
  const { blockId } = blockedTasks(['Later today one', 'Later today two'], { dateKey: '2099-03-04' });
  const { rows } = taskBlocks.listOutstanding({ now: new Date(2099, 2, 4, 8, 0) });

  const row = rows.find(r => r.blockId === blockId);
  assert.ok(row, 'a block later today must still be visible as a group');
  assert.equal(row.passed, false, 'it is in the diary, not owing a write-up');
  assert.equal(row.tasks.length, 2);
});
