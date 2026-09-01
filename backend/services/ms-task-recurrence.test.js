'use strict';

/**
 * A recurring Microsoft task is not finished by being completed.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * Nick ticked "Guild/F&C MI reports" three times in three days and it came back
 * every time. Nothing was broken: the PATCH reached Graph, Graph logged
 * `[ToDo] Completed`, and To Do did what recurrence means — closed THAT
 * occurrence, rolled the SAME task id forward, set `status` back to
 * `notStarted` and advanced `dueDateTime` by one month. The next mirror sync
 * read it from Graph as open and wrote it straight back into the vault.
 *
 * So a completion that worked perfectly was indistinguishable from one NEURO
 * had lost — and because the task was months in arrears, each tick moved it
 * exactly one month and it was going to keep coming back.
 *
 * ── What is pinned here ─────────────────────────────────────────────────────
 *
 * That recurrence is READ rather than inferred, that it survives the round trip
 * through the vault mirror and the two line editors, and that the words said
 * about a rolled task describe what happened instead of implying a failure.
 *
 * The fixture is the REAL Graph payload for that task, copied off the live
 * account on 1 Sep 2026 — this repo has been bitten twice by an invented
 * identifier (`sleep_core_hours`, `meeting_alert`), and a recurrence shape
 * guessed from the docs is the same trap.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msTask = require('../../shared/ms-task.cjs');

/** Live payload — Guild/F&C MI reports, MS To Do, list "Tasks". */
const LIVE_MONTHLY = {
  pattern: {
    type: 'absoluteMonthly', interval: 1, month: 0, dayOfMonth: 1,
    daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first',
  },
  range: {
    type: 'noEnd', startDate: '2025-08-01', endDate: '0001-01-01',
    recurrenceTimeZone: 'UTC', numberOfOccurrences: 0,
  },
};

const NOW = new Date('2026-09-01T08:00:00Z');

// ── The token ────────────────────────────────────────────────────────────────

test('token: the live monthly payload reads as monthly', () => {
  assert.equal(msTask.recurrenceToken(LIVE_MONTHLY), 'monthly');
});

test('token: an interval above 1 is carried, because "weekly" would be wrong', () => {
  assert.equal(msTask.recurrenceToken({ pattern: { type: 'weekly', interval: 2 } }), 'weekly:2');
  assert.equal(msTask.recurrenceToken({ pattern: { type: 'daily', interval: 1 } }), 'daily');
  assert.equal(msTask.recurrenceToken({ pattern: { type: 'relativeYearly', interval: 1 } }), 'yearly');
});

test('token: a pattern we cannot name is `repeats`, NEVER a guessed frequency', () => {
  // It still comes back, and saying so is true. Calling it monthly because most
  // of his are would be inventing a fact about his diary.
  assert.equal(msTask.recurrenceToken({ pattern: { type: 'someFuturePattern', interval: 1 } }), 'repeats');
  assert.equal(msTask.recurrenceToken({ pattern: {} }), 'repeats');
});

test('token: NOT recurring is null, and null is not `repeats`', () => {
  // The distinction is the whole point: null means the task is done when you
  // complete it, `repeats` means it will be back and we could not say when.
  assert.equal(msTask.recurrenceToken(null), null);
  assert.equal(msTask.recurrenceToken(undefined), null);
  assert.notEqual(msTask.recurrenceToken(null), 'repeats');
});

// ── The label ────────────────────────────────────────────────────────────────

test('label: reads off a task or a bare token', () => {
  assert.equal(msTask.recurrenceLabel('monthly'), 'Monthly');
  assert.equal(msTask.recurrenceLabel({ recurrence: 'weekly:2' }), 'Every 2 weeks');
  assert.equal(msTask.recurrenceLabel('repeats'), 'Repeats');
});

test('label: a one-off task gets NO badge', () => {
  // A badge on all 150 tasks is a badge nobody reads, and the one that matters
  // stops standing out.
  assert.equal(msTask.recurrenceLabel({ recurrence: null }), null);
  assert.equal(msTask.recurrenceLabel({}), null);
  assert.equal(msTask.recurrenceLabel('nonsense'), null);
});

// ── How far behind ───────────────────────────────────────────────────────────

test('behind: the live case — monthly, rolled to 31 Mar, still 5 occurrences back', () => {
  assert.equal(msTask.occurrencesBehind('monthly', '2026-03-31', NOW), 5);
});

test('behind: a due date in the future is CAUGHT UP, which is 0 and not null', () => {
  assert.equal(msTask.occurrencesBehind('monthly', '2026-09-30', NOW), 0);
});

test('behind: the interval divides the count', () => {
  // Ten weeks back on a fortnightly task is five occurrences, not ten.
  assert.equal(msTask.occurrencesBehind('weekly:2', '2026-06-23', NOW), 5);
  assert.equal(msTask.occurrencesBehind('weekly', '2026-08-18', NOW), 2);
});

test('behind: what cannot be counted honestly is null, never a number', () => {
  // null and 0 are different answers — 0 says caught up, null says we could not
  // tell. A 0 in place of "no idea" would read as an all-clear.
  assert.equal(msTask.occurrencesBehind('repeats', '2026-03-31', NOW), null);
  assert.equal(msTask.occurrencesBehind('monthly', null, NOW), null);
  assert.equal(msTask.occurrencesBehind('monthly', 'not-a-date', NOW), null);
  assert.equal(msTask.occurrencesBehind(null, '2026-03-31', NOW), null);
});

// ── The words ────────────────────────────────────────────────────────────────

test('notice: the live case names the pattern, the backlog and the next date', () => {
  const said = msTask.rolledNotice({ recurrence: 'monthly', nextDue: '2026-03-31' }, NOW);
  assert.match(said, /Monthly/);
  assert.match(said, /5 behind/);
  assert.match(said, /2026-03-31/);
});

test('notice: caught up says when it is back, and claims no backlog', () => {
  const said = msTask.rolledNotice({ recurrence: 'monthly', nextDue: '2026-09-30' }, NOW);
  assert.match(said, /2026-09-30/);
  assert.ok(!/behind/.test(said), 'nothing is behind, so nothing should say so');
});

test('notice: an unreadable next date says only what is known', () => {
  const said = msTask.rolledNotice({ recurrence: 'repeats', nextDue: null }, NOW);
  assert.match(said, /come back/);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(said), 'no date was returned — inventing one is worse than silence');
});

test('notice: nothing rolled, nothing said', () => {
  assert.equal(msTask.rolledNotice(null, NOW), null);
});

test('notice: NEVER implies the completion failed', () => {
  // The push landed. This is the one thing the message must not get wrong — the
  // whole bug was a working completion reading as a lost one, and a notice
  // saying "failed" or "not saved" would restate the bug in words.
  const forbidden = /fail|lost|not saved|did not work|error|could not complete/i;
  for (const rolled of [
    { recurrence: 'monthly', nextDue: '2026-03-31' },
    { recurrence: 'monthly', nextDue: '2026-09-30' },
    { recurrence: 'repeats', nextDue: null },
    { recurrence: null, nextDue: '2026-10-01' },
  ]) {
    const said = msTask.rolledNotice(rolled, NOW);
    assert.ok(said, 'a roll always has something to say');
    assert.ok(!forbidden.test(said), '"' + said + '" reads as a failure');
    assert.match(said, /closed|come back/, 'it has to say what actually happened');
  }
});

// ── The round trip through the vault mirror ──────────────────────────────────

function withVault(fileBody, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-msrec-'));
  fs.mkdirSync(path.join(root, 'Tasks'), { recursive: true });
  const file = path.join(root, 'Tasks', 'Microsoft Tasks.md');
  fs.writeFileSync(file, fileBody, 'utf-8');
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    const obsidian = require('./obsidian');
    return fn(obsidian, file);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MIRROR = [
  '# Microsoft Tasks',
  '',
  '## ToDo',
  '',
  '### Tasks',
  '',
  '- [ ] Guild/F&C MI reports \u{1F4C5} 2026-03-31 <!--rec:monthly--> <!--id:t1-->',
  '- [ ] Weekly-ish thing <!--rec:weekly:2--> <!--id:t2-->',
  '- [ ] A one-off \u{1F4C5} 2026-09-04 <!--id:t3-->',
  '',
].join('\n');

test('parse: the marker reads back onto the task', () => {
  const byId = withVault(MIRROR, (obsidian) => {
    const { active } = obsidian.parseVaultTodos({ dbTasks: false });
    return new Map(active.map(t => [t.ms_id, t]));
  });
  assert.equal(byId.get('t1').recurrence, 'monthly');
  assert.equal(byId.get('t2').recurrence, 'weekly:2');
  assert.equal(byId.get('t3').recurrence, null, 'a task with no marker does not recur');
});

test('parse: the marker NEVER reaches the task text', () => {
  // Anything on the line lands in the task's own wording and from there in its
  // dedupe key — which is why this is an HTML comment and not a suffix.
  const texts = withVault(MIRROR, (obsidian) =>
    obsidian.parseVaultTodos({ dbTasks: false }).active.map(t => t.text));
  // Asserted against the MARKER, not against the word "weekly" — one of these
  // tasks is legitimately called "Weekly-ish thing", and a test that cannot
  // tell a title from metadata is the thing being guarded against.
  assert.ok(!texts.some(t => /rec:|<!--/.test(t)), texts.join(' | '));
  assert.deepEqual(
    texts.slice().sort(),
    ['A one-off', 'Guild/F&C MI reports', 'Weekly-ish thing']
  );
});

test('editors: a rename keeps the marker, or the card stops saying it comes back', () => {
  const line = withVault(MIRROR, (obsidian, file) => {
    obsidian.setTaskFields(file, 6, { title: 'Guild + F&C MI reports', dueDate: '2026-04-30' }, 't1');
    return fs.readFileSync(file, 'utf-8').split('\n')[6];
  });
  assert.match(line, /<!--rec:monthly-->/);
  assert.match(line, /<!--id:t1-->/);
  assert.match(line, /2026-04-30/);
  assert.match(line, /Guild \+ F&C MI reports/);
});

test('editors: a progress marker lands before the comments, not after them', () => {
  const { line, reparsed } = withVault(MIRROR, (obsidian, file) => {
    obsidian.setTaskPercent(file, 7, 50, 't2');
    const raw = fs.readFileSync(file, 'utf-8').split('\n')[7];
    const { active } = obsidian.parseVaultTodos({ dbTasks: false });
    return { line: raw, reparsed: active.find(t => t.ms_id === 't2') };
  });
  assert.match(line, /Weekly-ish thing \(50%\)/);
  // The line has to survive its own edit: completion breaks on a line that no
  // longer parses, and the marker must not have displaced the id comment.
  assert.equal(reparsed.recurrence, 'weekly:2');
  assert.equal(reparsed.text, 'Weekly-ish thing (50%)');
});
