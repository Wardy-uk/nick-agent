'use strict';

/**
 * The tracker is hand-edited prose with a few tables in it, and this writer runs
 * unattended from chat. Two things must hold or it quietly corrupts the backlog:
 * a new item must never reuse a number, and a row must land inside the capture
 * table rather than anywhere else in a 750-line note.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tracker = require('./feature-tracker');

const HEAD = `---
type: tracker
updated: 2026-01-01
---

# NEURO Feature Tracker

## Now — decided and ready

| # | Feature | System | Status | Notes |
|---|---|---|---|---|
| 1 | Something | NEURO | **Ready** | notes |
| 103 | Duplicated on purpose | NEURO | **Ready** | notes |
| 103 | The other 103 | NOVA | **Ready** | notes |

---

## Related

- [[NEURO & SARA — What They Are]]
`;

test('numbering takes the max, not the count', () => {
  // Count would mint 104 here and collide with the duplicate pair already at 103.
  assert.equal(tracker.nextNumber(HEAD), 104);
  assert.equal(tracker.nextNumber('no rows at all'), 1);
});

test('first capture creates the section above Related', () => {
  const out = tracker.insertRow(HEAD, '| 104 | **A** | NEURO | **Captured** | n |');
  assert.ok(out.includes(tracker.SECTION));
  assert.ok(out.indexOf(tracker.SECTION) < out.indexOf('## Related'), 'section must sit above Related');
  assert.ok(out.includes('| 104 | **A** | NEURO | **Captured** | n |'));
  // The existing tables are untouched.
  assert.ok(out.includes('| 103 | The other 103 | NOVA | **Ready** | notes |'));
});

test('later captures append to that table, not to the last table in the file', () => {
  const once = tracker.insertRow(HEAD, '| 104 | **A** | NEURO | **Captured** | n |');
  const twice = tracker.insertRow(once, '| 105 | **B** | SARA | **Captured** | n |');
  const a = twice.indexOf('| 104 |');
  const b = twice.indexOf('| 105 |');
  assert.ok(a > 0 && b > a, 'B must follow A');
  assert.ok(b < twice.indexOf('## Related'), 'row must stay inside the capture section');
  assert.equal(twice.match(/## Captured/g).length, 1, 'section is created once, then reused');
});

test('captureFeature writes a row, restamps updated, and is reachable end to end', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tracker-')), 'tracker.md');
  fs.writeFileSync(file, HEAD, 'utf8');
  process.env.NEURO_TRACKER_PATH = file;
  try {
    const res = tracker.captureFeature({
      title: 'Capture | with a pipe',
      notes: 'Two\nlines',
      system: 'sara',
      source: 'chat',
    });
    assert.equal(res.ok, true);
    assert.equal(res.number, 104);
    const out = fs.readFileSync(file, 'utf8');
    // A raw pipe or newline in user text would split the row into nonsense.
    assert.ok(out.includes('| 104 | **Capture \\| with a pipe** | SARA | **Captured'));
    assert.ok(out.includes('Two lines (via chat)'));
    assert.ok(/^updated: \d{4}-\d{2}-\d{2}$/m.test(out));
    assert.ok(!out.includes('updated: 2026-01-01'));

    assert.equal(tracker.captureFeature({ title: '  ' }).ok, false);
  } finally {
    delete process.env.NEURO_TRACKER_PATH;
  }
});
