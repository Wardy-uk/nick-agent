'use strict';

/**
 * Weekly target — the number Nick sets on a Monday, and how far through it he is.
 *
 * ── What it counts, and why not the whole wins ledger ────────────────────────
 *
 * A target has to count the thing being targeted. The `wins` ledger deliberately
 * counts everything finished — commits, meetings, replies, decisions, 1-2-1s —
 * and that is right for a momentum feed and WRONG for a target: at ~9 commits a
 * day a target of fifteen would be met by Tuesday lunchtime without a single
 * task being closed. That is exactly how the wins STREAK died — it jumped from 4
 * to 35 the moment meetings were counted honestly and became unbreakable, and a
 * number that cannot go down is not a signal.
 *
 * So this counts `kind = 'task_done'` and nothing else.
 *
 * ⚠ `task_done` specifically, and NOT also the `complete_task` SARA action.
 * Executing that action calls `task-store.updateTask`, which logs `task_done` —
 * so both land in the ledger for one closed task, and counting both would
 * silently inflate every task Nick closes through SARA. `task-store` is the ONE
 * writer of tasks, so every completion path (the phone, chat, MCP, a focus
 * session, an approved action) passes through it and is counted exactly once.
 *
 * ── The refusals ─────────────────────────────────────────────────────────────
 *
 * 1. NO TARGET IS NOT A TARGET OF ZERO. `unset` is its own state and must never
 *    render as a full red ring — "you have done none of the nothing you set" is
 *    a discouraging way to say "you did not set one".
 *
 * 2. AN UNREADABLE LEDGER IS NOT AN EMPTY WEEK. `known:false` carries a reason.
 *    This is `wins`' own founding rule and it matters more here, because a ring
 *    at zero is a picture of a wasted week and pictures are believed faster than
 *    numbers.
 *
 * 3. NOTHING IS SET AUTOMATICALLY. `suggest()` proposes from history and says so
 *    (the `moscow_proposed` distinction — a proposal is not a decision). The
 *    target is a commitment Nick makes; a number NEURO picked for him is one he
 *    has no reason to feel anything about, which is the entire mechanism.
 *
 * Storage is a KV blob per week in `agent_state` (`weekly_target:<monday>`),
 * following `standup-session` and `focus-session`: a schema migration on the
 * live DB is a bigger risk than the query convenience is worth, and keying per
 * week means last week's target survives to be compared against.
 *
 * NB: it counts EVERY task, work and personal alike. When `tasks.domain` lands,
 * this is where the split goes — one target per domain, or a work-only target
 * with personal excluded. Deliberately not anticipated here.
 */

const db = require('../db/database');

const STATE_PREFIX = 'weekly_target:';

// A week of tasks. Above this it is a typo, not an intention — and a target
// nobody could hit is a ring permanently in the red, which is worse than none.
const MAX_TARGET = 200;

// ── Time ─────────────────────────────────────────────────────────────────────

/** Local date key. Never toISOString() — the Pi may run UTC. */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * The Monday of the week containing `anchor`. PURE.
 *
 * ⚠ Sunday belongs to the week that is ENDING, not the one about to start.
 * `getDay()` calls Sunday 0, so the naive `dow - 1` sends it back to -1 — one
 * day FORWARD — and a Sunday evening would read against a week that has not
 * begun, showing a target of nothing done. Pinned by a test.
 */
function weekStart(anchor = new Date()) {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const dow = d.getDay();
  return addDays(d, -(dow === 0 ? 6 : dow - 1));
}

function weekEnd(anchor = new Date()) {
  return addDays(weekStart(anchor), 6);
}

/** The KV key for the week containing `anchor`. */
function weekKey(anchor = new Date()) {
  return `${STATE_PREFIX}${dateKey(weekStart(anchor))}`;
}

// ── The target itself ────────────────────────────────────────────────────────

function readTarget(anchor = new Date()) {
  try {
    const raw = db.getState(weekKey(anchor));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const value = Number(parsed && parsed.target);
    if (!Number.isInteger(value) || value <= 0) return null;
    return { target: value, setAt: parsed.setAt || null, source: parsed.source || 'manual' };
  } catch (e) {
    // A corrupt blob is "no target", not a crash. The ring degrades to `unset`,
    // which is honest: we cannot show a target we cannot read.
    return null;
  }
}

/**
 * Set the week's target. `weekOf` allows setting NEXT week's on a Friday, which
 * is when a person actually thinks about it.
 *
 * Returns `{ok:false, error}` rather than throwing, so a route can say what was
 * wrong instead of 500ing on a fat-fingered number.
 */
function setTarget(value, { weekOf = new Date(), source = 'manual' } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'target must be a whole number' };
  }
  if (n <= 0) {
    // Zero is not a target, it is the absence of one, and storing it would make
    // "met" true forever. Clearing is a separate, explicit act.
    return { ok: false, error: 'target must be at least 1 — use DELETE to clear it' };
  }
  if (n > MAX_TARGET) {
    return { ok: false, error: `target must be ${MAX_TARGET} or fewer` };
  }

  const key = weekKey(weekOf);
  db.setState(key, JSON.stringify({
    target: n,
    setAt: new Date().toISOString(),
    source: String(source || 'manual'),
  }));
  return { ok: true, target: n, weekStart: dateKey(weekStart(weekOf)) };
}

function clearTarget({ weekOf = new Date() } = {}) {
  db.run('DELETE FROM agent_state WHERE key = ?', [weekKey(weekOf)]);
  return { ok: true, weekStart: dateKey(weekStart(weekOf)) };
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Tasks closed per day across a date range.
 *
 * Returns null — never an empty map — when the ledger cannot be read, so the
 * caller can tell "no tasks closed" from "we could not count".
 */
function _tasksByDay(from, to) {
  try {
    const rows = db.all(
      // SUM(count), not COUNT(*). They are equal for `task_done` today — one row
      // per closed task, `count` defaulting to 1 — but `count` exists precisely
      // because rows can FOLD (git commits already do), and a folded task_done
      // row would be silently undercounted by COUNT(*). Zero behaviour change
      // now, and it cannot quietly go wrong later.
      `SELECT date_key, SUM(count) n FROM wins
        WHERE kind = 'task_done' AND date_key BETWEEN ? AND ?
        GROUP BY date_key`,
      [from, to]
    );
    return new Map(rows.map((r) => [r.date_key, Number(r.n) || 0]));
  } catch (e) {
    return null;
  }
}

/**
 * Working days in the week, and how many are left including today.
 *
 * Working days rather than calendar days, so the pace does not tell Nick he is
 * behind on a Saturday. Reads the bank-holiday set — a week containing the
 * August Monday genuinely has less room in it.
 *
 * Degrades to plain Mon–Fri if `working-days` cannot answer; a pace line is not
 * worth failing the whole ring over.
 */
function _weekShape(anchor = new Date()) {
  const start = weekStart(anchor);
  const todayKey = dateKey(anchor);

  let isWorking = (d) => {
    const dow = d.getDay();
    return dow !== 0 && dow !== 6;
  };
  try {
    const wd = require('./working-days');
    const holidays = wd.holidaySet();
    isWorking = (d) => wd.isWorkingDay(d, holidays);
  } catch (e) { /* Mon–Fri fallback above */ }

  let total = 0;
  let remaining = 0;
  let todayIsWorkingDay = false;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dateKey(d);
    const working = isWorking(d);
    if (working) total++;
    if (working && key >= todayKey) remaining++;
    if (key === todayKey) todayIsWorkingDay = working;
  }
  return { total, remaining, todayIsWorkingDay };
}

/**
 * Where the week stands. PURE — no DB, no clock, no I/O.
 *
 * The `pi-health.assess()` / `state-of-play.assess()` split: the judgement is
 * the product, so it pins without a database.
 *
 * @param {object} input
 * @param {boolean} input.known               could the ledger be read at all
 * @param {number|null} input.target          null when none is set for this week
 * @param {number} input.done                 tasks closed so far this week
 * @param {number} input.workingDaysTotal
 * @param {number} input.workingDaysRemaining including today, when today works
 * @param {boolean} input.todayIsWorkingDay
 */
function assess(input = {}) {
  const known = input.known !== false;
  const target = Number.isInteger(input.target) && input.target > 0 ? input.target : null;
  const done = Number.isFinite(Number(input.done)) ? Number(input.done) : 0;

  if (!known) {
    return {
      state: 'unknown', target, done: null, remaining: null, over: 0,
      fraction: null, pace: null, needPerDay: null,
    };
  }
  if (target === null) {
    // No claim about progress can be made, so none is. `fraction: null` is what
    // stops a renderer drawing an empty ring that reads as a failed week.
    return {
      state: 'unset', target: null, done, remaining: null, over: 0,
      fraction: null, pace: null, needPerDay: null,
    };
  }

  const over = Math.max(0, done - target);
  const remaining = Math.max(0, target - done);
  const fraction = target > 0 ? done / target : 0;

  const total = Math.max(0, Number(input.workingDaysTotal) || 0);
  const left = Math.max(0, Number(input.workingDaysRemaining) || 0);
  // Elapsed INCLUDING today when today is a working day — the day in progress
  // counts towards what should be done by the end of it, not by the start.
  const elapsed = total > 0
    ? Math.min(total, total - left + (input.todayIsWorkingDay ? 1 : 0))
    : 0;

  // What the pace says he should be at by the end of today.
  const expected = total > 0 ? (target * elapsed) / total : null;

  let state;
  if (over > 0) state = 'exceeded';
  else if (done >= target) state = 'met';
  else if (expected === null) state = 'on-track';
  // A whole task behind, not a fraction of one. Comparing against the raw
  // expectation would call him behind at 5 of an expected 5.4, which is a
  // rounding artefact dressed up as a judgement.
  else if (done < Math.floor(expected)) state = 'behind';
  else state = 'on-track';

  return {
    state,
    target,
    done,
    remaining,
    over,
    fraction,
    pace: expected === null ? null : Math.round(expected * 10) / 10,
    // How many a day to finish, over the working days actually left. Null when
    // there are none — "3 a day across 0 days" is not advice.
    needPerDay: remaining > 0 && left > 0 ? Math.ceil(remaining / left) : null,
    workingDaysLeft: left,
  };
}

/**
 * One line stating where the week is. PURE — takes an assess() result.
 *
 * Composed on the SERVER for the same reason `attention.sayLine` is: the ring,
 * the Surface and any later notification must not phrase the same fact three
 * ways. SARA's register — the fact and the move, no cheerleading, and no
 * encouraging version of a bad week.
 */
function say(a) {
  if (!a) return null;
  if (a.state === 'unknown') return "Couldn't count this week's tasks.";
  if (a.state === 'unset') {
    return a.done > 0
      ? `${a.done} closed this week. No target set.`
      : 'No target set for this week.';
  }
  if (a.state === 'exceeded') {
    return `${a.done} of ${a.target} — ${a.over} past target.`;
  }
  if (a.state === 'met') return `${a.done} of ${a.target} — target met.`;

  const core = `${a.done} of ${a.target}`;
  if (a.remaining > 0 && a.needPerDay) {
    const days = a.workingDaysLeft;
    return `${core} — ${a.remaining} to go, ${a.needPerDay} a day over ${days} day${days === 1 ? '' : 's'}.`;
  }
  if (a.remaining > 0) return `${core} — ${a.remaining} to go, and the week is out of working days.`;
  return `${core}.`;
}

/**
 * A target to propose, from what Nick has actually done in recent whole weeks.
 *
 * Median, not mean — one heavy week should not set the bar for every week after
 * it, the same reason `wins.typicalDay` is a median. Whole weeks only: the week
 * in progress would drag the suggestion down every Monday morning.
 *
 * Returns null below MIN_WEEKS rather than a number built on one data point.
 * A suggestion drawn from two weeks is a guess wearing the clothes of a fact —
 * `stress-score`'s `calibrating` refusal, and `wins`' TYPICAL_MIN_DAYS.
 */
const SUGGEST_MIN_WEEKS = 3;
const SUGGEST_WINDOW_WEEKS = 8;

function suggest(anchor = new Date()) {
  const weeks = recentWeeks(anchor, SUGGEST_WINDOW_WEEKS);
  if (weeks === null) return null;
  const counts = weeks.filter((w) => w.known).map((w) => w.done);
  if (counts.length < SUGGEST_MIN_WEEKS) {
    return { value: null, basis: 'not enough history yet', samples: counts.length };
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return {
    value: median,
    basis: `median of your last ${counts.length} full weeks`,
    samples: counts.length,
    // Carried so the proposal can be argued with rather than just accepted.
    weeks: counts,
  };
}

/**
 * The last `n` COMPLETE weeks before the one containing `anchor`, newest first.
 * Null when the ledger could not be read at all.
 */
/**
 * The first day the ledger has ANY task completion for.
 *
 * ⚠ Weeks before this are not weeks in which Nick closed nothing — they are
 * weeks the ledger did not cover. Counting them as zero is the "absence of
 * evidence read as evidence of absence" trap this codebase keeps tripping over,
 * and here it is not cosmetic: `suggest()` takes a MEDIAN, so eight empty weeks
 * drag the proposal to 0, which is not a target anybody can be set.
 *
 * Measured on the live ledger: task_done rows begin 2026-08-14, while the wins
 * table itself goes back to 2026-06-01 — so the gap is real and would have
 * proposed a target of zero off [12,3,0,0,0,0,0,0].
 *
 * Returns null when the ledger cannot be read, which callers treat as "cannot
 * tell", not "no history".
 */
function _ledgerStartsAt() {
  try {
    const row = db.get("SELECT MIN(date_key) AS first FROM wins WHERE kind = 'task_done'");
    return row && row.first ? String(row.first) : null;
  } catch (e) {
    return null;
  }
}

function recentWeeks(anchor = new Date(), n = 8) {
  const thisMonday = weekStart(anchor);
  const oldest = addDays(thisMonday, -7 * n);
  const byDay = _tasksByDay(dateKey(oldest), dateKey(addDays(thisMonday, -1)));
  if (byDay === null) return null;

  const ledgerStart = _ledgerStartsAt();

  const out = [];
  for (let i = 1; i <= n; i++) {
    const start = addDays(thisMonday, -7 * i);
    const end = addDays(start, 6);
    let done = 0;
    for (let d = 0; d < 7; d++) done += byDay.get(dateKey(addDays(start, d))) || 0;
    const stored = readTarget(start);

    // A week that ended before the ledger began is UNKNOWN, not empty. `suggest`
    // already filters on `known`, so this alone keeps the proposal honest.
    const covered = !ledgerStart || dateKey(end) >= ledgerStart;

    out.push({
      weekStart: dateKey(start),
      done: covered ? done : null,
      target: stored ? stored.target : null,
      met: stored && covered ? done >= stored.target : null,
      known: covered,
      ...(covered ? {} : { why: 'before the wins ledger started' }),
    });
  }
  return out;
}

/**
 * Everything a renderer needs, in one read.
 *
 * This is what rides on the attention payload — so the lock screen draws its
 * ring from the same numbers and the same words as every other surface, and
 * pays for no second request while the phone is locked.
 */
function snapshot(anchor = new Date()) {
  const start = weekStart(anchor);
  const end = weekEnd(anchor);
  const byDay = _tasksByDay(dateKey(start), dateKey(end));

  const stored = readTarget(anchor);
  const shape = _weekShape(anchor);

  if (byDay === null) {
    const a = assess({ known: false, target: stored ? stored.target : null });
    return {
      known: false,
      why: 'the wins ledger could not be read',
      weekStart: dateKey(start),
      weekEnd: dateKey(end),
      ...a,
      say: say(a),
      byDay: null,
    };
  }

  let done = 0;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const key = dateKey(addDays(start, i));
    const n = byDay.get(key) || 0;
    done += n;
    days.push({ date: key, done: n });
  }

  const a = assess({
    known: true,
    target: stored ? stored.target : null,
    done,
    workingDaysTotal: shape.total,
    workingDaysRemaining: shape.remaining,
    todayIsWorkingDay: shape.todayIsWorkingDay,
  });

  return {
    known: true,
    weekStart: dateKey(start),
    weekEnd: dateKey(end),
    setAt: stored ? stored.setAt : null,
    ...a,
    say: say(a),
    byDay: days,
  };
}

module.exports = {
  snapshot,
  setTarget,
  clearTarget,
  readTarget,
  suggest,
  recentWeeks,
  MAX_TARGET,
  // exported for tests — pure, no DB, no clock
  assess,
  say,
  weekStart,
  weekEnd,
  dateKey,
};
