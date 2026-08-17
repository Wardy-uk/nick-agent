'use strict';

/**
 * One-off cleanup for the duplicate Plaud admin blocks created on 17 Aug 2026,
 * before plaud-admin-blocks took a run lock. The scheduler's calendar-sync pass
 * overlapped a manual apply, both planned against an empty ledger, and 27 blocks
 * were created twice — 52 on the calendar.
 *
 * Safety, in order of how much it matters:
 *   - dry run by DEFAULT; --apply is required to delete anything.
 *   - only events whose subject starts with the admin-block prefix are ever
 *     considered. A real meeting is never a candidate.
 *   - a block is deleted ONLY when another block survives at the identical
 *     start + subject. A group of one is reported and left alone, so the worst
 *     case is that this script does nothing.
 *   - within a group the survivor is the one the ledger recorded, so the ledger
 *     keeps pointing at a live event.
 *
 * Usage (on the Pi):
 *   node backend/scripts/dedupe-plaud-admin-blocks.js            # dry run
 *   node backend/scripts/dedupe-plaud-admin-blocks.js --apply
 */

require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const DAYS = 30;

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const db = require('../db/database');
  await db.init();

  const microsoft = require('../services/microsoft');
  const service = require('../services/plaud-admin-blocks');
  const PREFIX = service._internals.SUBJECT_PREFIX;

  const now = new Date();
  const from = dateStr(now);
  const to = dateStr(new Date(now.getTime() + DAYS * 86400000));

  const events = await microsoft.fetchCalendarEvents(from, to);
  if (!Array.isArray(events)) {
    console.error('No calendar returned — refusing to guess. Nothing done.');
    process.exit(1);
  }

  const blocks = events.filter(e => String(e.subject || '').startsWith(PREFIX));
  console.log(`${events.length} events ${from} → ${to}; ${blocks.length} admin block(s).`);

  const ledgerIds = new Set(
    Object.values(readLedger(db)).map(e => e && e.blockId).filter(Boolean)
  );

  // Group on DATE + SUBJECT, not on the exact start time.
  //
  // The first cut keyed on the slot and missed half the mess. The two competing
  // passes did not produce identical events: the second fetched the calendar
  // after the first had already created some blocks, saw them as busy, and
  // placed its copies in the NEXT free slot. So the duplicates sit minutes
  // apart — 11:45 and 11:55 for the same standup — and a slot key cannot see
  // them. The duplicate unit is the MEETING, and the block's own subject
  // carries the meeting title.
  const groups = new Map();
  for (const b of blocks) {
    const key = `${String(b.start).slice(0, 10)}|${b.subject}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const doomed = [];
  let singles = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) { singles++; continue; }
    const keeper = group.find(b => ledgerIds.has(b.id)) || group[0];
    for (const b of group) {
      if (b.id !== keeper.id) doomed.push({ ...b, key, start: b.start });
    }
  }

  // Independent cross-check. The ledger records exactly the blocks NEURO
  // believes it created, so anything not in it is by definition surplus. If
  // the two methods disagree, the grouping is wrong and this must not delete —
  // the whole risk here is removing a block that was the real one.
  const orphans = blocks.filter(b => !ledgerIds.has(b.id));
  const doomedIds = new Set(doomed.map(d => d.id));
  const agree = orphans.length === doomed.length && orphans.every(o => doomedIds.has(o.id));
  console.log(`Cross-check — ledger orphans: ${orphans.length}, grouped duplicates: ${doomed.length} → ${agree ? 'agree' : 'DISAGREE'}`);
  if (!agree) {
    console.error('The two methods disagree. Refusing to delete anything — investigate by hand.');
    process.exit(1);
  }

  console.log(`${groups.size} distinct slot(s): ${singles} clean, ${groups.size - singles} duplicated.`);
  console.log(`${doomed.length} block(s) to delete.\n`);
  for (const d of doomed) console.log(`   - ${String(d.start).slice(0, 16).replace('T', ' ')}  ${d.subject}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply.');
    process.exit(0);
  }

  let deleted = 0;
  const failed = [];
  for (const d of doomed) {
    const result = await microsoft.deleteCalendarEvent(d.id);
    if (result.deleted) deleted++;
    else failed.push({ key: d.key, reason: result.reason });
  }

  console.log(`\nDeleted ${deleted}/${doomed.length}.`);
  for (const f of failed) console.log(`   FAILED ${f.key}: ${f.reason}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error('Cleanup failed:', e.message);
  process.exit(1);
});

function readLedger(db) {
  try {
    const raw = db.getState('plaud_admin_blocks');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
