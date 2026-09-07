'use strict';

/**
 * Initiation signals — the work that makes work possible.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every reward surface in NEURO counts finishing. `wins` counts finished work,
 * `weekly-target` counts closed tasks, `adhd-dashboard._momentum` counts both.
 * Nick's stated failure mode is INITIATION, not completion — so the whole
 * reward apparatus is pointed at the half of the loop that is not broken.
 *
 * Four acts are counted here, and none of them is finishing something:
 *
 *   STARTS    he began a session on a thing
 *   SHRINKS   he cut a thing down until it was startable
 *   TRIAGE    he decided a task's shape — due date, estimate, MoSCoW
 *   ESTIMATES how his own guesses compare with what the work took
 *
 * `focus-session` has recorded every start, every shrink and every planned-vs-
 * actual pair since it shipped, and NOTHING has ever read them back as a
 * signal. Triage was recorded nowhere at all until `task_triaged` landed
 * alongside this. It adds no store and no counter of its own: everything here
 * is derived from records of things Nick actually did, so it cannot drift from
 * them.
 *
 * ── The rules, which are the product ────────────────────────────────────────
 *
 * 1. A START COUNTS EVEN IF IT WENT NOWHERE. Sessions that were abandoned,
 *    expired or interrupted are counted exactly like finished ones. This is the
 *    whole point: rewarding only the starts that became finishes is the surface
 *    NEURO already has. `endedReason` is never filtered on.
 *
 * 2. THE LIVE SESSION COUNTS. It is not in history until it ends, so a count
 *    drawn from history alone is short by one for as long as he is working —
 *    wrong in the one direction that matters, at the one moment it is read.
 *
 * 3. YOU CANNOT BEAT AN ESTIMATE YOU DID NOT MAKE. A session with
 *    `plannedAssumed` is measured against NEURO's own 30-minute assumption, not
 *    against a judgement Nick made, so it is EXCLUDED from the estimate read
 *    and the exclusion is reported. Scoring him against a number the system
 *    invented is the #87 rule — a guess laundered into a measurement — wearing
 *    a game's clothes.
 *
 * 4. NO STREAKS, NO SCORES, NO GRADES. The wins streak died because it counted
 *    consecutive days with any win, jumped 4 -> 35 and became unbreakable; a
 *    number that cannot go down is not a signal (`wins.typicalDay`). The
 *    comparison here is the same one that replaced it: Nick against his own
 *    recent median, never against zero and never against anyone else.
 *
 * 5. SHRINKING IS EVIDENCE ABOUT THE WORK, NEVER ABOUT NICK. `friction.js`
 *    holds this rule and it holds here unchanged. "Started at 'rewrite the
 *    escalation policy', moved on 'open the doc and list the headings'" is a
 *    fact about how a task had to be cut up. It is never a failure, never a
 *    count against him, and no wording here may imply either.
 *
 *    ⚠ This is NOT `friction.js`'s shrink insight and does not replace it. That
 *    one reports a PATTERN across 21 days — one task shrunk repeatedly may need
 *    a different shape. This reports the ACT, on the day, as the thing that got
 *    him moving. Same evidence, opposite question.
 *
 * 6. THE HISTORY IS CAPPED AND SAYS SO. `focus-session.HISTORY_LIMIT` is 50, so
 *    any window wide enough to reach the cap yields a FLOOR, not a total. A
 *    capped count reported as a total is the silent-cap species this codebase
 *    has shipped five times; `complete` carries the answer.
 *
 * 7. A DAY BEFORE THE HISTORY BEGINS IS UNKNOWN, NOT ZERO. Within the covered
 *    window a weekday with no session is a real zero — he started nothing, and
 *    dropping those would make `typical` the typical of days he already started
 *    something, which flatters every ordinary day into looking below normal.
 *    Before the oldest record there is no such claim to make.
 *
 * PURE: `assess()` takes plain rows and an anchor, touches no DB and no clock —
 * the `pi-health.assess()` / `friction.assess()` split. Only `build()` reads.
 *
 * CommonJS — NEURO backend convention.
 */

// Trailing window for "your normal". Matches wins.typicalDay: three weeks is
// long enough to survive one odd week and short enough to still describe now.
const TYPICAL_WINDOW_DAYS = 21;

// Below this many covered weekdays there is no median worth quoting. The same
// refusal stress-score makes when it reports `calibrating`, and for the same
// reason: a number built on three days is noise wearing the clothes of a fact.
const TYPICAL_MIN_DAYS = 5;

// How many shrink ladders to show. A reminder of what worked, not a log of
// everything ever cut down.
const MAX_LADDER = 4;

// Estimate pairs needed before the read says anything. A single session is an
// anecdote, and an anecdote presented as calibration is what rule 3 forbids.
const MIN_ESTIMATE_PAIRS = 3;

// Landing within this many minutes of the estimate is its own outcome. Without
// it a two-minute overrun files as a miss, which is not what happened.
const CLOSE_MINUTES = 5;

// ── Time ─────────────────────────────────────────────────────────────────────

/** Local date key. Never toISOString() — the Pi may run UTC. */
function dateKey(d) {
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

function isWeekend(d) {
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

function parseAt(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Monday of the week containing `d`. Sunday is day 0, hence the explicit case. */
function weekStart(d) {
  const dow = d.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  const r = addDays(d, -back);
  r.setHours(0, 0, 0, 0);
  return r;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ── The read ─────────────────────────────────────────────────────────────────

/**
 * Every start NEURO knows about, newest first.
 *
 * The live session is folded in as a start in its own right (rule 2), marked
 * `live` so nothing downstream can mistake it for a finished record — its
 * elapsed time is still moving and it has no actual to compare with.
 */
function startsFrom(history, live) {
  const rows = [];

  if (live && live.startedAt) {
    rows.push({
      id: live.id,
      at: live.startedAt,
      text: live.text,
      taskId: live.taskId ?? null,
      plannedMinutes: live.plannedMinutes ?? null,
      plannedAssumed: Boolean(live.plannedAssumed),
      actualMinutes: null,
      shrinks: live.shrinks || 0,
      originalText: live.originalText || null,
      finalStep: live.nextStep || null,
      endedReason: null,
      live: true,
    });
  }

  for (const s of history || []) {
    if (!s || !s.startedAt) continue;
    // ⚠ A session is briefly readable from BOTH sources as it ends — archived
    // into history while a caller still holds the live view. Keyed on id so it
    // cannot be counted twice; the double would land on today's number, which
    // is the one anybody is looking at.
    if (live && s.id && s.id === live.id) continue;
    rows.push({
      id: s.id,
      at: s.startedAt,
      text: s.text,
      taskId: s.taskId ?? null,
      plannedMinutes: s.plannedMinutes ?? null,
      plannedAssumed: Boolean(s.plannedAssumed),
      actualMinutes: Number.isFinite(s.actualMinutes) ? s.actualMinutes : null,
      shrinks: s.shrinks || 0,
      originalText: s.originalText || null,
      finalStep: s.finalStep || null,
      // Recorded, never filtered on. Rule 1.
      endedReason: s.endedReason || null,
      live: false,
    });
  }

  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Starts per day, and how that compares with Nick's own normal.
 *
 * `complete` is false when the history cap may have eaten part of the window —
 * the count is then a floor and no caller may present it as a total.
 */
function assessStarts(starts, anchor, { historyCapped = false } = {}) {
  const todayKey = dateKey(anchor);
  const monday = weekStart(anchor);

  const byDay = new Map();
  let oldest = null;
  for (const s of starts) {
    const at = parseAt(s.at);
    if (!at) continue;
    const key = dateKey(at);
    byDay.set(key, (byDay.get(key) || 0) + 1);
    if (!oldest || at < oldest) oldest = at;
  }

  const today = byDay.get(todayKey) || 0;

  let week = 0;
  for (const s of starts) {
    const at = parseAt(s.at);
    if (at && at >= monday) week += 1;
  }

  // Rule 7: zeros only inside the covered window.
  const counts = [];
  let coveredDays = 0;
  for (let i = 1; i <= TYPICAL_WINDOW_DAYS; i++) {
    const d = addDays(anchor, -i);
    if (isWeekend(d)) continue;
    if (oldest && d < oldest) continue; // before the record begins — unknown, not zero
    coveredDays += 1;
    counts.push(byDay.get(dateKey(d)) || 0);
  }

  const typical = counts.length >= TYPICAL_MIN_DAYS ? median(counts) : null;

  return {
    today,
    week,
    typical,
    typicalBasis: typical === null
      ? `${coveredDays} weekday(s) on record — too few to say what normal is`
      : `median of ${counts.length} weekdays`,
    // Something running right now. Worth its own flag: a card should say "one
    // running" rather than folding it into a bare count of finished things.
    live: starts.some((s) => s.live),
    complete: !historyCapped,
    incompleteWhy: historyCapped
      ? 'the session history is at its cap, so anything older than the most recent 50 sessions is a floor'
      : null,
  };
}

/**
 * The shrink ladders — what a task had to become before it could be started.
 *
 * Rule 5. Every line is a fact about the work with its evidence attached, and
 * `originalText` is what makes it readable: without the wording he began with,
 * "shrunk twice" is a number about a person.
 */
function assessShrinks(starts, anchor) {
  const todayKey = dateKey(anchor);
  const monday = weekStart(anchor);

  let today = 0;
  let week = 0;
  const ladder = [];

  for (const s of starts) {
    if (!s.shrinks) continue;
    const at = parseAt(s.at);
    if (!at) continue;
    if (dateKey(at) === todayKey) today += s.shrinks;
    if (at >= monday) week += s.shrinks;

    // Only a ladder with both ends is worth rendering. A shrink with no
    // `finalStep` is one where he asked for smaller and had not yet named it —
    // real, counted above, and nothing to show.
    if (s.originalText && s.finalStep && ladder.length < MAX_LADDER) {
      ladder.push({
        id: s.id,
        at: s.at,
        from: s.originalText,
        to: s.finalStep,
        shrinks: s.shrinks,
        live: s.live,
      });
    }
  }

  return { today, week, ladder };
}

/**
 * Planned against actual, over sessions where the plan was NICK'S.
 *
 * Rule 3 is the whole of this function. `plannedAssumed` sessions are dropped
 * and counted separately, so the read can say "6 of your 9 sessions had no
 * estimate of yours to compare against" rather than quietly scoring him against
 * a 30-minute default he never chose.
 *
 * There is no grade. `under` / `close` / `over` are counts of what happened.
 */
function assessEstimates(starts) {
  const judged = [];
  let assumed = 0;

  for (const s of starts) {
    if (s.live) continue; // still running — no actual yet
    if (!(s.plannedMinutes > 0) || !(s.actualMinutes > 0)) continue;
    if (s.plannedAssumed) { assumed += 1; continue; }
    judged.push(s);
  }

  if (judged.length < MIN_ESTIMATE_PAIRS) {
    return {
      known: false,
      reason: judged.length
        ? `${judged.length} session(s) where you set the estimate — too few to read anything from`
        : 'no finished sessions yet where you set the estimate',
      judged: judged.length,
      assumedExcluded: assumed,
      under: 0,
      close: 0,
      over: 0,
      last: null,
    };
  }

  let under = 0;
  let close = 0;
  let over = 0;
  for (const s of judged) {
    const diff = s.actualMinutes - s.plannedMinutes;
    if (Math.abs(diff) <= CLOSE_MINUTES) close += 1;
    else if (diff < 0) under += 1;
    else over += 1;
  }

  const newest = judged[0];

  return {
    known: true,
    reason: null,
    judged: judged.length,
    // Reported, never hidden: on most days the excluded majority IS the finding.
    assumedExcluded: assumed,
    under,
    close,
    over,
    last: {
      text: newest.text,
      plannedMinutes: newest.plannedMinutes,
      actualMinutes: newest.actualMinutes,
      diffMinutes: newest.actualMinutes - newest.plannedMinutes,
      at: newest.at,
    },
  };
}

/**
 * Triage — deciding a task's shape, which is what makes it startable.
 *
 * Reads `task_triaged` events, which `task-store.updateTask` writes on a REAL
 * change to a shaping field (due date, estimate, MoSCoW, priority, origin,
 * domain). Re-saving the same values logs nothing, so this cannot be inflated
 * by opening a card and pressing Save.
 *
 * ⚠ COUNTED PER TASK, NEVER PER FIELD-WRITE. Setting a due date, clearing it
 * and setting it again is one task triaged, not three — a count of writes is
 * trivially gameable by the one person it is meant to serve, which is the
 * objection `wins` raises against scoring and it applies here with more force
 * because these writes are cheap. `fields` is reported so the read can say WHAT
 * was decided without the total depending on how many things changed at once.
 *
 * ⚠ FIRST ESTIMATES ARE COUNTED SEPARATELY, and that is the point rather than a
 * detail: `time-fit` and `day-planner` are both starved of estimates, and
 * putting one on a task that never had one is the act worth encouraging. A
 * re-estimate is real triage and still counts in the total — it is simply not
 * the same thing, so it does not get to inflate that number.
 */
function assessTriage(events, anchor) {
  const todayKey = dateKey(anchor);
  const monday = weekStart(anchor);

  const todayTasks = new Set();
  const weekTasks = new Set();
  const firstEstimatesToday = new Set();
  const fieldCounts = new Map();

  for (const e of events || []) {
    const at = parseAt(e && e.at);
    if (!at) continue;
    const taskId = e.taskId ?? e.task_id ?? null;
    // Without a task id there is nothing to count once. Dropping it is right:
    // an unattributable triage would either inflate the total or need a key
    // invented for it, and an invented key is not evidence.
    if (taskId == null) continue;

    const isToday = dateKey(at) === todayKey;
    if (at >= monday) weekTasks.add(taskId);
    if (!isToday) continue;

    todayTasks.add(taskId);
    const fields = Array.isArray(e.fields) ? e.fields : [];
    for (const f of fields) fieldCounts.set(f, (fieldCounts.get(f) || 0) + 1);
    if (fields.includes('estimate_minutes') && e.estimateWasSet === false) {
      firstEstimatesToday.add(taskId);
    }
  }

  return {
    today: todayTasks.size,
    week: weekTasks.size,
    // The estimates the planner did not have this morning and has now.
    firstEstimatesToday: firstEstimatesToday.size,
    // What was actually decided, so a card can say "3 due dates, 2 estimates"
    // rather than a bare number nobody can picture.
    byField: Object.fromEntries(fieldCounts),
  };
}

/**
 * What to say at the moment a session closes. PURE.
 *
 * The close-out is the only moment the real duration is known while Nick is
 * still thinking about the task, so it is where an estimate gets calibrated —
 * `day-planner` has been learning from these pairs since it shipped and has
 * never once told him one. Feedback he never sees cannot change an estimate.
 *
 * ⚠ Rule 3 again, at the sharpest point. On an ASSUMED plan there is nothing to
 * compare: the 30 minutes was NEURO's, so "you went 60 over" would be the system
 * marking him against its own guess. That case states the duration and invites
 * an estimate next time — it never reports a miss.
 *
 * Phrased HERE and nowhere else, following `wins.headline`: three surfaces show
 * a finished session and three phrasings of one fact is how they drift.
 *
 * There is no praise for being under and no reproach for being over. Both are
 * information about how long the work takes, which is the only thing this is
 * for. `kind` is structured so a caller can style it without parsing the words.
 */
function estimateCloseout({ plannedMinutes = null, plannedAssumed = true, actualMinutes = null } = {}) {
  // ⚠ ZERO IS A MEASUREMENT, NOT AN ABSENCE. A session closed inside a minute
  // rounds to 0 and is a real, and for this surface a rather important, thing
  // to have happened — the whole premise is that small starts count. Only an
  // unreadable duration says nothing. Guarding on `> 0` conflated the two and
  // silently dropped the close-out from exactly the shortest sessions.
  if (!Number.isFinite(actualMinutes) || actualMinutes < 0) return null;

  // "0 min" reads as a bug rather than as a fact about a very short session.
  const spent = actualMinutes === 0 ? 'Under a minute' : `${actualMinutes} min`;

  if (plannedAssumed || !(plannedMinutes > 0)) {
    return {
      kind: 'no-estimate',
      say: `${spent}. There was no estimate of yours to compare that with — worth setting one next time.`,
      diffMinutes: null,
    };
  }

  const diff = actualMinutes - plannedMinutes;
  if (Math.abs(diff) <= CLOSE_MINUTES) {
    return {
      kind: 'close',
      say: `${spent} against the ${plannedMinutes} you set — you called that one.`,
      diffMinutes: diff,
    };
  }
  if (diff < 0) {
    return {
      kind: 'under',
      say: `${spent} against the ${plannedMinutes} you set — ${Math.abs(diff)} under.`,
      diffMinutes: diff,
    };
  }
  return {
    kind: 'over',
    say: `${spent} against the ${plannedMinutes} you set — ${diff} over. Worth knowing for the next one like it.`,
    diffMinutes: diff,
  };
}

/**
 * The whole read. PURE.
 *
 * `gaps` is carried in from the caller so an unreadable source is NAMED rather
 * than arriving as a confident zero — the rule `wins` was built on.
 */
function assess({ history = [], live = null, triage = [], anchor = new Date(), gaps = [], historyLimit = 50 } = {}) {
  const starts = startsFrom(history, live);
  const historyCapped = Array.isArray(history) && history.length >= historyLimit;

  return {
    starts: assessStarts(starts, anchor, { historyCapped }),
    shrinks: assessShrinks(starts, anchor),
    triage: assessTriage(triage, anchor),
    estimates: assessEstimates(starts),
    gaps,
    // An empty read with no gaps is a true "nothing yet"; with gaps it is "I
    // could not look". Those license opposite things to say, so they are never
    // conflated — the distinction VESTA, SARA and the Surface all hold.
    known: gaps.length === 0,
  };
}

/** Reads the sources and assesses. Never throws: a failed read is a named gap. */
function build(now = new Date()) {
  const gaps = [];
  let history = [];
  let live = null;
  let historyLimit = 50;

  try {
    const focusSession = require('./focus-session');
    history = focusSession.history();
    live = focusSession.current(now.getTime());
    if (Number.isFinite(focusSession.HISTORY_LIMIT)) historyLimit = focusSession.HISTORY_LIMIT;
  } catch (e) {
    gaps.push({ source: 'focus-session', why: e.message });
  }

  let triage = [];
  try {
    const db = require('./../db/database');
    const { parseDbTime } = require('./wins');

    // ⚠ The range is widened by a day at each end ON PURPOSE. `logActivity`
    // keys `date_key` off UTC while every window here is LOCAL, so an evening
    // triage in BST is filed under tomorrow's key. Pulling a day of margin and
    // then filtering precisely on `created_at` is the only way to get both the
    // cheap indexed read and the right answer at the edges.
    const from = dateKey(addDays(weekStart(now), -1));
    const to = dateKey(addDays(now, 1));

    triage = (db.getActivityForRange(from, to) || [])
      .filter((r) => r.event_type === 'task_triaged')
      .map((r) => {
        let data = {};
        try { data = r.event_data ? JSON.parse(r.event_data) : {}; } catch { /* a row we cannot read is a row with no fields */ }
        const at = parseDbTime(r.created_at);
        return {
          at: at ? at.toISOString() : null,
          taskId: data.taskId ?? null,
          fields: Array.isArray(data.fields) ? data.fields : [],
          estimateWasSet: data.estimateWasSet === true,
        };
      })
      .filter((r) => r.at);
  } catch (e) {
    gaps.push({ source: 'task-triage', why: e.message });
  }

  return assess({ history, live, triage, anchor: now, gaps, historyLimit });
}

module.exports = {
  assess,
  build,
  estimateCloseout,
  // Exported for tests — the pure halves carry the judgement worth pinning.
  startsFrom,
  assessStarts,
  assessShrinks,
  assessTriage,
  assessEstimates,
  dateKey,
  weekStart,
  TYPICAL_WINDOW_DAYS,
  TYPICAL_MIN_DAYS,
  MIN_ESTIMATE_PAIRS,
  CLOSE_MINUTES,
  MAX_LADDER,
};
