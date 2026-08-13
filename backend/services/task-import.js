'use strict';

/**
 * One-time importer: seeds the `tasks` table from the vault.
 *
 * Step 1 of the source-of-truth migration. `Master Todo.md` supplies the tasks;
 * the two triage worksheets supply the metadata that had nowhere to live:
 *   - `Tasks/MoSCoW - Open Actions 2026-08-12.md`  → MoSCoW bucket
 *   - `Tasks/MUST - Prioritise 1-3.md`             → priority 1-3
 *   - `task_moscow` table                          → earlier in-app ratings (fallback)
 *
 * Only Master Todo lines become tasks. The MoSCoW worksheet also lists Jira tickets,
 * MS Planner items and flagged emails — those have their own systems of record and
 * importing them would make NEURO source #2 for someone else's data. They are counted
 * and reported instead, so what was left out is visible rather than silent.
 *
 * Idempotent: dedupe_key is UNIQUE, so re-running updates rather than duplicating.
 * Safe to dry-run first — and it is dry by default.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const obsidian = require('./obsidian');
const taskStore = require('./task-store');

const MOSCOW_FILE = 'MoSCoW - Open Actions 2026-08-12.md';
const PRIORITY_FILE = 'MUST - Prioritise 1-3.md';
const MASTER_FILE = 'Master Todo.md';

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function tasksDir() {
  return path.join(vaultPath(), 'Tasks');
}

/** Split a markdown table row into trimmed cells, or null if it isn't one. */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  if (cells.length < 3) return null;
  // Separator rows (---, :--:) and the header row itself carry no data.
  if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) return null;
  return cells;
}

// A trailing `?` in the worksheet means the bucket was inferred, not decided —
// the file says so itself. Those import as proposals so the review queue still asks.
function parseMoscowCell(value) {
  const raw = String(value || '').trim();
  const proposed = raw.includes('?');
  // `MUST***` is Nick's own emphasis for the three he flagged himself, so the cell has
  // to be read past the decoration — not just past the `?`.
  const cleaned = raw.replace(/[?*_\s]/g, '').toLowerCase();
  if (cleaned === 'must') return { moscow: 'must', proposed };
  if (cleaned === 'should') return { moscow: 'should', proposed };
  if (cleaned === 'could') return { moscow: 'could', proposed };
  if (cleaned === "won't" || cleaned === 'wont') return { moscow: 'wont', proposed };
  if (cleaned === 'done') return { done: true };
  return {};
}

/**
 * Read both worksheets into one lookup: normalised text → { moscow, priority, due, done }.
 * Keyed on both the full normalised text and the 80-char dedupe key, because the
 * worksheets and the vault sometimes disagree about a trailing clause.
 */
function buildMetadataIndex() {
  const index = new Map();
  const stats = { moscowRows: 0, priorityRows: 0, doneRows: 0, nonMasterRows: {} };

  const put = (text, patch) => {
    if (!text) return;
    for (const key of [taskStore.normalizeText(text), taskStore.dedupeKey(text)]) {
      if (!key) continue;
      index.set(key, { ...(index.get(key) || {}), ...patch });
    }
  };

  // MoSCoW worksheet: | # | Task | Source | Due | MoSCoW |
  const moscowPath = path.join(tasksDir(), MOSCOW_FILE);
  if (fs.existsSync(moscowPath)) {
    for (const line of fs.readFileSync(moscowPath, 'utf-8').split('\n')) {
      const cells = tableCells(line);
      if (!cells || cells.length < 5) continue;
      if (!/^\d+$/.test(cells[0])) continue;
      const [, text, source, due, bucket] = cells;
      const parsed = parseMoscowCell(bucket);
      if (parsed.done) stats.doneRows++;
      stats.moscowRows++;
      // Which sources the worksheet covers that this import deliberately skips.
      const sourceLabel = (source || '').split('·')[0].trim() || 'unknown';
      if (!/^master todo/i.test(sourceLabel)) {
        stats.nonMasterRows[sourceLabel] = (stats.nonMasterRows[sourceLabel] || 0) + 1;
      }
      if (parsed.proposed) stats.proposedRows = (stats.proposedRows || 0) + 1;
      put(text, {
        ...(parsed.moscow ? { moscow: parsed.moscow, proposed: parsed.proposed } : {}),
        ...(parsed.done ? { done: true } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(due) ? { due } : {}),
      });
    }
  }

  // Priority worksheet: | Priority | Task | Source | Due |
  const priorityPath = path.join(tasksDir(), PRIORITY_FILE);
  if (fs.existsSync(priorityPath)) {
    for (const line of fs.readFileSync(priorityPath, 'utf-8').split('\n')) {
      const cells = tableCells(line);
      if (!cells || cells.length < 3) continue;
      const priority = Number(cells[0]);
      if (![1, 2, 3].includes(priority)) continue;
      stats.priorityRows++;
      // Everything in this file was already triaged MUST — carry that across, since
      // a priority with no bucket would land the task back in the untriaged pile.
      // This file only exists because Nick sat down and prioritised it, so MUST here
      // is a decision, not a guess — it clears any `?` the other worksheet proposed.
      put(cells[1], { priority, moscow: 'must', proposed: false });
    }
  }

  // Legacy in-app ratings — lowest precedence, applied only where the worksheets
  // are silent. task_text is the first 200 chars, which normalises fine.
  let legacyRows = 0;
  try {
    for (const row of db.getAllTaskMoscow()) {
      if (!row.task_text) continue;
      const key = taskStore.dedupeKey(row.task_text);
      if (!key || index.has(key)) continue;
      index.set(key, { moscow: row.moscow });
      legacyRows++;
    }
  } catch (e) {
    console.warn('[TaskImport] Could not read legacy task_moscow:', e.message);
  }
  stats.legacyRows = legacyRows;

  return { index, stats };
}

/**
 * Master Todo lines carry their history inline: `task text <sub>rescued from New ToDos
 * (archive)</sub>` or `<sub>2026-08-11 · Lomond / TPFG review</sub>`. That is provenance,
 * not part of the task, and keeping it in the text is what stopped 85 of 130 lines
 * matching their worksheet row. Split it off and keep it as a note.
 */
function splitProvenance(text) {
  const notes = [];
  const clean = String(text || '')
    .replace(/<(sub|small)>([\s\S]*?)<\/\1>/gi, (_, __, inner) => { notes.push(inner.trim()); return ' '; })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: clean, note: notes.filter(Boolean).join(' · ') || null };
}

/** Master Todo checkbox lines, as parsed by the existing vault parser. */
function readMasterTodo() {
  const masterPath = path.join(tasksDir(), MASTER_FILE);
  if (!fs.existsSync(masterPath)) return { tasks: [], masterPath: null };
  const { active, done } = obsidian.parseVaultTodos({ dbTasks: false });
  const isMaster = t => t.filePath === masterPath;
  return {
    masterPath,
    tasks: [...active.filter(isMaster), ...done.filter(isMaster)],
  };
}

/**
 * Seed the tasks table.
 * @param {{ dryRun?: boolean, includeDone?: boolean }} options — dryRun defaults to TRUE.
 */
function importFromVault(options = {}) {
  const dryRun = options.dryRun !== false;
  const includeDone = options.includeDone === true;

  if (!vaultPath() || !fs.existsSync(vaultPath())) {
    return { ok: false, error: 'Vault path not configured' };
  }

  const { index, stats } = buildMetadataIndex();
  const { tasks, masterPath } = readMasterTodo();
  if (!masterPath) return { ok: false, error: `${MASTER_FILE} not found` };

  const result = {
    ok: true,
    dryRun,
    masterTodoLines: tasks.length,
    openLines: tasks.filter(t => t.status !== 'done').length,
    doneLines: tasks.filter(t => t.status === 'done').length,
    created: 0,
    updated: 0,
    skippedDone: 0,
    withMoscow: 0,
    withProposedMoscow: 0,
    withPriority: 0,
    unmatched: [],
    worksheets: stats,
  };

  const relativeMaster = path.relative(vaultPath(), masterPath).replace(/\\/g, '/');

  const apply = () => {
    for (const task of tasks) {
      const isDone = task.status === 'done';
      if (isDone && !includeDone) { result.skippedDone++; continue; }

      const { text: cleanText, note } = splitProvenance(task.text);
      if (!cleanText) continue;

      const key = taskStore.dedupeKey(cleanText);
      const meta = index.get(taskStore.normalizeText(cleanText)) || index.get(key) || null;
      if (!meta) result.unmatched.push(cleanText.slice(0, 90));

      // The worksheet knowing an item is done beats an unticked vault checkbox —
      // that is exactly the triage Nick did on 12 Aug.
      const status = isDone || meta?.done ? 'done' : task.status === 'in-progress' ? 'in-progress' : 'open';
      if (status === 'done' && !includeDone) { result.skippedDone++; continue; }

      if (meta?.moscow) result.withMoscow++;
      if (meta?.moscow && meta.proposed) result.withProposedMoscow++;
      if (meta?.priority) result.withPriority++;

      const payload = {
        text: cleanText,
        notes: note,
        status,
        moscow: meta?.moscow || null,
        moscowProposed: Boolean(meta?.moscow && meta.proposed),
        priority: meta?.priority || null,
        due_date: task.due_date || meta?.due || null,
        source: 'master-todo-import',
        origin_path: task.meta?.sourcePath || relativeMaster,
        origin_line: task.lineNumber == null ? null : task.lineNumber,
        context: task.context || null,
        ms_id: task.ms_id || null,
        skipExport: true,
      };

      if (dryRun) {
        const existing = db.getTaskByDedupeKey(key);
        if (existing) result.updated++; else result.created++;
        continue;
      }

      const { created } = taskStore.createTask(payload);
      if (created) result.created++; else result.updated++;
    }
  };

  if (dryRun) apply();
  else db.batchSaves(apply);

  result.unmatchedCount = result.unmatched.length;
  result.unmatched = result.unmatched.slice(0, 15);

  if (!dryRun) {
    const exported = require('./task-export').writeExport();
    result.export = exported;
    result.verify = require('./task-export').verifyExport();
  }
  result.dbCounts = db.countTasks();

  console.log(`[TaskImport] ${dryRun ? 'DRY RUN' : 'APPLIED'} — ${result.created} new, ${result.updated} existing, ${result.skippedDone} done skipped, ${result.withMoscow} with MoSCoW (${result.withProposedMoscow} proposed, not decided), ${result.withPriority} with priority`);
  return result;
}

module.exports = {
  buildMetadataIndex,
  splitProvenance,
  importFromVault,
  readMasterTodo,
};
