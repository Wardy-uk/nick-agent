'use strict';

/**
 * #114 — reading captured features back.
 *
 * Capture writes into the tracker from chat and both Capture surfaces, and
 * nothing read it: the only way to see whether an idea had landed was to open
 * the file. Same built-but-unreachable shape as #96/#97 one layer down.
 *
 * The parsing has two traps worth pinning, both from the file's real state:
 * the tracker contains DUPLICATE item numbers (feature-tracker already numbers
 * max+1 rather than counting because of it), so sorting must be stable rather
 * than assuming a number is a key; and the ranked sections above the capture
 * section run to a hundred-odd rows, which must never be included — listing
 * them would make this a second, worse view of the backlog instead of an
 * answer to "did that thing I said land".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tracker = require('./feature-tracker');

function withTracker(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tracker-'));
  const file = path.join(dir, 'tracker.md');
  fs.writeFileSync(file, body);
  const prev = process.env.NEURO_TRACKER_PATH;
  process.env.NEURO_TRACKER_PATH = file;
  try { return fn(file); }
  finally {
    process.env.NEURO_TRACKER_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const RANKED = [
  '---', 'updated: 2026-08-16', '---', '',
  '# NEURO Feature Tracker', '',
  '## Now — decided and ready', '',
  '| # | Feature | System | Status | Notes |',
  '|---|---|---|---|---|',
  '| 4 | **Escalation first-drafts** | NOVA | **Ready** | ranked, not captured |',
  '| 5 | **Something else** | NEURO | **Ready** | ranked, not captured |', '',
].join('\n');

const CAPTURED = [
  '## Captured — raised in passing', '',
  'blurb', '',
  '| # | Feature | System | Status | Notes |',
  '|---|---|---|---|---|',
  '| 114 | **Nothing reads captured features back** | NEURO | **Captured 15 Aug** | note one |',
  '| 119 | **npm test writes to the real vault** | NEURO | **Captured 16 Aug** | note two |', '',
].join('\n');

test('only the capture section is listed — never the ranked sections above it', () => {
  withTracker(`${RANKED}\n${CAPTURED}`, () => {
    const r = tracker.listCaptured({ limit: 50 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 2, 'the ranked rows must not be counted');
    assert.deepStrictEqual(r.items.map(i => i.number), [119, 114]);
  });
});

test('newest first, and the fields are unwrapped', () => {
  withTracker(`${RANKED}\n${CAPTURED}`, () => {
    const [first] = tracker.listCaptured({}).items;
    assert.strictEqual(first.number, 119);
    assert.strictEqual(first.title, 'npm test writes to the real vault', 'bold markers stripped');
    assert.strictEqual(first.system, 'NEURO');
    assert.strictEqual(first.status, 'Captured 16 Aug');
    assert.strictEqual(first.notes, 'note two');
  });
});

test('a duplicate number keeps both rows, in file order', () => {
  // The live tracker really does contain duplicates — #66, #78, #106, #107 each
  // appear twice. A parser that treated the number as a key would silently drop
  // half of a pair.
  const dupes = CAPTURED.replace(
    '| 119 | **npm test writes to the real vault** | NEURO | **Captured 16 Aug** | note two |',
    '| 114 | **First of the pair** | NEURO | **Captured 16 Aug** | a |\n' +
    '| 114 | **Second of the pair** | SARA | **Captured 16 Aug** | b |'
  );
  withTracker(`${RANKED}\n${dupes}`, () => {
    const r = tracker.listCaptured({ limit: 50 });
    assert.strictEqual(r.total, 3, 'all three rows survive — none deduped by number');
    // The table is append-only, so later in the file is newer. With the number
    // useless as a tie-break, file order reversed is the answer.
    assert.deepStrictEqual(r.items.map(i => i.title), [
      'Second of the pair',
      'First of the pair',
      'Nothing reads captured features back',
    ]);
  });
});

test('no capture section yet is empty-and-fine, not an error', () => {
  // #28's rule: "there are none" and "I could not ask" are different answers.
  withTracker(RANKED, () => {
    const r = tracker.listCaptured({});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 0);
    assert.deepStrictEqual(r.items, []);
  });
});

test('an unreachable tracker reports an error rather than an empty list', () => {
  const prev = process.env.NEURO_TRACKER_PATH;
  process.env.NEURO_TRACKER_PATH = path.join(os.tmpdir(), 'definitely-not-here-114.md');
  try {
    const r = tracker.listCaptured({});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not found/i);
    assert.deepStrictEqual(r.items, []);
  } finally {
    process.env.NEURO_TRACKER_PATH = prev;
  }
});

test('limit is bounded, and nonsense falls back to the default', () => {
  // #69's rule: clamping `limit=-5` to 1 returns one row, which looks like the
  // truth. Rubbish input must fall back to the default, not the nearest legal.
  withTracker(`${RANKED}\n${CAPTURED}`, () => {
    assert.strictEqual(tracker.listCaptured({ limit: 1 }).items.length, 1);
    assert.strictEqual(tracker.listCaptured({ limit: -5 }).items.length, 2, 'default, not 1');
    assert.strictEqual(tracker.listCaptured({ limit: 'banana' }).items.length, 2);
    assert.strictEqual(tracker.listCaptured({ limit: 9999 }).total, 2);
  });
});

test('a captured row survives a round trip through captureFeature', () => {
  withTracker(RANKED, () => {
    const w = tracker.captureFeature({ title: 'A thing on the train', system: 'SARA', notes: 'why' });
    assert.strictEqual(w.ok, true);
    const r = tracker.listCaptured({});
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.items[0].number, w.number);
    assert.strictEqual(r.items[0].title, 'A thing on the train');
    assert.strictEqual(r.items[0].system, 'SARA');
  });
});
