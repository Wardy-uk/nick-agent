'use strict';

/**
 * What Nick owes Chris, whether it was produced, and when the next one is due.
 *
 * ── What this is, and the thing it deliberately is not ──────────────────────
 *
 * It is a DELIVERABLE TRACKER. It answers "what do I owe and when", from
 * records that already exist, and it never grades him.
 *
 * The obvious version of this feature is a burn-down: a percentage against
 * 11 Oct, four competency bars filling up. That version is refused, and the
 * reason is written down in VANTAGE's `self.js`, about exactly this data:
 * *"None of this is scored or graded. It is assembled so a coach can ask a
 * better question, and a tool that turned it into a performance number would be
 * doing the opposite of the job."* Chris is the one assessing the PIP. A tool
 * that scores it for him produces a number Nick will argue with instead of a
 * list he can act on — and on a bad week it is a screen that tells a man whose
 * failure mode is avoidance that he is failing. So: counts of what exists,
 * names of what does not, dates. No percentage, no score, no RAG, no trend
 * arrow. Pinned by a test that scans the payload for the vocabulary.
 *
 * ── Where the facts come from ───────────────────────────────────────────────
 *
 * Nothing here is a new measurement. `weekly-risk` has recorded every published
 * and every sent weekly summary since it shipped, and `management-log.assess()`
 * already computes both competency-3 and competency-4 figures. This joins them
 * and adds the calendar. If a number here disagrees with those screens, those
 * screens are right.
 *
 * ── The refusals ────────────────────────────────────────────────────────────
 *
 * 1. PRODUCED AND SENT ARE DIFFERENT FACTS. `weekly-risk` keeps them apart on
 *    purpose (`publishedAt` vs `sentRecord`) — a published week is a draft on
 *    disk, and reporting it as delivered would tell Nick he had sent something
 *    Chris has never seen. That is the single most expensive mistake this file
 *    could make, so `produced` and `sent` are counted separately and a week
 *    that is one but not the other is named.
 *
 * 2. A WEEK BEFORE THE CADENCE EXISTED IS NOT OWED. The Monday-midday cadence
 *    was agreed at the 1-2-1 on 12 Aug 2026, three weeks after the PIP began.
 *    Counting the weeks before it as missed would manufacture failures against
 *    a standard that did not exist — the tracker inventing a worse record than
 *    the real one, in the place he checks before writing to his manager.
 *
 * 3. AN UNREADABLE STORE IS A GAP, NEVER A MISS. "I could not read it" and "you
 *    did not do it" are opposite facts, and only one of them is an accusation.
 *    Every read that fails is NAMED and `known` goes false. `wins`' founding
 *    rule, and it matters more here than anywhere it has been applied before.
 *
 * 4. THE CURRENT WEEK IS NOT LATE UNTIL IT IS LATE. Before Monday midday it is
 *    `due`; after, with nothing produced, it is `late`. A tracker that opens on
 *    Monday morning already calling the week missed is one he stops opening.
 *
 * PURE where it judges: `assess()` takes plain records and a clock — the
 * `pi-health.assess()` / `friction.assess()` split. Only `build()` reads.
 *
 * CommonJS — NEURO backend convention.
 */

// ── The plan's own dates ─────────────────────────────────────────────────────
//
// Hard-coded deliberately, following `management-log`'s BASELINE_DATE: these are
// fixed by the PIP document, not by anything NEURO can observe, and a file that
// failed to load would otherwise silently produce a tracker measuring nothing.
// If the plan changes, change them here on purpose.

/** PIP start. */
const PIP_START = '2026-07-27';
/** The 60-day review. `management-log.REVIEW_DATE` is the same date. */
const PIP_REVIEW = '2026-09-11';
/** PIP end. */
const PIP_END = '2026-10-11';

/**
 * The first week the weekly summary was owed.
 *
 * The Monday-midday cadence was agreed at the 1-2-1 on 12 Aug 2026; this is the
 * Monday of that week. Refusal 2 — weeks before it are outside the standard and
 * are never counted as missed.
 */
const WEEKLY_OWED_FROM = '2026-08-10';

/** The weekly summary is due by midday on the Monday it commences. */
const WEEKLY_DUE_HOUR = 12;

// ── Time ─────────────────────────────────────────────────────────────────────

/** Local date key. Never toISOString() — the Pi may run UTC. */
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse YYYY-MM-DD as LOCAL midnight. `new Date('2026-08-14')` is UTC. */
function parseLocal(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Monday of the week containing `date`. Mirrors weekly-risk.weekCommencing. */
function weekCommencing(date) {
  const dt = parseLocal(date);
  if (!dt) return null;
  const shift = (dt.getDay() + 6) % 7; // Mon=0 … Sun=6
  return dateKey(addDays(dt, -shift));
}

/** Calendar days from `from` to `to`, or null if either is unreadable. */
function daysBetween(from, to) {
  const a = parseLocal(from);
  const b = parseLocal(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Every Monday owed between two dates, inclusive of the week containing `to`. */
function weeksOwed(fromWeek, toDate) {
  const start = parseLocal(weekCommencing(fromWeek));
  const endWeek = weekCommencing(toDate);
  const end = parseLocal(endWeek);
  if (!start || !end || end < start) return [];
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 7)) out.push(dateKey(d));
  return out;
}

// ── The weekly summary ───────────────────────────────────────────────────────

/**
 * Which weekly summaries exist, which were sent, and which are missing.
 *
 * `records` is `[{ week, published, sent }]` — booleans, gathered by `build()`
 * from weekly-risk's own stores. Refusal 1 keeps the two apart all the way
 * through: `producedNotSent` is its own list because a draft on disk is not a
 * thing Chris has received.
 */
function assessWeekly(records = [], { today = dateKey(), nowHour = 0 } = {}) {
  const owed = weeksOwed(WEEKLY_OWED_FROM, today);
  const currentWeek = weekCommencing(today);
  const byWeek = new Map();
  for (const r of records || []) {
    if (r && r.week) byWeek.set(r.week, r);
  }

  const produced = [];
  const sent = [];
  const producedNotSent = [];
  const missing = [];

  for (const week of owed) {
    const rec = byWeek.get(week);
    const isCurrent = week === currentWeek;

    if (rec?.sent) { sent.push(week); produced.push(week); continue; }
    if (rec?.published) {
      produced.push(week);
      // A draft that exists and has not gone. Named for the current week too:
      // "written, not sent" is exactly the state worth being told about on the
      // Monday it is still fixable.
      producedNotSent.push(week);
      continue;
    }

    // Refusal 4: the current week is not late until midday Monday has passed.
    if (isCurrent && nowHour < WEEKLY_DUE_HOUR && today === week) continue;
    missing.push(week);
  }

  const current = {
    week: currentWeek,
    produced: Boolean(byWeek.get(currentWeek)?.published),
    sent: Boolean(byWeek.get(currentWeek)?.sent),
    // `due` before midday Monday, `late` after it with nothing produced, and
    // `done` once it has gone. Three states, because "not yet" and "overdue"
    // license completely different things to do about it.
    state: byWeek.get(currentWeek)?.sent
      ? 'sent'
      : byWeek.get(currentWeek)?.published
        ? 'written-not-sent'
        : (today === currentWeek && nowHour < WEEKLY_DUE_HOUR) ? 'due' : 'late',
  };

  return {
    owedFrom: WEEKLY_OWED_FROM,
    owed: owed.length,
    produced: produced.length,
    sent: sent.length,
    producedNotSent,
    missing,
    current,
  };
}

// ── The window ───────────────────────────────────────────────────────────────

/**
 * Where today sits in the plan. Dates and a day count, and nothing else — no
 * "x% through", which is the score this file exists not to produce.
 */
function assessWindow(today = dateKey()) {
  const toReview = daysBetween(today, PIP_REVIEW);
  const toEnd = daysBetween(today, PIP_END);
  return {
    start: PIP_START,
    review: PIP_REVIEW,
    end: PIP_END,
    daysToReview: toReview,
    daysToEnd: toEnd,
    // Which half of the plan the standards come from. Competency 4's baseline
    // must reach zero by the review; the five-working-day standard is what is
    // judged after it.
    phase: toReview === null ? 'unknown' : toReview > 0 ? 'before-review' : 'after-review',
  };
}

// ── The whole read ───────────────────────────────────────────────────────────

/**
 * `log` is `management-log.assess()`'s output, or null when it could not be
 * read. Nothing is recomputed from it — the figures are lifted, so this screen
 * and the management log cannot disagree about the same competency.
 */
function assess({ weekly = [], log = null, today = dateKey(), nowHour = 0, gaps = [] } = {}) {
  const out = {
    window: assessWindow(today),
    weekly: assessWeekly(weekly, { today, nowHour }),
    log: null,
    gaps,
    // Refusal 3. A tracker that could not read its sources must never render
    // as a clean record, and must never render as a missed one either.
    known: gaps.length === 0,
    today,
  };

  if (log) {
    out.log = {
      // Competency 3: written down within two working days, with an owner and
      // a due date on every open item.
      lateLogged: log.lateLogged?.length ?? 0,
      missingOwner: log.missingOwner?.length ?? 0,
      missingDue: log.missingDue?.length ?? 0,
      // Competency 4: the 27 Jul baseline, which must reach zero by the review.
      baselineStillOpen: log.baseline?.stillOpen ?? null,
      baselineCount: log.baseline?.count ?? null,
      baselineTargetDate: log.baseline?.targetDate ?? PIP_REVIEW,
      // The post-review standard, visible before it is the thing being judged.
      breachesFiveDay: log.breachesFiveDay?.length ?? 0,
      overdueCount: log.overdueCount ?? 0,
      // Never a finding — nothing measured it. Carried so the panel can ask
      // Nick rather than reporting it to anyone as a gap.
      hrUnknown: log.hrUnknown?.length ?? 0,
      hrGap: log.hrGap?.length ?? 0,
    };
  }

  return out;
}

/** Reads weekly-risk and management-log, and assesses. Never throws. */
function build(now = new Date()) {
  const gaps = [];
  const today = dateKey(now);

  let weekly = [];
  try {
    const wr = require('./weekly-risk');
    // Only the weeks actually owed are asked about — there is no point reading
    // state for weeks nobody was ever going to write.
    for (const week of weeksOwed(WEEKLY_OWED_FROM, today)) {
      weekly.push({
        week,
        published: Boolean(wr.publishedAt(week)),
        // ⚠ `sentRecord`, not `isLocked`. Locked answers "may this screen
        // rebuild?", which Nick can change by reopening a week — and reopening
        // must not erase the fact that Chris received it.
        sent: Boolean(wr.sentRecord(week)),
      });
    }
  } catch (e) {
    weekly = [];
    gaps.push({ source: 'weekly-risk', why: e.message });
  }

  let log = null;
  try {
    log = require('./management-log').status({ today });
  } catch (e) {
    gaps.push({ source: 'management-log', why: e.message });
  }

  return assess({ weekly, log, today, nowHour: now.getHours(), gaps });
}

module.exports = {
  assess,
  build,
  // Exported for tests — the pure halves carry the judgement worth pinning.
  assessWeekly,
  assessWindow,
  weeksOwed,
  weekCommencing,
  daysBetween,
  dateKey,
  PIP_START,
  PIP_REVIEW,
  PIP_END,
  WEEKLY_OWED_FROM,
  WEEKLY_DUE_HOUR,
};
