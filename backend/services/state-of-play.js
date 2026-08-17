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

  const jiraFetched = db.get("SELECT MAX(fetched_at) m FROM jira_tickets_cache")?.m || null;
  const queue = {
    cached: scalar("SELECT COUNT(*) c FROM jira_tickets_cache"),
    atRisk: scalar("SELECT COUNT(*) c FROM jira_tickets_cache WHERE at_risk=1"),
    byStatus: rows("SELECT status k, COUNT(*) c FROM jira_tickets_cache GROUP BY k ORDER BY c DESC"),
    fetchedAt: jiraFetched,
    staleDays: daysSince(jiraFetched),
  };

  const inbox = {
    open: scalar("SELECT COUNT(*) c FROM inbox_items WHERE dismissed=0"),
    byUrgency: tally(rows("SELECT urgency k, COUNT(*) c FROM inbox_items WHERE dismissed=0 GROUP BY k"), 'k'),
  };

  // 21 days is three weeks of habit — long enough to show a pattern, short
  // enough to fit a row of cells without scrolling on a phone.
  const ritualRows = rows(`SELECT date_key, standup_done, eod_done, captures_count
                           FROM daily_summary ORDER BY date_key DESC LIMIT 21`);
  const rituals = {
    days: ritualRows.slice().reverse(),
    standupDays: ritualRows.filter(r => r.standup_done).length,
    eodDays: ritualRows.filter(r => r.eod_done).length,
    window: ritualRows.length,
  };

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

  return {
    generatedAt: new Date().toISOString(),
    tasks, commitments, approvals, queue, inbox, rituals, vault, jobs, calendar,
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

  // Stale caches first. A stale cache is worse than a big number, because a big
  // number is at least true — a stale one is a screen quietly showing fiction.
  if (s.queue.staleDays !== null && s.queue.staleDays > DAILY_STALE_DAYS) {
    add('critical', 'Jira queue cache is stale',
      `Last fetched ${s.queue.staleDays} days ago — the queue figures on every other screen are that old.`,
      'escalations');
  }

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

module.exports = { snapshot, assess, overall, TRACKED_JOBS, _internals: { daysSince, todayLocal } };
