'use strict';

/**
 * Two long commitments that are not the same commitment (fix b).
 *
 * `dedupe_key` is UNIQUE and a second sighting FOLDS into the first, silently
 * and by design. At 80 characters that made a collision a way to LOSE A TASK:
 * two genuinely different commitments sharing their first eighty normalised
 * characters became one row, and the second simply never appeared — no error,
 * nothing missing, just a task that was never there.
 *
 * The fixtures are the shape the store actually holds. Commitments extracted
 * from meeting notes open with the same long preamble and differ only in the
 * clause that says what to do; eighty normalised characters is about a dozen
 * words, which these two share.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-key-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'a.db');

const db = require('../db/database');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

// Identical for the first ~110 characters, then genuinely different work.
const A = 'Work with the rest of customer care to identify what the twelve customer-facing knowledge base articles should be and agree the list with Mel';
const B = 'Work with the rest of customer care to identify what the twelve customer-facing knowledge base articles should be and write the first one';

test('the shared prefix really is longer than the old key', () => {
  // If this fails the fixtures have drifted and the test below proves nothing.
  const na = taskStore.normalizeText(A);
  const nb = taskStore.normalizeText(B);
  assert.equal(na.slice(0, 80), nb.slice(0, 80), 'fixtures must collide at 80');
  assert.notEqual(na.slice(0, taskStore.KEY_LENGTH), nb.slice(0, taskStore.KEY_LENGTH));
});

test('two long, similarly-prefixed but distinct commitments no longer collide', () => {
  assert.notEqual(taskStore.dedupeKey(A), taskStore.dedupeKey(B));
});

test('and both survive as separate tasks', () => {
  // The behavioural half. Before this, the second create folded into the first
  // and returned `created: false` — the task simply never appeared.
  const first = taskStore.createTask({ text: A, source: 'test' });
  const second = taskStore.createTask({ text: B, source: 'test' });
  assert.equal(first.created, true);
  assert.equal(second.created, true, 'the second commitment must not fold into the first');
  assert.notEqual(first.id, second.id);
});

test('a genuine re-sighting still folds', () => {
  // The widening must not cost the behaviour the key exists for.
  const again = taskStore.createTask({ text: A, source: 'test' });
  assert.equal(again.created, false);
});

test('a reworded tail past the key length still folds, which is the trade', () => {
  // The key is still a PREFIX, not the whole string — deliberately. Something
  // that matches for 200 normalised characters is the same commitment with a
  // different ending, and folding it is the point of having a key at all.
  // The divergence has to start PAST the key length, or this asserts nothing —
  // the shared head below is comfortably longer than KEY_LENGTH on its own.
  const head = `${A} ${A}`;
  assert.ok(taskStore.normalizeText(head).length > taskStore.KEY_LENGTH, 'fixture head must exceed the key length');
  const long = `${head} and then a trailing clause that goes on`;
  const longer = `${head} and then a completely different ending`;
  assert.equal(taskStore.dedupeKey(long), taskStore.dedupeKey(longer));
});

test('short tasks are unaffected', () => {
  assert.equal(taskStore.dedupeKey('Book the dentist'), 'book the dentist');
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test('rekeyAll brings an old 80-char key up to the current length', () => {
  const { id } = taskStore.createTask({ text: 'Something else entirely that is quite long and would key past eighty characters easily', source: 'test' });
  const full = db.getTaskRow(id).dedupe_key;

  // Fake a row left over from before the widening.
  db.updateTaskRow(id, { dedupe_key: full.slice(0, 80) });
  assert.notEqual(db.getTaskRow(id).dedupe_key, full);

  const res = taskStore.rekeyAll();
  assert.equal(res.ok, true);
  assert.ok(res.rekeyed >= 1);
  assert.equal(db.getTaskRow(id).dedupe_key, full, 'the row must be findable by its own key again');
});

test('rekeyAll is idempotent', () => {
  const second = taskStore.rekeyAll();
  assert.equal(second.rekeyed, 0);
});

test('a task is findable by its own key after the migration', () => {
  // This is what actually breaks if the migration does not run: the mirror
  // suppression, focus-session matching and task-import folding all go through
  // `getTaskByDedupeKey`.
  const text = 'A commitment long enough that its key runs well past the old eighty character boundary indeed';
  const { id } = taskStore.createTask({ text, source: 'test' });
  const found = db.getTaskByDedupeKey(taskStore.dedupeKey(text));
  assert.ok(found, 'lookup by computed key must find the row');
  assert.equal(found.id, id);
});
