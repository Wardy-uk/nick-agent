'use strict';

/**
 * Working Memory — persistent context cache with observations.
 *
 * Phase 2c: expanded beyond simple cache to include:
 *   - Short-lived observations (queue changes, snooze patterns, etc.)
 *   - Cross-refresh continuity (observations survive cache refresh)
 *   - Daily note writing (append-only NEURO Observations section)
 *
 * Still deterministic. No LLM calls.
 */

const db = require('../db/database');

const TTL_MS = 10 * 60 * 1000; // 10 minutes

let _cache = null;
let _lastRefresh = 0;
let _refreshing = false;

// ── Observations ──
// Short-lived observations that survive cache refreshes.
// Each observation: { type, message, timestamp, data }
// Max 50 observations, auto-pruned after 8 hours.
const _observations = [];
const MAX_OBSERVATIONS = 50;
const OBSERVATION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Previous state snapshot for change detection
let _prevEscalationCount = null;

/**
 * Get the current working context, refreshing if stale.
 */
async function getContext() {
  const now = Date.now();
  if (_cache && (now - _lastRefresh) < TTL_MS) {
    return _cache;
  }
  return refresh();
}

/**
 * Force a full refresh of the working context.
 */
async function refresh() {
  if (_refreshing) {
    return _cache || _buildEmpty();
  }

  _refreshing = true;
  try {
    const vaultCache = require('./vault-cache');
    const t0 = Date.now();

    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;
    const isWorkHours = !isWeekend && hour >= 8 && hour <= 18;

    // Vault todos (CACHED — only re-parses if files changed)
    let todos = null;
    try { todos = vaultCache.getTodos(); } catch {}

    // 90-day plan (CACHED — only re-parses if file changed)
    let ninetyDayPlan = null;
    try { ninetyDayPlan = vaultCache.getPlan(); } catch (e) { console.warn('[WorkingMemory] getPlan failed:', e.message); }

    // Merge in ONLY the plan tasks that are actionable this fortnight.
    //
    // Tasks/Task System Boundary.md (10 Jul 2026) is explicit: plan deliverables
    // are tracked in the plan and reach the task queue "only if actionable this
    // fortnight". Merging the plan wholesale took overdue from 7 to 101 and
    // recreated the failure that doc was written to fix — "a list of 1,161 items
    // is functionally a list of zero items".
    //
    // A finished plan's leftovers are not 73 tasks, they're one unmade decision;
    // collectPlanClosure() in the decision engine raises that separately.
    let planSummary = null;
    try {
      const planTasks = vaultCache.getPlanTasks();
      const windowMs = 14 * 86400000;
      const todayMs = new Date(dateKey).getTime();
      const actionable = planTasks.filter((t) => {
        if (!t.due_date) return false;
        const due = new Date(t.due_date.split('T')[0]).getTime();
        return Math.abs(due - todayMs) <= windowMs;
      });
      if (todos && actionable.length) {
        todos = { ...todos, active: [...(todos.active || []), ...actionable] };
      }

      const totalDays = ninetyDayPlan?.totalDays || 90;
      const currentDay = ninetyDayPlan?.currentDay || 0;
      planSummary = {
        over: Boolean(ninetyDayPlan) && currentDay > totalDays,
        unfinished: planTasks.length,
        surfaced: actionable.length,
        currentDay,
        totalDays,
      };
    } catch (e) { console.warn('[WorkingMemory] plan task merge failed:', e.message); }

    // Today's calendar (fast — SQLite)
    let calendar = [];
    try {
      const todayStr = dateKey;
      const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
      calendar = db.getCalendarEvents(todayStr, tomorrowStr);
    } catch {}

    // Active nudges (fast — SQLite)
    let nudges = [];
    try { nudges = db.getActiveNudges(); } catch {}

    // Today's activity (fast — SQLite)
    let todayActivity = [];
    try { todayActivity = db.getActivityForDate(dateKey); } catch {}

    // Daily note (CACHED — only re-reads if file changed)
    let dailyNote = null;
    try { dailyNote = vaultCache.getDailyNote(); } catch {}

    // Escalation count
    let unseenEscalations = 0;
    try {
      const jira = require('./jira');
      unseenEscalations = jira.getUnseenEscalationCount ? jira.getUnseenEscalationCount() : 0;
    } catch {}

    // Pending imports count
    let pendingImports = 0;
    try {
      const imports = require('./imports');
      const pending = imports.getPending();
      pendingImports = pending.length;
    } catch {}

    // ── Detect changes and record observations ──
    _detectChanges(unseenEscalations, nudges, todayActivity);

    // ── Snooze pattern detection ──
    const snoozeCount = todayActivity.filter(a => a.event_type === 'nudge_snoozed').length;
    const dismissCount = todayActivity.filter(a => a.event_type === 'nudge_dismissed').length;

    // Prune old observations
    _pruneObservations();

    _cache = {
      refreshedAt: Date.now(),
      dateKey,
      timeContext: { hour, day, isWeekend, isWorkHours },
      todos,
      ninetyDayPlan,
      planSummary,
      calendar,
      nudges,
      todayActivity,
      dailyNote: dailyNote ? true : false,
      unseenEscalations,
      pendingImports,
      userActiveToday: todayActivity.length > 0,
      standupDone: todayActivity.some(a => a.event_type === 'standup_done'),
      eodDone: todayActivity.some(a => a.event_type === 'eod_done'),
      // Phase 2c additions
      observations: _observations.slice(), // copy
      snoozeCount,
      dismissCount,
    };

    _lastRefresh = Date.now();
    console.log(`[WorkingMemory] Context refreshed in ${Date.now() - t0}ms`);
    return _cache;
  } catch (e) {
    console.error('[WorkingMemory] Refresh failed:', e.message);
    return _cache || _buildEmpty();
  } finally {
    _refreshing = false;
  }
}

function _detectChanges(unseenEscalations, nudges, todayActivity) {
  // New escalations
  if (_prevEscalationCount !== null && unseenEscalations > _prevEscalationCount) {
    _addObservation('new_escalation', `New escalation detected (${unseenEscalations} unseen)`, { count: unseenEscalations });
  }
  _prevEscalationCount = unseenEscalations;

  // Repeated snoozing (check today's activity)
  const snoozeCount = todayActivity.filter(a => a.event_type === 'nudge_snoozed').length;
  if (snoozeCount >= 5 && !_hasRecentObservation('snooze_pattern', 60)) {
    _addObservation('snooze_pattern', `${snoozeCount} snoozes today — possible avoidance pattern`, { count: snoozeCount });
  }

  // Standup still pending late
  const hour = new Date().getHours();
  const standupDone = todayActivity.some(a => a.event_type === 'standup_done');
  const isWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
  if (isWeekday && hour >= 11 && !standupDone && !_hasRecentObservation('standup_late', 120)) {
    _addObservation('standup_late', `Standup still pending at ${hour}:00`, { hour });
  }
}

function _addObservation(type, message, data = {}) {
  _observations.push({
    type,
    message,
    timestamp: Date.now(),
    data,
  });
  // Cap size
  while (_observations.length > MAX_OBSERVATIONS) {
    _observations.shift();
  }
  console.log(`[WorkingMemory] Observation: ${message}`);
}

function _hasRecentObservation(type, withinMinutes) {
  const cutoff = Date.now() - (withinMinutes * 60 * 1000);
  return _observations.some(o => o.type === type && o.timestamp > cutoff);
}

function _pruneObservations() {
  const cutoff = Date.now() - OBSERVATION_TTL_MS;
  while (_observations.length > 0 && _observations[0].timestamp < cutoff) {
    _observations.shift();
  }
}

/**
 * Get recent observations, optionally filtered by type.
 */
function getObservations(type = null) {
  _pruneObservations();
  if (type) return _observations.filter(o => o.type === type);
  return _observations.slice();
}

/**
 * Write today's observations to the daily note (append-only).
 * Called by scheduler at EOD or on demand.
 * Only writes if there are observations and the section doesn't already exist.
 */
function writeObservationsToDaily() {
  if (_observations.length === 0) return false;

  try {
    const obsidian = require('./obsidian');
    const dailyNote = obsidian.readTodayDailyNote();

    // Don't write if section already exists
    if (dailyNote && dailyNote.includes('## NEURO Observations')) return false;

    const lines = _observations.map(o => {
      const time = new Date(o.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `- ${time} — ${o.message}`;
    });

    const section = `\n\n## NEURO Observations\n${lines.join('\n')}\n`;
    obsidian.appendToDailyNote(section);
    console.log(`[WorkingMemory] Wrote ${_observations.length} observations to daily note`);
    return true;
  } catch (e) {
    console.warn('[WorkingMemory] Failed to write observations:', e.message);
    return false;
  }
}

function invalidate(reason) {
  _lastRefresh = 0;
  if (reason) {
    console.log(`[WorkingMemory] Invalidated: ${reason}`);
  }
}

function getCacheAge() {
  if (!_cache) return null;
  return Date.now() - _lastRefresh;
}

function _buildEmpty() {
  return {
    refreshedAt: 0,
    dateKey: new Date().toISOString().split('T')[0],
    timeContext: { hour: new Date().getHours(), day: new Date().getDay(), isWeekend: false, isWorkHours: false },
    todos: null,
    ninetyDayPlan: null,
    planSummary: null,
    calendar: [],
    nudges: [],
    todayActivity: [],
    dailyNote: false,
    unseenEscalations: 0,
    pendingImports: 0,
    userActiveToday: false,
    standupDone: false,
    eodDone: false,
    observations: [],
    snoozeCount: 0,
    dismissCount: 0,
  };
}

module.exports = {
  getContext,
  refresh,
  invalidate,
  getCacheAge,
  getObservations,
  writeObservationsToDaily,
};
