'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { _internals } = require('./claude');
const { parseDecisions } = _internals;

// #28 was filed as "logged decisions render nowhere". Nothing was ever logged.
// Both system prompts document `[DECISION: text]`; the parser matched
// `[DECISION] text`. Measured before touching anything: the `decisions` table
// held 0 rows, and `Decision Log/decisions.md` held ONE entry in five months —
// a pleasantry with a doubled bullet, not a decision.

test('the documented [DECISION: text] form is captured', () => {
  assert.deepEqual(
    parseDecisions('Right. [DECISION: move the Tuesday standup to 9:30] Done.'),
    ['move the Tuesday standup to 9:30']
  );
});

test('several decisions in one response are all captured, in order', () => {
  assert.deepEqual(
    parseDecisions('[DECISION: drop the Pi 4 worker]\nand\n[DECISION: route heavy prose to cloud]'),
    ['drop the Pi 4 worker', 'route heavy prose to cloud']
  );
});

test('a response with no marker logs nothing', () => {
  assert.deepEqual(parseDecisions('We should probably decide about the worker soon.'), []);
  assert.deepEqual(parseDecisions(''), []);
  assert.deepEqual(parseDecisions(null), []);
});

test('the documented form cannot swallow the rest of the reply', () => {
  // Bounded by the closing bracket. The old unbounded capture is exactly how the
  // single historical vault entry became a whole sentence of chat.
  const out = parseDecisions('[DECISION: use restic] and then a long paragraph about B2 pricing that goes on.');
  assert.deepEqual(out, ['use restic']);
});

test('the legacy bare form still works, but only to end of line', () => {
  const out = parseDecisions('[DECISION] use restic for backups\nNext paragraph, unrelated.');
  assert.deepEqual(out, ['use restic for backups']);
});

test('a leading bullet is stripped, so the vault log cannot get "- - "', () => {
  assert.deepEqual(parseDecisions('[DECISION: - go with B2]'), ['go with B2']);
  assert.deepEqual(parseDecisions('[DECISION] - go with B2'), ['go with B2']);
});

test('the same decision in both forms is logged once', () => {
  assert.deepEqual(
    parseDecisions('[DECISION: go with B2]\n[DECISION] go with B2'),
    ['go with B2']
  );
});

test('an empty marker logs nothing rather than a blank row', () => {
  assert.deepEqual(parseDecisions('[DECISION: ]'), []);
  assert.deepEqual(parseDecisions('[DECISION]\n'), []);
});

// The bug was a contract mismatch between the prompt and the parser, so pin the
// contract itself — a prompt edit that renames the marker must fail here rather
// than silently emptying the table again for five months.
test('both system prompts still document the form the parser accepts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'claude.js'), 'utf8');
  const documented = source.match(/\[DECISION: text\]/g) || [];
  assert.ok(documented.length >= 2, 'both prompts should document [DECISION: text]');
  // And the documented form must actually parse.
  assert.deepEqual(parseDecisions('[DECISION: text]'), ['text']);
});

test('the sibling markers were never broken and are unchanged', () => {
  // ADD TODO / MEETING NOTE / UPDATE PERSON all use the colon form already —
  // DECISION was the only one out of step, which is why it was the only one
  // with an empty table.
  const source = fs.readFileSync(path.join(__dirname, 'claude.js'), 'utf8');
  for (const marker of ['ADD TODO', 'MEETING NOTE', 'UPDATE PERSON']) {
    assert.ok(
      source.includes(`\\[${marker}:\\s*(.+?)\\]`),
      `${marker} should still use the bounded colon form`
    );
  }
});
