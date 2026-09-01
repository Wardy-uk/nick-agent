'use strict';

/**
 * Action Items service — finds open/closed action items across the vault.
 *
 * Scans Meetings/** and Tasks/Master Todo.md for `- [ ]` / `- [x]` lines,
 * optionally filtered by person (matches via `👤 [[People/Name|...]]` marker
 * or by person name substring).
 */

const fs = require('fs');
const path = require('path');
const vaultExclusions = require('./vault-exclusions');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function walkDir(dir, maxDepth = 3, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, maxDepth, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parseActionLine(line, file, lineNumber) {
  const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
  if (!m) return null;
  const done = m[1].toLowerCase() === 'x';
  let text = m[2];

  // Extract assignee via 👤 [[People/Name|Display]] marker
  const assigneeMatch = text.match(/👤\s*\[\[People\/([^|\]]+)(?:\|([^\]]+))?\]\]/);
  const assignee = assigneeMatch ? (assigneeMatch[2] || assigneeMatch[1]).trim() : null;

  // Extract due date via 📅 YYYY-MM-DD
  const dueMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const dueDate = dueMatch ? dueMatch[1] : null;

  // Strip markers for clean text
  const cleanText = text
    .replace(/👤\s*\[\[[^\]]+\]\]/g, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .trim();

  return { file, lineNumber, text: cleanText, rawText: text, done, assignee, dueDate };
}

function matchesPerson(action, fileContent, personName) {
  if (!personName) return true;
  const first = personName.split(' ')[0].toLowerCase();
  const full = personName.toLowerCase();

  // Strong: explicit 👤 assignee match
  if (action.assignee) {
    const al = action.assignee.toLowerCase();
    if (al === full || al.includes(first)) return true;
  }

  // Weak: action text mentions person name
  const textLower = action.text.toLowerCase();
  if (textLower.includes(full) || textLower.includes(first)) return true;

  return false;
}

function fileIsRecent(filePath, daysBack) {
  if (!daysBack) return true;
  const base = path.basename(filePath);
  const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) {
    // No date in filename — use mtime
    try {
      const stat = fs.statSync(filePath);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      return ageDays <= daysBack;
    } catch { return true; }
  }
  const fileDate = new Date(m[1]);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  return fileDate >= cutoff;
}

/**
 * Find action items in the vault.
 * @param {object} opts
 * @param {string=} opts.person  Filter to actions assigned to or mentioning this person
 * @param {('open'|'done'|'all')=} opts.status  Default 'open'
 * @param {number=} opts.daysBack  Default 90 — only scan meetings within this window
 * @returns {Array<object>}
 */
function findActionItems({ person, status = 'open', daysBack = 90 } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) return [];

  const targetDirs = [
    path.join(vault, 'Meetings'),
    path.join(vault, 'Tasks'),
    path.join(vault, 'Documents', 'HR'),
    // People cards carry the commitments made in NOVA 1-2-1s, written back by
    // nova-121-writeback. Without this they were parseable but unreachable — the whole
    // point of writing them in Obsidian task syntax is that this finds them. Safe to add:
    // People notes carried no checkboxes at all before that job existed.
    path.join(vault, 'People'),
  ];

  const results = [];

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = walkDir(dir, 4);
    for (const file of files) {
      const rel = path.relative(vault, file).replace(/\\/g, '/');

      // ⚠ The one exclude list, applied here too — it was not, and the
      // consequence was that this endpoint's numbers meant nothing.
      //
      // Measured on the live vault, 1 Sep 2026: 3,218 open action items, of
      // which 307 carried a past due date. Only 84 of those were real. The
      // rest were:
      //
      //   1,055 rows from Tasks/Archive — files DELIBERATELY retired (the
      //         Master Todo and the eleven superseded MoSCoW worksheets,
      //         archived in #46/#27 precisely so nothing would read them).
      //     233 rows from "NEURO Tasks (export).md" and a Syncthing conflict
      //         copy of it — a read-only MIRROR of the tasks table, so every
      //         task was counted a second and third time as though it were a
      //         separate commitment.
      //    ~128 rows from FIVE .sync-conflict- copies of the Microsoft
      //         mirror, counting the same twenty-odd tasks five times over.
      //
      // fileIsRecent could not save it: Syncthing rewrites mtimes, so a note
      // retired in July looks like it was touched this morning. And nothing
      // downstream could tell — a consumer asking "how many commitments are
      // past their date" got a plausible number four times too big, which is
      // the shape this codebase keeps meeting (the stale Jira cache; the
      // MoSCoW worksheets still holding 36 entity rows after retirement).
      // VANTAGE was reporting the 307 to Nick as broken promises.
      if (vaultExclusions.isExcludedPath(rel)) continue;

      if (!fileIsRecent(file, daysBack)) continue;
      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const action = parseActionLine(lines[i], rel, i + 1);
        if (!action) continue;

        if (status === 'open' && action.done) continue;
        if (status === 'done' && !action.done) continue;

        if (!matchesPerson(action, content, person)) continue;

        results.push(action);
      }
    }
  }

  // Sort: open+overdue first, then by due date ascending, then by file date descending
  results.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.file.localeCompare(a.file);
  });

  return results;
}

// `parseActionLine` is exported so nova-121-writeback can prove, in a test, that the
// lines it writes into People cards are actually readable by this parser. The two are a
// contract — writer and reader of the same syntax — and it was only checked by eye.
module.exports = { findActionItems, _internals: { parseActionLine } };
