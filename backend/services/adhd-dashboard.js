'use strict';

/**
 * ADHD dashboard — the "help me actually function today" view.
 *
 * The rest of NEURO answers "what is true?". This answers a different question:
 * "what does an ADHD brain need on the screen right now to get moving?" Those
 * pull in opposite directions, so the rules here are deliberate:
 *
 *   1. ONE thing, never a list. A list of 101 overdue tasks is a threat display —
 *      it restates the anxiety instead of giving somewhere to start. Everything
 *      else on this page is support for the one thing.
 *   2. Evidence of progress, prominently. ADHD memory drops completed work, so
 *      the day feels like nothing happened even when it didn't. Wins get shown
 *      back with the same weight as what's outstanding.
 *   3. Avoidance named as data, never as judgement. "Snoozed 5 times" is a fact
 *      that helps. "You keep avoiding this" is shame, and shame feeds the loop.
 *   4. Quick wins available on demand. Activation energy is the blocker, so
 *      there is always a 2-minute option when the main thing is too big.
 *   5. Counts are shown next to what to DO about them, or not at all.
 *
 * Deterministic — no LLM. Same discipline as the decision engine, and for the
 * same reason: this has to be instant and identical every time it loads.
 */

const db = require('../db/database');

const QUICK_WIN_MAX_WORDS = 9;

// Verbs that usually front a small, closeable action. Deliberately narrow —
// a false "quick win" that turns out to be an hour is worse than none at all,
// because it teaches you not to trust the panel.
const QUICK_WIN_VERBS = /^(reply|respond|email|message|call|ring|ping|send|forward|approve|sign|book|schedule|confirm|check|read|review|share|post|update|add|log|file|chase|ask|tell|remind|order|pay|cancel|accept|decline)\b/i;

// Anything with these in it is not a quick win however short the line is.
const NOT_QUICK = /\b(plan|design|draft|write up|write-up|build|rebuild|implement|migrate|investigate|analyse|analyze|research|restructure|rewrite|strategy|framework|roadmap|proposal|policy)\b/i;

function _dateKey(d = new Date()) {
  return d.toISOString().split('T')[0];
}

function _daysAgoKey(n) {
  return _dateKey(new Date(Date.now() - n * 86400000));
}

function _parseData(row) {
  if (!row.event_data) return {};
  try { return JSON.parse(row.event_data); } catch { return {}; }
}

// ── Momentum ─────────────────────────────────────────────────────────────────

/**
 * What has actually moved, today and over the last week.
 *
 * "Done" counts finished work only — tasks completed, rituals done, 1-2-1s held,
 * escalations resolved. Deliberately NOT captures or chat messages: capturing a
 * thought is valuable but it is not progress, and counting it would let a day of
 * pure input read as a productive one.
 */
function _momentum(dateKey) {
  const DONE_EVENTS = new Set([
    'task_done', 'plan_task_done', 'standup_done', 'eod_done',
    'one_two_one_done', 'escalation_resolved',
  ]);

  const week = db.getActivityForRange(_daysAgoKey(6), dateKey);
  const byDay = new Map();
  for (const row of week) {
    if (!DONE_EVENTS.has(row.event_type)) continue;
    byDay.set(row.date_key, (byDay.get(row.date_key) || 0) + 1);
  }

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const key = _daysAgoKey(i);
    last7.push({ date: key, done: byDay.get(key) || 0 });
  }

  const today = week.filter(r => r.date_key === dateKey);
  const rituals = {
    standup: today.some(r => r.event_type === 'standup_done'),
    eod: today.some(r => r.event_type === 'eod_done'),
  };

  // Streak = consecutive days back from today with any finished work. Today not
  // counting yet is not a broken streak — it's a day in progress, so the count
  // starts from yesterday when today is still empty.
  let streak = 0;
  for (let i = (byDay.get(dateKey) ? 0 : 1); i < 60; i++) {
    const key = _daysAgoKey(i);
    const day = new Date(key).getDay();
    if (day === 0 || day === 6) continue; // weekends don't break a work streak
    if (!byDay.get(key)) break;
    streak++;
  }

  return {
    doneToday: byDay.get(dateKey) || 0,
    streakDays: streak,
    rituals,
    last7,
    best7: last7.reduce((max, d) => Math.max(max, d.done), 0),
  };
}

// ── Wins ─────────────────────────────────────────────────────────────────────

/**
 * Today's finished work, newest first, as things you can read back.
 *
 * Sorted on id rather than reversing the query: several wins can land inside the
 * same second, and created_at ties come back in no guaranteed order.
 */
function _winsToday(dateKey) {
  const rows = db.getActivityForDate(dateKey);
  const wins = [];

  for (const row of rows) {
    const data = _parseData(row);
    const time = (row.created_at || '').slice(11, 16);
    let text = null;

    switch (row.event_type) {
      case 'task_done': text = data.text || 'Task completed'; break;
      case 'plan_task_done': if (data.done) text = `90-day plan: ${data.taskText || 'task'}`; break;
      case 'standup_done': text = 'Standup done'; break;
      case 'eod_done': text = 'End of day done'; break;
      case 'one_two_one_done': text = `1-2-1 with ${data.personName || 'a report'}`; break;
      case 'escalation_resolved': text = `Escalation resolved: ${data.ticketKey || ''}`.trim(); break;
      default: break;
    }
    if (text) wins.push({ id: row.id, time, text, kind: row.event_type });
  }

  return wins.sort((a, b) => b.id - a.id).map(({ id, ...win }) => win);
}

// ── Avoidance radar ──────────────────────────────────────────────────────────

/**
 * What is being pushed away, stated as fact.
 *
 * Three signals, all persisted (the decision engine's dismiss history is
 * in-memory and resets on restart, so it is not trustworthy here):
 *   - nudges snoozed or dismissed repeatedly, by type
 *   - the stalest high-signal task, via todo-intelligence
 *   - tasks that have sat open a long time without ever being touched
 *
 * Tone rule: every entry says what happened and how long. None of them says
 * what it means about Nick.
 */
function _avoidance(dateKey) {
  const signals = [];
  const week = db.getActivityForRange(_daysAgoKey(6), dateKey);

  const counts = new Map();
  for (const row of week) {
    if (row.event_type !== 'nudge_snoozed' && row.event_type !== 'nudge_dismissed') continue;
    const type = _parseData(row).nudgeType || _parseData(row).type || 'reminder';
    const entry = counts.get(type) || { type, snoozed: 0, dismissed: 0 };
    if (row.event_type === 'nudge_snoozed') entry.snoozed++;
    else entry.dismissed++;
    counts.set(type, entry);
  }

  for (const entry of counts.values()) {
    const total = entry.snoozed + entry.dismissed;
    if (total < 3) continue; // once or twice is a busy day, not a pattern
    signals.push({
      kind: 'nudge',
      label: `${entry.type} reminder`,
      detail: `pushed back ${total} time${total === 1 ? '' : 's'} this week`,
      count: total,
    });
  }

  try {
    const { active } = require('./obsidian').parseVaultTodos();
    const stale = require('./todo-intelligence').buildFollowThroughCandidate(active);
    if (stale) {
      signals.push({
        kind: 'task',
        label: stale.text,
        detail: stale.message || 'on your list a while, untouched',
        count: null,
      });
    }
  } catch { /* vault unavailable — the nudge signals still stand on their own */ }

  try {
    const taskStore = require('./task-store');
    const now = Date.now();
    const old = taskStore.listTasks({ status: 'all', includeDone: false })
      .filter(t => (t.status === 'open' || t.status === 'in-progress') && t.created_at)
      .map(t => ({
        ...t,
        ageDays: Math.floor((now - new Date(String(t.created_at).replace(' ', 'T')).getTime()) / 86400000),
      }))
      .filter(t => t.ageDays >= 21 && t.moscow === 'must')
      .sort((a, b) => b.ageDays - a.ageDays);

    if (old.length) {
      signals.push({
        kind: 'task',
        label: old[0].text,
        detail: `marked must-do ${old[0].ageDays} days ago, still open`,
        count: old.length > 1 ? old.length : null,
      });
    }
  } catch { /* task store unavailable */ }

  return {
    signals: signals.slice(0, 4),
    snoozesToday: db.getActivityForDate(dateKey).filter(r => r.event_type === 'nudge_snoozed').length,
  };
}

// ── Quick wins ───────────────────────────────────────────────────────────────

/**
 * Small, closeable things — the way back in when the main task is too big.
 *
 * Short line, action verb, no project words. Overdue items are excluded on
 * purpose: an overdue task is not a low-stakes warm-up, and offering one as a
 * "quick win" is how a five-minute detour becomes the whole afternoon.
 */
function _quickWins(todos, dateKey) {
  const wins = [];

  for (const todo of todos) {
    const text = String(todo.text || '').trim();
    if (!text) continue;
    if (todo.due_date && todo.due_date.split('T')[0] < dateKey) continue;
    // Plenty of vault lines carry the date in the text rather than in due_date
    // ("Review applicants — due 2026-07-28"), and those were slipping through
    // the overdue guard and being offered as warm-ups.
    const inlineDue = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (inlineDue && inlineDue[1] < dateKey) continue;
    if (text.split(/\s+/).length > QUICK_WIN_MAX_WORDS) continue;
    if (NOT_QUICK.test(text)) continue;
    if (!QUICK_WIN_VERBS.test(text)) continue;

    wins.push({
      text,
      task_id: todo.task_id || null,
      ms_id: todo.ms_id || null,
      source: todo.source || null,
      filePath: todo.filePath || null,
      lineNumber: todo.lineNumber == null ? null : todo.lineNumber,
      due_date: todo.due_date || null,
    });
    if (wins.length >= 5) break;
  }

  return wins;
}

// ── Right now ────────────────────────────────────────────────────────────────

/**
 * The one thing. Straight from the decision engine + next-action engine, so this
 * panel can never disagree with Focus about what matters — two surfaces naming
 * different top priorities is worse than either alone.
 */
async function _rightNow() {
  try {
    const engine = require('./decision-engine');
    const nextActionEngine = require('./next-action-engine');
    const workingMemory = require('./working-memory');

    const [ctx, result] = await Promise.all([workingMemory.getContext(), engine.evaluate()]);
    if (!result.items || !result.items.length) return { item: null, action: null, waiting: 0 };

    const actions = nextActionEngine.computeNextActions(result.items, ctx);
    const top = result.items[0];

    return {
      item: {
        id: top.id,
        type: top.type,
        title: top.title,
        reason: top.reason,
        urgency: top.urgency,
        source: top.source,
      },
      action: actions.primaryAction || null,
      // Named, not listed. Knowing four other things are tracked is reassuring;
      // seeing them is the overwhelm this panel exists to avoid.
      waiting: Math.max(0, result.items.length - 1),
    };
  } catch (e) {
    console.warn('[ADHD] rightNow failed:', e.message);
    return { item: null, action: null, waiting: 0 };
  }
}

// ── Time context ─────────────────────────────────────────────────────────────

function _shape(hour, isWeekend) {
  if (isWeekend) return { mode: 'weekend', line: 'Weekend. Rest is strategy — this page can wait.' };
  if (hour < 9) return { mode: 'early', line: 'Early. Pick the one thing before the day picks for you.' };
  if (hour < 12) return { mode: 'morning', line: 'Morning — your best focus window. Spend it on the hard thing.' };
  if (hour < 14) return { mode: 'midday', line: 'Midday. Good window for the things that need other people.' };
  if (hour < 16) return { mode: 'afternoon', line: 'Afternoon dip. Quick wins count as progress.' };
  if (hour < 18) return { mode: 'lateday', line: 'Late in the day. Close something, then close the laptop.' };
  return { mode: 'evening', line: 'Evening. Whatever is left will still be there tomorrow.' };
}

// ── Build ────────────────────────────────────────────────────────────────────

async function build() {
  const t0 = Date.now();
  const now = new Date();
  const dateKey = _dateKey(now);
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;

  let todos = [];
  try {
    todos = require('./vault-cache').getTodos()?.active || [];
  } catch (e) {
    console.warn('[ADHD] Could not load todos:', e.message);
  }

  const rightNow = await _rightNow();

  // The session container (#88) and the return prompt (#89). This panel named
  // activation energy as the blocker and then only ever answered it with a
  // SMALLER task; a started session is the other answer, and the one that keeps
  // an interrupted thing from silently rejoining the pile of 128.
  let session = { session: null, recovery: null };
  try {
    session = require('./focus-session').status();
  } catch (e) {
    console.warn('[ADHD] Session state unavailable:', e.message);
  }

  const payload = {
    generatedAt: now.toISOString(),
    dateKey,
    shape: _shape(hour, isWeekend),
    rightNow,
    session: session.session,
    recovery: session.recovery,
    momentum: _momentum(dateKey),
    winsToday: _winsToday(dateKey),
    avoidance: _avoidance(dateKey),
    quickWins: _quickWins(todos, dateKey),
    openTasks: todos.length,
  };

  console.log(`[ADHD] Built in ${Date.now() - t0}ms — done:${payload.momentum.doneToday} wins:${payload.winsToday.length} avoid:${payload.avoidance.signals.length} quick:${payload.quickWins.length} session:${payload.session ? payload.session.status : 'none'}`);
  return payload;
}

module.exports = {
  build,
  // Exported for tests — these carry the judgement worth pinning down.
  _momentum,
  _avoidance,
  _quickWins,
  _winsToday,
  _shape,
};
