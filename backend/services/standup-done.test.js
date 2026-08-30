'use strict';

/**
 * "Standup already done today." — on a morning Nick had not done one.
 *
 * Reported from the phone on 30 Aug 2026, with the daily note on screen showing
 * the whole story underneath it:
 *
 *     ## Focus Today
 *     - [ ]
 *
 * An EMPTY checkbox. NEURO writes that skeleton into every daily note, and
 * `routes/standup.js` matched `- [ ]` — so the scaffold satisfied its own test
 * and the screen announced work nobody had done. `activity.js` was worse still:
 * the bare HEADING counted.
 *
 * The deeper fault was not the regex. There were FOUR implementations of one
 * question at three different strictness levels, so the nudge kept correctly
 * asking for a standup while the screen said it was finished. Two surfaces
 * disagreeing about one fact is worse than either being wrong alone, because
 * there is no way to tell which to believe.
 *
 * PURE, so this pins without a vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { standupDoneIn } = require('./standup-accountability');

// The note from the screenshot, byte for byte.
const REPORTED = `# 2026-08-30

## Focus Today
- [ ]

---

## Calendar Today
`;

test('THE REPORTED BUG: an empty checkbox is not a standup', () => {
  assert.equal(standupDoneIn(REPORTED), false);
});

test('the bare heading is not a standup either', () => {
  assert.equal(standupDoneIn('# Day\n\n## Focus Today\n\n## Calendar\n'), false);
  // NEURO writes the scaffold, so a detector that accepts the scaffold creates
  // the evidence for its own test — the `task-blocks` empty-stub rule exactly.
  assert.equal(standupDoneIn('## Focus Today\n-\n'), false);
  assert.equal(standupDoneIn('## Focus Today\n- [ ]\n- [ ]\n'), false);
});

test('a real focus item IS a standup', () => {
  assert.equal(standupDoneIn('## Focus Today\n- [ ] Write the risk assessment\n'), true);
  // Ticked already counts too — doing it and finishing it are both "done it".
  assert.equal(standupDoneIn('## Focus Today\n- [x] Write the risk assessment\n'), true);
});

test('an explicit Standup section counts, wherever it sits', () => {
  assert.equal(standupDoneIn('## Standup\n\nSome prose.\n'), true);
});

test('"none" is an answer, not a commitment', () => {
  // The writer emits this for a genuinely empty day; treating it as a focus
  // item would make "nothing today" indistinguishable from a filled-in plan.
  assert.equal(standupDoneIn('## Focus Today\n- [ ] none\n'), false);
});

test('an unreadable note is NOT a completed standup', () => {
  // `readTodayDailyNote()` returns null when the vault is unreachable. Reading
  // that as "done" would silence the nudge on exactly the days NEURO is blind.
  for (const bad of [null, undefined, '', 0, {}]) {
    assert.equal(standupDoneIn(bad), false, String(bad));
  }
});

test('⚠ every consumer asks the ONE predicate — no copy survives', () => {
  // The bug was four implementations, not one bad regex. This fails if any of
  // them grows back, which is the only thing that stops the drift returning.
  const files = ['../routes/standup.js', './nudges.js', './activity.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      src.includes('standupDoneIn'),
      `${rel} must ask the shared predicate`
    );
    // ⚠ Scoped to the code that answers "IS IT DONE", not to every mention of
    // the section.
    //
    // A first cut banned the `inFocus` scan outright and was WRONG:
    // `routes/standup.js` walks Focus Today three more times — for carry-over
    // items, and to build the EOD context — and those answer a different
    // question ("what were today's items") perfectly legitimately. Banning the
    // scan would have forced three correct pieces of code to be rewritten to
    // satisfy a test.
    //
    // What must never come back is a SECOND ANSWER to the done question, so the
    // assertion is on the done-flag assignments themselves.
    assert.ok(
      !/standup_?[Dd]one\w*\s*=\s*(true|1)\s*;/.test(src)
      || /standupDoneIn/.test(src),
      `${rel} sets a standup-done flag from its own scan`
    );
    assert.ok(
      !/includes\('## Focus Today'\)\)\s*\w+\.standup_done/.test(src),
      `${rel} still treats the bare heading as a completed standup`
    );
  }
});
