#!/usr/bin/env node
'use strict';

/**
 * Set the 1-2-1 `cadence:` on active direct-report People notes.
 *
 * Nick reset every 1-2-1 across 18-25 Aug 2026 and stated the new rhythm in the room
 * ("ongoing on a monthly basis", "monthly, six weekly, or bi-monthly depending upon
 * different factors"). Every People note still said `fortnightly`, so the board computed
 * due dates a fortnight after each reset and had the whole team due in early September.
 *
 *   node backend/scripts/set-121-cadence.js                  # dry run, changes nothing
 *   node backend/scripts/set-121-cadence.js --apply
 *   node backend/scripts/set-121-cadence.js --cadence six-weekly --only "Abdi Mohamed"
 *
 * ⚠ Rewrites the ONE `cadence:` line by hand rather than reserialising the frontmatter.
 * `updateFrontmatter` is line-based and silently drops YAML block lists — these notes
 * carry `aliases:` blocks, which #38 made load-bearing for name resolution.
 *
 * ⚠ It does NOT touch `next-1-2-1-due`. That is derived at read time by
 * one-to-one-detect.foldDetected(last + cadence), and the stored value is exactly the
 * stale number that made the cards wrong — writing a fresh guess here would put a second
 * copy of a derived fact back on disk. The 22:00 syncPeopleNotes pass owns that field.
 */

const fs = require('fs');
const path = require('path');

const { cadenceDays, CADENCES } = require('../services/one-to-one-detect');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cadence = argValue('--cadence') || 'monthly';
const only = argValue('--only');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// Refuse a cadence the readers do not name, rather than writing a word that silently
// falls through to the 14-day default — the exact failure this script exists to undo.
const known = CADENCES.map((c) => c.value);
if (!known.includes(cadence)) {
  console.error(`Refusing: "${cadence}" is not a cadence NEURO names. Known: ${known.join(', ')}`);
  process.exit(1);
}

const vault = process.env.OBSIDIAN_VAULT_PATH;
if (!vault || !path.isAbsolute(vault)) {
  console.error('Refusing: OBSIDIAN_VAULT_PATH must be set to an absolute path.');
  process.exit(1);
}
const peopleDir = path.join(vault, 'People');
if (!fs.existsSync(peopleDir)) {
  console.error(`Refusing: ${peopleDir} does not exist.`);
  process.exit(1);
}

function field(body, key) {
  const m = body.replace(/\r/g, '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

const rows = [];
for (const file of fs.readdirSync(peopleDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'))) {
  const full = path.join(peopleDir, file);
  const raw = fs.readFileSync(full, 'utf8');
  const name = file.replace(/\.md$/, '');

  if (field(raw, 'direct-report') !== 'true') continue;
  if (field(raw, 'archived') === 'true') continue;
  if (only && name !== only) continue;

  const current = field(raw, 'cadence');
  // "n/a" is a deliberate statement that this person is not on a cadence. Overwriting it
  // would quietly enrol somebody Nick has decided not to schedule.
  if (/^n\/?a$/i.test(current)) {
    rows.push({ name, current, next: current, action: 'skipped (cadence: n/a)' });
    continue;
  }
  if (current === cadence) {
    rows.push({ name, current, next: cadence, action: 'already set' });
    continue;
  }
  if (!/^cadence:/m.test(raw.replace(/\r/g, ''))) {
    rows.push({ name, current: '<none>', next: cadence, action: 'SKIPPED — no cadence line to replace' });
    continue;
  }

  if (apply) {
    const updated = raw.replace(/^cadence:.*$/m, `cadence: ${cadence}`);
    if (updated === raw) {
      rows.push({ name, current, next: cadence, action: 'SKIPPED — replace was a no-op' });
      continue;
    }
    fs.writeFileSync(full, updated);
  }
  rows.push({ name, current, next: cadence, action: apply ? 'updated' : 'would update' });
}

console.log(`${apply ? 'APPLY' : 'DRY RUN'} — cadence -> ${cadence} (${cadenceDays(cadence)} days)\n`);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(22)} ${String(r.current || '-').padEnd(14)} -> ${String(r.next).padEnd(12)} ${r.action}`);
}
const changed = rows.filter((r) => r.action === 'updated' || r.action === 'would update').length;
console.log(`\n${rows.length} active direct reports, ${changed} ${apply ? 'updated' : 'to update'}.`);
if (!apply && changed) console.log('Re-run with --apply to write.');
