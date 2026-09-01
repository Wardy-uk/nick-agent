'use strict';

/**
 * Commitment vs continual improvement — and the third state that is neither.
 *
 * Four things are pinned, and the middle two are the ones that would fail in
 * silence:
 *
 *  1. The vocabulary, and that there is NO default. `shared/task-domain.cjs`
 *     defaults unknown to `work` and argues for it; a future tidy-up that
 *     "makes the two modules consistent" would give this one a default too, and
 *     that default would decide, invisibly, whether Nick's own stretch goals are
 *     reported to his manager as broken promises.
 *
 *  2. Inference reads PROVENANCE, never wording. A keyword matcher is the
 *     obvious implementation and would be confidently wrong on a compliance
 *     report — the one place being confidently wrong costs most. Pinned with
 *     real live task wording that no honest rule can separate.
 *
 *  3. The unclassified bucket survives every count. The report's overdue
 *     headline is commitments only, so an unclassified row folded into either
 *     side either manufactures a broken promise or hides one.
 *
 *  4. Setting it by hand clears the proposed flag, and a second sighting never
 *     overwrites a decision.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A real scratch DB — the create/update path is what the panel and the report
// both go through, and stubbing it would prove nothing about either.
// ⚠ NEVER point this at the live agent.db.
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-origin-')), 'scratch.db',
);

const db = require('../db/database');
const taskStore = require('./task-store');

const {
  COMMITMENT, IMPROVEMENT, ORIGINS, UNCLASSIFIED_LABEL,
  normaliseOrigin, originLabel, originBadge,
  isCommitment, isImprovement, isUnclassified, inferOrigin,
} = require('../../shared/task-origin.cjs');

test.before(async () => { await db.init(); });

let seq = 0;
const uniq = (s) => `${s} ${++seq}`;

// ── 1. Vocabulary, and the deliberate absence of a default ───────────────────

test('two origins and no more', () => {
  assert.deepStrictEqual([...ORIGINS], ['commitment', 'improvement']);
});

test('normaliseOrigin returns null for anything unrecognised — there is no default', () => {
  assert.strictEqual(normaliseOrigin('Commitment'), COMMITMENT);
  assert.strictEqual(normaliseOrigin('  IMPROVEMENT '), IMPROVEMENT);
  assert.strictEqual(normaliseOrigin(null), null);
  assert.strictEqual(normaliseOrigin(undefined), null);
  assert.strictEqual(normaliseOrigin(''), null);
  assert.strictEqual(normaliseOrigin('ask'), null);
  assert.strictEqual(normaliseOrigin('continual improvement'), null);
});

test('the module exports NO default-resolving helper', () => {
  // The counterpart to domainOrDefault is absent on purpose. If someone adds
  // one, this fails and they have to read the header first — the two mistakes
  // point in opposite directions and both land in a report about Nick's PIP.
  const mod = require('../../shared/task-origin.cjs');
  assert.strictEqual(mod.originOrDefault, undefined);
  assert.strictEqual(mod.DEFAULT_ORIGIN, undefined);
});

test('unclassified is its own state, tested positively', () => {
  const none = { origin: null };
  assert.strictEqual(isUnclassified(none), true);
  assert.strictEqual(isCommitment(none), false);
  // ⚠ The point: NOT a commitment does not make it improvement.
  assert.strictEqual(isImprovement(none), false);
  assert.strictEqual(originLabel(null), UNCLASSIFIED_LABEL);
});

test('the badge is silent for unclassified and marks a proposal with a ?', () => {
  assert.strictEqual(originBadge({ origin: null }), null);
  assert.strictEqual(originBadge({ origin: COMMITMENT }), 'Commitment');
  assert.strictEqual(originBadge({ origin: COMMITMENT, originProposed: true }), 'Commitment?');
  assert.strictEqual(originBadge({ origin: IMPROVEMENT }), 'Improvement');
});

// ── 2. Inference reads provenance, never wording ─────────────────────────────

test('a management-log mirror is a commitment', () => {
  const g = inferOrigin({ source: 'management-log' });
  assert.strictEqual(g.origin, COMMITMENT);
  assert.match(g.basis, /management log/i);
});

test('a task promoted from a meeting note is a commitment — he said it in the room', () => {
  const g = inferOrigin({
    source: 'meeting-promotion',
    originPath: 'Meetings/2026/08/2026-08-18 – Support Leads.md',
  });
  assert.strictEqual(g.origin, COMMITMENT);
});

test('a Planner card is a commitment; an MS To Do task is NOT', () => {
  assert.strictEqual(inferOrigin({ source: 'manual', msSource: 'MS Planner' }).origin, COMMITMENT);
  // To Do is Nick's own private list. Treating it as a shared board would file
  // his personal reminders as promises to other people.
  assert.strictEqual(inferOrigin({ source: 'manual', msSource: 'MS ToDo' }), null);
});

test('a meeting-promotion task from OUTSIDE Meetings/ is not inferred', () => {
  // The rule is "said in front of other people", and the evidence for that is
  // the note being a meeting note. A daily-note scratch line is not.
  assert.strictEqual(
    inferOrigin({ source: 'meeting-promotion', originPath: 'Daily/2026-08-18.md' }),
    null,
  );
});

test('NEGATIVE: wording is never read — two real live tasks, one of each, both unclassifiable', () => {
  // Both are genuine open rows from the live store on 1 Sep 2026, and to a human
  // they are obviously different: the first names its requester, the second is
  // plainly Nick's own idea. They arrived by the SAME route and carry the same
  // provenance, so the classifier must decline both rather than guess.
  const ask = {
    source: 'master-todo-import',
    originPath: 'Tasks/Master Todo.md',
    text: 'Prepare MyAudience vs iMail price comparisons (for Chris → SLT)',
  };
  const own = {
    source: 'master-todo-import',
    originPath: 'Tasks/Master Todo.md',
    text: 'Build escalation accuracy view in NOVA — rejection rate per source tier',
  };
  assert.strictEqual(inferOrigin(ask), null);
  assert.strictEqual(inferOrigin(own), null);
});

test('NEGATIVE: an unknown route in yields null, not a bucket', () => {
  for (const source of ['manual', 'capture', 'chat', 'mcp', 'watch', 'master-todo-import', '']) {
    assert.strictEqual(inferOrigin({ source }), null, `${source} should not be inferred`);
  }
});

// ── 3. The store: a decision, a proposal, and the way back ───────────────────

test('a created task with no evidence is unclassified, not defaulted', () => {
  const { id } = taskStore.createTask({ text: uniq('Tidy the escalation tracker'), source: 'manual' });
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, null);
  assert.strictEqual(row.origin_proposed, 0);
});

test('a created task with evidence is PROPOSED, never decided', () => {
  const { id } = taskStore.createTask({
    text: uniq('Nick to review the call process and report back'),
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/08/2026-08-21 – Ops.md',
  });
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, COMMITMENT);
  // The flag is the whole contract: importing a guess as a decision invents a
  // call Nick never made, and this one is counted in a report he signs.
  assert.strictEqual(row.origin_proposed, 1);
});

test('an explicit origin at creation is a DECISION, not a proposal', () => {
  const { id } = taskStore.createTask({
    text: uniq('Rebuild the weekly KPI pack'),
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/08/2026-08-21 – Ops.md',
    origin: IMPROVEMENT,
  });
  const row = db.getTaskRow(id);
  // Explicit beats inference, and beats it in the direction that disagrees.
  assert.strictEqual(row.origin, IMPROVEMENT);
  assert.strictEqual(row.origin_proposed, 0);
});

test('setting it by hand clears the proposed flag', () => {
  const { id } = taskStore.createTask({
    text: uniq('Nick to circulate the mail provider comparison'),
    source: 'management-log',
  });
  assert.strictEqual(db.getTaskRow(id).origin_proposed, 1);
  // Confirming the proposal UNCHANGED still counts as making the call — that is
  // exactly what the report needs to know about its own figures.
  taskStore.updateTask(id, { origin: COMMITMENT });
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, COMMITMENT);
  assert.strictEqual(row.origin_proposed, 0);
});

test('null clears it back to unclassified — disagreeing without yet knowing', () => {
  const { id } = taskStore.createTask({ text: uniq('Draft the QA calibration note'), source: 'management-log' });
  taskStore.updateTask(id, { origin: null });
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, null);
  assert.strictEqual(row.origin_proposed, 0);
});

test('an unrecognised origin is REFUSED, never silently dropped', () => {
  const { id } = taskStore.createTask({ text: uniq('Something to classify'), source: 'manual' });
  assert.throws(() => taskStore.updateTask(id, { origin: 'ask' }), /commitment/);
  assert.strictEqual(db.getTaskRow(id).origin, null);
});

test('a second sighting fills a blank but NEVER overwrites a decision', () => {
  const text = uniq('Nick will define the ticket documentation process');
  const { id } = taskStore.createTask({ text, source: 'manual' });
  taskStore.updateTask(id, { origin: IMPROVEMENT });

  // The same task turns up again out of a meeting note. The meeting is not new
  // evidence about whose idea it was, and Nick has already ruled.
  const again = taskStore.createTask({
    text,
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/08/2026-08-26 – Leads.md',
  });
  assert.strictEqual(again.created, false);
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, IMPROVEMENT);
  assert.strictEqual(row.origin_proposed, 0);
});

test('a second sighting DOES fill in an origin nobody has set', () => {
  const text = uniq('Nick to schedule the Claude training sessions');
  const { id } = taskStore.createTask({ text, source: 'manual' });
  assert.strictEqual(db.getTaskRow(id).origin, null);

  taskStore.createTask({
    text,
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/08/2026-08-26 – Leads.md',
  });
  const row = db.getTaskRow(id);
  assert.strictEqual(row.origin, COMMITMENT);
  assert.strictEqual(row.origin_proposed, 1);
});

test('the todo shape carries origin through to the panel, raw and undefaulted', () => {
  const { id } = taskStore.createTask({ text: uniq('Mirror check'), source: 'management-log' });
  const todo = taskStore.activeTodos().find(t => t.task_id === id);
  assert.strictEqual(todo.origin, COMMITMENT);
  assert.strictEqual(todo.originProposed, true);

  const { id: plain } = taskStore.createTask({ text: uniq('Unclassified mirror check'), source: 'manual' });
  const other = taskStore.activeTodos().find(t => t.task_id === plain);
  // ⚠ null, not 'improvement'. The panel has to be able to see the difference.
  assert.strictEqual(other.origin, null);
});

// ── 4. Filtering: absent means every origin, including the unclassified ──────

test('listing without an origin filter includes the unclassified pile', () => {
  const { id } = taskStore.createTask({ text: uniq('Visible without a filter'), source: 'manual' });
  const all = db.listTaskRows({ status: 'open' });
  assert.ok(all.some(r => r.id === id), 'an unclassified task must not be hidden by default');
});

test('originUnset asks for the unclassified rows alone', () => {
  const { id: unset } = taskStore.createTask({ text: uniq('Needs a decision'), source: 'manual' });
  const { id: decided } = taskStore.createTask({ text: uniq('Already decided'), source: 'management-log' });
  const rows = db.listTaskRows({ status: 'open', originUnset: true });
  assert.ok(rows.some(r => r.id === unset));
  assert.ok(!rows.some(r => r.id === decided));
});
