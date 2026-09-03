'use strict';

/**
 * Who a task says it came from.
 *
 * `source` is the only field that answers "did a person type this, or did
 * something generate it", and it is read by the weekly risk report, the origin
 * classifier and by Nick's own eye when he is deciding what he actually owes.
 *
 * ⚠ The bug this pins was invisible for the whole life of the feature: the chat
 * `[ADD TODO: ...]` marker handler called `addTodoToMasterList(text, { trigger:
 * ... })` while the function reads `options.origin`, so the key never matched and
 * the store's `|| 'manual'` fallback took over. Model output was stamped as
 * something Nick typed, and nothing in the data could tell the two apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attrib-'));
process.env.NEURO_DB_PATH = path.join(root, 'attrib.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const obsidian = require('./obsidian');

test.before(async () => { await db.init(); });

function rowFor(text) {
  return db.get('SELECT * FROM tasks WHERE text = ?', [text]);
}

test('a todo from the chat marker is NOT stamped as something Nick typed', () => {
  const text = 'Chase the DNS change with infrastructure';
  obsidian.addTodoFromChat(text);

  const row = rowFor(text);
  assert.ok(row, 'the chat marker must still create the task');
  assert.notEqual(row.source, 'manual',
    'model output must never be attributed to Nick — this is the bug');
  assert.equal(row.source, 'chat-marker');
});

test('the chat marker leaves the origin COLUMN null — a different question', () => {
  // ⚠ `addTodoToMasterList`'s parameter is named `origin` and feeds the `source`
  // column. The `origin` column is commitment-vs-improvement, and `inferOrigin`
  // deliberately returns null for every route INTO the store: knowing a human
  // did not type this is not the same as knowing who wanted the work, and null
  // is documented as a first-class value for exactly that gap.
  const text = 'Draft the migration note for the team';
  obsidian.addTodoFromChat(text);

  const row = rowFor(text);
  assert.equal(row.origin, null, 'origin must stay null, not be guessed from the route');
  assert.equal(row.origin_proposed, 0, 'nothing was proposed, so nothing should be flagged as a guess');
});

// ─────────────────────────────────────────────────────────────────────────────
// Every writer names itself.
//
// The chat-marker bug was only findable by hand-auditing 15 call sites. This is
// the same shape as `action-presenter.test.js`: scan the source so the next one
// fails at the moment it is written rather than during the next investigation.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_DIRS = [__dirname, path.join(__dirname, '..', 'routes')];

/** Every `createTask({ ... })` call in the backend, with its argument text. */
function createTaskCallSites() {
  const sites = [];
  for (const dir of SERVICE_DIRS) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      // task-store defines createTask; it is the callee, not a caller.
      if (file === 'task-store.js') continue;
      const re = /createTask\(\{/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        // Walk to the matching brace so a nested object cannot truncate the arg.
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) break; }
        }
        sites.push({
          file,
          line: src.slice(0, m.index).split('\n').length,
          arg: src.slice(m.index, i + 1),
        });
      }
    }
  }
  return sites;
}

test('every createTask call site names its source explicitly', () => {
  const sites = createTaskCallSites();
  // Positive control: a scan that finds nothing passes by absence, which is how
  // a broken scan looks exactly like a clean codebase.
  assert.ok(sites.length >= 10, `expected to find the known call sites, found ${sites.length}`);

  const unnamed = sites.filter(s => !/\bsource:/.test(s.arg));
  assert.deepEqual(unnamed.map(s => `${s.file}:${s.line}`), [],
    'these createTask calls do not pass a source, so their tasks would be stored '
    + '"unattributed" — every writer must name itself');
});

test('no call site re-implements the unnamed-writer default', () => {
  // One place decides what an unnamed writer is called. A second `|| 'manual'`
  // anywhere is how the two come to disagree — and `manual` specifically is the
  // claim that a person typed it.
  const offenders = createTaskCallSites()
    .filter(s => /source:\s*[^,}]*\|\|\s*'manual'/.test(s.arg))
    .map(s => `${s.file}:${s.line}`);
  assert.deepEqual(offenders, [],
    'a call site must not default its own source to "manual"');
});

test('the store default is unattributed, and says so out loud', () => {
  const src = fs.readFileSync(path.join(__dirname, 'task-store.js'), 'utf8');
  assert.doesNotMatch(src, /source:\s*input\.source\s*\|\|\s*'manual'/,
    'the silent manual default is the bug — it attributes unnamed writes to Nick');
  assert.match(src, /'unattributed'/);
  // The log line is the point: a default that fires in silence is what took so
  // long to notice in the first place.
  assert.match(src, /console\.warn\([^)]*no source/);
});

test('the caller passes the key the function actually reads', () => {
  // The bug was a key mismatch, not a wrong value, so the source is what pins
  // it: `trigger` alone reintroduces the fault with every test above still
  // passing on the store default.
  const src = fs.readFileSync(path.join(__dirname, 'obsidian.js'), 'utf-8');
  const fn = src.slice(src.indexOf('function addTodoFromChat'));
  const body = fn.slice(0, fn.indexOf('}'));
  assert.match(body, /origin:\s*'chat-marker'/,
    'addTodoFromChat must pass `origin`, which is the key addTodoToMasterList reads');
});
