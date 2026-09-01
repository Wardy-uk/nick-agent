'use strict';

/**
 * The /api/todos whitelist is the FOURTH place a task field can be dropped in
 * silence, and it is the one the panel actually reads.
 *
 * `task-store.toTodoShape` can carry a field, `decorateTask` can spread it
 * through, and the route can still leave it out of its object literal — at
 * which point every badge, filter and control on the screen behaves as though
 * the field does not exist. Nothing throws, nothing logs, and the UI looks
 * like a feature that was never built.
 *
 * It has already cost twice: `estimateMinutes` went missing from POST
 * /api/tasks the same way, and `domain` was absent from THIS list, so
 * `domainBadge` in TodoPanel could never fire in full mode — the personal chip
 * had never once rendered, from the day the domain split shipped until
 * 1 Sep 2026, with a green suite over it the whole time.
 *
 * ⚠ What this pins and what it does not. It is a SOURCE SCAN, so it proves the
 * key is listed, not that the value arrives correct at runtime — a real HTTP
 * exercise of this route needs a vault on disk and is covered by the panel's
 * own behaviour. It catches the failure that actually happens: somebody tidies
 * the literal and a field silently stops existing. The positive control is
 * what stops a broken scan passing by finding nothing.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'todos.js'), 'utf8');

// The object literal the panel is built from, isolated so a stray match
// elsewhere in the file cannot make this pass.
function mappedBlock() {
  const start = SOURCE.indexOf('vault_task: true');
  assert.ok(start > 0, 'could not find the /api/todos mapping block — this scan is broken, not passing');
  const end = SOURCE.indexOf('const enriched', start);
  assert.ok(end > start, 'could not find the end of the mapping block');
  // Walk back to the start of the literal so the whole thing is in view.
  const from = SOURCE.lastIndexOf('id: i + 1', 0 + start);
  return SOURCE.slice(from > 0 ? from : start, end);
}

test('positive control: the scan finds a block containing keys known to be there', () => {
  const block = mappedBlock();
  for (const key of ['task_id:', 'text:', 'moscow:', 'due_date:']) {
    assert.ok(block.includes(key), `${key} missing — the scan is looking at the wrong text`);
  }
});

test('origin survives the whitelist — the panel badge and filters read it', () => {
  const block = mappedBlock();
  assert.ok(block.includes('origin:'), 'origin dropped: every task would read as unclassified');
  assert.ok(block.includes('originProposed:'), 'originProposed dropped: a guess would render as Nick\'s own call');
});

test('origin is passed through RAW, never defaulted', () => {
  const block = mappedBlock();
  // ⚠ `t.origin || 'improvement'` here would be the whole feature undone: the
  // report counts unclassified as its own bucket precisely because guessing
  // either way is expensive, and a default in the route would make the screen
  // disagree with the document.
  assert.match(block, /origin:\s*t\.origin \|\| null/, 'origin must default to null, not to a bucket');
});

test('domain survives it too — the chip that never rendered', () => {
  assert.ok(mappedBlock().includes('domain:'), 'domain dropped: the personal badge cannot fire');
});
