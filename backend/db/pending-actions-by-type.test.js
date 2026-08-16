'use strict';

/**
 * #83 — the todos route's suggestion list asked for 1,000 pending actions of
 * EVERY type and then discarded everything that was not a `capture_todo`.
 *
 * So the bound had to be large enough to swallow the entire pending queue just
 * to be correct about one type, and once the queue passed it the tail vanished
 * with no error and no signal. At the 930-action peak that was not theoretical:
 * `ORDER BY confidence DESC, created_at DESC` spans all types, so a genuine
 * capture_todo could be pushed past the cap by hundreds of rows the caller was
 * about to throw away.
 *
 * The tracker's premise ("the queue currently sits at 929") is stale — it was
 * measured at 4 on 16 Aug — so this is a latent bug, and these tests are what
 * stop it becoming a live one again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pending-'));
process.env.NEURO_DB_PATH = path.join(root, 'pending.db');

const db = require('./database');

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM sara_actions', []); });

test('a bound on one type is not spent on the others', () => {
  // Bury one capture_todo under high-confidence noise of other types. The old
  // read sorted across every type, so the noise outranks it.
  for (let i = 0; i < 300; i++) {
    db.createSaraAction('open_task', { i }, 0.99, 'noise', `noise-${i}`);
  }
  const wanted = db.createSaraAction(
    'capture_todo', { text: 'Confirm the field mapping' }, 0.10, 'low confidence but real', 'wanted'
  );

  const viaGlobalCap = db.getPendingSaraActions(100).filter(a => a.type === 'capture_todo');
  assert.equal(viaGlobalCap.length, 0, 'precondition: a global cap spends itself on other types');

  const scoped = db.getPendingSaraActionsByType('capture_todo', 100);
  assert.equal(scoped.length, 1, 'a typed bound only ever holds rows of that type');
  assert.equal(scoped[0].id, wanted);
});

test('the count is of what is pending, not of what was returned', () => {
  // The route renders a capped, de-duplicated list, so its length is not a
  // count of what is waiting. Reporting that length as the total is the mistake
  // that had /api/actions claiming 10 pending against a real queue of 930.
  for (let i = 0; i < 250; i++) {
    db.createSaraAction('capture_todo', { text: `task ${i}` }, 0.5, 'bulk', `bulk-${i}`);
  }
  db.createSaraAction('reply_email', { to: 'someone@example.com' }, 0.9, 'other type', 'other');

  assert.equal(db.getPendingSaraActionsByType('capture_todo', 200).length, 200, 'the cap holds');
  assert.equal(db.countPendingSaraActionsByType('capture_todo'), 250, 'the count ignores the cap');
  assert.equal(db.countPendingSaraActionsByType('reply_email'), 1, 'and is scoped to the type');
});

test('only pending rows count — an approved one is not still waiting', () => {
  const id = db.createSaraAction('capture_todo', { text: 'done with' }, 0.5, 'x', 'dedupe-1');
  db.createSaraAction('capture_todo', { text: 'still open' }, 0.5, 'x', 'dedupe-2');
  db.run('UPDATE sara_actions SET status = ? WHERE id = ?', ['executed', id]);

  assert.equal(db.countPendingSaraActionsByType('capture_todo'), 1);
  assert.equal(db.getPendingSaraActionsByType('capture_todo', 100).length, 1);
});

test('a type nobody has queued is zero, not an error', () => {
  assert.equal(db.countPendingSaraActionsByType('chase_commitment'), 0);
  assert.deepEqual(db.getPendingSaraActionsByType('chase_commitment', 100), []);
});
