'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFollowThroughCandidate,
  buildTodayLane,
  parseEmbeddedMeta,
  serializeEmbeddedMeta,
  triageTodo,
} = require('./todo-intelligence');

test('triageTodo marks urgent customer work as must/high/needsToday', () => {
  const result = triageTodo({
    text: 'Reply to customer on SLA breach today',
    sourcePath: 'Meetings/2026-07-10-queue.md',
    dueDate: null,
  });
  assert.equal(result.moscow, 'must');
  assert.equal(result.priority, 'high');
  assert.equal(result.needsToday, true);
  assert.equal(result.context, 'meeting-follow-up');
});

test('embedded metadata round-trips cleanly', () => {
  const raw = serializeEmbeddedMeta({ context: 'queue', moscow: 'must', created: '2026-07-10' });
  assert.deepEqual(parseEmbeddedMeta(`- [ ] Do the thing ${raw}`), {
    context: 'queue',
    moscow: 'must',
    created: '2026-07-10',
  });
});

test('buildTodayLane favours must-move work', () => {
  const lane = buildTodayLane([
    { id: 1, text: 'Reply to breached queue item', priority: 'high', due_date: null, source: 'Master (Inbox)', mustdo: true, meta: { created: '2026-07-09' }, _score: 88 },
    { id: 2, text: 'Tidy old notes', priority: 'low', due_date: null, source: 'Master (Later)', mustdo: false, meta: { created: '2026-07-01' }, _score: 4 },
  ], '2026-07-10');
  assert.equal(lane.length, 1);
  assert.equal(lane[0].text, 'Reply to breached queue item');
});

test('buildFollowThroughCandidate returns the stalest high-signal task', () => {
  const follow = buildFollowThroughCandidate([
    { id: 1, text: 'Chase finance approval', priority: 'normal', due_date: null, source: 'Master (Inbox)', mustdo: false, meta: { created: '2026-07-08', sourcePath: 'Meetings/finance.md' }, _score: 60 },
  ], '2026-07-10');
  assert.match(follow.message, /Chase finance approval/);
  assert.equal(follow.context, 'meeting-follow-up');
});
