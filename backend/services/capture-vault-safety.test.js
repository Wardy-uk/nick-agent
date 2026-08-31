'use strict';

/**
 * The capture drop-box never writes into the repository.
 *
 * ⚠ The bug: `path.join('', 'Tasks', 'Capture.md')` is `Tasks/Capture.md` — a
 * RELATIVE path, resolved against the backend process's working directory. So
 * an unset `OBSIDIAN_VAULT_PATH` did not fail. It created
 * `backend/Tasks/Capture.md` inside the repo, reported success, and drained
 * into it forever: a capture typed in Obsidian went to a file NEURO was not
 * reading, and a capture NEURO wrote went to a file Obsidian could not see.
 * The drop-box working perfectly, against nothing. An untracked
 * `backend/Tasks/Capture.md` in the working tree is what it left behind.
 *
 * These run in a CHILD PROCESS with the environment scrubbed, because the rest
 * of the suite sets `OBSIDIAN_VAULT_PATH` at module load and the whole point is
 * what happens when it is missing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const REPO_TASKS = path.join(BACKEND, 'Tasks');

/** Run a snippet with a scrubbed env and the backend as cwd. Returns stdout. */
function runIsolated(snippet, vaultPath) {
  const env = { ...process.env };
  delete env.OBSIDIAN_VAULT_PATH;
  if (vaultPath !== undefined) env.OBSIDIAN_VAULT_PATH = vaultPath;
  return execFileSync(process.execPath, ['-e', snippet], {
    cwd: BACKEND,
    env,
    encoding: 'utf-8',
  }).trim();
}

// ── ensureCaptureFile refuses, rather than writing into the repo ─────────────

test('ensureCaptureFile with no vault fails safely and writes nothing', () => {
  const before = fs.existsSync(REPO_TASKS);
  const out = runIsolated(`
    const d = require('./services/task-capture-drain');
    const r = d.ensureCaptureFile();
    console.log(JSON.stringify({ r, capturePath: d.capturePath(), logPath: d.logPath() }));
  `);
  const { r, capturePath, logPath } = JSON.parse(out);

  // A structured refusal a caller can log — not a throw, because the startup
  // path must not die here, and not a success, because nothing was created.
  assert.equal(r.ok, false);
  assert.equal(r.created, false);
  assert.equal(r.reason, 'not-configured');
  assert.match(r.error, /OBSIDIAN_VAULT_PATH/);

  // ⚠ Null, never a repo-relative path. A caller that cannot tell "no vault"
  // from "a path" writes into the repository, which is the bug.
  assert.equal(capturePath, null);
  assert.equal(logPath, null);

  assert.equal(fs.existsSync(REPO_TASKS), before, 'no backend/Tasks directory may appear');
  assert.equal(fs.existsSync(path.join(REPO_TASKS, 'Capture.md')), false);
});

test('a relative vault path is refused — it is the repo-relative trap by another name', () => {
  const out = runIsolated(`
    const d = require('./services/task-capture-drain');
    console.log(JSON.stringify(d.resolveVault()));
  `, 'Tasks');
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-absolute');
});

test('a vault path that is a FILE, not a directory, is refused', () => {
  const tmpFile = path.join(os.tmpdir(), `neuro-not-a-vault-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'not a vault', 'utf-8');
  try {
    const out = runIsolated(`
      const d = require('./services/task-capture-drain');
      console.log(JSON.stringify(d.resolveVault()));
    `, tmpFile);
    const r = JSON.parse(out);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-a-directory');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('a vault path that does not exist is refused as unreadable', () => {
  const missing = path.join(os.tmpdir(), `neuro-missing-vault-${Date.now()}`);
  const out = runIsolated(`
    const d = require('./services/task-capture-drain');
    console.log(JSON.stringify(d.resolveVault()));
  `, missing);
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreadable');
});

test('drainCaptureFile with no vault refuses with a reason, and creates nothing', () => {
  const out = runIsolated(`
    const d = require('./services/task-capture-drain');
    console.log(JSON.stringify(d.drainCaptureFile({ force: true })));
  `);
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-configured');
  assert.equal(fs.existsSync(path.join(REPO_TASKS, 'Capture.md')), false);
});

// ── The startup path, which is where the artifact actually came from ─────────

test('scheduler startup with no OBSIDIAN_VAULT_PATH creates no repo-relative Tasks directory', () => {
  const existedBefore = fs.existsSync(REPO_TASKS);

  // The exact startup sequence, minus the cron registration — the guard is what
  // is under test, and it must warn rather than quietly set up a phantom vault.
  const out = runIsolated(`
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    const captureDrain = require('./services/task-capture-drain');
    const vault = captureDrain.resolveVault();
    if (!vault.ok) {
      console.warn('[Scheduler] Obsidian capture drop-box NOT set up - ' + vault.error);
    } else {
      captureDrain.ensureCaptureFile();
      captureDrain.drainCaptureFile({ force: true });
    }
    console.log(JSON.stringify({ ok: vault.ok, warnings }));
  `);
  const { ok, warnings } = JSON.parse(out);

  assert.equal(ok, false);
  // ⚠ One useful configuration warning, not a misleading successful setup line.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOT set up/);
  assert.match(warnings[0], /OBSIDIAN_VAULT_PATH/);

  assert.equal(fs.existsSync(REPO_TASKS), existedBefore, 'backend/Tasks must not be created');
  assert.equal(fs.existsSync(path.join(REPO_TASKS, 'Capture.md')), false);
});

test('the scheduler source guards the startup drain on a resolved vault', () => {
  // A source scan, because the alternative is booting the whole scheduler. The
  // positive control is the `ensureCaptureFile` call itself: if that string
  // ever disappears this test must fail rather than pass by absence.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'scheduler.js'), 'utf-8');
  assert.ok(src.includes('ensureCaptureFile()'), 'positive control — the startup drain still exists');
  const idxGuard = src.indexOf('captureDrain.resolveVault()');
  const idxEnsure = src.indexOf('captureDrain.ensureCaptureFile()');
  assert.ok(idxGuard > -1, 'startup must resolve the vault first');
  assert.ok(idxGuard < idxEnsure, 'the guard must come BEFORE the file is created');
});

// ── And it still works when there IS a vault ────────────────────────────────

test('a real vault still gets its drop-box — the guard costs offline capture nothing', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capture-vault-'));
  const out = runIsolated(`
    const d = require('./services/task-capture-drain');
    const r = d.ensureCaptureFile();
    console.log(JSON.stringify({ r, capturePath: d.capturePath() }));
  `, vault);
  const { r, capturePath } = JSON.parse(out);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(capturePath, path.join(vault, 'Tasks', 'Capture.md'));
  assert.ok(fs.existsSync(path.join(vault, 'Tasks', 'Capture.md')));
  assert.equal(fs.existsSync(path.join(REPO_TASKS, 'Capture.md')), false);
});
