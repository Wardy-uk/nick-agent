'use strict';

/**
 * Which Planner board / To Do list a Microsoft task is on.
 *
 * Two halves pinned here: the round trip through the vault mirror (a `### `
 * heading written by syncMicrosoftTasks, read back by parseVaultTodos as
 * `msPlan`) and the pure badge the three task surfaces render from it.
 *
 * The rule under all of it is that UNKNOWN STAYS UNKNOWN. A plan title Graph
 * would not give up must arrive on a card as silence, never as a plan id and
 * never as the previous heading — a card naming the wrong board is worse than
 * one naming none.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const msTask = require('../../shared/ms-task.cjs');

// ── The pure half — no vault, no DB ──────────────────────────────────────────

test('badge: system and board together by default', () => {
  assert.equal(
    msTask.msPlanBadge({ source: 'NEURO', msSource: 'MS Planner', msPlan: 'Support Squad' }),
    'Planner · Support Squad'
  );
  assert.equal(
    msTask.msPlanBadge({ source: 'MS ToDo', msPlan: 'Work' }),
    'To Do · Work'
  );
});

test('badge: withSystem:false is for a card already showing an MS source badge', () => {
  assert.equal(
    msTask.msPlanBadge({ source: 'MS Planner', msPlan: 'Support Squad' }, { withSystem: false }),
    'Support Squad',
    'the row renders "MS Planner" beside this — repeating it is two badges for one fact'
  );
});

test('badge: a linked task with no readable board still says which system', () => {
  // The Microsoft mirror line is suppressed once a pair is linked, so without
  // this the card loses every trace of where the work actually lives.
  assert.equal(msTask.msPlanBadge({ source: 'NEURO', msSource: 'MS Planner', msPlan: null }), 'Planner');
});

test('badge: nothing known is SILENCE, never a placeholder', () => {
  assert.equal(msTask.msPlanBadge({ source: 'NEURO', msPlan: null }), null);
  assert.equal(msTask.msPlanBadge({ source: 'Daily (Focus Today)' }), null);
  assert.equal(msTask.msPlanBadge(null), null);
  // Whitespace is not a board name.
  assert.equal(msTask.msPlanBadge({ source: 'NEURO', msPlan: '   ' }), null);
});

// ── The round trip through the vault mirror ──────────────────────────────────

function withVault(fileBody, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-msplan-'));
  fs.mkdirSync(path.join(root, 'Tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Tasks', 'Microsoft Tasks.md'), fileBody, 'utf-8');
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    // Required inside, after the env var is set: nothing in obsidian.js reads
    // the vault at module load, but keeping it here makes the dependency obvious.
    const obsidian = require('./obsidian');
    return fn(obsidian);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MIRROR = [
  '# Microsoft Tasks',
  '',
  '## Planner',
  '',
  '### Support Squad',
  '',
  '- [ ] Succession plan <!--id:p1-->',
  '',
  '### (plan unknown)',
  '',
  '- [ ] Orphaned board task <!--id:p2-->',
  '',
  '## ToDo',
  '',
  '- [ ] Before any list heading <!--id:t0-->',
  '',
  '### Work',
  '',
  '- [ ] FOC report <!--id:t1-->',
  '',
].join('\n');

test('parse: a task carries the board heading above it', () => {
  const byId = withVault(MIRROR, (obsidian) => {
    const { active } = obsidian.parseVaultTodos({ dbTasks: false });
    return new Map(active.map(t => [t.ms_id, t]));
  });

  assert.equal(byId.get('p1').msPlan, 'Support Squad');
  assert.equal(byId.get('p1').source, 'MS Planner');
  assert.equal(byId.get('t1').msPlan, 'Work');
  assert.equal(byId.get('t1').source, 'MS ToDo');
});

test('parse: the unknown-plan heading reads back as null, not as its own text', () => {
  const byId = withVault(MIRROR, (obsidian) => {
    const { active } = obsidian.parseVaultTodos({ dbTasks: false });
    return new Map(active.map(t => [t.ms_id, t]));
  });
  assert.equal(byId.get('p2').msPlan, null, '"(plan unknown)" is a marker, not a board');
});

test('parse: a board name never leaks across the Planner/ToDo boundary', () => {
  const byId = withVault(MIRROR, (obsidian) => {
    const { active } = obsidian.parseVaultTodos({ dbTasks: false });
    return new Map(active.map(t => [t.ms_id, t]));
  });
  // t0 sits under `## ToDo` with no `### ` of its own — the last heading seen
  // was Planner's "(plan unknown)", and before the reset it would have inherited
  // whichever board happened to be last in the Planner section.
  assert.equal(byId.get('t0').msPlan, null);
  assert.equal(byId.get('t0').source, 'MS ToDo');
});

test('parse: the heading is not swallowed as a task and does not reach the text', () => {
  const texts = withVault(MIRROR, (obsidian) =>
    obsidian.parseVaultTodos({ dbTasks: false }).active.map(t => t.text));
  assert.ok(!texts.some(t => /Support Squad/.test(t)), 'the board is metadata, not part of the task');
  assert.equal(texts.filter(Boolean).length, 4);
});
