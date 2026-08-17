#!/usr/bin/env node
'use strict';

/**
 * Backfill meetings-held into the wins ledger.
 *
 * `recordMeetingsHeld` is hooked onto calendar-sync, which fetches FORWARD from
 * today — so it catches each meeting as it finishes (the sync runs every few
 * minutes) but has never seen the ones already held. Without this the ledger
 * looks thin for a week after the source ships, which is the same complaint the
 * source was built to answer: a count that is true and too small reads as "you
 * did almost nothing", exactly like the tickbox it replaced.
 *
 * READ-ONLY against Graph, and deliberately NOT a call to `calendar-sync.sync()`
 * with a wider window. That is how 25 Plaud admin blocks ended up in the real
 * calendar for September: sync() runs plaud-admin-blocks' syncHook, which
 * APPLIES, so widening its window creates events weeks early. This script
 * fetches events and writes nothing but wins rows.
 *
 *   node scripts/backfill-meeting-wins.js            # dry run, prints what it would add
 *   node scripts/backfill-meeting-wins.js --apply    # writes
 *   node scripts/backfill-meeting-wins.js --days 60 --apply
 */

require('dotenv').config();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const days = (() => {
  const i = args.indexOf('--days');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 365 ? n : 30;
})();

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const db = require('../db/database');
  await db.init();

  const microsoft = require('../services/microsoft');
  const wins = require('../services/wins');

  const now = new Date();
  const from = localDateKey(new Date(now.getTime() - days * 86400000));
  const to = localDateKey(now);

  console.log(`[BackfillMeetings] ${APPLY ? 'APPLY' : 'DRY RUN'} — ${from} → ${to}`);

  const me = await microsoft.getSignedInAddress().catch(() => null);
  if (!me) {
    // Fail closed and say so, rather than counting every solo focus block as a
    // meeting. Same rule as plaud-admin-blocks: nothing knowable, nothing counted.
    console.error('[BackfillMeetings] No signed-in address — refusing. Nothing can tell Nick\'s attendee entry from anyone else\'s.');
    process.exit(1);
  }

  const events = await microsoft.fetchCalendarEvents(from, to);
  if (!Array.isArray(events)) {
    // graphFetch returns null on 401 rather than an empty collection, precisely
    // so this reads as "could not ask" and not "you had no meetings".
    console.error('[BackfillMeetings] Calendar unavailable (auth or bridge). Nothing written.');
    process.exit(1);
  }
  console.log(`[BackfillMeetings] ${events.length} event(s) fetched`);

  if (!APPLY) {
    // Asks the recorder's own predicate rather than restating the conditions.
    // The first cut re-listed them here and immediately drifted: it missed the
    // events Outlook CANCELS BY RENAMING, so the dry run promised two meetings
    // that never happened.
    const would = [];
    const skipped = {};
    for (const ev of events) {
      const why = wins.meetingSkipReason(ev, me, now);
      if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
      would.push(`${localDateKey(new Date(ev.end))}  ${String(ev.subject || 'Meeting').slice(0, 60)}`);
    }
    console.log(`[BackfillMeetings] would add ${would.length} meeting win(s)`);
    for (const line of would.slice(0, 25)) console.log('   ', line);
    if (would.length > 25) console.log(`    … and ${would.length - 25} more`);
    console.log('[BackfillMeetings] skipped:', JSON.stringify(skipped));
    console.log('[BackfillMeetings] dry run — nothing written. Re-run with --apply.');
    return;
  }

  const { added, considered } = wins.recordMeetingsHeld(events, { me, now });
  console.log(`[BackfillMeetings] added ${added} of ${considered} qualifying meeting(s)`);

  const s = wins.summary();
  console.log(`[BackfillMeetings] ledger now — today ${s.doneToday}, week ${s.doneThisWeek}, total ${s.total}, streak ${s.streakDays}`);
  console.log('[BackfillMeetings] by source (week):', JSON.stringify(s.bySource));
})().catch((e) => {
  console.error('[BackfillMeetings] Failed:', e.message);
  process.exit(1);
});
