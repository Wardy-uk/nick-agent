'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-msq-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'agent.db');

const db = require('../db/database');
const queue = require('../services/ms-push-queue');

test.before(async () => { await db.init(); });

function reset() {
  db.setState(queue.STATE_KEY, '[]');
}

/** A stand-in for services/microsoft with a scripted answer per call. */
function fakeGraph(answers) {
  const calls = [];
  return {
    calls,
    completeMicrosoftTask: async (msId, source, listId) => {
      calls.push({ msId, source, listId });
      const next = answers.shift();
      return next || { completed: false, reason: 'auth' };
    },
  };
}

test('a refused completion is held, and the same tick twice is one entry', () => {
  reset();
  queue.enqueue({ msId: 'AAA', source: 'MS Planner', text: 'Succession plan', reason: 'auth' });
  queue.enqueue({ msId: 'AAA', source: 'MS Planner', text: 'Succession plan', reason: 'auth' });
  const s = queue.status();
  assert.equal(s.pendingCount, 1, 'one task, one entry — a second tick must not queue a second push');
  assert.equal(s.pending[0].text, 'Succession plan');
  assert.equal(s.pending[0].reasonText, 'Microsoft sign-in expired');
});

test('nothing to push to is the only terminal reason', () => {
  reset();
  // `no_task_id` cannot be retried — there is no id to retry against.
  assert.equal(queue.enqueue({ msId: 'BBB', reason: 'no_task_id' }), null);
  assert.equal(queue.status().pendingCount, 0);

  // ⚠ NEGATIVE, and the important one. `not_found` looks terminal and is not:
  // setPlannerPercent returns it when it cannot read the task's etag, and
  // graphFetch returns null on a 401 — so a real task reports `not_found`
  // throughout an auth outage. Giving up on it would drop the completion at
  // exactly the moment this whole queue exists for.
  assert.ok(queue.enqueue({ msId: 'CCC', reason: 'not_found' }));
  assert.equal(queue.status().pendingCount, 1);
});

test('a held completion is retried and clears when Microsoft comes back', async () => {
  reset();
  queue.enqueue({ msId: 'DDD', source: 'MS ToDo', listId: 'list-1', reason: 'auth' });

  const down = fakeGraph([{ completed: false, reason: 'auth' }]);
  let r = await queue.drain({ microsoft: down });
  assert.equal(r.completed, 0);
  assert.equal(r.stillPending, 1, 'still down — still held');
  assert.deepEqual(down.calls[0], { msId: 'DDD', source: 'MS ToDo', listId: 'list-1' });

  const up = fakeGraph([{ completed: true, kind: 'todo' }]);
  r = await queue.drain({ microsoft: up });
  assert.equal(r.completed, 1);
  assert.equal(r.stillPending, 0);
  assert.equal(queue.status().pendingCount, 0);
});

test('the mirror hides a held task, and gives it back the moment we give up', async () => {
  reset();
  queue.enqueue({ msId: 'EEE', reason: 'auth' });
  assert.ok(queue.pendingIds().has('EEE'), 'suppressed while the push is in flight');

  // Exhaust it. Suppression must end with the retrying — a completion that is
  // never going to land is a task Nick has to see again, not one hidden for ever.
  const down = fakeGraph(Array.from({ length: queue.MAX_ATTEMPTS }, () => ({ completed: false, reason: 'auth' })));
  for (let i = 0; i < queue.MAX_ATTEMPTS; i++) await queue.drain({ microsoft: down });

  const s = queue.status();
  assert.equal(s.pendingCount, 0);
  assert.equal(s.failedCount, 1, 'failed, NOT deleted — a dropped completion is the original bug');
  assert.ok(!queue.pendingIds().has('EEE'), 'the task reappears in the mirror');
  assert.equal(s.failed[0].reason, 'auth', 'and it still says why');
});

test('exhaustion is attempts OR age, and is pure', () => {
  const now = new Date('2026-08-30T12:00:00Z');
  const fresh = { attempts: 1, firstAt: '2026-08-30T11:00:00Z' };
  assert.equal(queue.isExhausted(fresh, now), false);

  assert.equal(queue.isExhausted({ attempts: queue.MAX_ATTEMPTS, firstAt: now.toISOString() }, now), true);

  // Age matters separately: a ten-minute drain burns MAX_ATTEMPTS in two hours,
  // which is shorter than a weekend of expired auth — but an item that errors
  // before it can attempt would otherwise sit pending for ever.
  const old = { attempts: 0, firstAt: '2026-08-01T12:00:00Z' };
  assert.equal(queue.isExhausted(old, now), true);
});

test('a corrupt queue suppresses nothing rather than breaking the vault sync', () => {
  db.setState(queue.STATE_KEY, 'not json at all');
  assert.deepEqual([...queue.pendingIds()], [], 'degrades to empty');
  assert.equal(queue.status().pendingCount, 0);
});

test('forget is the way back, and says whether it found anything', () => {
  reset();
  queue.enqueue({ msId: 'FFF', reason: 'auth' });
  assert.equal(queue.forget('FFF'), true);
  assert.equal(queue.forget('FFF'), false, 'a forget that matched nothing is not a success');
  assert.equal(queue.status().pendingCount, 0);
});

test('one failure does not abandon the rest of the queue', async () => {
  reset();
  queue.enqueue({ msId: 'G1', reason: 'auth' });
  queue.enqueue({ msId: 'G2', reason: 'auth' });
  queue.enqueue({ msId: 'G3', reason: 'auth' });

  const mixed = {
    completeMicrosoftTask: async (msId) => {
      if (msId === 'G2') throw new Error('network gone');
      return { completed: true, kind: 'planner' };
    },
  };
  const r = await queue.drain({ microsoft: mixed });
  assert.equal(r.attempted, 3);
  assert.equal(r.completed, 2, 'G1 and G3 land despite G2 throwing');
  assert.equal(r.stillPending, 1);
  assert.equal(queue.status().pending[0].msId, 'G2');
});

test('the queue survives a restart', () => {
  reset();
  queue.enqueue({ msId: 'HHH', text: 'Send the slides', reason: 'auth' });
  // Nothing is cached in module scope — every read goes back to agent_state,
  // which is the whole point: the backend restarts several times a day on
  // deploys, and an in-memory queue would lose what it exists to hold.
  delete require.cache[require.resolve('../services/ms-push-queue')];
  const reloaded = require('../services/ms-push-queue');
  assert.equal(reloaded.status().pendingCount, 1);
  assert.equal(reloaded.status().pending[0].text, 'Send the slides');
});
