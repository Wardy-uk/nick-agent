'use strict';

/**
 * One commitment, one line on the People card.
 *
 * The write-back deduped by NOVA id; the task store dedupes by normalised text.
 * Two NOVA sessions on the same day can produce the same commitment with two
 * ids, so the card wrote both lines while Nick's task list folded them into
 * one. Live example: Maria Pappa carries *"Work with the rest of customer care
 * to identify what the twelve customer-facing knowledge base articles should
 * be"* as `nova:17` AND `nova:7` — byte-identical text, same due date, two
 * boxes to tick for one conversation.
 *
 * `nova-121-writeback` now keys new writes through `task-store.dedupeKey`, so
 * this cannot recur. This is the history: the lines already written.
 *
 * ⚠ It removes a LINE from a card. It does not touch NOVA — those records are
 * NOVA's and both stay exactly as they are — and it never edits the surviving
 * line's text, date or id.
 *
 * Rules, all of them the ones this repo already uses for a vault writer:
 *   · DRY RUN by default. `--apply` writes.
 *   · Backs up every file it touches to `Scripts/.lint-backups/<stamp>/`.
 *   · Keeps the FIRST occurrence in file order and drops the later ones, so the
 *     id that has been on the card longest is the one that survives — anything
 *     already referring to it keeps working.
 *   · Idempotent: a second run finds nothing to do.
 *   · A card it cannot read is REPORTED, never skipped in silence.
 *
 * Usage:  node backend/scripts/dedupe-people-card-actions.js [--apply]
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { dedupeKey } = require('../services/task-store');

const APPLY = process.argv.includes('--apply');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || '';
const BACKUP_REL = 'Scripts/.lint-backups';

/** The same stripping the writer's own key uses — owner link, date, id comment. */
function commitmentBody(taskBody) {
  return taskBody
    .replace(/<!--\s*nova:\d+\s*-->/g, ' ')
    .replace(/👤\s*\[\[[^\]]*\]\]/g, ' ')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, ' ');
}

function plan(source) {
  const lines = String(source).split(/\r?\n/);
  const seen = new Map();
  const drop = [];

  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*+]\s*\[([ xX])\]\s+(.*)$/);
    if (!m) return;
    // ⚠ Only ever collapse two UNTICKED lines. A ticked one is a record that
    // the work was done, and removing it would erase evidence rather than a
    // duplicate.
    if (m[1] !== ' ') return;
    const key = dedupeKey(commitmentBody(m[2]));
    if (!key) return;
    const id = (line.match(/<!--\s*nova:(\d+)\s*-->/) || [])[1] || null;
    if (seen.has(key)) {
      drop.push({ index: i, line, key, id, keptId: seen.get(key).id });
    } else {
      seen.set(key, { index: i, id });
    }
  });

  if (!drop.length) return null;
  const dropIdx = new Set(drop.map(d => d.index));
  return { drop, next: lines.filter((_, i) => !dropIdx.has(i)).join('\n') };
}

function main() {
  if (!VAULT || !fs.existsSync(VAULT)) {
    console.error('OBSIDIAN_VAULT_PATH is not set or not readable — refusing to guess a vault.');
    process.exit(1);
  }
  const dir = path.join(VAULT, 'People');
  if (!fs.existsSync(dir)) {
    console.error('No People/ folder in the vault.');
    process.exit(1);
  }

  const stamp = `${new Date().toISOString().slice(0, 10)}-card-dedupe`;
  let touched = 0;
  let removed = 0;
  const unreadable = [];

  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const abs = path.join(dir, file);
    let source;
    try { source = fs.readFileSync(abs, 'utf-8'); } catch (e) {
      unreadable.push(`${file}: ${e.message}`);
      continue;
    }

    const result = plan(source);
    if (!result) continue;

    touched += 1;
    removed += result.drop.length;
    console.log(`\n${file}`);
    for (const d of result.drop) {
      console.log(`  ${APPLY ? 'removed' : 'would remove'} nova:${d.id} (duplicate of nova:${d.keptId})`);
      console.log(`    ${d.line.trim().slice(0, 100)}`);
    }

    if (APPLY) {
      const backupDir = path.join(VAULT, BACKUP_REL, stamp);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(abs, path.join(backupDir, file));
      fs.writeFileSync(abs, result.next, 'utf-8');
    }
  }

  console.log(`\n${APPLY ? 'Removed' : 'Would remove'} ${removed} duplicate line(s) across ${touched} card(s).`);
  if (unreadable.length) {
    console.log(`⚠ ${unreadable.length} card(s) could not be read:`);
    for (const u of unreadable) console.log(`   ${u}`);
  }
  if (!APPLY) console.log('Dry run. Re-run with --apply to write (backs up to Scripts/.lint-backups/).');
}

if (require.main === module) main();

module.exports = { plan, commitmentBody };
