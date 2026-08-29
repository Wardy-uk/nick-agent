'use strict';

/**
 * Weekly target — the pure half.
 *
 * `assess`, `say`, `weekStart` and `dateKey` are exported specifically so the
 * judgement pins without a DB or a clock (the `pi-health.assess()` split). The
 * states are the product here: a ring on a lock screen is believed faster than
 * a number, so "unset", "unknown" and "behind" have to stay separable.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { assess, say, weekStart, weekEnd, dateKey, MAX_TARGET } = require('./weekly-target');

// A full working week, for the pace arithmetic.
const FULL = { workingDaysTotal: 5, workingDaysRemaining: 0, todayIsWorkingDay: false };

// ── Week maths ──────────────────────────────────────────────────────────────

test('the week starts on MONDAY, and Sunday belongs to the week that is ENDING', () => {
  // getDay() calls Sunday 0, so the naive `dow - 1` sends it one day FORWARD
  // into a week that has not begun — a Sunday evening would then read against
  // an empty target.
  assert.equal(dateKey(weekStart(new Date('2026-08-31T09:00:00'))), '2026-08-31'); // Monday
  assert.equal(dateKey(weekStart(new Date('2026-08-30T23:00:00'))), '2026-08-24'); // Sunday
  assert.equal(dateKey(weekStart(new Date('2026-08-29T10:00:00'))), '2026-08-24'); // Saturday
});

test('the week is seven days long, Monday to Sunday', () => {
  const anchor = new Date('2026-08-29T10:00:00');
  assert.equal(dateKey(weekStart(anchor)), '2026-08-24');
  assert.equal(dateKey(weekEnd(anchor)), '2026-08-30');
});

// ── The states ──────────────────────────────────────────────────────────────

test('no target is UNSET, not a target of zero', () => {
  // "You have done none of the nothing you set" is a discouraging way to say
  // nobody set one, and a full red ring is exactly how that would render.
  const a = assess({ known: true, target: null, done: 12, ...FULL });
  assert.equal(a.state, 'unset');
  assert.equal(a.target, null);
  assert.equal(a.fraction, null, 'fraction must be null so nothing draws a ring');
  assert.equal(a.done, 12, 'the count is still true and still worth showing');
});

test('an unreadable ledger is UNKNOWN, not an empty week', () => {
  const a = assess({ known: false, target: 20 });
  assert.equal(a.state, 'unknown');
  assert.equal(a.done, null);
  assert.equal(a.fraction, null);
});

test('met and exceeded are different states', () => {
  const met = assess({ known: true, target: 20, done: 20, ...FULL });
  const over = assess({ known: true, target: 20, done: 26, ...FULL });
  assert.equal(met.state, 'met');
  assert.equal(met.over, 0);
  assert.equal(over.state, 'exceeded');
  assert.equal(over.over, 6);
});

test('remaining never goes negative', () => {
  const a = assess({ known: true, target: 10, done: 14, ...FULL });
  assert.equal(a.remaining, 0);
  assert.equal(a.over, 4);
});

test('behind is a WHOLE task behind, not a rounding artefact', () => {
  // At 5 of an expected 5.4 he is not behind — comparing against the raw
  // expectation would dress a rounding error up as a judgement.
  // 27 over 5 days, two days elapsed, expects 10.8. Ten closed is short of the
  // fraction but not of a whole task, so it must NOT read as behind.
  const rounding = assess({
    known: true, target: 27, done: 10,
    workingDaysTotal: 5, workingDaysRemaining: 4, todayIsWorkingDay: true,
  });
  assert.equal(rounding.pace, 10.8);
  assert.equal(rounding.state, 'on-track');

  const genuinely = assess({
    known: true, target: 20, done: 2,
    workingDaysTotal: 5, workingDaysRemaining: 1, todayIsWorkingDay: true,
  });
  assert.equal(genuinely.state, 'behind');
});

test('pace counts the day in progress towards the END of it', () => {
  // Monday morning should not already expect Monday's share to be finished.
  const monday = assess({
    known: true, target: 10, done: 0,
    workingDaysTotal: 5, workingDaysRemaining: 5, todayIsWorkingDay: true,
  });
  assert.equal(monday.pace, 2, 'one working day elapsed of five, so 2 of 10');
});

test('needPerDay is null when there are no working days left', () => {
  // "3 a day across 0 days" is not advice.
  const a = assess({
    known: true, target: 20, done: 5,
    workingDaysTotal: 5, workingDaysRemaining: 0, todayIsWorkingDay: false,
  });
  assert.equal(a.needPerDay, null);
  assert.equal(a.remaining, 15);
});

// ── The words ───────────────────────────────────────────────────────────────

test('say() never claims a number it does not have', () => {
  assert.match(say(assess({ known: false, target: 5 })), /Couldn't count/);
  assert.match(say(assess({ known: true, target: null, done: 0, ...FULL })), /No target set/);
  // Work done without a target is still work done, and saying so costs nothing.
  assert.match(say(assess({ known: true, target: null, done: 7, ...FULL })), /7 closed this week/);
});

test('say() distinguishes met from exceeded in words, not just in state', () => {
  // The lock screen strips colour, so the WORDS are what carry this.
  assert.match(say(assess({ known: true, target: 10, done: 10, ...FULL })), /target met/);
  assert.match(say(assess({ known: true, target: 10, done: 13, ...FULL })), /3 past target/);
});

test('say() gives the rate needed, and admits when the week has run out', () => {
  const midweek = say(assess({
    known: true, target: 20, done: 8,
    workingDaysTotal: 5, workingDaysRemaining: 3, todayIsWorkingDay: true,
  }));
  assert.match(midweek, /12 to go/);
  assert.match(midweek, /a day over 3 days/);

  const spent = say(assess({
    known: true, target: 20, done: 8,
    workingDaysTotal: 5, workingDaysRemaining: 0, todayIsWorkingDay: false,
  }));
  assert.match(spent, /out of working days/);
});

test('a sane ceiling exists on the target', () => {
  // A target nobody could hit is a ring permanently in the red, which is worse
  // than having none at all.
  assert.ok(Number.isInteger(MAX_TARGET) && MAX_TARGET > 0 && MAX_TARGET <= 500);
});

// ── History coverage ────────────────────────────────────────────────────────

test('a week before the ledger began is UNKNOWN, not a week of zero', () => {
  // Measured on the live DB: task_done rows begin 2026-08-14 while the wins
  // table goes back to 2026-06-01, so eight lookback weeks included six the
  // ledger never covered. suggest() takes a MEDIAN, so those zeros dragged the
  // proposal to 0 — which setTarget then refuses, because 0 is not a target.
  //
  // Exercised through the real function against a scratch DB, because the bug
  // lives in the SQL boundary, not in arithmetic a fixture could stand in for.
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wt-'));
  const prev = process.env.NEURO_DB_PATH;
  process.env.NEURO_DB_PATH = path.join(dir, 'scratch.db');

  // Fresh module registry so database.js picks up the scratch path.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const db = require('./../db/database');
  const wt = require('./weekly-target');

  return db.init().then(() => {
    const anchor = new Date('2026-08-31T10:00:00'); // a Monday
    // One task closed in the week of 24 Aug, and nothing before it ever.
    db.run(
      `INSERT INTO wins (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
       VALUES ('2026-08-26', '2026-08-26T10:00:00Z', 'activity', 'task_done', 'a task', 'x', 1, 'k1', '2026-08-26T10:00:00Z')`
    );

    const weeks = wt.recentWeeks(anchor, 8);
    const covered = weeks.filter((w) => w.known);
    const uncovered = weeks.filter((w) => !w.known);

    assert.equal(covered.length, 1, 'only the week containing the one row is known');
    assert.equal(covered[0].done, 1);
    assert.ok(uncovered.length >= 6, 'the rest predate the ledger');
    assert.equal(uncovered[0].done, null, 'unknown weeks carry null, never 0');
    assert.match(uncovered[0].why, /before the wins ledger/);

    // And the proposal must not be dragged to zero by them.
    const s = wt.suggest(anchor);
    assert.ok(s.value === null || s.value > 0, `a proposal of ${s.value} is not a target`);

    process.env.NEURO_DB_PATH = prev;
    for (const k of Object.keys(require.cache)) delete require.cache[k];
    // better-sqlite3 still holds the file open, and Windows refuses to unlink a
    // held file — so cleanup is best-effort. A temp directory left behind is
    // not worth failing a passing test over (and moving a live DB file is the
    // mistake that destroyed the local agent.db once already).
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* held open */ }
  });
});
