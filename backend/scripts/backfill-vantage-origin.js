#!/usr/bin/env node
'use strict';

/**
 * Stamp the origin VANTAGE now sends onto the rows written before it sent one.
 *
 *   node backend/scripts/backfill-vantage-origin.js           # show what it would do
 *   node backend/scripts/backfill-vantage-origin.js --apply   # write it
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Both routes a VANTAGE finding can take into the task store now set an explicit
 * `origin: 'commitment'` — `vantage/backend/services/neuro.js:createTask` on the
 * direct path, and `suggestion-engine`'s `vantage_suggestion` case on the
 * approval path. That was fixed in VANTAGE `c7aa030`, which did not reach the Pi
 * until 3 Sep 2026. Rows written by the previously deployed code carry no origin
 * at all — the same gap that was fixed for `nova-121`, just on a writer nobody
 * had come back to.
 *
 * So this is a DATA-only fix. It does not change behaviour and it is not a
 * migration: new rows have been correct since the deploy.
 *
 * ── What it will and will not touch ──────────────────────────────────────────
 *
 *   • Only VANTAGE sources, and only where `origin` is missing. A decision
 *     already recorded is never revisited.
 *   • `origin_proposed = 0`, NOT 1. This is not a guess: it is the value the
 *     writer would have sent, and NEURO's contract is that an origin supplied by
 *     the sending system is stored as a DECISION rather than a proposal — no
 *     trailing '?'. Stamping it as a guess would understate the commitment
 *     figure in the weekly report, which is the number that goes to Chris.
 *   • ⚠ `updated_at` is deliberately NOT touched. Correcting provenance is not
 *     an edit to the task, and churning the timestamp would drag these rows into
 *     every "recently modified" scan — the #78 lesson.
 *
 * ⚠ It REFUSES if any unstamped row was created after the writer fix was
 * deployed, because that would mean the writer is still wrong and a backfill
 * would paper over it rather than surface it.
 *
 * Idempotent: running it twice writes nothing the second time.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');

const APPLY = process.argv.includes('--apply');
const VANTAGE_SOURCES = ['vantage-finding', 'vantage-plan', 'vantage'];
// When the fixed VANTAGE writer reached the Pi. Anything unstamped after this
// is a live bug, not history.
const WRITER_FIXED_AT = process.env.VANTAGE_WRITER_FIXED_AT || '2026-09-03 11:12:00';

async function main() {
  await db.init();

  const marks = VANTAGE_SOURCES.map(() => '?').join(',');
  const all = db.all(
    `SELECT id, source, origin, origin_proposed, status, created_at, text
       FROM tasks WHERE source IN (${marks}) ORDER BY id`,
    VANTAGE_SOURCES,
  );

  console.log(`VANTAGE-sourced tasks: ${all.length}`);
  for (const r of all) {
    console.log(`  #${r.id} [${r.source}] origin=${JSON.stringify(r.origin)} `
      + `proposed=${r.origin_proposed} ${r.created_at} | ${String(r.text).slice(0, 58)}`);
  }

  const targets = all.filter((r) => r.origin === null || String(r.origin).trim() === '');
  if (!targets.length) {
    console.log('\nNothing to do — every VANTAGE task already carries an origin.');
    return;
  }

  const afterFix = targets.filter((r) => r.created_at >= WRITER_FIXED_AT);
  if (afterFix.length) {
    console.error(`\n*** REFUSING: ${afterFix.length} row(s) with no origin were created after `
      + `${WRITER_FIXED_AT}, so the WRITER is still wrong. Fix that first — a backfill here `
      + 'would hide a live bug rather than close a historical gap.');
    for (const r of afterFix) console.error(`      #${r.id} ${r.created_at}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${targets.length} row(s) need an origin, all predating ${WRITER_FIXED_AT}:`);
  for (const r of targets) console.log(`  #${r.id} [${r.source}] ${r.created_at}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  for (const r of targets) {
    db.run(
      "UPDATE tasks SET origin = 'commitment', origin_proposed = 0 "
      + "WHERE id = ? AND (origin IS NULL OR TRIM(origin) = '')",
      [r.id],
    );
  }
  console.log(`\nStamped ${targets.length} row(s): ${targets.map((r) => `#${r.id}`).join(', ')}`);

  for (const r of db.all(
    `SELECT id, source, origin, origin_proposed FROM tasks WHERE id IN (${targets.map(() => '?').join(',')})`,
    targets.map((r) => r.id),
  )) {
    console.log(`  #${r.id} [${r.source}] origin=${JSON.stringify(r.origin)} proposed=${r.origin_proposed}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
