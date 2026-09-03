'use strict';

/**
 * No writer resolves a path from an unset vault (fix d).
 *
 * `getVaultPath()` returns `''` when `OBSIDIAN_VAULT_PATH` is unset, and
 * `path.join('', 'Daily')` is RELATIVE — so a writer that builds its path from
 * the root creates its folder wherever the process happens to be running,
 * writes a real note into it, and reports success. On a dev box that is inside
 * the repository, and it has now been found three times: the capture drop-box
 * (`Tasks/Capture.md`), `appendToDailyNote` (a `Daily/` folder in the
 * checkout), and this pass, which found five more including `writeStandup`
 * putting `STANDUP.md` in the working directory.
 *
 * The audit that was asked for is the second test: it walks the source rather
 * than trusting this list to stay complete.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

/** Run a writer with the vault unset, from a scratch cwd, and see what happens. */
function withNoVault(fn) {
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_VAULT_PATH;
  try { return fn(); } finally { if (prev !== undefined) process.env.OBSIDIAN_VAULT_PATH = prev; }
}

const obsidian = require('./obsidian');

// ---------------------------------------------------------------------------
// The writers refuse
// ---------------------------------------------------------------------------

test('every root-resolving writer throws rather than writing to a relative path', () => {
  const cases = [
    ['writeTodayDailyNote', () => obsidian.writeTodayDailyNote('# note')],
    ['writeStandup', () => obsidian.writeStandup('# standup')],
    ['updatePersonNote', () => obsidian.updatePersonNote('Someone', { last121: '2026-09-03' })],
    ['writePersonNoteRaw', () => obsidian.writePersonNoteRaw('Someone', '# person')],
    ['appendDecision', () => obsidian.appendDecision('decided a thing')],
    ['saveMeetingNoteFromChat', () => obsidian.saveMeetingNoteFromChat('A meeting', 'what happened')],
  ];
  withNoVault(() => {
    for (const [name, run] of cases) {
      assert.throws(run, /OBSIDIAN_VAULT_PATH is not configured/, `${name} must refuse`);
    }
  });
});

test('nothing was created in the working directory by that', () => {
  // The actual symptom, asserted directly: the last two rounds of this bug were
  // found by noticing a folder in `git status`, not by a test.
  for (const stray of ['Daily', 'People', 'Decision Log', 'Meetings', 'STANDUP.md', 'Tasks']) {
    assert.equal(fs.existsSync(path.join(process.cwd(), stray)), false,
      `${stray} appeared in the working directory`);
    assert.equal(fs.existsSync(path.join(REPO, stray)), false,
      `${stray} appeared in backend/`);
  }
});

test('appendToDailyNote returns null instead of throwing, and still writes nothing', () => {
  // Deliberately the odd one out: a daily-note append is bookkeeping on the
  // back of real work, and losing the note must not fail the thing that caused
  // it. It must still never write outside the vault.
  withNoVault(() => {
    assert.equal(obsidian.appendToDailyNote('- 09:00 — something'), null);
  });
  assert.equal(fs.existsSync(path.join(process.cwd(), 'Daily')), false);
});

test('a configured vault is completely unaffected', () => {
  // The guard must cost nothing in production, which is every case that matters.
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vault-'));
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = vault;
  try {
    assert.equal(obsidian.requireVaultPath(), vault);
    const written = obsidian.appendToDailyNote('- 09:00 — something');
    assert.ok(written && written.startsWith(vault), 'it must write inside the vault');
    assert.equal(fs.existsSync(written), true);
  } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = prev;
  }
});

// ---------------------------------------------------------------------------
// The audit, so the list above cannot go stale
// ---------------------------------------------------------------------------

test('no writer in obsidian.js joins the UNGUARDED accessor and then writes', () => {
  // The scan is the point. This class of bug was findable only by hand-auditing
  // every caller, which is how it survived three separate discoveries.
  const src = fs.readFileSync(path.join(__dirname, 'obsidian.js'), 'utf-8');
  const lines = src.split('\n');
  const offenders = [];

  lines.forEach((line, i) => {
    // A path built from the raw accessor...
    if (!/path\.join\(\s*getVaultPath\(\)/.test(line)) return;
    // ...inside THIS function, bounded at the next top-level declaration. A
    // fixed window bleeds into the next function and flags readers that
    // correctly guard with existsSync — which it did, on `readTodayDailyNote`
    // and `listPeopleNotes`, both of which are fine.
    let end = i + 1;
    while (end < lines.length && !/^(async )?function \w+/.test(lines[end])) end += 1;
    const body = lines.slice(i, end).join('\n');
    if (/(writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync)\s*\(/.test(body)) {
      offenders.push(`L${i + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(offenders, [], `these build a path from an unguarded vault and then write:\n${offenders.join('\n')}`);
  // Positive control: the scan is looking at real code and the pattern exists
  // in its guarded form.
  assert.match(src, /path\.join\(requireVaultPath\(\)/);
});

test('the other vault-writing services fail safely too', () => {
  // Checked by hand this pass and pinned so it stays true:
  //  · plaud-sync   — its own getVaultPath() THROWS when unset.
  //  · task-capture-drain — resolveVault() / capturePath() / logPath() return
  //    null and every write is guarded on it.
  //  · task-export  — writeExport() returns { ok: false } before writing.
  const plaud = fs.readFileSync(path.join(__dirname, 'plaud-sync.js'), 'utf-8');
  assert.match(plaud, /OBSIDIAN_VAULT_PATH is not configured/);

  const drain = fs.readFileSync(path.join(__dirname, 'task-capture-drain.js'), 'utf-8');
  assert.match(drain, /if \(!target\) return;/);

  const exp = fs.readFileSync(path.join(__dirname, 'task-export.js'), 'utf-8');
  const writeExport = exp.slice(exp.indexOf('function writeExport'));
  const guard = writeExport.indexOf('Vault path not configured');
  const write = writeExport.indexOf('writeFileSync');
  assert.ok(guard > -1 && guard < write, 'writeExport must refuse before it writes');
});
