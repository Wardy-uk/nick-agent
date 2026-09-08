#!/usr/bin/env node
'use strict';

/**
 * Recover the provenance detail for tasks that were promoted before the store
 * kept it.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * An email-promoted task carries `origin_path: email:<Graph id>` and nothing
 * else, so the only thing a card could ever say about it was "an email". That
 * is task #251: MUST, high priority, due today, unidentifiable.
 *
 * The sender and subject were never lost — they are on the `capture_todo`
 * sara_action the task was promoted from, under `payload.email`, which is
 * matched to the task by `payload.sourcePath === tasks.origin_path`. This walks
 * that join and writes what it finds into `origin_detail`.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *
 *  - DRY RUN BY DEFAULT. `--apply` writes. It prints what it would do either
 *    way, so the confirm quotes real numbers rather than an estimate.
 *
 *  - It only ever fills a BLANK. A row that already carries detail is left
 *    alone and reported as skipped — this is a recovery pass, not an authority.
 *
 *  - A task whose action has been pruned is reported as UNRECOVERABLE by id,
 *    never quietly counted as done. The whole failure being fixed is a row that
 *    cannot say where it came from; a backfill that silently leaves some of
 *    them in that state, and prints a clean total, reproduces it.
 *
 *  - It writes NOTHING when the action carries no usable sender or subject.
 *    Storing `{"email":{}}` would make `describeTaskProvenance` report detail as
 *    recorded and then render nothing — a gap wearing the costume of an answer.
 *
 * Usage:
 *   node backend/scripts/backfill-task-origin-detail.js            # dry run
 *   node backend/scripts/backfill-task-origin-detail.js --apply
 */

const db = require('../db/database');

const APPLY = process.argv.includes('--apply');

function usableEmail(email) {
  if (!email || typeof email !== 'object') return null;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const out = {
    from: pick(email.from),
    fromEmail: pick(email.fromEmail),
    subject: pick(email.subject),
    received: pick(email.received),
  };
  // Nothing a person could read = nothing worth storing. See rule 4.
  if (!out.from && !out.fromEmail && !out.subject) return null;
  return out;
}

async function main() {
  await db.init();

  // Every task whose path is a Graph id and which has no detail yet. Deliberately
  // narrow: a vault path already reads as a sentence and needs no rescue.
  const rows = db.all(
    `SELECT id, text, source, origin_path, created_at
       FROM tasks
      WHERE origin_path LIKE 'email:%'
        AND (origin_detail IS NULL OR origin_detail = '')
      ORDER BY id`,
  ) || [];

  console.log(`${rows.length} task(s) carry an email id and no readable detail.\n`);

  const recovered = [];
  const unrecoverable = [];

  for (const row of rows) {
    const actions = db.getSaraActionsBySource(row.origin_path, 'capture_todo') || [];
    // Newest first: a commitment re-raised is the same email, and the latest
    // sighting is the one whose metadata is most likely to be complete.
    const withEmail = actions
      .map((a) => usableEmail(a && a.payload && a.payload.email))
      .filter(Boolean);

    if (!withEmail.length) {
      unrecoverable.push(row);
      continue;
    }
    recovered.push({ row, email: withEmail[withEmail.length - 1] });
  }

  for (const { row, email } of recovered) {
    const who = email.from || email.fromEmail;
    console.log(`  #${row.id}  ${row.text.slice(0, 60)}`);
    console.log(`         from ${who || '(sender not recorded)'}`
      + (email.subject ? ` — "${email.subject}"` : ''));
    if (APPLY) {
      db.updateTaskRow(row.id, { origin_detail: JSON.stringify({ email }) });
    }
  }

  if (unrecoverable.length) {
    // Named, never folded into a total. These stay unanswerable and that is a
    // fact worth knowing rather than a rounding error.
    console.log(`\n${unrecoverable.length} task(s) whose suggestion has been pruned — still unanswerable:`);
    for (const row of unrecoverable) {
      console.log(`  #${row.id}  ${row.text.slice(0, 60)}`);
    }
  }

  console.log(`\n${APPLY ? 'Wrote' : 'Would write'} detail for ${recovered.length} task(s);`
    + ` ${unrecoverable.length} unrecoverable.`);
  if (!APPLY) console.log('Dry run — re-run with --apply to write.');
}

main().catch((e) => { console.error(e); process.exit(1); });
