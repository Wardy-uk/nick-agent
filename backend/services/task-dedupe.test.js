'use strict';

/**
 * Tests for task-dedupe.
 *
 * The ranking half is pure, so it is driven with plain arrays — no DB, no vault,
 * no clock. The link/dismiss half genuinely touches the database, so it runs
 * against a scratch one via NEURO_DB_PATH rather than asserting on source text:
 * a test that reads the code cannot catch the code being wrong (17 Aug 2026).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-dedupe-'));
process.env.NEURO_DB_PATH = path.join(scratchDir, 'agent.db');

// A THROWAWAY vault, set explicitly. Never the real one (#119) — and the
// suppression test below genuinely needs a vault to parse, so it builds its own.
const scratchVault = path.join(scratchDir, 'vault');
fs.mkdirSync(path.join(scratchVault, 'Tasks'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = scratchVault;
fs.writeFileSync(path.join(scratchVault, 'Tasks', 'Microsoft Tasks.md'), [
  '# Microsoft Tasks',
  '',
  '## Planner',
  '',
  '- [ ] Succession plan 📅 2022-10-31 <!--id:ms-succession-->',
  '- [ ] OOH Support <!--id:ms-ooh-->',
  '',
].join('\n'));

const db = require('../db/database');
const taskStore = require('../services/task-store');
const dedupe = require('./task-dedupe');

// ── Pure: ranking ────────────────────────────────────────────────────────────

// The pair this feature exists for, taken verbatim from the live vault. Planner's
// wording is a two-word subset of NEURO's; no normalisation gets one to the other,
// so dedupe_key can never match them and containment has to.
const SUCCESSION_MS = { ms_id: 'ms-succession', text: 'Succession plan', source: 'MS Planner', due_date: '2022-10-31' };
const SUCCESSION_NEURO = {
  id: 58,
  text: 'Build succession plan — cover for HoTS and emerging team leads. **Reframe around Tribe restructure / Support Chapter model.**',
  source: 'master-todo-import',
};

// The highest-scoring NON-duplicate on the live data (0.397). It is the reason
// MIN_SCORE is 0.42 and not lower, so it is pinned as a negative.
const PRODUCTION_MS = { ms_id: 'ms-prod', text: 'Extract Production Ops from Support', source: 'MS Planner' };
const PRODUCTION_NEURO = {
  id: 98,
  text: 'Provide realistic headcount for production/support per squad and map the monitoring',
  source: 'meeting-promotion',
};

function corpus() {
  // Padding so IDF has a corpus to work against — with two documents every token
  // is equally rare and the weighting cannot do its job. These are stock Nick
  // phrasings, which is exactly what should be discounted.
  const filler = [
    'Review the support queue and escalate anything over SLA',
    'Review customer feedback with the team',
    'Support the team through the restructure',
    'Weekly report for the SMT on support performance',
    'Plan the next quarter with the leads',
  ].map((text, i) => ({ id: 900 + i, text, source: 'filler' }));
  return filler;
}

test('the real duplicate is found, and found strongly', () => {
  const pairs = dedupe.rankCandidates({
    neuroTasks: [SUCCESSION_NEURO, PRODUCTION_NEURO, ...corpus()],
    msTasks: [SUCCESSION_MS],
  });
  assert.equal(pairs.length, 1, 'exactly one candidate for one Microsoft task');
  assert.equal(pairs[0].neuro.id, 58);
  assert.equal(pairs[0].confidence, 'strong');
  assert.equal(pairs[0].matchedOn, 'containment', 'the short-inside-long case');
  assert.ok(pairs[0].sharedWords.some(w => w.token === 'succession'));
});

test('the top live false positive stays below the threshold', () => {
  const pairs = dedupe.rankCandidates({
    neuroTasks: [PRODUCTION_NEURO, ...corpus()],
    msTasks: [PRODUCTION_MS],
  });
  assert.equal(pairs.length, 0, '"Extract Production Ops" is not the headcount task');

  // Still reachable on purpose when Nick asks to look under the line.
  const weak = dedupe.rankCandidates({
    neuroTasks: [PRODUCTION_NEURO, ...corpus()],
    msTasks: [PRODUCTION_MS],
    minScore: 0.2,
  });
  assert.equal(weak.length, 1, 'lowering the floor exposes it rather than hiding it forever');
  assert.equal(weak[0].confidence, 'possible');
});

test('a noun in one list and a gerund in the other still match', () => {
  // "Succession plan" (Planner) vs "Succession planning…" (NEURO). Without folding
  // -ing these share ONE token, fall under the two-token rule and are never
  // offered — measured at 0.195 before the fold, 1.0 after. Nick writes the same
  // job as a noun in one place and an activity in the other constantly.
  const pairs = dedupe.rankCandidates({
    neuroTasks: [{ id: 7, text: 'Succession planning for team leads' }, ...corpus()],
    msTasks: [SUCCESSION_MS],
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].confidence, 'strong');

  // The fold has to produce a stem that actually matches, not a stump.
  assert.ok(dedupe.tokenize('planning').has('plan'), 'planning → plann → plan');
  assert.ok(dedupe.tokenize('reporting').has('report'));
  assert.ok(dedupe.tokenize('reviewed').has('review'));
  // …without mangling words that merely end the same way.
  assert.ok(dedupe.tokenize('feedback').has('feedback'));
  assert.ok(dedupe.tokenize('needed').has('need'));
});

test('a single shared word never carries a pair on containment alone', () => {
  // "FOC report" against a task mentioning reports: containment would be 1.0 on
  // one token. Two shared content tokens are required before containment counts.
  const pairs = dedupe.rankCandidates({
    neuroTasks: [{ id: 106, text: 'Nick to add a week-on-week trend to the performance report' }, ...corpus()],
    msTasks: [{ ms_id: 'ms-foc', text: 'FOC report', source: 'MS ToDo' }],
  });
  assert.equal(pairs.length, 0);
});

test('IDF discounts stock vocabulary — a shared rare word outranks a shared common one', () => {
  const neuro = [
    { id: 1, text: 'Sandford Estates duplicate record cleanup' },
    { id: 2, text: 'Review the support queue for the team' },
    ...corpus(),
  ];
  const pairs = dedupe.rankCandidates({
    neuroTasks: neuro,
    msTasks: [{ ms_id: 'm', text: 'Remove Sandford Estates (duplicate)', source: 'MS ToDo' }],
    minScore: 0,
  });
  assert.equal(pairs[0].neuro.id, 1, 'the Sandford pair ranks first, not the "review/support/team" one');
});

test('an already-linked NEURO task is not offered again', () => {
  const pairs = dedupe.rankCandidates({
    neuroTasks: [{ ...SUCCESSION_NEURO, ms_id: 'ms-succession' }, ...corpus()],
    msTasks: [SUCCESSION_MS],
  });
  assert.equal(pairs.length, 0);
});

test('a dismissed pair is never offered again', () => {
  const args = { neuroTasks: [SUCCESSION_NEURO, ...corpus()], msTasks: [SUCCESSION_MS] };
  assert.equal(dedupe.rankCandidates(args).length, 1);
  const withDismissal = dedupe.rankCandidates({
    ...args,
    dismissed: new Set([dedupe.pairKey(58, 'ms-succession')]),
  });
  assert.equal(withDismissal.length, 0);
});

test('notes state due-date agreement as a fact, without moving the score', () => {
  const same = dedupe.rankCandidates({
    neuroTasks: [{ ...SUCCESSION_NEURO, due_date: '2022-10-31' }, ...corpus()],
    msTasks: [SUCCESSION_MS],
  });
  const differing = dedupe.rankCandidates({
    neuroTasks: [{ ...SUCCESSION_NEURO, due_date: '2026-01-01' }, ...corpus()],
    msTasks: [SUCCESSION_MS],
  });
  assert.match(same[0].notes.join(' '), /Same due date/);
  assert.match(differing[0].notes.join(' '), /Due dates differ/);
  assert.equal(same[0].score, differing[0].score, 'corroboration is for Nick to read, not a score fudge');
});

test('empty input is an empty list, not a throw', () => {
  assert.deepEqual(dedupe.rankCandidates({}), []);
  assert.deepEqual(dedupe.rankCandidates({ neuroTasks: [SUCCESSION_NEURO], msTasks: [] }), []);
});

// ── Stateful: linking, against a real scratch DB ─────────────────────────────

test('link, suppress, unlink — the real DB path', async (t) => {
  await db.init();

  const a = taskStore.createTask({ text: 'Build succession plan for the support chapter', skipExport: true });
  const b = taskStore.createTask({ text: 'Completely unrelated task about invoices', skipExport: true });

  // Link
  const linked = dedupe.linkPair(a.id, 'ms-succession', 'MS Planner');
  assert.equal(linked.ok, true);
  assert.equal(linked.task.ms_id, 'ms-succession');
  assert.equal(linked.task.ms_source, 'MS Planner', 'the hint survives the write');

  // This is the fact the suppression in parseVaultTodos depends on. Asserting what
  // the store actually hands back, rather than that the code mentions it.
  assert.ok(dedupe.linkedMsIds().has('ms-succession'));

  // One Microsoft task cannot back two NEURO tasks — the second would hide a real
  // task behind a completion it never earned.
  const clash = dedupe.linkPair(b.id, 'ms-succession', 'MS Planner');
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, 'ms_task_already_linked');
  assert.equal(clash.linkedTo, a.id);

  // Unlink puts it back
  assert.equal(dedupe.unlinkPair(a.id).ok, true);
  assert.equal(dedupe.linkedMsIds().has('ms-succession'), false);
  assert.equal(db.getTaskRow(a.id).ms_source, null, 'the hint is cleared too, not left stale');

  assert.equal(dedupe.unlinkPair(a.id).reason, 'not_linked');
  assert.equal(dedupe.linkPair(999999, 'ms-x').reason, 'task_not_found');
});

test('dismissals persist and round-trip through the state store', async () => {
  await db.init();
  const t1 = taskStore.createTask({ text: 'A task that merely resembles a Microsoft one', skipExport: true });

  dedupe.dismissPair(t1.id, 'ms-not-the-same', 'different piece of work');
  assert.ok(dedupe.dismissedKeySet().has(dedupe.pairKey(t1.id, 'ms-not-the-same')));

  // Reject then link: linking must clear the rejection, or the pair sits in both
  // piles and the screen contradicts itself.
  dedupe.linkPair(t1.id, 'ms-not-the-same');
  assert.equal(dedupe.dismissedKeySet().has(dedupe.pairKey(t1.id, 'ms-not-the-same')), false);

  assert.equal(dedupe.undismissPair(t1.id, 'never-dismissed').ok, false);
});

test('a linked Microsoft line stops listing separately — and the NEURO one survives', async () => {
  await db.init();
  const obsidian = require('./obsidian');

  const task = taskStore.createTask({
    text: 'Build succession plan — cover for HoTS and emerging team leads',
    skipExport: true,
  });

  // The trap this test exists for: once linked, the NEURO row carries the SAME
  // ms_id as the Microsoft line, so "is ms-succession still listed?" answers yes
  // for the wrong reason. Both halves have to be asserted separately or the
  // suppression can break without any test noticing.
  const msBacked = t => /^MS /.test(t.source || '');

  const before = obsidian.parseVaultTodos().active;
  assert.ok(before.some(t => t.ms_id === 'ms-succession' && msBacked(t)), 'Microsoft line listed to begin with');

  dedupe.linkPair(task.id, 'ms-succession', 'MS Planner');

  const after = obsidian.parseVaultTodos().active;
  assert.equal(after.some(t => t.ms_id === 'ms-succession' && msBacked(t)), false, 'the Microsoft line is gone');
  assert.ok(after.some(t => t.task_id === task.id), 'the NEURO task is still there');
  assert.equal(after.length, before.length - 1, 'exactly one row disappeared');
  assert.ok(after.some(t => t.ms_id === 'ms-ooh'), 'an unrelated Microsoft task is untouched');

  // Unlinking has to bring it back, or a mistaken link is unrecoverable.
  dedupe.unlinkPair(task.id);
  assert.ok(obsidian.parseVaultTodos().active.some(t => t.ms_id === 'ms-succession' && msBacked(t)));

  // The importer reads the vault alone; suppressing against rows it cannot see
  // would silently drop a task from its input.
  dedupe.linkPair(task.id, 'ms-succession', 'MS Planner');
  const vaultOnly = obsidian.parseVaultTodos({ dbTasks: false }).active;
  assert.ok(vaultOnly.some(t => t.ms_id === 'ms-succession'), 'dbTasks:false still sees the Microsoft line');
  dedupe.unlinkPair(task.id);
});

test('a Microsoft source hint is normalised, and an unknown one stays null', () => {
  assert.equal(dedupe.normaliseMsSource('MS Planner'), 'MS Planner');
  assert.equal(dedupe.normaliseMsSource('MS ToDo'), 'MS ToDo');
  assert.equal(dedupe.normaliseMsSource('MS To-Do'), 'MS ToDo');
  // Guessing sends the completion to the wrong API; null makes it try both.
  assert.equal(dedupe.normaliseMsSource('something else'), null);
  assert.equal(dedupe.normaliseMsSource(null), null);
});

test('matchText scores arbitrary text against tasks, including Microsoft-linked ones', () => {
  const tasks = [
    { id: 1, text: 'Publish triage and escalation criteria for every team', status: 'open' },
    // Already merged with Mel's Planner board. rankCandidates excludes these
    // because their duplicate question is settled; matchText must NOT, or the
    // plan action they answer would be offered a brand new task instead.
    { id: 2, text: 'Reinstate regular one to one meetings for Customer Care', status: 'open', ms_id: 'ms-1', ms_source: 'MS Planner' },
    { id: 3, text: 'Order more coffee for the office kitchen', status: 'open' },
  ];

  const results = dedupe.matchText({
    texts: [
      { id: 'T1', text: 'Publish triage and escalation criteria for every team' },
      { id: 'Q6', text: 'Reinstate regular 1:1s for every Customer Care colleague' },
      { id: 'N6', text: 'Release governance forum / project gate' },
    ],
    tasks,
  });

  const byId = Object.fromEntries(results.map(r => [r.id, r]));
  assert.equal(byId.T1.matches[0].task.id, 1);
  assert.equal(byId.T1.matches[0].confidence, 'strong');

  assert.equal(byId.Q6.matches[0].task.id, 2, 'a Planner-linked task is still a valid answer');
  assert.equal(byId.Q6.matches[0].task.ms_source, 'MS Planner', 'the Planner badge survives to the caller');

  // Nothing in the store is this action. Saying so is the point — it is what
  // lets the caller offer to create rather than guess.
  assert.equal(byId.N6.matches.length, 0);

  // Caller ids are echoed untouched; the caller keys its own data on them.
  assert.deepEqual(results.map(r => r.id), ['T1', 'Q6', 'N6']);
});

test('matchText searches the Microsoft mirror, not just the task store', () => {
  // The failure this exists to prevent: on 20 Aug 2026 the store held 163 tasks
  // with ZERO ms_id links, while Mel's Planner board sat in the vault mirror. A
  // match run over tasks alone answers "nothing exists" for work that is on the
  // board with a due date on it.
  const results = dedupe.matchText({
    texts: [{ id: 'T6', text: 'Top 10 missing troubleshooting guides, SMEs assigned' }],
    tasks: [{ id: 1, text: 'Order more coffee for the office kitchen', status: 'open' }],
    msTasks: [{ ms_id: 'ms-kb', text: 'Missing troubleshooting guides — assign SMEs to the top 10', source: 'MS Planner' }],
  });

  const [m] = results[0].matches;
  assert.equal(m.kind, 'microsoft');
  assert.equal(m.ms.ms_id, 'ms-kb');
  assert.equal(m.ms.ms_source, 'MS Planner');
  assert.equal(m.task, undefined, 'a Microsoft match has no NEURO task — the caller must create one');
});

test('a Planner item already merged into a task is offered once, as the task', () => {
  const results = dedupe.matchText({
    texts: [{ id: 'Q6', text: 'Reinstate regular one to one meetings for Customer Care' }],
    tasks: [{ id: 7, text: 'Reinstate regular one to one meetings for Customer Care', status: 'open', ms_id: 'ms-121', ms_source: 'MS Planner' }],
    msTasks: [{ ms_id: 'ms-121', text: 'Reinstate regular one to one meetings for Customer Care', source: 'MS Planner' }],
  });

  assert.equal(results[0].matches.length, 1, 'the merged pair is one candidate, not two');
  assert.equal(results[0].matches[0].kind, 'neuro');
  assert.equal(results[0].matches[0].task.id, 7);
});

test('matchText ignores text with no content tokens rather than matching everything', () => {
  const results = dedupe.matchText({
    texts: [{ id: 'A', text: 'the and of' }, { id: 'B', text: '' }],
    tasks: [{ id: 1, text: 'Publish triage and escalation criteria', status: 'open' }],
  });
  assert.equal(results.length, 0);
});

test.after(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
});

// ── Pure: NEURO against itself ───────────────────────────────────────────────
//
// Every one of these is verbatim from the live task list on 31 Aug 2026, scored
// against the whole 143-task pool (which is what sets the IDF and therefore the
// scores). The negatives are what put INTERNAL_MIN_SCORE at 0.65 rather than at
// task-dedupe's 0.42: this corpus is all Nick's own wording, so the stock
// vocabulary is shared almost completely and the floor has to sit higher.

const LIVE_TASKS = [
  { id: 1, text: 'Prepare MyAudience vs iMail price comparisons (for Chris -> SLT)', created_at: '2026-07-01T09:00:00Z' },
  { id: 2, text: 'Nick to prepare price comparisons between MyAudience and iMail (or similar); Chris to bring to SLT', created_at: '2026-08-01T09:00:00Z' },
  { id: 3, text: 'Consult Annabelle for insights', created_at: '2026-07-02T09:00:00Z' },
  { id: 4, text: 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights', created_at: '2026-08-02T09:00:00Z' },
  { id: 5, text: 'Get support ring every ticket trial results from Zoe and evaluate (with Chris)', created_at: '2026-07-03T09:00:00Z' },
  { id: 6, text: 'Chris/Nick to obtain support trial results from Zoe and evaluate effectiveness of ringing every ticket', created_at: '2026-08-03T09:00:00Z' },
  // The two clearest false positives on the live data - different jobs that share
  // his stock vocabulary. Both must stay OUT.
  { id: 7, text: 'Career progression pathways defined by **Day 45**', created_at: '2026-07-04T09:00:00Z' },
  { id: 8, text: 'Kayleigh Russell - career progression plans for DD team by Day 30 (17 April)', created_at: '2026-08-04T09:00:00Z' },
  { id: 9, text: 'Compile list of EXP/LSL dashboard users to grant access', created_at: '2026-07-05T09:00:00Z' },
  { id: 10, text: 'Provide timescales for LSL and EXP dashboards - due 2026-07-14', created_at: '2026-08-05T09:00:00Z' },
  { id: 11, text: 'Review skills matrix - note gaps, missing agents, empty sheets', created_at: '2026-07-06T09:00:00Z' },
  { id: 12, text: 'Book the dentist', created_at: '2026-07-07T09:00:00Z' },
];

function internalPairsFor(ids, opts = {}) {
  return dedupe.rankInternalCandidates({ tasks: LIVE_TASKS, ...opts })
    .filter(p => ids.includes(p.keep.id) && ids.includes(p.drop.id));
}

test('the reworded duplicates dedupe_key cannot see are found', () => {
  const pairs = dedupe.rankInternalCandidates({ tasks: LIVE_TASKS });
  const found = new Set(pairs.map(p => [p.keep.id, p.drop.id].sort((a, b) => a - b).join('-')));
  assert.ok(found.has('1-2'), 'the MyAudience/iMail price comparison pair');
  assert.ok(found.has('3-4'), 'the Annabelle pair');
  assert.ok(found.has('5-6'), 'the Zoe trial-results pair');
});

test('two different jobs sharing stock vocabulary are NOT offered', () => {
  // 0.584 and 0.533 on the live pool. If either of these ever appears, the floor
  // has been lowered past the point where the screen is worth reading.
  assert.equal(internalPairsFor([7, 8]).length, 0, 'career progression: two different deadlines and owners');
  assert.equal(internalPairsFor([9, 10]).length, 0, 'dashboards: compile a user list vs provide timescales');
});

test('an unrelated task matches nothing', () => {
  const pairs = dedupe.rankInternalCandidates({ tasks: LIVE_TASKS });
  assert.equal(pairs.filter(p => p.keep.id === 12 || p.drop.id === 12).length, 0);
});

test('a pair is scored ONCE, not twice with the sides swapped', () => {
  const pairs = dedupe.rankInternalCandidates({ tasks: LIVE_TASKS });
  const keys = pairs.map(p => p.pairKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('the older task is the one offered to keep - it is the one with history on it', () => {
  const [pair] = internalPairsFor([3, 4]);
  assert.equal(pair.keep.id, 3);
  assert.equal(pair.drop.id, 4);
});

test('a rejected internal pair is never offered again', () => {
  const key = dedupe.internalPairKey(4, 3);
  assert.equal(key, dedupe.internalPairKey(3, 4), 'the key must not depend on the order');
  assert.equal(internalPairsFor([3, 4], { dismissed: new Set([key]) }).length, 0);
});

test('an internal rejection key cannot be mistaken for a Microsoft one', () => {
  assert.ok(dedupe.internalPairKey(3, 4).startsWith('task:'));
  assert.notEqual(dedupe.internalPairKey(3, 4), dedupe.pairKey(3, 4));
});

test('looking under the line is possible, and is what surfaces the near misses', () => {
  assert.equal(internalPairsFor([7, 8], { minScore: 0.5 }).length, 1);
});

// ── Stateful: merging ────────────────────────────────────────────────────────

test('merging keeps one task, drops the other, and fills only the blanks', () => {
  const keep = taskStore.createTask({ text: 'Consult Annabelle for insights' });
  const drop = taskStore.createTask({
    text: 'Nick Ward will consult Annabelle, who is further ahead in this process, for insights',
    due_date: '2026-09-10',
    moscow: 'must',
  });

  const result = dedupe.mergeInternalPair(keep.id, drop.id);
  assert.equal(result.ok, true);
  assert.equal(result.dropped.status, 'dropped', 'never deleted - dropped, so it can come back');
  assert.equal(result.keep.status, 'open');
  assert.equal(result.keep.due_date, '2026-09-10', 'the blank was filled from the second sighting');
  assert.equal(result.keep.moscow, 'must');

  const merges = dedupe.listMerges();
  assert.ok(merges.some(m => m.droppedId === drop.id && m.keptId === keep.id));
  assert.ok(merges.find(m => m.droppedId === drop.id).droppedText.includes('further ahead'),
    'the other wording survives the merge');
});

test('merging never overwrites a decision Nick has already made', () => {
  const keep = taskStore.createTask({ text: 'Draft the Q4 capacity model', due_date: '2026-09-01', moscow: 'should' });
  const drop = taskStore.createTask({ text: 'Draft a Q4 capacity model for the support chapter', due_date: '2026-12-25', moscow: 'wont' });
  const result = dedupe.mergeInternalPair(keep.id, drop.id);
  assert.equal(result.keep.due_date, '2026-09-01');
  assert.equal(result.keep.moscow, 'should');
});

test('a merge can be undone and the task comes back open', () => {
  const keep = taskStore.createTask({ text: 'Write the incident review template' });
  const drop = taskStore.createTask({ text: 'Write an incident review template for the team' });
  dedupe.mergeInternalPair(keep.id, drop.id);
  const undo = dedupe.unmergeInternalPair(drop.id);
  assert.equal(undo.ok, true);
  assert.equal(undo.task.status, 'open');
  assert.equal(dedupe.listMerges().some(m => m.droppedId === drop.id), false);
});

test('merging away a Microsoft-linked task is REFUSED rather than moving the link', () => {
  const keep = taskStore.createTask({ text: 'Sort out the out of hours support rota' });
  const drop = taskStore.createTask({ text: 'Sort the OOH support rota out properly' });
  dedupe.linkPair(drop.id, 'ms-ooh', 'MS Planner');
  const result = dedupe.mergeInternalPair(keep.id, drop.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drop_is_linked_to_microsoft');
  assert.equal(taskStore.getTask(drop.id).status, 'open', 'and the task is untouched');
});

test('a task cannot be merged into itself, or merged twice', () => {
  const t = taskStore.createTask({ text: 'Renew the SSL certificate for the portal' });
  const other = taskStore.createTask({ text: 'Renew SSL certificates for the customer portal' });
  assert.equal(dedupe.mergeInternalPair(t.id, t.id).reason, 'same_task');
  dedupe.mergeInternalPair(t.id, other.id);
  assert.equal(dedupe.mergeInternalPair(t.id, other.id).reason, 'already_dropped');
});

test('an internal rejection persists and round-trips', () => {
  dedupe.dismissInternalPair(3, 4, 'different meetings');
  assert.ok(dedupe.dismissedKeySet().has(dedupe.internalPairKey(3, 4)));
  assert.equal(dedupe.undismissInternalPair(3, 4).ok, true);
  assert.equal(dedupe.dismissedKeySet().has(dedupe.internalPairKey(3, 4)), false);
});
