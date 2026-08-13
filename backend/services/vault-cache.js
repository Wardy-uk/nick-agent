'use strict';

/**
 * Vault Cache — mtime-based caching for expensive vault parse operations.
 *
 * Caches:
 *   - parseVaultTodos() result
 *   - parseNinetyDayPlan() result
 *   - listPeopleNotes() result
 *   - readTodayDailyNote() result
 *
 * Invalidation: file mtime check (fast stat call vs full parse).
 * Also invalidated by vault-hooks.js on writes.
 *
 * All methods are synchronous or return the same types as the originals.
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// ── Cache entries ──
const _cache = {
  todos: { data: null, mtimes: null, at: 0 },
  plan: { data: null, mtime: null, at: 0 },
  people: { data: null, mtime: null, at: 0 },
  dailyNote: { data: null, mtime: null, at: 0, dateKey: null },
};

// ── Scored tasks cache ──
let _scoredTasks = { data: null, filter: null, dateKey: null, hash: null, at: 0 };
const SCORED_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// ── Telemetry ──
const _perf = { hits: 0, misses: 0 };

/**
 * Get mtime of a file, or 0 if not found.
 */
function _mtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Get mtimes for the todo source files.
 */
function _todoMtimes() {
  if (!VAULT_PATH) return null;
  return {
    master: _mtime(path.join(VAULT_PATH, 'Tasks', 'Master Todo.md')),
    ms: _mtime(path.join(VAULT_PATH, 'Tasks', 'Microsoft Tasks.md')),
    daily: _mtime(path.join(VAULT_PATH, 'Daily')), // directory mtime changes when files added/modified
    // Tasks NEURO owns live in the DB, whose writes touch no vault file. Without the
    // revision counter an edited MoSCoW stays stale until some unrelated file changes.
    tasks: _taskRevision(),
  };
}

function _taskRevision() {
  try {
    return require('./task-store').getRevision();
  } catch {
    return 0;
  }
}

function _mtimesEqual(a, b) {
  if (!a || !b) return false;
  return a.master === b.master && a.ms === b.ms && a.daily === b.daily && a.tasks === b.tasks;
}

/**
 * Cached parseVaultTodos().
 * Returns the same shape as obsidian.parseVaultTodos().
 * Only re-parses if source files have changed.
 */
function getTodos() {
  const mtimes = _todoMtimes();
  if (_cache.todos.data && _mtimesEqual(_cache.todos.mtimes, mtimes)) {
    _perf.hits++;
    return _cache.todos.data;
  }

  _perf.misses++;
  const t0 = Date.now();
  const obsidian = require('./obsidian');
  const data = obsidian.parseVaultTodos();
  console.log(`[VaultCache] parseVaultTodos: ${Date.now() - t0}ms (miss)`);

  _cache.todos = { data, mtimes, at: Date.now() };
  return data;
}

/**
 * Cached parseNinetyDayPlan().
 */
function getPlan() {
  if (!VAULT_PATH) return null;
  const planPath = path.join(VAULT_PATH, 'Projects', '90 Day Plan', '90 Day Plan - Daily Tasks.md');
  const mtime = _mtime(planPath);

  if (_cache.plan.data && _cache.plan.mtime === mtime) {
    _perf.hits++;
    return _cache.plan.data;
  }

  _perf.misses++;
  const t0 = Date.now();
  const obsidian = require('./obsidian');
  const data = obsidian.parseNinetyDayPlan();
  console.log(`[VaultCache] parseNinetyDayPlan: ${Date.now() - t0}ms (miss)`);

  _cache.plan = { data, mtime, at: Date.now() };
  return data;
}

/**
 * Cached listPeopleNotes().
 * Directory scan is cheap but called per-email in scoring — cache it.
 */
function getPeopleIndex() {
  if (!VAULT_PATH) return [];
  const peopleDir = path.join(VAULT_PATH, 'People');
  const mtime = _mtime(peopleDir);

  if (_cache.people.data && _cache.people.mtime === mtime) {
    _perf.hits++;
    return _cache.people.data;
  }

  _perf.misses++;
  const obsidian = require('./obsidian');
  const data = obsidian.listPeopleNotes();
  _cache.people = { data, mtime, at: Date.now() };
  return data;
}

/**
 * Cached readTodayDailyNote().
 * Only re-reads if file mtime changed or date rolled over.
 */
function getDailyNote() {
  if (!VAULT_PATH) return null;
  const dateKey = new Date().toISOString().split('T')[0];
  const notePath = path.join(VAULT_PATH, 'Daily', `${dateKey}.md`);
  const mtime = _mtime(notePath);

  if (_cache.dailyNote.data !== undefined &&
      _cache.dailyNote.mtime === mtime &&
      _cache.dailyNote.dateKey === dateKey) {
    _perf.hits++;
    return _cache.dailyNote.data;
  }

  _perf.misses++;
  const obsidian = require('./obsidian');
  const data = obsidian.readTodayDailyNote();
  _cache.dailyNote = { data, mtime, at: Date.now(), dateKey };
  return data;
}

/**
 * Cached scored tasks for drill-down.
 * Keyed by filter + dateKey + todo mtime hash.
 */
function getScoredTasks(filter, ranker) {
  const dateKey = new Date().toISOString().split('T')[0];
  const mtimes = _todoMtimes();
  const hash = mtimes ? `${mtimes.master}:${mtimes.ms}:${mtimes.daily}:${mtimes.tasks}` : 'none';
  const now = Date.now();

  if (_scoredTasks.data &&
      _scoredTasks.filter === filter &&
      _scoredTasks.dateKey === dateKey &&
      _scoredTasks.hash === hash &&
      (now - _scoredTasks.at) < SCORED_CACHE_TTL) {
    _perf.hits++;
    return _scoredTasks.data;
  }

  _perf.misses++;
  const t0 = Date.now();
  const data = ranker(); // caller provides the ranking function
  console.log(`[VaultCache] scoredTasks(${filter}): ${Date.now() - t0}ms (miss)`);

  _scoredTasks = { data, filter, dateKey, hash, at: now };
  return data;
}

/**
 * Invalidate all caches. Called by vault-hooks on write.
 */
function invalidate(reason) {
  _cache.todos = { data: null, mtimes: null, at: 0 };
  _cache.plan = { data: null, mtime: null, at: 0 };
  _cache.people = { data: null, mtime: null, at: 0 };
  _cache.dailyNote = { data: null, mtime: null, at: 0, dateKey: null };
  _scoredTasks = { data: null, filter: null, dateKey: null, hash: null, at: 0 };
  if (reason) console.log(`[VaultCache] Invalidated: ${reason}`);
}

/**
 * Invalidate specific cache by type.
 */
function invalidateType(type) {
  if (type === 'todos' || type === 'all') {
    _cache.todos = { data: null, mtimes: null, at: 0 };
    _scoredTasks = { data: null, filter: null, dateKey: null, hash: null, at: 0 };
  }
  if (type === 'plan' || type === 'all') {
    _cache.plan = { data: null, mtime: null, at: 0 };
  }
  if (type === 'people' || type === 'all') {
    _cache.people = { data: null, mtime: null, at: 0 };
  }
  if (type === 'daily' || type === 'all') {
    _cache.dailyNote = { data: null, mtime: null, at: 0, dateKey: null };
  }
}

function getStats() {
  return { hits: _perf.hits, misses: _perf.misses };
}

// 90-Day Plan tasks, normalised to the same shape parseVaultTodos() returns.
//
// The plan lives in its own file, so it was only ever surfaced by /api/todos —
// which mapped it inline for the frontend. The decision engine reads
// getTodos() instead, so all ~73 plan tasks were invisible to Focus and to the
// briefing. This is the engine-facing view of the same data.
function getPlanTasks() {
  let plan = null;
  try { plan = getPlan(); } catch { return []; }
  if (!plan) return [];

  const OUTCOMES = {
    1: 'Visibility & BI', 2: 'Tiered Model', 3: 'Quality & CX',
    4: 'People & Culture', 5: 'Cross-functional', 6: 'Production'
  };

  const out = [];
  for (const t of plan.allTasks || []) {
    if (t.isCheckpoint) continue;
    if (t.status === 'x') continue;            // active only — done tasks aren't signals
    const isOverdue = t.day > 0 && t.day < plan.currentDay;
    const outcomeLabel = t.outcome ? OUTCOMES[t.outcome] || '' : '';
    out.push({
      text: t.text,
      due_date: t.calendarDate || null,
      priority: isOverdue ? 'high' : (t.day === plan.currentDay ? 'normal' : 'low'),
      source: `90-Day Plan${outcomeLabel ? ` (${outcomeLabel})` : ''}`,
      status: ' ',
      filePath: plan.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null,
    });
  }
  return out;
}

module.exports = {
  getTodos,
  getPlanTasks,
  getPlan,
  getPeopleIndex,
  getDailyNote,
  getScoredTasks,
  invalidate,
  invalidateType,
  getStats,
};
