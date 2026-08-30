'use strict';

/**
 * Task exporter — writes the DB out to one read-only vault note.
 *
 * This file is the migration's safety net. NEURO owning tasks means an outage makes
 * them read-only, so the export has to be honest about its own age: the header
 * carries a "last exported" stamp, and anything typed into it will be overwritten
 * on the next run. Capture goes in `Tasks/Capture.md` (drained one-way), never here.
 *
 * Nothing reads tasks back out of this file. It is a copy, not a store — which is
 * the whole point of the migration.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const EXPORT_RELATIVE = 'Tasks/NEURO Tasks (export).md';

const GROUPS = [
  { key: 'must', heading: '🔴 Must' },
  { key: 'should', heading: '🟡 Should' },
  { key: 'could', heading: '🔵 Could' },
  { key: 'wont', heading: '⚪ Won\'t (not now)' },
  { key: null, heading: '❓ Untriaged' },
];

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function exportPath() {
  return path.join(getVaultPath(), 'Tasks', 'NEURO Tasks (export).md');
}

function wikiLink(relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/\.md$/i, '');
  if (!clean) return null;
  return `[[${clean}|${clean.split('/').pop()}]]`;
}

function renderTaskLine(row) {
  const box = row.status === 'done' ? 'x' : row.status === 'in-progress' ? '/' : ' ';
  const bits = [];
  if (row.priority) bits.push(`P${row.priority}`);
  if (row.moscow_proposed) bits.push(`${row.moscow}? (proposed)`);
  if (row.due_date) bits.push(`📅 ${row.due_date}`);
  if (row.source && row.source !== 'manual') bits.push(row.source);
  const link = wikiLink(row.origin_path);
  if (link) bits.push(link);
  // Provenance the importer lifted out of Master Todo's inline <sub> annotations.
  // Always a bit, never loose text — verify() splits the line on the bit separator.
  if (row.notes) bits.push(`<sub>${row.notes}</sub>`);
  const suffix = bits.length ? `  ·  ${bits.join(' · ')}` : '';
  // The id is what makes a line traceable back to the row it came from.
  return `- [${box}] ${row.text}${suffix}  <!--neuro-task:${row.id}-->`;
}

function buildExport(rows, counts, now = new Date()) {
  const stamp = now.toISOString();
  const human = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });

  const lines = [
    '---',
    'type: tasks-export',
    'source: neuro',
    `exported: ${stamp}`,
    'tags: [tasks, neuro, generated]',
    '---',
    '',
    '# NEURO Tasks — export',
    '',
    `> **Generated file. Do not edit.** This is a read-only VIEW of NEURO's task`,
    '> table, so the list stays readable in Obsidian and on the phone when the Pi',
    '> is unreachable. Nothing is ever read back out of this file.',
    '>',
    '> **Where the durable record lives.** Every task captured through NEURO is',
    '> appended to `Tasks/Captured/Task Captures YYYY-MM.md` at the moment it is',
    '> captured, before the task row exists — that log is the vault record and it',
    '> is append-only. The task table is the operational projection of it (status,',
    '> MoSCoW, due dates, Microsoft links), and this file is a projection of that.',
    '> Notes you add to the capture log are safe; edits made HERE are overwritten',
    '> on the next export.',
    '>',
    `> **Last exported: ${human}** — if that looks stale, NEURO is down and this list is`,
    '> behind.',
    '>',
    '> To capture something new offline, put it in [[Tasks/Capture]] — NEURO drains that',
    '> file into the database and clears it. That path survives an outage; this one does not.',
    '',
    `**${counts.open} open** · ${counts.done} done · ${counts.untriaged} awaiting a MoSCoW decision`
      + (counts.proposed ? ` (of which ${counts.proposed} carry a proposed bucket)` : ''),
    '',
  ];

  for (const group of GROUPS) {
    const inGroup = rows.filter(r => (r.moscow || null) === group.key);
    if (!inGroup.length) continue;
    lines.push(`## ${group.heading} (${inGroup.length})`, '');
    // Within a bucket, most pressing first, then soonest due.
    inGroup.sort((a, b) => {
      const pa = a.priority || 0;
      const pb = b.priority || 0;
      if (pa !== pb) return pb - pa;
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      if (a.due_date) return -1;
      if (b.due_date) return 1;
      return a.id - b.id;
    });
    for (const row of inGroup) lines.push(renderTaskLine(row));
    lines.push('');
  }

  if (!rows.length) lines.push('*No open tasks.*', '');

  return lines.join('\n');
}

/** Regenerate the export note. Returns { ok, path, taskCount } . */
function writeExport() {
  const vaultPath = getVaultPath();
  if (!vaultPath || !fs.existsSync(vaultPath)) {
    return { ok: false, error: 'Vault path not configured' };
  }

  const rows = db.listTaskRows({ status: 'all', includeDone: false })
    .filter(r => r.status === 'open' || r.status === 'in-progress');
  const counts = db.countTasks();
  const content = buildExport(rows, counts);

  const target = exportPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');

  // Deliberately NOT calling vault-hooks.onVaultWrite: this file regenerates on
  // every task edit, and re-embedding it each time would churn the index for no
  // gain — and action extraction would read its own output back as candidates.
  console.log(`[Tasks] Exported ${rows.length} open tasks → ${EXPORT_RELATIVE}`);
  return { ok: true, path: EXPORT_RELATIVE, taskCount: rows.length, exportedAt: new Date().toISOString() };
}

/**
 * Verify the export matches the DB exactly — step 2 of the migration, and the
 * check worth re-running any time the export looks wrong. Compares by task id,
 * so a reworded line is caught as a mismatch rather than silently tolerated.
 */
function verifyExport() {
  const target = exportPath();
  if (!fs.existsSync(target)) return { ok: false, error: 'Export file does not exist' };

  const content = fs.readFileSync(target, 'utf-8');
  const fileTasks = new Map();
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[[ x\/]\] (.*?)(?:\s{2}·.*)?\s*<!--neuro-task:(\d+)-->\s*$/);
    if (!match) continue;
    fileTasks.set(Number(match[2]), match[1].trim());
  }

  const rows = db.listTaskRows({ status: 'all', includeDone: false })
    .filter(r => r.status === 'open' || r.status === 'in-progress');
  const dbTasks = new Map(rows.map(r => [r.id, r.text.trim()]));

  const missing = [...dbTasks.keys()].filter(id => !fileTasks.has(id));
  const extra = [...fileTasks.keys()].filter(id => !dbTasks.has(id));
  const mismatched = [...dbTasks.entries()]
    .filter(([id, text]) => fileTasks.has(id) && fileTasks.get(id) !== text)
    .map(([id, text]) => ({ id, db: text, file: fileTasks.get(id) }));

  const exportedAt = (content.match(/^exported:\s*(.+)$/m) || [])[1] || null;

  return {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    dbCount: dbTasks.size,
    fileCount: fileTasks.size,
    missing,
    extra,
    mismatched,
    exportedAt,
    path: EXPORT_RELATIVE,
  };
}

module.exports = {
  EXPORT_RELATIVE,
  buildExport,
  exportPath,
  verifyExport,
  writeExport,
};
