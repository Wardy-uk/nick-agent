#!/usr/bin/env node
'use strict';

/**
 * Propose an origin — commitment or continual improvement — for tasks that have
 * none.
 *
 *   node backend/scripts/backfill-task-origin.js            # show what it would do
 *   node backend/scripts/backfill-task-origin.js --apply    # write the proposals
 *
 * ── Why this is a script and not a migration ─────────────────────────────────
 *
 * The `origin` column is added with no default, deliberately (see
 * shared/task-origin.cjs): there is no value that is true of every existing row,
 * and the answer is counted in a report that goes to the manager assessing
 * Nick's PIP. So the column arrives empty and the guessing is a separate, opt-in
 * pass with a dry run in front of it — the same shape as seed-management-log and
 * migrate-121-booked.
 *
 * ── What it will and will not touch ──────────────────────────────────────────
 *
 *   • Only rows with `origin IS NULL`. A decision Nick has made is never
 *     revisited, and a proposal already standing is not re-proposed.
 *   • Everything it writes is stamped `origin_proposed = 1`, so it shows with a
 *     '?' and the weekly report can say how much of its split is still a guess.
 *   • It classifies nothing it cannot evidence. Most of the Master Todo import
 *     will come out unclassified and that is the correct answer, not a failure —
 *     nothing in the store records who wanted those.
 *
 * Idempotent: running it twice proposes nothing the second time.
 */

const path = require('path');
const db = require(path.join(__dirname, '..', 'db', 'database'));
const { inferOrigin, LABELS } = require(path.join(__dirname, '..', '..', 'shared', 'task-origin.cjs'));

const APPLY = process.argv.includes('--apply');
// Closed tasks are history; classifying them changes no report. `--all` is there
// for the one-off case of wanting the archive labelled too.
const ALL_STATUSES = process.argv.includes('--all');

async function main() {
  // The DB is opened lazily; a script is not the server and nothing else has
  // done this for it.
  await db.init();

  const where = ALL_STATUSES ? '' : " AND status IN ('open','in-progress')";
  const rows = db.all(`SELECT id, text, source, origin_path, ms_source, due_date, status
                       FROM tasks WHERE origin IS NULL${where} ORDER BY id`);

  const proposals = [];
  const untouched = [];
  for (const row of rows) {
    const guess = inferOrigin({
      source: row.source,
      msSource: row.ms_source,
      originPath: row.origin_path,
    });
    if (guess) proposals.push({ row, ...guess });
    else untouched.push(row);
  }

  console.log(`\nUnclassified tasks examined: ${rows.length}`);
  console.log(`  Can be proposed: ${proposals.length}`);
  console.log(`  No evidence — left unclassified: ${untouched.length}\n`);

  const byBasis = new Map();
  for (const p of proposals) {
    const key = `${LABELS[p.origin]} — ${p.basis}`;
    byBasis.set(key, (byBasis.get(key) || 0) + 1);
  }
  for (const [key, n] of byBasis) console.log(`  ${n}× ${key}`);
  console.log('');

  for (const p of proposals.slice(0, 20)) {
    console.log(`  #${p.row.id} → ${p.origin}${p.row.due_date ? ` (due ${p.row.due_date})` : ''}  ${p.row.text.slice(0, 70)}`);
  }
  if (proposals.length > 20) console.log(`  … and ${proposals.length - 20} more`);

  // The rows this cannot answer for are the point of the summary, not a
  // footnote: they are what Nick still has to decide, and the weekly report
  // counts them in their own bucket until he does.
  const overdueUnclassified = untouched.filter(r => r.due_date && r.due_date < todayLocal()).length;
  console.log(`\nStill needing a decision from you: ${untouched.length}${overdueUnclassified ? ` (${overdueUnclassified} of them overdue)` : ''}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.\n');
    return;
  }

  let written = 0;
  for (const p of proposals) {
    db.run('UPDATE tasks SET origin = ?, origin_proposed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND origin IS NULL',
      [p.origin, p.row.id]);
    written++;
  }
  console.log(`\nWrote ${written} proposal(s). All stamped as proposed — confirm or change them on the task row.\n`);
}

function todayLocal(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

main().catch(e => { console.error(e.message); process.exit(1); });
