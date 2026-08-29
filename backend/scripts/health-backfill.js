'use strict';

/**
 * Fill `health_daily` from the whole of `health_samples`.
 *
 * ⚠ CHUNKED, and that is not an optimisation. `health-daily.sync()` pulls HRV
 * and resting heart rate as RAW rows so the daily figure can be a median, and it
 * caps that read at 20,000 rows. There are 43,334 HRV samples over two years —
 * so a single sync({days: 3650}) would silently take the newest 20,000 and roll
 * up a partial history, with nothing to show it had. Same species as every other
 * silent cap in this codebase: a limit that truncates the answer rather than
 * refusing it.
 *
 * Idempotent — every row is an UPSERT keyed on the day, so running twice changes
 * nothing and a crash halfway through is resumed by running it again.
 *
 *   node backend/scripts/health-backfill.js [--days 800] [--chunk 30]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

async function main() {
  await db.init();
  const healthDaily = require('../services/health-daily');

  const totalDays = arg('days', 800);
  const chunk = arg('chunk', 30);

  // The chunked walk lives in health-daily.syncRange, shared with the nightly
  // wide re-roll — the alternative is chunking logic in this script that the
  // scheduler cannot reuse, which is how the two come to disagree about a rule
  // (bounded windows) that only matters when it is applied consistently.
  const { written, gaps: allGaps } = healthDaily.syncRange({ days: totalDays, chunk });

  const rows = db.getHealthDays(5000);
  const withSleep = rows.filter(r => r.asleep_hours != null).length;
  const withHrv = rows.filter(r => r.hrv_median != null).length;

  console.log(`\nhealth_daily now holds ${rows.length} days`);
  console.log(`  oldest ${rows[rows.length - 1]?.day}  newest ${rows[0]?.day}`);
  console.log(`  ${withSleep} with sleep, ${withHrv} with HRV`);
  if (allGaps.length) {
    console.log(`\n⚠ ${allGaps.length} gap(s) — these are days that could NOT be read, not days with nothing in them:`);
    for (const g of allGaps.slice(0, 20)) console.log(`  ${g.input}: ${g.why}`);
  }
}

main().catch((e) => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
