'use strict';

/**
 * One-off migration: pull BOOKED 1-2-1 dates out of `next-1-2-1-due` and into
 * the `1-2-1-booked` field they should always have had.
 *
 * Why: `book()` used to stamp the date of the meeting it had just put in the
 * diary into `next-1-2-1-due`. But the detector writes that same field as "when
 * the next one is OWED" (last held + cadence), and every reader — the nudge, the
 * Team board, chat — read it that way. So a booking made a reminder to make the
 * booking, and turned into "these need booking now" the day after the meeting.
 *
 * How a booking is identified, deterministically and with no calendar lookup:
 * the detector can only ever write `last-1-2-1 + cadence`, so a due date LATER
 * than that could not have come from the detector. On the live vault this is not
 * a close call — Stephen Mitchell's last 1-2-1 was 2026-03-26 (fortnightly, so
 * the detector would write 2026-04-09) against a stored due date of 2026-08-18.
 *
 * Read-only by default like every other vault-touching script here. Pass
 * `--apply` to write; every touched file is backed up first.
 *
 *   node backend/scripts/migrate-121-booked.js
 *   node backend/scripts/migrate-121-booked.js --apply
 */

const fs = require('fs');
const path = require('path');

const VAULT = process.env.OBSIDIAN_VAULT_PATH || 'C:\\Users\\NickW\\Documents\\Nicks knowledge base';
const APPLY = process.argv.includes('--apply');

const CADENCES = [
  { days: 56, match: /bi[-\s]?month|two[-\s]month/i },
  { days: 28, match: /month/i },
  { days: 14, match: /bi[-\s]?week|fortnight|two[-\s]week/i },
  { days: 7, match: /week/i },
];
const DEFAULT_CADENCE_DAYS = 14;

function cadenceDays(cadence) {
  const hit = CADENCES.find(c => c.match.test(String(cadence || '')));
  return hit ? hit.days : DEFAULT_CADENCE_DAYS;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`); // midday: no DST edge on date maths
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Frontmatter values only — vault notes are mixed CRLF/LF, so normalise first.
 * `[^\S\n]` not `\s`: `\s` matches newlines, so an EMPTY field would swallow the
 * line break and return the NEXT line's contents (Adele has a bare
 * `next-1-2-1-due:` followed by `last-contact:`, which read back as the latter).
 */
function readField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[^\\S\\n]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function main() {
  const peopleDir = path.join(VAULT, 'People');
  if (!fs.existsSync(peopleDir)) {
    console.error(`No People/ directory at ${peopleDir}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(VAULT, 'Scripts', '.lint-backups', `121-booked-${stamp}`);
  const results = [];

  for (const file of fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'))) {
    const full = path.join(peopleDir, file);
    const raw = fs.readFileSync(full, 'utf-8');
    const name = file.replace(/\.md$/, '');
    const normalised = raw.replace(/\r\n/g, '\n');
    if (!normalised.startsWith('---')) continue;
    const endIdx = normalised.indexOf('\n---', 3);
    if (endIdx === -1) continue;
    const fm = normalised.slice(0, endIdx);

    if (readField(fm, 'direct-report').toLowerCase() !== 'true') continue;
    if (readField(fm, '1-2-1-booked')) {
      results.push({ name, action: 'already-migrated' });
      continue;
    }

    const due = readField(fm, 'next-1-2-1-due');
    const last = readField(fm, 'last-1-2-1');
    if (!DATE_RE.test(due)) { results.push({ name, action: 'no-due-date' }); continue; }

    if (!DATE_RE.test(last)) {
      // Nothing to measure the due date against, so there is no way to tell a
      // booking from a hand-entered date. Report it rather than guess — writing
      // a booking that doesn't exist would silence a real reminder.
      results.push({ name, action: 'ambiguous-no-last', due });
      continue;
    }

    const detectorWouldWrite = addDays(last, cadenceDays(readField(fm, 'cadence')));
    if (due <= detectorWouldWrite) {
      results.push({ name, action: 'cadence-derived', due, detectorWouldWrite });
      continue;
    }

    // Later than the detector could ever have written it → book() put it there.
    const correctedDue = detectorWouldWrite;
    results.push({ name, action: 'migrated', booked: due, dueWas: due, dueNow: correctedDue });

    if (APPLY) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, file), raw, 'utf-8');

      let out = raw.replace(/^next-1-2-1-due:.*$/m, `next-1-2-1-due: ${correctedDue}`);
      // Sit the booking directly under the due date it was hiding inside.
      out = out.replace(/^(next-1-2-1-due:.*)$/m, `$1\n1-2-1-booked: ${due}`);
      fs.writeFileSync(full, out, 'utf-8');
    }
  }

  const migrated = results.filter(r => r.action === 'migrated');
  for (const r of results) {
    if (r.action === 'migrated') {
      console.log(`  ${r.name}: booked ${r.booked}, due corrected ${r.dueWas} -> ${r.dueNow}`);
    } else if (r.action === 'ambiguous-no-last') {
      console.log(`  ${r.name}: SKIPPED — due ${r.due} but no last-1-2-1 to measure against`);
    }
  }
  console.log(`\n${migrated.length} migrated, ${results.length - migrated.length} untouched (${APPLY ? 'APPLIED' : 'dry run — pass --apply to write'})`);
  if (APPLY && migrated.length) console.log(`Backups: ${backupDir}`);
}

main();
