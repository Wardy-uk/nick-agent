'use strict';

/**
 * The mirror line is found by ID, never by a supplied offset.
 *
 * ── Why this is the rule ────────────────────────────────────────────────────
 * `Tasks/Microsoft Tasks.md` is regenerated WHOLESALE by `syncMicrosoftTasks`
 * every 30 minutes on a weekday. Every caller that hands in a `lineNumber` is
 * quoting a position captured earlier — a lane fetched before the last resync,
 * an attention card generated at the last poll and clicked ten minutes later —
 * and after a resync that number routinely names a different task.
 *
 * `setTaskPercent` and `setTaskFields` already learned this the hard way and
 * both take an expected id. `toggleTask` did not, and it is the worst of the
 * three to get wrong: the next sync does not undo a completion. It reads the
 * wrong task as open again and the right one as never done, so the damage is a
 * ticked task somebody else is still waiting on plus a task Nick believes he
 * finished sitting quietly open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mscomp-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const obsidian = require('./obsidian');
const microsoft = require('./microsoft');
const msComplete = require('./ms-complete');

const MIRROR = path.join(vault, 'Tasks', 'Microsoft Tasks.md');
const A = 'AAAAaaaa1111';
const B = 'BBBBbbbb2222';

let calls = [];
let answer = { completed: true, kind: 'todo' };
const realComplete = microsoft.completeMicrosoftTask;

test.before(async () => {
  await db.init();
  microsoft.completeMicrosoftTask = async (msId, source, listId) => {
    calls.push({ msId, source, listId });
    return answer;
  };
});
test.after(() => { microsoft.completeMicrosoftTask = realComplete; });

test.beforeEach(() => {
  calls = [];
  answer = { completed: true, kind: 'todo' };
  writeMirror([
    '# Microsoft Tasks',
    '',
    '### Support',
    `- [ ] First task <!--id:${A}-->`,
    `- [ ] Second task <!--id:${B}-->`,
  ]);
});

function writeMirror(lines) {
  fs.writeFileSync(MIRROR, lines.join('\n'), 'utf-8');
}
function mirror() {
  return fs.readFileSync(MIRROR, 'utf-8').split('\n');
}

test('findMsTaskLine locates a task by its id, wherever the line has moved to', () => {
  assert.equal(obsidian.findMsTaskLine(A).lineNumber, 3);
  // Now the file is rewritten with the tasks in the other order, exactly as a
  // resync would do.
  writeMirror(['# Microsoft Tasks', '', '### Support', `- [ ] Second task <!--id:${B}-->`, `- [ ] First task <!--id:${A}-->`]);
  assert.equal(obsidian.findMsTaskLine(A).lineNumber, 4);
});

test('an id the mirror does not hold is null — a real answer, not an error', () => {
  // A completed task leaves this file on the next sync, so "not here" is the
  // ordinary state rather than a fault.
  assert.equal(obsidian.findMsTaskLine('nope-not-here'), null);
});

test('⚠ toggleTask REFUSES a line that does not carry the id it was told to expect', () => {
  assert.throws(
    () => obsidian.toggleTask(MIRROR, 3, B),
    /refusing to tick the wrong task/
  );
  assert.match(mirror()[3], /^- \[ \]/, 'and the line must be untouched');
});

test('the guard is opt-in, so every caller that has no id still works', () => {
  const res = obsidian.toggleTask(MIRROR, 3);
  assert.equal(res.status, 'done');
  assert.match(mirror()[3], /^- \[x\]/);
});

test('⚠ completing ticks the line carrying the ID, not the line at a stale offset', async () => {
  // The scenario that made this necessary: the card was generated when this task
  // sat at line 3, a resync moved it to line 4, and Nick presses Done. A path
  // trusting the offset would tick "Second task" — somebody else's work — and
  // leave this one open.
  writeMirror(['# Microsoft Tasks', '', '### Support', `- [ ] Second task <!--id:${B}-->`, `- [ ] First task <!--id:${A}-->`]);

  const res = await msComplete.completeMicrosoftTask({ msId: A, source: 'MS ToDo' });

  assert.equal(res.ok, true);
  assert.equal(res.mirrored, true);
  const lines = mirror();
  assert.match(lines[4], /^- \[x\] First task/, 'the right task is ticked');
  assert.match(lines[3], /^- \[ \] Second task/, 'and the wrong one is NOT');
});

test('a task absent from the mirror is still pushed to Graph, and says nothing was flipped', async () => {
  // An unreadable or out-of-date mirror must not cost the completion — the Graph
  // push is the half that matters.
  const res = await msComplete.completeMicrosoftTask({ msId: 'gone-from-the-file', source: 'MS Planner' });
  assert.equal(res.ok, true);
  assert.equal(res.mirrored, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].msId, 'gone-from-the-file');
});

test('completing records the win, once', () => {
  const before = db.getActivityForDate(new Date().toISOString().split('T')[0])
    .filter((e) => e.event_type === 'task_done').length;
  msComplete.recordCompletion({ text: 'Something', msId: 'never-linked', owner: 'microsoft' });
  const after = db.getActivityForDate(new Date().toISOString().split('T')[0])
    .filter((e) => e.event_type === 'task_done').length;
  assert.equal(after, before + 1);
});

test('⚠ a LINKED task is not counted twice — task-store already logged it', () => {
  const taskStore = require('./task-store');
  const { id } = taskStore.createTask({ text: 'A linked task', source: 'test' });
  db.run('UPDATE tasks SET ms_id = ? WHERE id = ?', ['linked-ms-id', id]);

  const key = new Date().toISOString().split('T')[0];
  const before = db.getActivityForDate(key).filter((e) => e.event_type === 'task_done').length;
  msComplete.recordCompletion({ text: 'A linked task', msId: 'linked-ms-id', owner: 'microsoft' });
  const after = db.getActivityForDate(key).filter((e) => e.event_type === 'task_done').length;
  assert.equal(after, before, 'inflating the ledger is strictly worse than missing one');
});
