'use strict';

/**
 * Route 3 — the Obsidian capture drop-box.
 *
 * `Tasks/Capture.md` is a DROP-BOX, NOT A STORE. NEURO reads it, creates the tasks,
 * and clears the line. If lines were left to linger it would quietly become a second
 * source of truth and we would be back to the three-places mess the migration fixed.
 *
 * Being one-way is also why capture keeps working while the Pi is down: type into the
 * file offline, and it drains on the next sync. That is the counterweight to tasks
 * being read-only during an outage.
 *
 * Deliberately named `Capture.md`, not `New ToDos.md` — an old file by that name still
 * exists in `Tasks/Archive/` and the drain must never be able to pick it up.
 */

const fs = require('fs');
const path = require('path');
const taskStore = require('./task-store');

const CAPTURE_RELATIVE = 'Tasks/Capture.md';
const LOG_RELATIVE = 'Tasks/Archive/Capture drain log.md';

// A file written seconds ago may be mid-edit in Obsidian or mid-write from
// Syncthing. Leave it for the next pass rather than draining half a thought.
const SETTLE_MS = 20000;

const TEMPLATE = `---
type: tasks-capture
source: obsidian
---

# Capture

> **Drop-box, not a list.** Write one task per line under Inbox. NEURO takes them into
> its task list and clears this file — normally within 10 minutes. Nothing stays here.
>
> This is the path that works while the Pi is down: type it now, it drains on the next sync.
> The full task list lives in [[Tasks/NEURO Tasks (export)]] (read-only) and in NEURO itself.
>
> Optional inline hints: \`!must\` \`!should\` \`!could\` \`!wont\` · \`p1\` \`p2\` \`p3\` (3 = most pressing) · \`@2026-08-20\` for a due date.

## Inbox

`;

/**
 * Where the vault is, and whether we can honestly say we have one.
 *
 * ⚠ `path.join('', 'Tasks', 'Capture.md')` is `Tasks/Capture.md` — a RELATIVE
 * path, which resolves against the backend process's working directory. So an
 * unset `OBSIDIAN_VAULT_PATH` did not fail: it quietly created
 * `backend/Tasks/Capture.md` inside the repository, reported success, and
 * drained into it forever. A capture written in Obsidian went to a file NEURO
 * was not reading, and a capture NEURO wrote went to a file Obsidian could not
 * see — the drop-box working perfectly against nothing.
 *
 * Nothing here builds a path until the vault has been resolved.
 */
function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

/**
 * Resolve the vault, or say precisely why not. PURE apart from the stat.
 * Returns `{ok:true, path}` or `{ok:false, reason, error}`.
 */
function resolveVault() {
  const raw = getVaultPath().trim();
  if (!raw) {
    return { ok: false, reason: 'not-configured', error: 'OBSIDIAN_VAULT_PATH is not set' };
  }
  // An absolute path is the only kind that cannot be re-rooted at the process
  // working directory by accident.
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: 'not-absolute', error: `OBSIDIAN_VAULT_PATH is not an absolute path: ${raw}` };
  }
  let stat;
  try { stat = fs.statSync(raw); }
  catch (e) { return { ok: false, reason: 'unreadable', error: `Vault path is not readable: ${e.message}` }; }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not-a-directory', error: `Vault path is not a directory: ${raw}` };
  }
  return { ok: true, path: raw };
}

/** True when a real, readable vault directory is configured. */
function vaultConfigured() {
  return resolveVault().ok;
}

/**
 * The capture drop-box, or NULL when there is no vault.
 *
 * ⚠ Null, never a repo-relative fallback. A caller that cannot tell "no vault"
 * from "a path" will write into the repository, which is the bug this fixes.
 */
function capturePath() {
  const vault = resolveVault();
  return vault.ok ? path.join(vault.path, 'Tasks', 'Capture.md') : null;
}

/** The drain audit log, or NULL when there is no vault. Same rule. */
function logPath() {
  const vault = resolveVault();
  return vault.ok ? path.join(vault.path, 'Tasks', 'Archive', 'Capture drain log.md') : null;
}

/**
 * Create the capture file with its template if it isn't there yet.
 *
 * Returns `{ok, created, path}` on success, or `{ok:false, reason, error}` —
 * a structured refusal a caller can log without throwing. It never throws on a
 * missing vault, because the only sane response to one is a warning, and a
 * startup path that dies here takes the whole scheduler with it.
 */
function ensureCaptureFile() {
  const vault = resolveVault();
  if (!vault.ok) {
    return { ok: false, created: false, path: null, reason: vault.reason, error: vault.error };
  }
  const target = path.join(vault.path, 'Tasks', 'Capture.md');
  try {
    if (fs.existsSync(target)) return { ok: true, created: false, path: CAPTURE_RELATIVE };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, TEMPLATE, 'utf-8');
    return { ok: true, created: true, path: CAPTURE_RELATIVE };
  } catch (e) {
    return { ok: false, created: false, path: null, reason: 'write-failed', error: e.message };
  }
}

/**
 * Pull the inline hints out of a captured line.
 * Returns { text, moscow, priority, due } with the hints stripped from text.
 */
function parseCaptureLine(raw) {
  let text = raw;
  let moscow = null;
  let priority = null;
  let due = null;

  text = text.replace(/(?:^|\s)!(must|should|could|wont)\b/i, (_, m) => { moscow = m.toLowerCase(); return ' '; });
  text = text.replace(/(?:^|\s)p([1-3])\b/i, (_, p) => { priority = Number(p); return ' '; });
  text = text.replace(/(?:^|\s)@(\d{4}-\d{2}-\d{2})\b/, (_, d) => { due = d; return ' '; });
  // A bare date is a due date too — that is how Nick writes them in the vault.
  if (!due) {
    text = text.replace(/(?:^|\s)(?:📅\s*|due::)?(\d{4}-\d{2}-\d{2})\b/, (_, d) => { due = d; return ' '; });
  }

  text = text.replace(/\s{2,}/g, ' ').trim();
  return { text, moscow, priority, due };
}

/** Lines that are structure, not capture. */
function isStructuralLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('#')) return true;
  if (t.startsWith('>')) return true;
  if (t === '---') return true;
  if (/^\*.*\*$/.test(t)) return true;   // italic note to self
  return false;
}

function appendDrainLog(entries) {
  if (!entries.length) return;
  const target = logPath();
  if (!target) return;   // no vault — nothing to audit into, and never into the repo
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const header = fs.existsSync(target)
    ? ''
    : `---\ntype: log\ntags: [tasks, generated]\n---\n\n# Capture drain log\n\n*Audit trail of lines NEURO took out of [[Tasks/Capture]]. Not a task list — the entries\ndeliberately carry no checkboxes so nothing can ever parse them back into tasks.*\n\n`;
  const stamp = new Date().toISOString();
  const body = entries.map(e => `${stamp} — task #${e.id}${e.created ? '' : ' (folded into existing)'} — ${e.text}`).join('\n');
  fs.appendFileSync(target, `${header}${body}\n`, 'utf-8');
}

/**
 * Drain the capture file into the task store and clear it.
 * @param {{ dryRun?: boolean, force?: boolean }} options
 */
function drainCaptureFile(options = {}) {
  const dryRun = options.dryRun === true;

  const vault = resolveVault();
  if (!vault.ok) {
    return { ok: false, reason: vault.reason, error: vault.error };
  }
  const target = path.join(vault.path, 'Tasks', 'Capture.md');

  if (!fs.existsSync(target)) {
    const ensured = ensureCaptureFile();
    if (!ensured.ok) return { ok: false, reason: ensured.reason, error: ensured.error };
    return { ok: true, drained: 0, created: 0, note: 'Capture file created' };
  }

  const stats = fs.statSync(target);
  if (!options.force && Date.now() - stats.mtimeMs < SETTLE_MS) {
    return { ok: true, drained: 0, created: 0, note: 'File touched moments ago — left to settle' };
  }

  const content = fs.readFileSync(target, 'utf-8');
  const body = content.replace(/^---[\s\S]*?---\n*/, '');

  const captured = [];
  for (const line of body.split('\n')) {
    if (isStructuralLine(line)) continue;
    // Anything already ticked was completed in the file rather than captured —
    // drop it rather than creating a task that is already done.
    if (/^\s*-\s*\[x\]/i.test(line)) continue;
    const stripped = line.replace(/^\s*(?:-\s*\[[ \/>]\]|[-*+])\s*/, '').trim();
    if (!stripped) continue;
    captured.push(stripped);
  }

  const result = { ok: true, dryRun, drained: captured.length, created: 0, folded: 0, tasks: [] };
  if (!captured.length) return result;

  const entries = [];
  for (const raw of captured) {
    const parsed = parseCaptureLine(raw);
    if (!parsed.text) continue;
    if (dryRun) {
      result.tasks.push({ text: parsed.text, ...parsed });
      continue;
    }
    const { id, created } = taskStore.createTask({
      text: parsed.text,
      moscow: parsed.moscow,
      priority: parsed.priority,
      due_date: parsed.due,
      source: 'obsidian-capture',
      origin_path: CAPTURE_RELATIVE,
      skipExport: true,
    });
    if (created) result.created++; else result.folded++;
    entries.push({ id, created, text: parsed.text });
    result.tasks.push({ id, created, text: parsed.text });
  }

  if (dryRun) return result;

  // Clear the line — this is the bit that stops the file becoming a store.
  fs.writeFileSync(target, TEMPLATE, 'utf-8');
  appendDrainLog(entries);
  taskStore.scheduleExport(500);

  console.log(`[TaskCapture] Drained ${result.drained} line(s): ${result.created} new, ${result.folded} folded into existing`);
  return result;
}

module.exports = {
  CAPTURE_RELATIVE,
  capturePath,
  logPath,
  resolveVault,
  vaultConfigured,
  drainCaptureFile,
  ensureCaptureFile,
  parseCaptureLine,
  TEMPLATE,
};
