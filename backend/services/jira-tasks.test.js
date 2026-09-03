'use strict';

/**
 * Jira-assigned tickets as tasks Jira closes (item 3).
 *
 * Decision 1 (3 Sep 2026): a ticket assigned to Nick becomes a real task with
 * NEURO's own fields, and there is NO manual tick — the ticket's own status
 * closes it, so there is never two places to close one thing.
 *
 * The tests that matter are the ones about closing, and they are all the same
 * shape: absence is not evidence. A ticket that did not come back from Jira
 * could be done, reassigned, moved somewhere the token cannot read, or deleted,
 * and only the first of those is a reason to mark Nick's work finished. A
 * wrongly closed task is work that silently stops existing, which is the one
 * failure this whole feature must not have.
 *
 * Runs against a scratch DB, so `NEURO_DB_PATH` is set before anything loads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-tasks-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'agent.db');
process.env.JIRA_ASSIGNED_SYNC_ENABLED = 'true';
process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
process.env.JIRA_EMAIL = 'nick@example.com';
process.env.JIRA_API_TOKEN = 'token';

const db = require('../db/database');
const jira = require('./jira');
const taskStore = require('./task-store');
const jiraTasks = require('./jira-tasks');

db.init?.();

const issue = (over = {}) => ({
  key: 'NT-14855', summary: 'Sandford escalation — portal contacts unbranded',
  status: 'In Progress', statusCategory: 'indeterminate', resolved: false,
  priority: 'Major', dueDate: null, created: '2026-08-01T09:00:00Z',
  updated: '2026-09-01T09:00:00Z', url: 'https://example.atlassian.net/browse/NT-14855', ...over,
});

/** Swap Jira's two reads for fixtures. Restored by every caller. */
function withJira({ assigned, states }, fn) {
  const realAssigned = jira.fetchAssignedToMe;
  const realStates = jira.fetchIssueStates;
  jira.fetchAssignedToMe = async () => assigned;
  jira.fetchIssueStates = async () => states;
  return Promise.resolve(fn()).finally(() => {
    jira.fetchAssignedToMe = realAssigned;
    jira.fetchIssueStates = realStates;
  });
}

function reset() {
  db.setState('jira_task_links', '{}');
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test('a dry run creates nothing', async () => {
  reset();
  const res = await withJira(
    { assigned: { issues: [issue()], complete: true }, states: { issues: [], complete: true } },
    () => jiraTasks.sync({ apply: false }),
  );
  assert.equal(res.assigned, 1);
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].dryRun, true);
  assert.deepEqual(jiraTasks.readLinks(), {}, 'nothing linked on a dry run');
});

test('an assigned ticket becomes a task carrying its key and a commitment origin', async () => {
  reset();
  const res = await withJira(
    { assigned: { issues: [issue()], complete: true }, states: { issues: [issue()], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  const taskId = res.created[0].taskId;
  const row = db.getTaskRow(taskId);
  assert.match(row.text, /^NT-14855: /);
  assert.equal(row.source, 'jira-assigned');
  // Somebody assigned it to him — that is the test for a commitment, and the
  // weekly risk report counts commitments.
  assert.equal(row.origin, 'commitment');
  assert.equal(row.origin_proposed, 0, 'an assignment is a fact, not a proposal');
  assert.match(row.origin_path, /browse\/NT-14855/);
  assert.equal(jiraTasks.keyForTask(taskId), 'NT-14855');
});

test('a second run does not create the task again', async () => {
  const before = Object.keys(jiraTasks.readLinks()).length;
  const res = await withJira(
    { assigned: { issues: [issue()], complete: true }, states: { issues: [issue()], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.created.length, 0);
  assert.equal(Object.keys(jiraTasks.readLinks()).length, before);
});

// ---------------------------------------------------------------------------
// No manual tick
// ---------------------------------------------------------------------------

test('a person cannot tick a Jira-linked task, and is told where the button is', () => {
  const taskId = jiraTasks.readLinks()['NT-14855'];
  assert.throws(
    () => taskStore.updateTask(taskId, { status: 'done' }),
    /NT-14855 closes this one/,
  );
  assert.equal(db.getTaskRow(taskId).status, 'open', 'the refusal must not half-apply');
});

test('the refusal is in the store, so every completion path hits it', () => {
  // The todos routes, the SARA funnel, the MCP tool and the chat tool all end
  // up in `updateTask`. A guard in a route is one the other three walk past.
  const src = fs.readFileSync(path.join(__dirname, 'task-store.js'), 'utf-8');
  assert.match(src, /jira-tasks/);
  assert.match(src, /keyForTask/);
});

test('dropping is still allowed — abandoning is not claiming it was finished', () => {
  const taskId = jiraTasks.readLinks()['NT-14855'];
  const updated = taskStore.updateTask(taskId, { status: 'dropped' });
  assert.equal(updated.status, 'dropped');
  taskStore.updateTask(taskId, { status: 'open' });
});

test('editing NEURO-side fields is untouched by the refusal', () => {
  const taskId = jiraTasks.readLinks()['NT-14855'];
  const updated = taskStore.updateTask(taskId, { moscow: 'must', due_date: '2026-09-30' });
  assert.equal(updated.moscow, 'must');
  assert.equal(updated.due_date, '2026-09-30');
});

// ---------------------------------------------------------------------------
// Closing — absence is never evidence
// ---------------------------------------------------------------------------

test('a resolved ticket closes the task', async () => {
  const taskId = jiraTasks.readLinks()['NT-14855'];
  const done = issue({ status: 'Resolved', statusCategory: 'done', resolved: true });
  const res = await withJira(
    { assigned: { issues: [], complete: true }, states: { issues: [done], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.closed.length, 1);
  assert.equal(res.closed[0].key, 'NT-14855');
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('a ticket Jira did not answer for is LEFT OPEN and reported', async () => {
  reset();
  const created = await withJira(
    { assigned: { issues: [issue({ key: 'NT-1' })], complete: true }, states: { issues: [issue({ key: 'NT-1' })], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  const taskId = created.created[0].taskId;

  // Deleted, moved to a project the token cannot read, or simply missing. None
  // of those is "Nick finished it".
  const res = await withJira(
    { assigned: { issues: [], complete: true }, states: { issues: [], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.closed.length, 0);
  assert.equal(db.getTaskRow(taskId).status, 'open');
  assert.ok(res.gaps.some((g) => /NT-1\b/.test(g)), 'the silence must be reported, not swallowed');
});

test('an unassigned ticket is unlinked and left open, never closed', async () => {
  reset();
  const created = await withJira(
    { assigned: { issues: [issue({ key: 'NT-2' })], complete: true }, states: { issues: [issue({ key: 'NT-2' })], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  const taskId = created.created[0].taskId;

  const res = await withJira(
    { assigned: { issues: [], complete: true }, states: { issues: [issue({ key: 'NT-2', status: 'In Progress' })], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.closed.length, 0);
  assert.equal(res.unlinked.length, 1);
  assert.equal(db.getTaskRow(taskId).status, 'open');
  // And now that nothing else will close it, Nick can.
  assert.equal(jiraTasks.keyForTask(taskId), null);
  assert.equal(taskStore.updateTask(taskId, { status: 'done' }).status, 'done');
});

test('a truncated assigned list unlinks nothing', async () => {
  reset();
  const created = await withJira(
    { assigned: { issues: [issue({ key: 'NT-3' })], complete: true }, states: { issues: [issue({ key: 'NT-3' })], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  const taskId = created.created[0].taskId;

  // The list came back capped, so "not in it" says nothing about assignment.
  const res = await withJira(
    { assigned: { issues: [], complete: false }, states: { issues: [issue({ key: 'NT-3' })], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.unlinked.length, 0);
  assert.equal(jiraTasks.keyForTask(taskId), 'NT-3', 'still linked');
  assert.ok(res.gaps.some((g) => /truncated/.test(g)));
});

test('creation is capped, and says so rather than filling the list silently', async () => {
  reset();
  const many = Array.from({ length: jiraTasks.MAX_CREATE + 5 }, (_, i) => issue({ key: `NT-90${i}`, summary: `Ticket number ${i}` }));
  const res = await withJira(
    { assigned: { issues: many, complete: true }, states: { issues: [], complete: true } },
    () => jiraTasks.sync({ apply: true }),
  );
  assert.equal(res.created.length, jiraTasks.MAX_CREATE);
  assert.equal(res.capped, 5);
});

test('the switch is read at call time, not captured at require time', () => {
  assert.equal(typeof jiraTasks.isEnabled, 'function');
  const src = fs.readFileSync(path.join(__dirname, 'jira-tasks.js'), 'utf-8');
  // The whole point of moving this to the registry: a module-level const is why
  // changing the switch needed a restart. If one comes back, this fails.
  assert.doesNotMatch(src, /^const ENABLED\s*=/m,
    'the switch must not be captured into a module-level const');
  assert.match(src, /feature-flags'\)\.isEnabled\('jira_assigned_sync'\)/,
    'the switch must be read through the flag registry, so Settings can set it');
});

test('APPLYING refuses when the switch is off, but the DRY RUN still answers', async () => {
  const flags = require('./feature-flags');
  const real = flags.isEnabled;
  flags.isEnabled = (key) => (key === 'jira_assigned_sync' ? false : real(key));
  try {
    const applied = await withJira(
      { assigned: { issues: [], complete: true }, states: { issues: [], complete: true } },
      () => jiraTasks.sync({ apply: true }),
    );
    assert.equal(applied.ok, false);
    assert.match(applied.reason, /disabled/);

    // The preview is what you consult BEFORE flipping the switch, so it must
    // work while the switch is off — and must say that it is off.
    const preview = await withJira(
      { assigned: { issues: [], complete: true }, states: { issues: [], complete: true } },
      () => jiraTasks.sync({ apply: false }),
    );
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.enabled, false);
  } finally {
    flags.isEnabled = real;
  }
});
