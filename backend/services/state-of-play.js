'use strict';

/**
 * State of play — the one screen that answers "what shape is everything in?".
 *
 * NEURO had plenty of surfaces that each answer a slice (Tasks, Actions, People,
 * Pi Health) and nothing that answers the whole. The gap that motivated this: the
 * Jira cache had been stale since 3 July and nothing anywhere said so, because
 * every existing panel either reads the cache happily or doesn't read it at all.
 * A staleness only shows up when something is looking for it.
 *
 * Split like pi-health, and for the same reason: `snapshot()` reads, `assess()`
 * judges. The judgement is the part worth pinning in a test, and it must not need
 * a database to run — so it takes a snapshot object and returns a ranked list.
 *
 * Read-only throughout. This panel must never be the reason something changed.
 */

const db = require('../db/database');

// Watchdog's own thresholds, deliberately reused rather than re-picked — two
// different numbers for "this job has stopped" is how you get a dashboard that
// disagrees with the alert that woke you up.
const DAILY_STALE_DAYS = 3;
const WEEKLY_STALE_DAYS = 10;

// The jobs scheduler.js stamps. Listed here rather than derived, because the
// point is to notice one that has stopped stamping entirely — deriving the list
// from what exists in agent_state would make a vanished job invisible by
// construction, which is exactly the failure being watched for.
const TRACKED_JOBS = [
  { name: 'nightly-sweep', cadence: 'daily' },
  { name: 'nightly-rollup', cadence: 'daily' },
  { name: 'embeddings-rebuild', cadence: 'daily' },
  { name: 'weekly-review', cadence: 'weekly' },
  { name: 'weekly-hygiene', cadence: 'weekly' },
  { name: 'knowledge-reflection', cadence: 'weekly' },
  // Unlike bank-holidays — deliberately untracked because a missed week is
  // harmless — a missed weekly risk report is a missed PIP deliverable with a
  // named recipient and a midday deadline. This is the case the board exists for.
  { name: 'weekly-risk-report', cadence: 'weekly' },
];

// Local, not UTC. The Pi may run in UTC and a date built with toISOString()
// flips a day early every evening — the same trap the calendar code documents.
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days between an ISO-ish timestamp and now. null when unparseable. */
function daysSince(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function rows(sql, params) {
  try { return db.all(sql, params) || []; } catch { return []; }
}
function scalar(sql, params, field = 'c') {
  try { return db.get(sql, params)?.[field] ?? 0; } catch { return 0; }
}

/** Turn [{k,c}] into {k: c} so the frontend doesn't have to hunt through arrays. */
function tally(list, key, count = 'c') {
  const out = {};
  for (const r of list) out[r[key]] = r[count];
  return out;
}

/**
 * The date keys of the last `count` days ending on `today`, oldest first. PURE.
 *
 * The strip is a CALENDAR window, not "whatever rows exist". Rendering only the
 * rows that happen to be in `daily_summary` is what made a missing day invisible
 * rather than visibly missing — the same shape as reading an unread domain as a
 * zero, in the one panel built to catch exactly that.
 */
function lastDays(today, count) {
  const out = [];
  const [y, m, d] = String(today).split('-').map(Number);
  for (let i = count - 1; i >= 0; i -= 1) {
    // Constructed as a LOCAL date and formatted with local getters — never
    // toISOString(), which flips the day early every evening under BST.
    const dt = new Date(y, m - 1, d - i);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * One cell per day, from the rollup where it exists and from the log where it
 * does not. PURE — the rule is the product, so it pins without a database.
 *
 * Three states per day, and keeping them apart is the whole point:
 *   * done      — the ritual happened;
 *   * not done  — we can see the day and nothing was logged;
 *   * unknown   — the day is outside what `activity_log` covers at all, so
 *                 nothing here may be read as a skipped ritual.
 *
 * ⚠ The denominator counts KNOWN days only. Counting an unknown day as a miss
 * would make a fresh install, or a pruned log, read as a man who stopped doing
 * his standups.
 */
function foldRituals({ dateKeys, rolled = [], live = [], logFrom = null }) {
  const byKey = new Map();
  for (const r of rolled) byKey.set(r.date_key, r);

  const liveByKey = new Map();
  for (const r of live) {
    const entry = liveByKey.get(r.date_key) || { standup: 0, eod: 0, captures: 0 };
    if (r.event_type === 'standup_done') entry.standup += r.c;
    else if (r.event_type === 'eod_done') entry.eod += r.c;
    else if (r.event_type === 'capture') entry.captures += r.c;
    liveByKey.set(r.date_key, entry);
  }

  const days = dateKeys.map((date_key) => {
    const row = byKey.get(date_key);
    if (row) {
      return {
        date_key,
        standup_done: row.standup_done ? 1 : 0,
        eod_done: row.eod_done ? 1 : 0,
        captures_count: row.captures_count || 0,
        // Rolled up: this is the stored answer, not one derived on the fly.
        rolled: true,
        known: true,
      };
    }
    const l = liveByKey.get(date_key);
    const known = !logFrom || date_key >= logFrom;
    return {
      date_key,
      // ⚠ null, never 0, when the day is outside the log — "I could not look"
      // and "he did not do it" are opposite facts and only one is a judgement.
      standup_done: known ? (l && l.standup ? 1 : 0) : null,
      eod_done: known ? (l && l.eod ? 1 : 0) : null,
      captures_count: known ? (l ? l.captures : 0) : null,
      rolled: false,
      known,
    };
  });

  const knownDays = days.filter((d) => d.known);
  return {
    days,
    standupDays: knownDays.filter((d) => d.standup_done).length,
    eodDays: knownDays.filter((d) => d.eod_done).length,
    window: knownDays.length,
    // Days the strip is showing from the log because the 22:00 rollup has not
    // reached them yet. Surfaced so the panel can say the figures are live
    // rather than silently presenting two different provenances as one.
    pendingRollup: days.filter((d) => d.known && !d.rolled).length,
    unknownDays: days.length - knownDays.length,
  };
}

function snapshot() {
  const today = todayLocal();

  const openTasks = scalar("SELECT COUNT(*) c FROM tasks WHERE status='open'");
  const tasks = {
    open: openTasks,
    done: scalar("SELECT COUNT(*) c FROM tasks WHERE status='done'"),
    moscow: tally(rows("SELECT COALESCE(moscow,'unset') k, COUNT(*) c FROM tasks WHERE status='open' GROUP BY k"), 'k'),
    // priority is 1-3 with NULL meaning never triaged; 0 is the unset bucket.
    unprioritised: scalar("SELECT COUNT(*) c FROM tasks WHERE status='open' AND priority IS NULL"),
    estimated: scalar("SELECT COUNT(*) c FROM tasks WHERE status='open' AND estimate_minutes IS NOT NULL"),
    overdue: scalar("SELECT COUNT(*) c FROM tasks WHERE status='open' AND due_date IS NOT NULL AND due_date < ?", [today]),
    dueToday: scalar("SELECT COUNT(*) c FROM tasks WHERE status='open' AND due_date = ?", [today]),
    noDueDate: scalar("SELECT COUNT(*) c FROM tasks WHERE status='open' AND due_date IS NULL"),
    byContext: rows("SELECT COALESCE(context,'none') k, COUNT(*) c FROM tasks WHERE status='open' GROUP BY k ORDER BY c DESC"),
    bySource: rows("SELECT COALESCE(source,'unknown') k, COUNT(*) c FROM tasks WHERE status='open' GROUP BY k ORDER BY c DESC LIMIT 6"),
  };

  const commitments = {
    open: scalar("SELECT COUNT(*) c FROM waiting_on WHERE status='open'"),
    people: scalar("SELECT COUNT(DISTINCT person) c FROM waiting_on WHERE status='open'"),
    top: rows(`SELECT person, COUNT(*) c, MIN(source_date) oldest
               FROM waiting_on WHERE status='open'
               GROUP BY person ORDER BY c DESC LIMIT 8`)
      .map(r => ({ person: r.person, count: r.c, oldest: r.oldest, ageDays: daysSince(r.oldest) })),
  };

  // What counts as outbound is action-presenter's call, never a list of type
  // names kept here. The first cut hardcoded one and got it wrong immediately:
  // `draft_reply` LOOKS outbound and is classified `write`, because approving it
  // sends nothing — it drafts the words and queues a separate reply_email for a
  // second approval. A dashboard claiming two things would leave the building
  // while the Actions panel says one is worse than no dashboard.
  //
  // getPendingSaraActions defaults to limit 10; passing a real bound matters,
  // since this queue has been 930 deep inside the last week.
  let pendingKinds = {};
  let pendingActions = [];
  try {
    const presenter = require('./action-presenter');
    pendingActions = db.getPendingSaraActions(2000) || [];
    for (const a of pendingActions) {
      const kind = presenter.describe(a)?.kind || 'unknown';
      pendingKinds[kind] = (pendingKinds[kind] || 0) + 1;
    }
  } catch { pendingKinds = {}; }

  const approvals = {
    pending: scalar("SELECT COUNT(*) c FROM sara_actions WHERE status='pending'"),
    pendingByType: tally(rows("SELECT type k, COUNT(*) c FROM sara_actions WHERE status='pending' GROUP BY k"), 'k'),
    pendingByKind: pendingKinds,
    outbound: pendingKinds.outbound || 0,
    lifetime: tally(rows("SELECT status k, COUNT(*) c FROM sara_actions GROUP BY k"), 'k'),
    recent: rows(`SELECT date(created_at) d, COUNT(*) c FROM sara_actions
                  WHERE created_at >= date('now','-13 day') GROUP BY d ORDER BY d`),
  };

  const inbox = {
    open: scalar("SELECT COUNT(*) c FROM inbox_items WHERE dismissed=0"),
    byUrgency: tally(rows("SELECT urgency k, COUNT(*) c FROM inbox_items WHERE dismissed=0 GROUP BY k"), 'k'),
  };

  // 21 days is three weeks of habit — long enough to show a pattern, short
  // enough to fit a row of cells without scrolling on a phone.
  //
  // ⚠ `daily_summary` alone CANNOT answer this, and reading it alone was a lie
  // the panel told every day. `runNightlyRollup()` fires at 22:00 and builds the
  // summary for YESTERDAY, so a day's row does not exist until 22:00 the day
  // after it — the strip lagged by up to 46 hours and today's standup could
  // never appear however early it was done. Found 7 Sep 2026: `activity_log`
  // held `standup_done` at 07:54 that morning and the newest `daily_summary` row
  // was 5 Sep, so Rituals showed a gap where a completed ritual was.
  //
  // The un-rolled days are therefore filled from `activity_log` — deliberately
  // the SAME source `buildDailySummary()` reads, not a second derivation. This
  // is the rollup's own answer computed early, never a second opinion about it.
  const ritualRows = rows(`SELECT date_key, standup_done, eod_done, captures_count
                           FROM daily_summary ORDER BY date_key DESC LIMIT 21`);
  const dateKeys = lastDays(today, 21);
  const live = rows(
    `SELECT date_key, event_type, COUNT(*) c FROM activity_log
      WHERE date_key >= ? AND date_key <= ? GROUP BY date_key, event_type`,
    [dateKeys[0], today]
  );
  // How far back the log itself reaches. A window day earlier than this is
  // UNKNOWN, not a skipped ritual — absence of a log is not evidence of absence.
  const logFrom = db.get('SELECT MIN(date_key) m FROM activity_log')?.m || null;
  const rituals = foldRituals({ dateKeys, rolled: ritualRows, live, logFrom });

  const lastEmbed = db.get("SELECT MAX(embedded_at) m FROM vault_embeddings")?.m || null;
  const vault = {
    chunks: scalar("SELECT COUNT(*) c FROM vault_embeddings"),
    files: scalar("SELECT COUNT(DISTINCT relative_path) c FROM vault_embeddings"),
    entities: scalar("SELECT COUNT(*) c FROM extracted_entities"),
    links: scalar("SELECT COUNT(*) c FROM note_links"),
    lastEmbedAt: lastEmbed,
    lastEmbedDays: daysSince(lastEmbed),
  };

  const stamped = tally(
    rows("SELECT key k, value c FROM agent_state WHERE key LIKE 'scheduler_last_run:%'"), 'k'
  );
  const jobs = TRACKED_JOBS.map(job => {
    const lastRun = stamped[`scheduler_last_run:${job.name}`] || null;
    const age = daysSince(lastRun);
    const limit = job.cadence === 'daily' ? DAILY_STALE_DAYS : WEEKLY_STALE_DAYS;
    return {
      ...job,
      lastRun,
      ageDays: age,
      // Never stamped is its own state, not "very stale" — a job that has never
      // run may simply have been added since the last deploy.
      state: lastRun === null ? 'never' : (age > limit ? 'stale' : 'ok'),
    };
  });

  const calendar = {
    upcoming: rows(`SELECT subject, start_time, show_as FROM calendar_cache
                    WHERE start_time >= datetime('now') ORDER BY start_time LIMIT 5`),
    cached: scalar("SELECT COUNT(*) c FROM calendar_cache"),
  };

  // Completions Microsoft would not take. Read-only, and never allowed to break
  // the board: an unreadable queue reports zeroes rather than 500ing the panel.
  let msPush = { pending: 0, failed: 0, oldestHours: null };
  try {
    const q = require('./ms-push-queue').status();
    msPush = {
      pending: q.pendingCount,
      failed: q.failedCount,
      oldestHours: q.pending.reduce((m, i) => Math.max(m, i.ageHours || 0), 0) || null,
    };
  } catch { /* zeroes */ }

  return {
    generatedAt: new Date().toISOString(),
    tasks, commitments, approvals, inbox, rituals, vault, jobs, calendar, msPush,
  };
}

/**
 * Rank what is actually wrong. Ordered worst-first; the panel renders the top of
 * this list as its focus band, so the ordering IS the product.
 *
 * Severity: critical (something is broken or silently lying) > warn (drifting)
 * > info (worth knowing, not wrong).
 */
function assess(s) {
  const issues = [];
  const add = (severity, title, detail, view) => issues.push({ severity, title, detail, view });

  // The Jira queue card is gone (27 Aug 2026). It reported a cache with no
  // writer — the queue feature was deleted on 3 July and readers were later
  // reintroduced against the rows it left behind. Both halves are now finished:
  // the readers were removed with the cache, so there is no longer a decision
  // outstanding for this panel to chase. Escalations were never part of it and
  // remain live. See db/database.js.

  for (const job of s.jobs) {
    if (job.state === 'stale') {
      add('critical', `${job.name} has stopped`,
        `Last ran ${job.ageDays} days ago (${job.cadence}).`, 'admin');
    } else if (job.state === 'never') {
      // Deliberately info, not warn. Stamping arrived with the catch-up work, so
      // a job whose slot has not come round since that deploy has no stamp and is
      // not faulty — embeddings-rebuild read "never run" on day one while it was
      // demonstrably mid-rebuild. Unknown is not the same as broken, and a board
      // that opens with two false warnings is one nobody reads by week two.
      add('info', `${job.name} has no last-run stamp yet`,
        'Not yet seen since run-tracking was added — it becomes meaningful once its slot has passed once.', 'admin');
    }
  }

  // A task Nick ticked that Microsoft never accepted. `failed` is CRITICAL and
  // outranks a merely pending one: the retrying has stopped, so the task is
  // about to reappear in the mirror as open — work he believes is done, handed
  // back with no explanation unless this says so.
  const ms = s.msPush || {};
  if (ms.failed > 0) {
    add('critical', `${ms.failed} completion${ms.failed === 1 ? '' : 's'} never reached Microsoft`,
      'NEURO has stopped retrying, so these tasks will reappear as open. Reconnect 365, then drain the queue.', 'todos');
  }
  if (ms.pending > 0) {
    add('warn', `${ms.pending} completion${ms.pending === 1 ? ' is' : 's are'} held for Microsoft`,
      `Ticked here, not yet accepted by Graph${ms.oldestHours ? ` (oldest ${ms.oldestHours}h)` : ''}. Retrying every 10 minutes.`, 'todos');
  }

  if (s.approvals.pending > 0) {
    const outbound = s.approvals.outbound || 0;
    add(outbound > 0 ? 'warn' : 'info',
      `${s.approvals.pending} action${s.approvals.pending === 1 ? '' : 's'} awaiting approval`,
      outbound > 0
        ? `${outbound} would send something to a real person (email or Teams). The rest are internal.`
        : 'All internal — nothing here sends anything.',
      'actions');
  }

  if (s.tasks.overdue > 0) {
    add('warn', `${s.tasks.overdue} tasks overdue`,
      'Past their due date and still open.', 'todos');
  }

  // Coverage gaps. These are the fields that make ranking and time-fit work, so
  // an empty one silently degrades those features rather than breaking them.
  if (s.tasks.open > 0 && s.tasks.estimated === 0) {
    add('warn', 'No task has a time estimate',
      `All ${s.tasks.open} open tasks fall back to the assumed 30 minutes, so "what fits" is guessing.`,
      'todos');
  }
  if (s.tasks.open > 0 && s.tasks.noDueDate / s.tasks.open > 0.8) {
    add('info', `${s.tasks.noDueDate} of ${s.tasks.open} tasks have no due date`,
      'Nothing to sort them by but MoSCoW.', 'todos');
  }

  if (s.commitments.open > 0) {
    const worst = s.commitments.top[0];
    add(s.commitments.open > 100 ? 'warn' : 'info',
      `${s.commitments.open} commitments owed to you`,
      worst
        ? `Across ${s.commitments.people} people. Worst: ${worst.person} (${worst.count}, oldest ${worst.ageDays} days).`
        : `Across ${s.commitments.people} people.`,
      'people');
  }

  if (s.rituals.window > 0 && s.rituals.standupDays <= 1) {
    add('info', `Standup logged ${s.rituals.standupDays} day${s.rituals.standupDays === 1 ? '' : 's'} in ${s.rituals.window}`,
      'The accountability chain reads yesterday\'s note, so it has little to work from.', 'standup');
  }

  const severityRank = { critical: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

/** Worst severity present, for the header band. */
function overall(issues) {
  if (issues.some(i => i.severity === 'critical')) return 'critical';
  if (issues.some(i => i.severity === 'warn')) return 'warn';
  return 'ok';
}

module.exports = { snapshot, assess, overall, TRACKED_JOBS, foldRituals, _internals: { daysSince, todayLocal, lastDays } };
