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

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function capturePath() {
  return path.join(getVaultPath(), 'Tasks', 'Capture.md');
}

function logPath() {
  return path.join(getVaultPath(), 'Tasks', 'Archive', 'Capture drain log.md');
}

/** Create the capture file with its template if it isn't there yet. */
function ensureCaptureFile() {
  const target = capturePath();
  if (fs.existsSync(target)) return { created: false, path: CAPTURE_RELATIVE };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, TEMPLATE, 'utf-8');
  return { created: true, path: CAPTURE_RELATIVE };
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
  const target = capturePath();

  if (!getVaultPath() || !fs.existsSync(getVaultPath())) {
    return { ok: false, error: 'Vault path not configured' };
  }
  if (!fs.existsSync(target)) {
    ensureCaptureFile();
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
  drainCaptureFile,
  ensureCaptureFile,
  parseCaptureLine,
  TEMPLATE,
};
