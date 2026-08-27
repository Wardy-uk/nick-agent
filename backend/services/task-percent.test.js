'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const obsidian = require('./obsidian');

function withLine(line, fn) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'Microsoft Tasks.md');
  fs.writeFileSync(f, `# Microsoft Tasks\n\n## Planner\n\n${line}\n`);
  fn(f, 4);
  return fs.readFileSync(f, 'utf-8').split('\n')[4];
}

test('adds a marker, keeping the due date and the id comment', () => {
  const out = withLine('- [ ] Brief TPJ teams 📅 2026-08-30 <!--id:abc123-->',
    (f, n) => obsidian.setTaskPercent(f, n, 50));
  assert.equal(out, '- [ ] Brief TPJ teams (50%) 📅 2026-08-30 <!--id:abc123-->');
});

test('replaces an existing marker rather than doubling it', () => {
  const out = withLine('- [ ] Re-instate 121s (75%) 📅 2026-08-30 <!--id:abc-->',
    (f, n) => obsidian.setTaskPercent(f, n, 50));
  assert.equal(out, '- [ ] Re-instate 121s (50%) 📅 2026-08-30 <!--id:abc-->');
});

test('zero removes the marker — that is how Planner renders not-started', () => {
  const out = withLine('- [ ] Some task (50%) <!--id:xyz-->',
    (f, n) => obsidian.setTaskPercent(f, n, 0));
  assert.equal(out, '- [ ] Some task <!--id:xyz-->');
});

test('a line with no due date and no id still works', () => {
  const out = withLine('- [ ] Bare task', (f, n) => obsidian.setTaskPercent(f, n, 50));
  assert.equal(out, '- [ ] Bare task (50%)');
});

test('the id comment survives — completion parses it, so losing it breaks ticking off', () => {
  const out = withLine('- [ ] Task (25%) <!--id:keepme-->', (f, n) => obsidian.setTaskPercent(f, n, 50));
  assert.match(out, /<!--id:keepme-->/);
});

test('a CRLF line keeps its ending', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '# T\r\n\r\n- [ ] Task <!--id:a-->\r\n');
  obsidian.setTaskPercent(f, 2, 50);
  assert.match(fs.readFileSync(f, 'utf-8'), /- \[ \] Task \(50%\) <!--id:a-->\r\n/);
});

test('a non-task line is refused rather than mangled', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '# Heading\n');
  assert.throws(() => obsidian.setTaskPercent(f, 0, 50), /Not a task line/);
});

// ── A line number is a position; the task is an identity ────────────────────
//
// This file is regenerated wholesale by syncMicrosoftTasks, so a client holding
// a lane fetched before a resync can hand back an offset that now points at a
// different task. Proved by accident: a probe paired one task's id with
// another's line and wrote "(50%)" onto a row sitting at 75%.

test('refuses to edit a line whose id is not the expected task', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '- [ ] Someone else (75%) <!--id:THEIRS-->\n');
  assert.throws(
    () => obsidian.setTaskPercent(f, 0, 50, 'MINE'),
    /refusing to edit the wrong task/
  );
  assert.match(fs.readFileSync(f, 'utf-8'), /\(75%\)/, 'the row must be untouched');
});

test('edits happily when the id on the line matches', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '- [ ] My task <!--id:MINE-->\n');
  obsidian.setTaskPercent(f, 0, 50, 'MINE');
  assert.match(fs.readFileSync(f, 'utf-8'), /My task \(50%\) <!--id:MINE-->/);
});

test('a line with no id is refused when an id was expected', () => {
  // Better to do nothing than to guess: an unidentified line cannot be proved
  // to be the right one.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '- [ ] No id here\n');
  assert.throws(() => obsidian.setTaskPercent(f, 0, 50, 'MINE'), /expected MINE/);
});

test('no expected id keeps the old permissive behaviour for other callers', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pct-')), 'm.md');
  fs.writeFileSync(f, '- [ ] Anything <!--id:whatever-->\n');
  obsidian.setTaskPercent(f, 0, 50);
  assert.match(fs.readFileSync(f, 'utf-8'), /\(50%\)/);
});
