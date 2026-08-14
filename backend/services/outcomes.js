'use strict';

/**
 * Outcomes — does any of this actually work?
 *
 * Everything else in NEURO measures the machine: Pi temperature, provider mix,
 * queue depth, sync status. Nothing measured whether the system was helping the
 * person it was built for, which meant every decision about what to build next
 * was taste rather than evidence.
 *
 * Seven signals, all derived from data already being collected. No new
 * instrumentation — this is a rollup and a view.
 *
 * The one that matters most is nagPressure. If snoozes and dismissals climb
 * while everything else looks healthy, the system is generating compliance
 * rather than help, and the right response is to build LESS. A measurement
 * layer that can only ever justify more features is not measuring anything.
 *
 * Snapshots are stored per ISO week rather than recomputed from history, so a
 * later change to how a metric is defined doesn't silently rewrite the past.
 */

const db = require('../db/database');

// Finished work only. Captures and chat messages are deliberately excluded:
// capturing a thought is valuable but it is not progress, and counting it lets
// a day of pure input read as a productive one.
const DONE_EVENTS = new Set([
  'task_done', 'plan_task_done', 'standup_done', 'eod_done',
  'one_two_one_done', 'escalation_resolved',
]);

function _dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Monday of the week containing `d`. Weeks are Mon-Sun. */
function weekStart(d = new Date()) {
  const day = d.getDay();
  const back = day === 0 ? 6 : day - 1;
  const monday = _addDays(d, -back);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** ISO-ish week key, e.g. 2026-W33. Stable, sortable, one row per week. */
function weekKey(d = new Date()) {
  const monday = weekStart(d);
  const jan1 = new Date(monday.getFullYear(), 0, 1);
  const week = Math.ceil(((monday - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${monday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function _parse(row) {
  if (!row.event_data) return {};
  try { return JSON.parse(row.event_data); } catch { return {}; }
}

/**
 * Compute the week's outcomes from the activity log and the live stores.
 *
 * Deliberately tolerant: every section is wrapped, because a metric that throws
 * must not take the whole rollup with it. A missing number is recoverable; a
 * missing week is a hole in the trend forever.
 */
function computeWeek(anchor = new Date()) {
  const monday = weekStart(anchor);
  const sunday = _addDays(monday, 6);
  const from = _dateStr(monday);
  const to = _dateStr(sunday);

  let rows = [];
  try { rows = db.getActivityForRange(from, to); } catch (e) {
    console.warn('[Outcomes] Activity read failed:', e.message);
  }

  const count = (type) => rows.filter(r => r.event_type === type).length;

  // ── Finished work ──
  const finished = rows.filter(r => DONE_EVENTS.has(r.event_type));
  const byDay = {};
  for (const r of finished) byDay[r.date_key] = (byDay[r.date_key] || 0) + 1;

  // ── Rituals: how many working days had one ──
  const standupDays = new Set(rows.filter(r => r.event_type === 'standup_done').map(r => r.date_key));
  const eodDays = new Set(rows.filter(r => r.event_type === 'eod_done').map(r => r.date_key));

  // ── Nag pressure — the honest one ──
  const snoozed = count('nudge_snoozed');
  const dismissed = count('nudge_dismissed');

  // ── Suggestion quality: a low approval rate means bad suggestions, and bad
  // suggestions train you to stop reading them. ──
  let actions = { executed: 0, rejected: 0, pending: 0 };
  try {
    const recent = db.getRecentSaraActions(200)
      .filter(a => (a.created_at || '') >= from);
    for (const a of recent) {
      if (a.status === 'executed') actions.executed++;
      else if (a.status === 'rejected') actions.rejected++;
      else if (a.status === 'pending') actions.pending++;
    }
  } catch (e) { console.warn('[Outcomes] Actions read failed:', e.message); }

  // ── Surface reach: if Today and Tasks are not opened, nothing above matters ──
  const tabs = {};
  for (const r of rows.filter(r => r.event_type === 'tab_open')) {
    const name = _parse(r).tabName || _parse(r).tab || 'unknown';
    tabs[name] = (tabs[name] || 0) + 1;
  }

  // ── Carried commitments: the thing chasing is meant to reduce ──
  let carried = null;
  try {
    const acc = require('./standup-accountability').buildAccountability();
    carried = {
      open: (acc?.openCommitments || []).length,
      stale: (acc?.openCommitments || []).filter(c => c.daysCarried >= 3).length,
    };
  } catch (e) { console.warn('[Outcomes] Accountability read failed:', e.message); }

  // ── Task pile: is the backlog growing or shrinking? ──
  let tasks = null;
  try {
    const counts = require('./task-store').counts();
    tasks = { open: counts.open ?? null, done: counts.done ?? null };
  } catch (e) { console.warn('[Outcomes] Task counts failed:', e.message); }

  const totalActions = actions.executed + actions.rejected;

  return {
    week: weekKey(anchor),
    from,
    to,
    computedAt: new Date().toISOString(),
    finished: {
      total: finished.length,
      byDay,
      // Working days with at least one finished thing — a truer read than a
      // total, which one heavy Tuesday can carry on its own.
      activeDays: Object.keys(byDay).length,
    },
    rituals: {
      standupDays: standupDays.size,
      eodDays: eodDays.size,
    },
    nagPressure: {
      snoozed,
      dismissed,
      total: snoozed + dismissed,
    },
    suggestions: {
      ...actions,
      approvalRate: totalActions ? Math.round((actions.executed / totalActions) * 100) : null,
    },
    reach: tabs,
    carried,
    tasks,
    captures: count('capture'),
  };
}

/** Persist a week's snapshot. Keyed per week, so re-running just overwrites. */
function snapshot(anchor = new Date()) {
  const data = computeWeek(anchor);
  try {
    db.setState(`outcomes_${data.week}`, JSON.stringify(data));
    console.log(`[Outcomes] ${data.week}: ${data.finished.total} finished, nag ${data.nagPressure.total}, approval ${data.suggestions.approvalRate ?? '—'}%`);
  } catch (e) {
    console.error('[Outcomes] Snapshot write failed:', e.message);
  }
  return data;
}

/**
 * The last `n` weeks, oldest first. Stored snapshots where they exist, computed
 * live for the current week so the view is never a week behind.
 */
function recent(n = 8) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const anchor = _addDays(weekStart(now), -7 * i);
    const key = weekKey(anchor);
    if (i === 0) { out.push(computeWeek(anchor)); continue; }
    try {
      const raw = db.getState(`outcomes_${key}`);
      if (raw) { out.push(JSON.parse(raw)); continue; }
    } catch {}
    // No snapshot for that week — say so rather than back-filling a computed
    // number that would look like a reading nobody actually took.
    out.push({ week: key, from: _dateStr(anchor), missing: true });
  }
  return out;
}

/**
 * Compare this week to the last few, and say what moved. Direction is what
 * matters here — a single week's number means very little on its own.
 */
function trend(n = 5) {
  const weeks = recent(n).filter(w => !w.missing);
  if (weeks.length < 2) return { enough: false, weeks: weeks.length };

  const current = weeks[weeks.length - 1];
  const prior = weeks.slice(0, -1);
  const avg = (pick) => {
    const vals = prior.map(pick).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const delta = (now, before) => (before == null || before === 0 ? null : Math.round(((now - before) / before) * 100));

  return {
    enough: true,
    week: current.week,
    finished: { now: current.finished.total, avg: avg(w => w.finished.total), changePct: delta(current.finished.total, avg(w => w.finished.total)) },
    // Falling nag pressure is GOOD, so the sign is interpreted at the surface,
    // not here. This layer reports movement; it does not editorialise.
    nagPressure: { now: current.nagPressure.total, avg: avg(w => w.nagPressure.total), changePct: delta(current.nagPressure.total, avg(w => w.nagPressure.total)) },
    carriedStale: { now: current.carried?.stale ?? null, avg: avg(w => w.carried?.stale) },
    approvalRate: { now: current.suggestions.approvalRate, avg: avg(w => w.suggestions.approvalRate) },
  };
}

module.exports = { computeWeek, snapshot, recent, trend, weekKey, weekStart };
