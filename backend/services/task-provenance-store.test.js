'use strict';

/**
 * The provenance detail survives the trip into the store and back out.
 *
 * The describer is pinned pure next door; this is the wiring, against a real
 * scratch DB, because the bug being fixed was not in the words — it was that
 * the sender and subject were known at promotion time and DROPPED on the way
 * in, so no describer could ever have rendered them.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ NEVER point this at the live agent.db.
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-prov-')), 'scratch.db',
);

const db = require('../db/database');
const taskStore = require('./task-store');
const { describeTaskProvenance } = require('../../shared/task-provenance.cjs');

test.before(async () => { await db.init(); });

test('an email-promoted task carries who asked and what about, all the way to the card', () => {
  const { id } = taskStore.createTask({
    text: 'Review what happened and explain where the process broke down',
    source: 'email-promotion',
    origin_path: 'email:AAMkAGI1MjNlMjY3',
    origin_detail: { email: { from: 'Naomi Wentworth', subject: 'Sandford escalation' } },
    skipExport: true,
  });

  const todo = taskStore.activeTodos().find(t => t.task_id === id);
  assert.ok(todo, 'the task should be in the open pool');

  const p = describeTaskProvenance(todo, { now: new Date() });
  assert.equal(p.from.label, 'Email from Naomi Wentworth');
  assert.ok(p.from.detail.includes('Sandford escalation'));
  // And the id still never reaches a label.
  assert.ok(!/AAMk/.test(p.from.label));
});

test('a row with nothing recorded stores NULL, not an empty object', () => {
  // "{}" in the column reads downstream as "detail WAS recorded" and then
  // renders nothing — a gap wearing the costume of an answer.
  const { id } = taskStore.createTask({
    text: 'Something from a note with no extra detail',
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/09/x.md',
    origin_detail: {},
    skipExport: true,
  });
  const todo = taskStore.activeTodos().find(t => t.task_id === id);
  assert.equal(todo.originDetail, null);
});

test('a second sighting fills in detail nobody had, and never overwrites it', () => {
  const text = 'Chase the supplier about the missing invoice';
  const first = taskStore.createTask({
    text, source: 'email-promotion', origin_path: 'email:AAA', skipExport: true,
  });
  assert.equal(first.created, true);

  const second = taskStore.createTask({
    text, source: 'email-promotion', origin_path: 'email:AAA',
    origin_detail: { email: { from: 'Adele', subject: 'Invoice' } },
    skipExport: true,
  });
  assert.equal(second.created, false, 'the same wording folds, it does not duplicate');
  let todo = taskStore.activeTodos().find(t => t.task_id === first.id);
  assert.ok(todo.originDetail.includes('Adele'), 'a blank should be filled in');

  taskStore.createTask({
    text, source: 'email-promotion', origin_path: 'email:AAA',
    origin_detail: { email: { from: 'Somebody Else', subject: 'Different' } },
    skipExport: true,
  });
  todo = taskStore.activeTodos().find(t => t.task_id === first.id);
  assert.ok(todo.originDetail.includes('Adele'), 'recorded detail is never overwritten');
  assert.ok(!todo.originDetail.includes('Somebody Else'));
});

test('the created date reaches the card', () => {
  const { id } = taskStore.createTask({ text: 'A task created just now', source: 'manual', skipExport: true });
  const todo = taskStore.activeTodos().find(t => t.task_id === id);
  const p = describeTaskProvenance(todo, { now: new Date() });
  assert.equal(p.addedKnown, true, 'created_at has a DB default — it must always be readable');
  assert.equal(p.added, 'Added today');
  assert.equal(p.how, 'You typed it in');
});
