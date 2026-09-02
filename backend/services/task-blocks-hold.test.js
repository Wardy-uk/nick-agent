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

// ── Writing the note on demand ───────────────────────────────────────────────

test('createNote writes the stub when it is missing', () => {
  const { blockId, full } = blockedTasks(['Note went missing']);
  fs.unlinkSync(full);   // vault write failed, or Nick deleted it

  const result = taskBlocks.createNote(blockId);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.ok(fs.existsSync(full), 'without this the block is held for a note there is nowhere to write');
});

test('createNote NEVER overwrites an existing note', () => {
  // The whole safety of the button. Clobbering a written-up note would destroy
  // the one thing this feature protects, in one click, with no undo.
  const { blockId, full } = blockedTasks(['Already written up']);
  writeUp(full);
  const before = fs.readFileSync(full, 'utf8');

  const result = taskBlocks.createNote(blockId);
  assert.equal(result.created, false);
  assert.match(result.reason, /already exists/);
  assert.equal(fs.readFileSync(full, 'utf8'), before, 'the write-up was overwritten');
  // Reported as a success: the note Nick wanted is there, which is what he asked for.
  assert.equal(result.ok, true);
});

test('a re-written stub lists what is in the block NOW, not what was', async () => {
  const { taskIds, blockId, full } = blockedTasks(['Kept task', 'Removed task']);
  await taskBlocks.removeTask(blockId, taskIds[1]);
  fs.unlinkSync(full);

  taskBlocks.createNote(blockId);
  const raw = fs.readFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, db.getTaskBlockRow(blockId).note_path), 'utf8');
  assert.ok(raw.includes('Kept task'));
  assert.ok(!raw.includes('Removed task'), 'the note named a task that is no longer in the block');
});

test('createNote on a block with nothing in it is refused, not written', () => {
  const { blockId } = blockedTasks(['Only task']);
  db.removeTaskBlockItem(blockId, db.listTaskBlockItems(blockId)[0].task_id);
  const result = taskBlocks.createNote(blockId);
  assert.equal(result.ok, false);
  assert.match(result.error, /no tasks/);
});

// ── Writing the note from inside NEURO ───────────────────────────────────────

test('the editor opens a missing note as a fresh stub, not an error', () => {
  const { blockId, full } = blockedTasks(['Note deleted in Obsidian']);
  fs.unlinkSync(full);

  const view = taskBlocks.readNoteForEdit(blockId);
  assert.equal(view.ok, true);
  assert.equal(view.exists, false, 'create and edit are the same act from where Nick sits');
  assert.ok(view.raw.includes('Note deleted in Obsidian'));
  assert.equal(view.written, false);
});

test('saving real prose completes the ticked tasks immediately', () => {
  // The sweep stays the mechanism for notes written in Obsidian. Here Nick is
  // looking at the screen, and a ten-minute wait to learn whether his words
  // counted is what would stop him trusting the rule.
  const { taskIds, blockId } = blockedTasks(['Ticked one', 'Never touched']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  const saved = taskBlocks.saveNote(
    blockId,
    view.raw.replace('## What came of it\n', '## What came of it\nCleared the first one; the second needs Chris.\n'),
    { baseHash: view.hash }
  );

  assert.equal(saved.ok, true);
  assert.equal(saved.released, true);
  assert.deepEqual(saved.completedTaskIds, [taskIds[0]]);
  assert.deepEqual(saved.stillOpenTaskIds, [taskIds[1]]);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete');
});

test('saving something that still says nothing does not release the block', () => {
  const { taskIds, blockId } = blockedTasks(['Still open after a non-answer']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  const saved = taskBlocks.saveNote(blockId, view.raw.replace('## What came of it\n', '## What came of it\ndone\n'), {
    baseHash: view.hash,
  });

  assert.equal(saved.ok, true, 'the words are still saved — they are his');
  assert.equal(saved.released, false);
  assert.match(saved.reason, /characters/);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'in-progress');
});

test('a note changed in the vault since loading refuses the save', () => {
  // The same file is open in Obsidian and delivered by Syncthing. Without this,
  // saving from a card left open since this morning silently destroys whatever
  // was written there since — and NEURO cannot merge prose.
  const { blockId, full } = blockedTasks(['Edited in two places']);
  const view = taskBlocks.readNoteForEdit(blockId);

  fs.writeFileSync(full, view.raw + '\nWritten in Obsidian while the card sat open.\n', 'utf8');

  const saved = taskBlocks.saveNote(blockId, view.raw + '\nWritten in NEURO.\n', { baseHash: view.hash });
  assert.equal(saved.ok, false);
  assert.equal(saved.conflict, true);
  assert.match(fs.readFileSync(full, 'utf8'), /Written in Obsidian/, 'the vault copy was overwritten');
});

test('frontmatter edited away is restored, so the note stays findable', () => {
  // `task_ids` is the link back to the block. Lose it and a renamed note can
  // never be matched again, and the block holds forever.
  const { blockId, full } = blockedTasks(['Frontmatter clobbered']);
  const view = taskBlocks.readNoteForEdit(blockId);

  const saved = taskBlocks.saveNote(blockId, 'Just my summary, typed over the whole file.', { baseHash: view.hash });
  assert.equal(saved.ok, true);

  const raw = fs.readFileSync(full, 'utf8');
  assert.match(raw, /^---\n/, 'the note lost its frontmatter');
  assert.match(raw, /task_ids:/);
  assert.ok(raw.includes('Just my summary'));
});

test('a finished block is not editable', () => {
  const { taskIds, blockId, full } = blockedTasks(['Already done and dusted']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const saved = taskBlocks.saveNote(blockId, 'trying to rewrite history', { baseHash: null });
  assert.equal(saved.ok, false);
  assert.match(saved.error, /not waiting on a write-up/);
});

// ── Undoing a drop ───────────────────────────────────────────────────────────

test('a dropped block can be restored, because dropping deletes nothing', async () => {
  const { taskIds, blockId } = blockedTasks(['Dropped by mistake', 'Also in that block']);
  taskBlocks.drop(blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'dropped');

  const result = taskBlocks.restore(blockId);
  assert.equal(result.ok, true);
  assert.equal(result.tasks, 2);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
  assert.equal(db.listTaskBlockItems(blockId).length, 2, 'the membership must survive a drop');
  for (const id of taskIds) assert.equal(db.getTaskRow(id).status, 'open');
});

test('restoring returns a block to awaiting-writeup if a task was ticked', () => {
  // A task ticked before the drop is still ticked, and still owed a write-up.
  // Always restoring to 'scheduled' would lose that.
  const { taskIds, blockId } = blockedTasks(['Ticked before the drop', 'Untouched']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  taskBlocks.drop(blockId);

  taskBlocks.restore(blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');
});

test('only a dropped block can be restored', () => {
  // A released block completed the ticked tasks and a complete one earned its
  // note. Reversing either is a decision to un-finish work, not an undo.
  const { taskIds, blockId, full } = blockedTasks(['Finished properly']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const result = taskBlocks.restore(blockId);
  assert.equal(result.ok, false);
  assert.match(result.error, /not dropped/);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
});

// ── Ticks survive the round trip between the card and the note ───────────────

test('ticks made on the card show up in the note when it is opened', () => {
  // The bug this fixes: the checklist was written when the block was created and
  // never updated, so it showed every task unticked however many had been ticked
  // off since. Two screens disagreeing about the same fact.
  const { taskIds, blockId } = blockedTasks(['Did this one', 'Did not do this']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  assert.ok(view.raw.includes(`- [x] Did this one <!--t:${taskIds[0]}-->`),
    'a task ticked on the card still showed unticked in the note');
  assert.ok(view.raw.includes(`- [ ] Did not do this <!--t:${taskIds[1]}-->`));
});

test('ticking a box in the note records the tick in NEURO', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked in the note', 'Left alone']);
  const view = taskBlocks.readNoteForEdit(blockId);

  const edited = view.raw
    .replace(`- [ ] Ticked in the note <!--t:${taskIds[0]}-->`, `- [x] Ticked in the note <!--t:${taskIds[0]}-->`)
    .replace('## What came of it\n', '## What came of it\nGot the first one finished, second slipped.\n');

  const saved = taskBlocks.saveNote(blockId, edited, { baseHash: view.hash });
  assert.equal(saved.released, true);
  assert.deepEqual(saved.completedTaskIds, [taskIds[0]]);
  assert.deepEqual(saved.stillOpenTaskIds, [taskIds[1]]);
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
});

test('unticking a box in the note takes the tick back', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked then reconsidered', 'Other']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');

  const view = taskBlocks.readNoteForEdit(blockId);
  const edited = view.raw.replace(`- [x] Ticked then reconsidered <!--t:${taskIds[0]}-->`,
    `- [ ] Ticked then reconsidered <!--t:${taskIds[0]}-->`);

  taskBlocks.saveNote(blockId, edited, { baseHash: view.hash });
  assert.equal(db.listTaskBlockItems(blockId).find(i => i.task_id === taskIds[0]).awaiting, 0);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled',
    'nothing is ticked any more, so nothing is owed');
});

test('a box ticked in Obsidian is honoured by the sweep', () => {
  // The note is most likely to be finished in Obsidian, and a tick made there
  // would otherwise be ignored in favour of a card Nick never opened.
  const { taskIds, blockId, full, notePath } = blockedTasks(['Done in Obsidian', 'Not done']);
  const view = taskBlocks.readNoteForEdit(blockId);

  fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, notePath),
    view.raw
      .replace(`- [ ] Done in Obsidian <!--t:${taskIds[0]}-->`, `- [x] Done in Obsidian <!--t:${taskIds[0]}-->`)
      .replace('## What came of it\n', '## What came of it\nWrote this up in Obsidian on the train.\n'),
    'utf8');

  const swept = taskBlocks.sweep();
  const entry = swept.completed.find(c => c.blockId === blockId);
  assert.deepEqual(entry.taskIds, [taskIds[0]]);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
});

test('a task already done shows ticked, even though it never held', () => {
  // It completed straight away because the note already had a write-up, so
  // `awaiting` was never set. Keying the box on that flag alone would show a
  // finished task unticked — the note contradicting the task list.
  const { taskIds, blockId, full } = blockedTasks(['One', 'Two']);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(
    '## What came of it\n', '## What came of it\nA summary written before any box was ticked.\n'), 'utf8');

  taskStore.updateTask(taskIds[0], { status: 'done' });
  const view = taskBlocks.readNoteForEdit(blockId);
  assert.ok(view.raw.includes('A summary written before any box was ticked.'));
  assert.match(view.raw, /- \[x\] One/);
});

// ── Several blocks at once ───────────────────────────────────────────────────

test('blocks on different days stay independent', () => {
  const a = blockedTasks(['Day one, job one', 'Day one, job two'], { dateKey: '2026-06-01' });
  const b = blockedTasks(['Day two, job one', 'Day two, job two'], { dateKey: '2026-06-02' });

  taskStore.updateTask(a.taskIds[0], { status: 'done' });
  taskStore.updateTask(b.taskIds[1], { status: 'done' });

  // Each tick lands in its own note and nowhere else.
  const viewA = taskBlocks.readNoteForEdit(a.blockId);
  const viewB = taskBlocks.readNoteForEdit(b.blockId);
  assert.ok(viewA.raw.includes(`- [x] Day one, job one <!--t:${a.taskIds[0]}-->`));
  assert.ok(viewA.raw.includes(`- [ ] Day one, job two <!--t:${a.taskIds[1]}-->`));
  assert.ok(viewB.raw.includes(`- [ ] Day two, job one <!--t:${b.taskIds[0]}-->`));
  assert.ok(viewB.raw.includes(`- [x] Day two, job two <!--t:${b.taskIds[1]}-->`));

  // Writing one up leaves the other exactly as it was.
  taskBlocks.saveNote(a.blockId, viewA.raw.replace('## What came of it\n',
    '## What came of it\nGot the first of the two done today.\n'), { baseHash: viewA.hash });

  assert.equal(db.getTaskBlockRow(a.blockId).status, 'complete');
  assert.equal(db.getTaskBlockRow(b.blockId).status, 'awaiting-writeup');
  assert.equal(db.getTaskRow(a.taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(b.taskIds[1]).status, 'in-progress');
});

test('two blocks on the same day get their own notes', () => {
  const a = blockedTasks(['Morning job'], { dateKey: '2026-06-03', startTime: '09:00' });
  const b = blockedTasks(['Afternoon job'], { dateKey: '2026-06-03', startTime: '14:00' });
  assert.notEqual(a.notePath, b.notePath, 'both blocks would write over each other');
});

test('a task in two open blocks is held by the most recent, and reported honestly', () => {
  // Legitimate: work that did not finish gets blocked again. The newer block is
  // the one being worked, so it is the one that holds.
  const first = blockedTasks(['Carried over', 'Only in the first'], { dateKey: '2026-06-04' });
  const second = blockedTasks(['Only in the second'], { dateKey: '2026-06-05' });
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);

  const held = taskStore.updateTask(first.taskIds[0], { status: 'done' }).held;
  assert.equal(held.blockId, second.blockId, 'the block being worked now should hold it');

  // Finish it via the second block.
  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nPicked up the carried-over one and finished it.\n'), { baseHash: view.hash });
  assert.equal(db.getTaskRow(first.taskIds[0]).status, 'done');

  // The FIRST block must not now claim that task is still outstanding.
  taskStore.updateTask(first.taskIds[1], { status: 'done' });
  const viewFirst = taskBlocks.readNoteForEdit(first.blockId);
  const saved = taskBlocks.saveNote(first.blockId, viewFirst.raw.replace('## What came of it\n',
    '## What came of it\nCleared what was left in this window.\n'), { baseHash: viewFirst.hash });

  assert.ok(!saved.stillOpenTaskIds.includes(first.taskIds[0]),
    'a task already finished in another block was reported as still open');
});

test('the sweep handles several blocks in one pass', () => {
  const a = blockedTasks(['Swept A'], { dateKey: '2026-06-06' });
  const b = blockedTasks(['Swept B'], { dateKey: '2026-06-07' });
  const c = blockedTasks(['Not written up'], { dateKey: '2026-06-08' });

  for (const x of [a, b, c]) taskStore.updateTask(x.taskIds[0], { status: 'done' });
  writeUp(a.full);
  writeUp(b.full);

  const swept = taskBlocks.sweep();
  const ids = swept.completed.map(x => x.blockId);
  assert.ok(ids.includes(a.blockId) && ids.includes(b.blockId));
  assert.ok(!ids.includes(c.blockId));
  assert.equal(db.getTaskRow(c.taskIds[0]).status, 'in-progress');
  assert.deepEqual(swept.gaps, []);
});

// ── Ticked is ticked everywhere; only one block carries the write-up ─────────

test('ticking a task ticks it in every block that holds it', () => {
  // Nick's rule, 18 Aug: "if I tick it off, it's ticked off — but it only needs
  // discussing in the block that's closing it."
  // Both blocks hold more than one task, which is when a note carries a
  // checklist at all — a single-task block has nothing to tick.
  const first = blockedTasks(['Carried over', 'Only in the first'], { dateKey: '2026-07-01' });
  const second = blockedTasks(['Second block A', 'Second block B'], { dateKey: '2026-07-02' });
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });

  for (const id of [first.blockId, second.blockId]) {
    const view = taskBlocks.readNoteForEdit(id);
    assert.ok(view.raw.includes(`- [x] Carried over <!--t:${first.taskIds[0]}-->`),
      `block #${id} still showed the task unticked`);
  }
});

test('closing it in one block stops the other asking for a write-up', () => {
  const first = blockedTasks(['Shared task'], { dateKey: '2026-07-03' });
  const second = blockedTasks(['Something else'], { dateKey: '2026-07-04' });
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });
  // Both now owe a write-up for it — whichever is written up first closes it.
  assert.equal(db.getTaskBlockRow(first.blockId).status, 'awaiting-writeup');
  assert.equal(db.getTaskBlockRow(second.blockId).status, 'awaiting-writeup');

  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nPicked up the shared one and finished it here.\n'), { baseHash: view.hash });

  assert.equal(db.getTaskRow(first.taskIds[0]).status, 'done');
  // The other block has nothing outstanding left, so it must stop asking.
  assert.equal(db.getTaskBlockRow(first.blockId).status, 'scheduled',
    'a block went on demanding a write-up for work already closed elsewhere');
});

test('a block with its OWN unfinished ticks keeps owing one', () => {
  // The settle must be per task, not "this block is done now".
  const first = blockedTasks(['Shared again', 'Its own work'], { dateKey: '2026-07-05' });
  const second = blockedTasks(['Elsewhere'], { dateKey: '2026-07-06' });
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });
  taskStore.updateTask(first.taskIds[1], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nClosed the shared one over here.\n'), { baseHash: view.hash });

  assert.equal(db.getTaskBlockRow(first.blockId).status, 'awaiting-writeup',
    'its own ticked task still needs writing up');
  assert.equal(db.getTaskRow(first.taskIds[1]).status, 'in-progress');
});

test('unticking a task unticks it everywhere too', () => {
  const first = blockedTasks(['On the fence'], { dateKey: '2026-07-07' });
  const second = blockedTasks(['Other work'], { dateKey: '2026-07-08' });
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });
  taskBlocks.setTickEverywhere(first.taskIds[0], false);

  for (const id of [first.blockId, second.blockId]) {
    assert.equal(
      db.listTaskBlockItems(id).find(i => i.task_id === first.taskIds[0]).awaiting, 0,
      `block #${id} kept a tick that was taken back`
    );
  }
});

// ── The due date follows the block ──────────────────────────────────────────
//
// Blocking a task IS deciding when it is being done, so a due date that says
// otherwise leaves it in the overdue lane on a day it is already scheduled for.
// The direction matters: pulling a date in is bookkeeping, pushing one out moves
// a deadline, and only the second has to be reported.

/** Graph is not reachable from a test, and does not need to be — the write-back
 *  happens before the event is created, which is exactly what the last of these
 *  pins. */
function withoutGraph(fn) {
  const microsoft = require('./microsoft');
  const real = microsoft.createCalendarEvent;
  microsoft.createCalendarEvent = async () => ({ created: false, reason: 'no graph in tests' });
  try { return fn(); } finally { microsoft.createCalendarEvent = real; }
}

function freshTask(text, dueDate = null) {
  const { id } = taskStore.createTask({ text, source: 'manual', skipExport: true });
  if (dueDate) taskStore.updateTask(id, { due_date: dueDate });
  return id;
}

test('blocking a task sets its due date to the day of the block', async () => {
  const id = freshTask('Write the charter');
  assert.equal(db.getTaskRow(id).due_date, null);

  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-10', startTime: '10:00', minutes: 30,
  }));

  assert.equal(db.getTaskRow(id).due_date, '2026-09-10');
  // Reported even though Graph refused — the date really did move, and a caller
  // reading updates only on success would call a half-done state nothing.
  assert.deepEqual(res.dueUpdates.map(u => [u.taskId, u.from, u.to, u.later]),
    [[id, null, '2026-09-10', false]]);
});

test('pulling a due date IN is not reported as moving a deadline', async () => {
  const id = freshTask('Due next week', '2026-09-20');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-11', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-11');
  assert.equal(res.dueUpdates[0].later, false);
});

test('pushing a due date OUT moves a deadline, and says so', async () => {
  const id = freshTask('Due tomorrow', '2026-09-02');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-12', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-12');
  assert.deepEqual(
    res.dueUpdates.map(u => ({ from: u.from, to: u.to, later: u.later })),
    [{ from: '2026-09-02', to: '2026-09-12', later: true }],
  );
});

test('a task already due on the day is left alone, not rewritten', async () => {
  const id = freshTask('Already dated', '2026-09-13');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-13', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-13');
  assert.deepEqual(res.dueUpdates, [], 'nothing changed, so nothing to report');
});

test('saveDue:false leaves every due date where it was', async () => {
  const a = freshTask('Untouched A');
  const b = freshTask('Untouched B', '2026-09-03');
  await withoutGraph(() => taskBlocks.schedule([a, b], {
    date: '2026-09-14', startTime: '10:00', minutes: 60, saveDue: false,
  }));
  assert.equal(db.getTaskRow(a).due_date, null);
  assert.equal(db.getTaskRow(b).due_date, '2026-09-03');
});

test('plan() says which deadlines the window would push out, and creates nothing', () => {
  const early = freshTask('Owed sooner', '2026-09-04');
  const late = freshTask('Owed later', '2026-09-30');
  const none = freshTask('No date');

  const draft = taskBlocks.plan([early, late, none], {
    date: '2026-09-15', startTime: '10:00', minutes: 60,
  });

  assert.equal(draft.ok, true);
  assert.equal(draft.dueLaterCount, 1, 'only the one due before the block is pushed out');
  assert.deepEqual(draft.tasks.map(t => t.dueMovesLater), [true, false, false]);
  assert.deepEqual(draft.tasks.map(t => t.dueDate), ['2026-09-04', '2026-09-30', null]);
  // Planning is a read. A plan that had already moved the dates would make the
  // preview the act it exists to precede.
  assert.equal(db.getTaskRow(early).due_date, '2026-09-04');
  assert.equal(db.getTaskRow(late).due_date, '2026-09-30');
  assert.equal(db.getTaskRow(none).due_date, null);
});

// ── Rescheduling a block that did not happen ────────────────────────────────
//
// The property that matters is the one about ticks: a tick is finished work, so
// it must NEVER travel into a future slot. Everything else here exists to stop
// the recovery path costing more than the missed window did.

/** Graph, answering. `withoutGraph` above makes schedule() fail by design, which
 *  is the wrong shape for testing a move — a reschedule that cannot create the
 *  new block correctly refuses to touch the old one. */
function withGraph(fn) {
  const microsoft = require('./microsoft');
  const real = {
    create: microsoft.createCalendarEvent,
    update: microsoft.updateCalendarEvent,
    del: microsoft.deleteCalendarEvent,
  };
  const deleted = [];
  let seq = 0;
  microsoft.createCalendarEvent = async () => ({ created: true, event: { id: `evt-${++seq}`, webLink: null } });
  microsoft.updateCalendarEvent = async () => ({ updated: true });
  microsoft.deleteCalendarEvent = async (id) => { deleted.push(id); return { deleted: true }; };
  const done = (r) => { Object.assign(microsoft, {
    createCalendarEvent: real.create, updateCalendarEvent: real.update, deleteCalendarEvent: real.del,
  }); return r; };
  return Promise.resolve(fn(deleted)).then(done, (e) => { done(); throw e; });
}

test('an untouched block moves whole, and its old event is deleted', async () => {
  const { taskIds, blockId } = blockedTasks(['Charter V2', 'Rejection reasons'], { dateKey: '2026-09-01' });
  db.updateTaskBlockRow(blockId, { event_id: 'evt-old' });

  const res = await withGraph(async (deleted) => {
    const r = await taskBlocks.reschedule(blockId, { date: '2026-09-15', startTime: '10:00', minutes: 60 });
    assert.deepEqual(deleted, ['evt-old'], 'the old event should not survive an empty block');
    return r;
  });

  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'dropped');
  assert.equal(db.getTaskBlockRow(blockId).status, 'dropped');
  assert.equal(res.moved.length, 2);
  // Both tasks are in the new block, and only there.
  const moved = db.listTaskBlockItems(res.to.blockId).map(i => i.task_id).sort();
  assert.deepEqual(moved, [...taskIds].sort());
  assert.equal(db.listTaskBlockItems(blockId).length, 0);
});

test('a TICKED task never moves — it stays, owed a write-up', async () => {
  // The whole rule. Carrying finished work into a future slot would make the
  // new block's note responsible for evidence about a sitting already had, and
  // would put a completion in the diary that has already happened.
  const { taskIds, blockId } = blockedTasks(['Did this one', 'Never started', 'Also not started'], { dateKey: '2026-09-01' });
  db.updateTaskBlockRow(blockId, { event_id: 'evt-part' });
  taskStore.updateTask(taskIds[0], { status: 'done' });   // held, awaiting write-up
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');

  const res = await withGraph(async (deleted) => {
    const r = await taskBlocks.reschedule(blockId, { date: '2026-09-16', startTime: '10:00', minutes: 60 });
    // A block that produced real work is a record of where the time went.
    assert.deepEqual(deleted, [], 'an event holding finished work must not be deleted');
    return r;
  });

  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'kept');
  assert.equal(res.from.stillOwedWriteUp, 1);
  assert.deepEqual(res.moved.map(m => m.taskId).sort(), [taskIds[1], taskIds[2]].sort());

  // The ticked one is still on the old block and still held.
  const left = db.listTaskBlockItems(blockId);
  assert.deepEqual(left.map(i => i.task_id), [taskIds[0]]);
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');
  assert.equal(db.getTaskRow(taskIds[0]).status, 'in-progress');

  // And it did not follow the others into the new slot.
  const next = db.listTaskBlockItems(res.to.blockId).map(i => i.task_id);
  assert.ok(!next.includes(taskIds[0]), 'a ticked task reached the new block');
});

test('asking to move a ticked task is REFUSED, not quietly skipped', async () => {
  const { taskIds, blockId } = blockedTasks(['Done already', 'Outstanding'], { dateKey: '2026-09-01' });
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, {
    date: '2026-09-17', startTime: '10:00', minutes: 60, taskIds: [taskIds[0], taskIds[1]],
  }));
  assert.equal(res.ok, false);
  assert.match(res.error, /ticked/i);
  assert.deepEqual(res.tickedIds, [taskIds[0]]);
  // Nothing moved.
  assert.equal(db.listTaskBlockItems(blockId).length, 2);
});

test('part of a block can be moved on its own', async () => {
  const { taskIds, blockId } = blockedTasks(['Move me', 'Leave me', 'Leave me too'], { dateKey: '2026-09-01' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, {
    date: '2026-09-18', startTime: '10:00', minutes: 30, taskIds: [taskIds[0]],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'kept');
  assert.deepEqual(db.listTaskBlockItems(blockId).map(i => i.task_id).sort(), [taskIds[1], taskIds[2]].sort());
  assert.deepEqual(db.listTaskBlockItems(res.to.blockId).map(i => i.task_id), [taskIds[0]]);
});

test('a block with nothing outstanding is refused — it needs a note, not a slot', async () => {
  const { taskIds, blockId } = blockedTasks(['The only one'], { dateKey: '2026-09-01' });
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, { date: '2026-09-19', startTime: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /write-up/i);
});

test('a failed new block leaves the old one exactly as it was', async () => {
  // Order is load-bearing: detaching first and then failing would leave the
  // tasks in no block at all, which is worse than the missed window.
  const { blockId } = blockedTasks(['Stays put A', 'Stays put B'], { dateKey: '2026-09-01' });
  const before = db.listTaskBlockItems(blockId).length;

  const clash = blockedTasks(['Occupant'], { dateKey: '2026-09-20', startTime: '11:00' });
  assert.ok(clash.blockId);

  const res = await taskBlocks.reschedule(blockId, { date: '2026-09-20', startTime: '11:00', minutes: 60 });
  assert.equal(res.ok, false);
  assert.equal(res.rescheduling, blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
  assert.equal(db.listTaskBlockItems(blockId).length, before);
});

test('a finished block is not reopened by giving it a new slot', async () => {
  // released / complete / dropped all ended the block deliberately. `restore` is
  // the way back from a drop; a new slot is not an undo.
  const { blockId } = blockedTasks(['Abandoned'], { dateKey: '2026-09-01' });
  taskBlocks.drop(blockId);
  const res = await withGraph(() => taskBlocks.reschedule(blockId, { date: '2026-09-21', startTime: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /dropped/);
});
