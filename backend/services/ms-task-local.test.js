'use strict';

/**
 * What NEURO thinks about a task Microsoft owns.
 *
 * The central negative is the last one: nothing this service does may reach
 * Microsoft. That is Nick's whole ask — "working on" and "blocked" are the
 * PRIVATE versions of a status his team would otherwise read off a shared
 * board — and it is exactly the kind of promise that gets broken later by
 * somebody helpfully wiring the state up to `wip-ms` for consistency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mslocal-')), 'a.db');

const msLocal = require('./ms-task-local');
const db = require('../db/database');

test.before(async () => { await db.init(); });

const reset = () => db.setState(msLocal._KEY, '{}');

test('a state round-trips', () => {
  reset();
  msLocal.set('AAA', { state: 'working' });
  assert.equal(msLocal.get('AAA').state, 'working');
  msLocal.set('AAA', { state: 'blocked' });
  assert.equal(msLocal.get('AAA').state, 'blocked');
});

test('an unknown state stores nothing rather than something plausible', () => {
  reset();
  msLocal.set('AAA', { state: 'on fire' });
  assert.equal(msLocal.get('AAA'), null);
  assert.equal(msLocal.normState('on fire'), null);
});

test('an omitted field is left alone; an explicit null clears it', () => {
  // The distinction the whole merge rests on — a control that sets MoSCoW must
  // not wipe the state beside it just by not mentioning it.
  reset();
  msLocal.set('AAA', { state: 'blocked', moscow: 'must', priority: 3 });
  msLocal.set('AAA', { moscow: 'should' });
  const after = msLocal.get('AAA');
  assert.equal(after.state, 'blocked');
  assert.equal(after.priority, 3);
  assert.equal(after.moscow, 'should');

  msLocal.set('AAA', { state: null });
  assert.equal(msLocal.get('AAA').state, null);
  assert.equal(msLocal.get('AAA').moscow, 'should');
});

test('an entry with nothing left in it is deleted, not stored as a row of nulls', () => {
  // Or the blob grows one key per task ever looked at and never shrinks.
  reset();
  msLocal.set('AAA', { state: 'working' });
  msLocal.set('AAA', { state: null });
  assert.equal(msLocal.get('AAA'), null);
  assert.deepEqual(JSON.parse(db.getState(msLocal._KEY)), {});
});

test('annotation folds onto a Microsoft row and marks the letter as NEURO\'s own', () => {
  reset();
  msLocal.set('AAA', { state: 'blocked', moscow: 'must', priority: 2 });
  const [row] = msLocal.annotate([{ ms_id: 'AAA', task_id: null, text: 'x' }]);
  assert.equal(row.msLocalState, 'blocked');
  assert.equal(row.moscow, 'must');
  assert.equal(row.taskPriority, 2);
  assert.equal(row.msLocal, true);
});

test('a NEURO-owned row is never overwritten by an annotation', () => {
  // A linked task carries a real moscow off the tasks table. Two disagreeing
  // triages on one task, with no way to tell which was read, is worse than one.
  reset();
  msLocal.set('AAA', { moscow: 'must' });
  const [row] = msLocal.annotate([{ ms_id: 'AAA', task_id: 42, moscow: 'could', text: 'x' }]);
  assert.equal(row.moscow, 'could');
  assert.equal(row.msLocal, undefined);
  assert.equal(row.msLocalState, undefined);
});

test('a row with no annotation is returned untouched', () => {
  reset();
  msLocal.set('AAA', { moscow: 'must' });
  const [row] = msLocal.annotate([{ ms_id: 'BBB', task_id: null, moscow: null, text: 'x' }]);
  assert.equal(row.moscow, null);
  assert.equal(row.msLocal, undefined);
});

test('NOTHING here talks to Microsoft', () => {
  // The promise the feature IS. A future "let us keep Planner in sync" would
  // publish "blocked" onto a board Nick's team reads, which is the one thing
  // this service exists to avoid.
  const src = fs.readFileSync(path.join(__dirname, 'ms-task-local.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['microsoft', 'graph', 'wip-ms', 'fetch(', 'axios']) {
    assert.ok(!code.toLowerCase().includes(forbidden), `ms-task-local reaches out via "${forbidden}"`);
  }
  // Positive control: the scan can see the code it is scanning.
  assert.ok(code.includes('annotate'));
});
