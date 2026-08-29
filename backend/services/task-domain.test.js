'use strict';

/**
 * The work/personal split.
 *
 * Two things are pinned here, and the second is the one that would fail
 * silently in production:
 *
 *  1. The vocabulary — what counts as a domain, what an unknown value does, and
 *     which way each of the two defaults falls. They fall OPPOSITE ways on
 *     purpose (storage defaults to work, outbound blocks only what is provably
 *     personal) and a future tidy-up that "makes them consistent" would either
 *     empty the briefing or leak personal tasks into it.
 *
 *  2. The cross-domain dedupe collision. `dedupe_key` is UNIQUE across the whole
 *     tasks table and predates the domain question entirely, so a personal task
 *     sharing wording with a work one folds into it — and folding is silent, so
 *     the task just never appears. That is the exact class of failure the domain
 *     split exists to remove.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A real scratch DB, so the collision test exercises the actual UNIQUE index
// rather than a stub of it — the index IS the bug.
// ⚠ NEVER point this at the live agent.db: moving a live DB aside for a test is
// how the local dev copy was destroyed once already (mistakes.md, 13 Aug). It
// must be set before db/database is first required, hence up here.
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-domain-')), 'scratch.db',
);

const db = require('../db/database');
const taskStore = require('./task-store');

const {
  WORK, PERSONAL, DOMAINS, DEFAULT_DOMAIN,
  normaliseDomain, domainOrDefault, domainLabel, domainBadge,
  isPersonal, isWork, mayLeaveTheBuilding,
} = require('../../shared/task-domain.cjs');

// ── Vocabulary ───────────────────────────────────────────────────────────────

test('there are exactly two domains, and work is the default', () => {
  // A taxonomy with speculative empty branches is one that gets argued with
  // rather than used. If a third is ever added it should be a deliberate change
  // to this assertion, not something that drifts in.
  assert.deepEqual([...DOMAINS], ['work', 'personal']);
  assert.equal(DEFAULT_DOMAIN, WORK);
});

test('normaliseDomain returns null for anything it does not recognise', () => {
  assert.equal(normaliseDomain('work'), WORK);
  assert.equal(normaliseDomain('PERSONAL'), PERSONAL);
  assert.equal(normaliseDomain('  Personal  '), PERSONAL);
  // Null rather than the default: storing and rendering want opposite things
  // from a bad value, and folding them here hides a typo behind a silent 'work'.
  assert.equal(normaliseDomain('family'), null);
  assert.equal(normaliseDomain(''), null);
  assert.equal(normaliseDomain(null), null);
  assert.equal(normaliseDomain(undefined), null);
});

test('domainOrDefault fails towards the VISIBLE mistake', () => {
  // A personal task filed as work turns up looking odd in the work lane and
  // gets fixed in a tap. A work task filed as personal vanishes and nothing
  // says so. The default is chosen for that asymmetry, not by coin toss.
  assert.equal(domainOrDefault(undefined), WORK);
  assert.equal(domainOrDefault('nonsense'), WORK);
  assert.equal(domainOrDefault('personal'), PERSONAL);
});

test('a row written before the column existed reads as work', () => {
  assert.equal(isWork({}), true);
  assert.equal(isWork({ domain: null }), true);
  assert.equal(isPersonal({}), false);
});

test('the work badge is silent by default', () => {
  // Nearly every task is work, so a "Work" chip on all of them is a label every
  // row shares — it sorts nothing and reads as noise, the same finding that
  // made nearly-every-task-a-MUST useless for ranking.
  assert.equal(domainBadge({ domain: WORK }), null);
  assert.equal(domainBadge({}), null);
  assert.equal(domainBadge({ domain: PERSONAL }), 'Personal');
  // Only where both appear side by side does the absence become ambiguous.
  assert.equal(domainBadge({ domain: WORK }, { withWork: true }), 'Work');
});

test('an unrecognised domain renders as itself rather than vanishing', () => {
  assert.equal(domainLabel('household'), 'household');
  assert.equal(domainLabel(PERSONAL), 'Personal');
});

// ── The outbound guard ───────────────────────────────────────────────────────

test('outbound blocks what is POSITIVELY personal, and nothing else', () => {
  // ⚠ The negative half is the point. Requiring a positive 'work' would have
  // suppressed every Microsoft mirror line and every vault-backed task — none of
  // which carries the column at all — and silently emptied the briefing. The
  // first cut did exactly that on a "fail closed" instinct.
  assert.equal(mayLeaveTheBuilding({ domain: PERSONAL }), false);
  assert.equal(mayLeaveTheBuilding({ domain: WORK }), true);
  assert.equal(mayLeaveTheBuilding({}), true, 'a task with no domain must still reach the briefing');
  assert.equal(mayLeaveTheBuilding({ domain: null }), true);
});

test('the two defaults deliberately fall opposite ways', () => {
  // Storage says "unknown is work". Outbound says "unknown may go". Both are
  // permissive, and that is coherent: the threat is personal data leaving, and
  // a task only becomes personal by being told so, explicitly.
  const unknown = { domain: undefined };
  assert.equal(domainOrDefault(unknown.domain), WORK);
  assert.equal(mayLeaveTheBuilding(unknown), true);
});

// ── The work calendar ────────────────────────────────────────────────────────

test('the day planner refuses to block a personal task into the work diary', () => {
  // The planner auto-creates real events on a timer in Nick's Nurtur calendar,
  // whose busy time his colleagues can see. "Collect the kids" becoming a booked
  // work block is wrong AND visible to other people, so the guard sits in the
  // pure funnel every path goes through rather than in one caller.
  const { toPlannerTask } = require('./day-planner');

  const work = { task_id: 1, text: 'Write the risk report', estimateMinutes: 60, domain: 'work' };
  const personal = { task_id: 2, text: 'Collect the kids', estimateMinutes: 30, domain: 'personal' };
  const legacy = { task_id: 3, text: 'Task from before the column existed', estimateMinutes: 30 };

  assert.ok(toPlannerTask(work), 'a work task must still be plannable');
  assert.equal(toPlannerTask(personal), null, 'a personal task must never reach the work calendar');
  // Absent domain reads as work — the pre-migration shape must not silently
  // stop being schedulable, which would empty the planner on the day it shipped.
  assert.ok(toPlannerTask(legacy), 'a task with no domain must still be plannable');

  // The existing refusal is untouched: a file-backed line is owned elsewhere.
  assert.equal(toPlannerTask({ text: 'Microsoft mirror line', domain: 'work' }), null);
});

// ── The lane ─────────────────────────────────────────────────────────────────

test("the today lane shows BOTH domains unless a caller asks for one", () => {
  const { buildTodayLane } = require('./todo-intelligence');
  const today = '2026-08-29';
  const tasks = [
    { text: 'Sign the risk assessment', due_date: today, domain: 'work' },
    { text: 'Collect the kids', due_date: today, domain: 'personal' },
    { text: 'Task from before the column', due_date: today },
  ];

  // ⚠ The default is BOTH, and that is the correction worth pinning. Defaulting
  // to work would hide a personal task that is genuinely due today from the one
  // screen Nick uses to find what he owes — the invisible failure the domain
  // split exists to prevent, committed by the fix for it.
  const all = buildTodayLane(tasks, today);
  assert.equal(all.length, 3);

  const work = buildTodayLane(tasks, today, 5, { domain: 'work' });
  assert.deepEqual(work.map((t) => t.text).sort(), [
    'Sign the risk assessment', 'Task from before the column',
  ], 'absent domain counts as work');

  const personal = buildTodayLane(tasks, today, 5, { domain: 'personal' });
  assert.deepEqual(personal.map((t) => t.text), ['Collect the kids']);
});

// ── The collision ────────────────────────────────────────────────────────────

test.before(async () => { await db.init(); });

test('a personal task does not fold into a work task with the same wording', () => {
  const work = taskStore.createTask({ text: 'Book the dentist', domain: 'work' });
  const personal = taskStore.createTask({ text: 'Book the dentist', domain: 'personal' });

  assert.equal(work.created, true);
  assert.equal(personal.created, true, 'the personal task must NOT fold into the work one');
  assert.notEqual(personal.id, work.id);
  assert.equal(personal.task.domain, 'personal');
  assert.equal(work.task.domain, 'work');

  // Same domain still folds — the whole point of the key is preserved.
  const again = taskStore.createTask({ text: 'Book the dentist', domain: 'personal' });
  assert.equal(again.created, false);
  assert.equal(again.id, personal.id);

  // ⚠ The ordinary key is untouched, so the six callers outside task-store that
  // compute dedupeKey(text) and look a task up by it still find what they always
  // found. Only the colliding row carries a suffix.
  assert.equal(work.task.dedupe_key, taskStore.dedupeKey('Book the dentist'));
});
