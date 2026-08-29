'use strict';

/**
 * Does the body predict the day's work? MEASURE FIRST.
 *
 * The obvious pitch for wiring health into NEURO is "your worst days follow bad
 * nights". It is plausible, it is the sort of thing wellness apps assert, and
 * nothing in this codebase had ever checked it. So this script checks it before
 * anything is built on it — and is written to be able to come back with "no,
 * there is nothing here", which is a perfectly good result and the reason to run
 * it at all.
 *
 * Method, and its limits, stated up front:
 *
 *  - Output per day is the `wins` ledger (a DETECTED count: commits, actions,
 *    replies, completed tasks, 1-2-1s), which only starts on 2026-06-01. That is
 *    the binding constraint on sample size, not the health data.
 *  - Days are bucketed by `health-daily.readiness()` using a baseline built from
 *    the PRECEDING days only, so no day is judged against itself or against its
 *    own future — the mistake that makes a backtest look clairvoyant.
 *  - Only COMPLETE days count. Today is half a day of steps and half a day of
 *    work, and it flatters whichever side you are arguing for.
 *  - The comparison is a permutation test: shuffle the labels 20,000 times and
 *    ask how often chance beats the observed gap. It makes no distributional
 *    assumption, which matters at n≈50.
 *
 * ⚠ This measures ASSOCIATION on one person over one quarter. Even a clean
 * result would not license "sleep badly, work less" as a claim NEURO makes at
 * him — the honest use is deciding whether the planner's capacity rule is worth
 * keeping, not generating advice.
 *
 *   node backend/scripts/measure-health-work.js [--days 120]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');

const SHUFFLES = 20000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(n, dp = 2) { return Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null; }

/**
 * How often does chance produce a gap this big? No distributional assumption,
 * which is the point at this sample size.
 */
function permutationP(groupA, groupB) {
  const observed = Math.abs(mean(groupA) - mean(groupB));
  const pool = [...groupA, ...groupB];
  const n = groupA.length;
  let atLeastAsExtreme = 0;

  for (let i = 0; i < SHUFFLES; i++) {
    // Fisher-Yates on a copy.
    const shuffled = [...pool];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const gap = Math.abs(mean(shuffled.slice(0, n)) - mean(shuffled.slice(n)));
    if (gap >= observed) atLeastAsExtreme++;
  }
  return atLeastAsExtreme / SHUFFLES;
}

function report(label, a, b, nameA, nameB) {
  console.log(`\n── ${label} ──`);
  if (a.length < 8 || b.length < 8) {
    // Refusing is the correct answer here. A comparison of five days against
    // three is not a finding, and dressing it up as one is exactly the habit
    // this codebase keeps deleting.
    console.log(`  NOT ENOUGH DATA — ${nameA}: ${a.length} days, ${nameB}: ${b.length} days (need 8 each).`);
    return;
  }
  const p = permutationP(a, b);
  console.log(`  ${nameA.padEnd(22)} n=${String(a.length).padStart(3)}  mean ${round(mean(a))}  median ${round(median(a))}`);
  console.log(`  ${nameB.padEnd(22)} n=${String(b.length).padStart(3)}  mean ${round(mean(b))}  median ${round(median(b))}`);
  console.log(`  difference in means: ${round(mean(a) - mean(b))}`);
  console.log(`  permutation p = ${round(p, 4)} ${p < 0.05 ? '← unlikely to be chance' : '← consistent with chance'}`);
}

async function main() {
  await db.init();
  const healthDaily = require('../services/health-daily');

  const days = arg('days', 120);
  const rows = healthDaily.recentDays(days).filter(d => d.complete).sort((a, b) => (a.day < b.day ? -1 : 1));

  if (rows.length < 20) {
    console.log(`Only ${rows.length} complete days in health_daily — run health-backfill.js first.`);
    return;
  }

  // Output per day, from the wins ledger. `count` matters: commits fold to one
  // row per repo per day carrying their count, so summing rows would treat a
  // nine-commit day as a one-commit day.
  const winRows = db.all('SELECT date_key, SUM(count) AS n FROM wins GROUP BY date_key');
  const wins = new Map();
  for (const r of winRows) wins.set(r.date_key, r.n);

  const first = [...wins.keys()].sort()[0];
  const overlap = rows.filter(d => d.day >= first);

  console.log(`Health days: ${rows.length} (${rows[0].day} → ${rows[rows.length - 1].day})`);
  console.log(`Wins ledger starts ${first} — overlap is ${overlap.length} days, and that is the binding limit.`);

  // A day present in health_daily but absent from wins is a genuine zero: the
  // ledger materialises rows for every day it finds work on, so "no row" means
  // "nothing detected", not "not measured".
  const output = (day) => wins.get(day) || 0;

  // ── Readiness, judged only on what came BEFORE each day ──
  const buckets = { low: [], normal: [], high: [], unknown: [] };
  for (let i = 0; i < overlap.length; i++) {
    const day = overlap[i];
    const priorIndex = rows.findIndex(r => r.day === day.day);
    const prior = rows.slice(Math.max(0, priorIndex - healthDaily.BASELINE_DAYS), priorIndex);
    const r = healthDaily.readiness(day, healthDaily.buildBaseline(prior));
    buckets[r.known ? r.state : 'unknown'].push(output(day.day));
  }

  console.log(`\nBucketed by readiness (baseline from the preceding ${healthDaily.BASELINE_DAYS} days only):`);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(8)} ${String(v.length).padStart(3)} days  mean output ${round(mean(v)) ?? '—'}`);
  }
  report('Low-readiness days vs the rest', buckets.low, [...buckets.normal, ...buckets.high],
    'low readiness', 'normal or high');

  // ── Sleep, on the NEXT day's work ──
  //
  // Deliberately next-day rather than same-day: last night's sleep is stamped on
  // this morning's date by the wake-date rule, so same-day is already the right
  // pairing for sleep — but the shortfall is also tested against the FOLLOWING
  // day, because a broken night's cost often lands 24 hours later.
  const sleepBase = median(rows.map(d => d.asleepHours).filter(Number.isFinite));
  const short = [];
  const usual = [];
  const shortNext = [];
  const usualNext = [];
  for (let i = 0; i < overlap.length; i++) {
    const d = overlap[i];
    if (!Number.isFinite(d.asleepHours)) continue;
    const isShort = d.asleepHours <= sleepBase - 1.25;
    (isShort ? short : usual).push(output(d.day));
    const next = overlap[i + 1];
    if (next) (isShort ? shortNext : usualNext).push(output(next.day));
  }
  console.log(`\nSleep median across the window: ${round(sleepBase, 2)}h — "short" means 1.25h below that.`);
  report('Short nights vs usual (same day)', short, usual, 'after a short night', 'after a usual night');
  report('Short nights vs usual (next day)', shortNext, usualNext, 'day after short', 'day after usual');

  console.log('\n⚠ Association on one person over one quarter. Whatever this says, it is a reason to keep');
  console.log('  or drop the planner\'s capacity rule — not a claim for NEURO to make at Nick.');
}

main().catch((e) => {
  console.error('Measurement failed:', e.message);
  process.exit(1);
});
