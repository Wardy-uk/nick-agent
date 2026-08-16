'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _rekeyTodoList } = require('./microsoft');

// #71 — the vault records a bare <!--id:...--> for a Microsoft task with no
// list id, so completing one has to find its list first. That map lived only in
// memory, which made the fallback (walk every To Do list, one Graph call each)
// the NORMAL path: neuro-backend restarts several times a day on deploys, and
// the first completion after each restart paid for the walk.
//
// Persisting it to agent_state fixes the cost and introduces the opposite
// problem — an in-memory cache self-corrected every restart, a stored one does
// not. Hence re-keying a whole list on each sync rather than appending to it:
// the map stays the size of "tasks currently open" and a completed task falls
// out on its own. (completeTodoTask covers the residue by forgetting the entry
// and re-walking once on a 404.)

const map = (obj) => new Map(Object.entries(obj));

test('a task that has left the list is dropped, not left behind forever', () => {
  const cache = map({ 'task-a': 'list-1', 'task-b': 'list-1' });
  const changed = _rekeyTodoList(cache, 'list-1', ['task-a']);
  assert.equal(changed, true);
  assert.deepEqual(Object.fromEntries(cache), { 'task-a': 'list-1' });
});

test('re-keying one list leaves every other list untouched', () => {
  // The sync loops the lists one at a time, so a pass over list-1 must not look
  // like "list-2 is now empty".
  const cache = map({ 'task-a': 'list-1', 'task-b': 'list-2' });
  _rekeyTodoList(cache, 'list-1', ['task-a']);
  assert.equal(cache.get('task-b'), 'list-2');
});

test('a task that moved between lists is re-pointed at the new one', () => {
  const cache = map({ 'task-a': 'list-1' });
  const changed = _rekeyTodoList(cache, 'list-2', ['task-a']);
  assert.equal(changed, true);
  assert.equal(cache.get('task-a'), 'list-2');
});

test('an unchanged list reports no change — that is what gates the DB write', () => {
  // Every sync pass calls this for every list. Without the flag it would write
  // the blob back on each one, several times an hour, for nothing.
  const cache = map({ 'task-a': 'list-1' });
  assert.equal(_rekeyTodoList(cache, 'list-1', ['task-a']), false);
});

test('emptying a list clears its entries and says so', () => {
  const cache = map({ 'task-a': 'list-1' });
  assert.equal(_rekeyTodoList(cache, 'list-1', []), true);
  assert.equal(cache.size, 0);
});
