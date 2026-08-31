'use strict';

/**
 * The household task list — who a task is FOR, and who may see it.
 *
 * ⚠ `shared-tasks` was a name in the SCOPES array and NOTHING ELSE. It could be
 * ticked in Settings and changed absolutely nothing, so two people on the same
 * household surface each saw only what they had personally typed — which is why
 * the second person appeared to be unable to use the app at all.
 *
 * The dangerous half of fixing that is the pool: widening "what I sent" to
 * "what the household sent" must NOT widen to "everything of Nick's that is not
 * work". Most of the tests here exist to hold that line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-shared-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';

const db = require('../db/database');
const capture = require('./capture-links');
const taskStore = require('./task-store');

let helen, nickTest, loner;

test.before(async () => {
  await db.init();
  capture.create({ label: 'Helen', username: 'helen', pin: '135790', scopes: ['tasks', 'shared-tasks'] });
  capture.create({ label: 'Nick Test', username: 'test', pin: '135790', scopes: ['tasks', 'shared-tasks'] });
  capture.create({ label: 'Loner', username: 'loner', pin: '135790', scopes: ['tasks'] });
  helen = capture.resolveSession(capture.login('helen', '135790').token);
  nickTest = capture.resolveSession(capture.login('test', '135790').token);
  loner = capture.resolveSession(capture.login('loner', '135790').token);
});

// ── Assignment ───────────────────────────────────────────────────────────────

test('who a task can be for is derived from the household, not typed out', () => {
  const ids = capture.people().map(p => p.id);
  assert.ok(ids.includes('nick'), 'the owner is always assignable');
  assert.ok(ids.includes('helen'));
  assert.ok(ids.includes('test'));
  // ⚠ Unassigned is the ABSENCE of a choice, not a person. Offering it as one
  // invites code that treats it as an identity it can compare against.
  assert.equal(ids.includes(null), false);
  assert.equal(ids.includes(''), false);
});

test('she can assign to herself, to Nick, or leave it unassigned', () => {
  capture.submit(helen, 'Book the dentist', { assignee: 'helen' });
  capture.submit(helen, 'Put the bins out', { assignee: 'nick' });
  capture.submit(helen, 'Buy a birthday card', {});

  const rows = capture.submissions(helen);
  const find = t => rows.find(r => r.text === t);
  assert.equal(find('Book the dentist').assignee, 'helen');
  assert.equal(find('Book the dentist').assigneeLabel, 'Helen');
  assert.equal(find('Put the bins out').assignee, 'nick');
  assert.equal(find('Put the bins out').assigneeLabel, 'Nick');
  // ⚠ Unassigned stays null — never quietly attributed to whoever typed it.
  assert.equal(find('Buy a birthday card').assignee, null);
  assert.equal(find('Buy a birthday card').assigneeLabel, null);
});

/**
 * ⚠ A typo must not create a person. A stored assignee matching nobody would
 * render as a task belonging to a ghost, which is worse than one plainly
 * belonging to nobody.
 */
test('an unrecognised assignee becomes unassigned, not stored as given', () => {
  assert.equal(capture.resolveAssignee('Nigel'), null);
  assert.equal(capture.resolveAssignee(''), null);
  assert.equal(capture.resolveAssignee(null), null);
  // Case-insensitive against the real household, though.
  assert.equal(capture.resolveAssignee('HELEN'), 'helen');
  assert.equal(capture.resolveAssignee('Nick'), 'nick');

  capture.submit(helen, 'Task for a ghost', { assignee: 'Nigel' });
  const row = capture.submissions(helen).find(r => r.text === 'Task for a ghost');
  assert.equal(row.assignee, null);
});

// ── Who sees what ────────────────────────────────────────────────────────────

test('with shared-tasks, she sees what the OTHER household account sent', () => {
  capture.submit(nickTest, 'Fix the shed door', { assignee: 'nick' });
  const texts = capture.submissions(helen).map(r => r.text);
  assert.ok(texts.includes('Fix the shed door'), 'the household list is shared');
  // And it says who sent it, which only means anything once it can differ.
  const row = capture.submissions(helen).find(r => r.text === 'Fix the shed door');
  assert.equal(row.from, 'Nick Test');
});

test('WITHOUT the scope, an account still sees only its own — unchanged', () => {
  capture.submit(loner, 'My own private errand');
  const texts = capture.submissions(loner).map(r => r.text);
  assert.deepEqual(texts, ['My own private errand']);
  assert.equal(texts.includes('Book the dentist'), false, 'no household pool without the scope');
  // `from` is meaningless on a single-person list and is not sent.
  assert.equal(capture.submissions(loner)[0].from, null);
});

/**
 * ⚠ THE test this whole file exists for.
 *
 * Widening "what I sent" to "what the household sent" must NEVER widen to
 * "everything of Nick's that is not work". His own personal list is
 * personal-domain too, so a `domain = 'personal'` filter would have swept it all
 * in — which is why the pool is a `source` PREFIX instead.
 */
test('the household pool NEVER contains Nick\'s own tasks', () => {
  // The shapes his own tasks actually arrive in.
  taskStore.createTask({ text: 'Prepare the disciplinary pack', domain: 'personal', source: 'manual' });
  taskStore.createTask({ text: 'Call the GP about the referral', domain: 'personal', source: 'chat' });
  taskStore.createTask({ text: 'Review the Q3 numbers', domain: 'work', source: 'mcp' });
  taskStore.createTask({ text: 'Sort the fraud investigation file', domain: 'personal', source: 'obsidian-capture' });

  const texts = capture.submissions(helen).map(r => r.text);
  for (const secret of [
    'Prepare the disciplinary pack',
    'Call the GP about the referral',
    'Review the Q3 numbers',
    'Sort the fraud investigation file',
  ]) {
    assert.equal(texts.includes(secret), false, `"${secret}" must never reach the household list`);
  }
  // Positive control — without it this passes just as well on an empty list,
  // which is the trap this codebase keeps re-learning.
  assert.ok(texts.includes('Book the dentist'), 'her own household tasks are still there');
  assert.ok(texts.includes('Fix the shed door'), 'and the other account\'s');
});

test('a household task is still a PERSONAL task, never a work one', () => {
  const row = db.listTaskRows({ status: 'all', includeDone: true, sourcePrefix: 'capture:' })
    .find(r => r.text === 'Book the dentist');
  assert.equal(row.domain, 'personal');
  assert.equal(row.source, 'capture:Helen');
});

test('the assignee survives a round trip through the database', () => {
  const row = db.listTaskRows({ status: 'all', includeDone: true, sourcePrefix: 'capture:' })
    .find(r => r.text === 'Put the bins out');
  // ⚠ createTaskRow's INSERT is an explicit column list — a field omitted there
  // is silently dropped, which is exactly how estimateMinutes once went missing
  // from POST /api/tasks. This asserts the column is really written.
  assert.equal(row.assignee, 'nick');
});
