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
 * Reads `services/wins` rather than counting activity_log directly. It used to
 * do the latter, over a six-event set that only `task_done` and the two rituals
 * ever actually fired — and MEASURED on the live DB, that came to four
 * completions in thirty days, against 271 commits and 57 executed SARA actions.
 * This card was opened nine times in that window and showed 0 with no streak on
 * every one of them. It was not wrong about the events; it was wrong about what
 * counts as evidence that Nick did something, because the only thing feeding it
 * was self-report.
 *
 * The wins ledger DETECTS finished work instead — the same rule as "who reports
 * to Nick is READ, not typed" and "1-2-1s are detected, not declared". `gaps`
 * travels with it so a source that could not be read is named on the card
 * rather than quietly lowering the number, which is the failure mode this whole
 * change exists to remove.
 *
 * `rituals` still comes from activity_log: standup and EOD are binary facts
 * about today, not a count, and the tick marks read them directly.
 */
function _momentum(dateKey) {
  const wins = require('./wins');
  const summary = wins.summary();

  const today = db.getActivityForDate(dateKey);
  const rituals = {
    standup: today.some(r => r.event_type === 'standup_done'),
    eod: today.some(r => r.event_type === 'eod_done'),
  };

  return {
    doneToday: summary.doneToday,
    doneThisWeek: summary.doneThisWeek,
    // The one counter in NEURO where growth is good news. Every other number
    // that climbs here is a debt: 159 open tasks, 287 waiting-on, the pending
    // actions queue.
    total: summary.total,
    // The streak is gone. It counted consecutive days with any win, which was
    // fine while the ledger only knew about ticked tasks and worthless the
    // moment meetings were counted honestly: it jumped 4 → 35 and became
    // unbreakable. `typical` replaces it with something Nick can be compared
    // WITH — his own median working day, null until there is enough of it.
    typical: summary.typical,
    rituals,
    last7: summary.last7,
    best7: summary.best7,
    bySource: summary.bySource,
    knownGaps: summary.knownGaps,
  };
}

// ── Wins ─────────────────────────────────────────────────────────────────────

/**
 * Today's finished work, newest first, as things you can read back.
 *
 * Now the wins ledger's list rather than a second reading of activity_log, so
 * the card and the count cannot disagree about what a win is — the same reason
 * cadenceState, working-days and action-presenter each ended up with exactly
 * one definition three surfaces share.
 *
 * `evidence` travels to the client. A win that cannot say what proves it is an
 * assertion, and an assertion is what the old tickbox already was.
 */
function _winsToday(dateKey) {
  // `time` is formatted by the ledger, not here — it is local HH:MM off a UTC
  // ISO timestamp, and two copies of that conversion is how one of them ends up
  // slicing the string and reading an hour early through the whole of BST.
  return require('./wins').winsForDate(dateKey).map(w => ({
    time: w.time,
    text: w.text,
    kind: w.kind,
    source: w.source,
    evidence: w.evidence,
    count: w.count,
  }));
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
/**
 * Where a snoozed reminder's subject lives.
 *
 * ⚠ An unmapped type resolves to null, and null renders as NO navigation
 * button rather than as a guess. A button that lands somewhere unrelated is
 * worse than no button — it teaches that the links on this page are decoration
 * (which is exactly what `Dashboard`'s "Queue" button had become, pointing at a
 * view deleted in July).
 */
function _nudgeDestination(type) {
  // Keys are `nudges.NUDGE_TYPES` verbatim — not a guess at what a nudge type
  // might be called. Values are `App.jsx` view ids, likewise. Both halves have
  // bitten this repo before (`sleep_core_hours`, `meeting_alert`), and a wrong
  // key here fails silently as "no button".
  const map = {
    standup: 'standup',
    todo: 'todos',
    eod: 'eod',
    121: 'people',
    plan_milestone: 'plan',
    journal: 'journal',
    escalation: 'escalations',
    email: 'inbox',
  };
  return map[String(type || '').toLowerCase()] || null;
}

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
      // Where the thing being pushed back actually lives. A card that says a
      // reminder has been snoozed four times and cannot take you to what it is
      // about is a card that can only be read, and this one is read weekly.
      nudgeType: entry.type,
      navigate: _nudgeDestination(entry.type),
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
        // ⚠ The handles are what make this row answerable. Absent them the
        // client can only navigate to the whole task list, which is where Nick
        // already was — a "link" that changes nothing.
        task_id: stale.task_id ?? null,
        ms_id: stale.ms_id ?? null,
        source: stale.source ?? null,
        filePath: stale.filePath ?? null,
        lineNumber: stale.lineNumber ?? null,
        navigate: 'todos',
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
        // ⚠ These are `tasks` ROWS, so the id is the handle and there is no
        // file line to tick. `origin_path` is a provenance backlink to the note
        // a task came FROM — passing it as `filePath` would hand a completion
        // route a path with no task line on it.
        task_id: old[0].id ?? null,
        ms_id: old[0].ms_id ?? null,
        source: old[0].source ?? null,
        filePath: null,
        lineNumber: null,
        navigate: 'todos',
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

  // Fold finished work in before reading it back, so the card is never an hour
  // stale at the moment it is being looked at. Idempotent and cheap; the hourly
  // scheduled pass exists for the surfaces that never hit this build.
  //
  // `gaps` is carried to the client rather than swallowed: a source that could
  // not be read must be NAMED. This card spent months showing 0 finished on
  // days full of finished work and looked perfectly correct doing it, and a
  // count that cannot say what it failed to see is that same bug wearing a
  // different number.
  let winGaps = [];
  try {
    winGaps = require('./wins').sync().gaps || [];
  } catch (e) {
    winGaps = [`wins ledger unavailable — ${e.message}`];
  }

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

  // What the sessions say about STARTING. Folded in here rather than fetched
  // separately, because this page is read at moments of low executive function
  // and a second round trip is a second chance to be slow.
  //
  // ⚠ It is a DERIVED read over the same history `session` above came from — no
  // store, no counter — so it cannot drift from it. Never allowed to fail the
  // build: momentum is the point of the page and a starts count is beside it.
  let signals = null;
  try {
    signals = require('./initiation-signals').build(now);
  } catch (e) {
    console.warn('[ADHD] Session signals unavailable:', e.message);
  }

  const payload = {
    generatedAt: now.toISOString(),
    dateKey,
    shape: _shape(hour, isWeekend),
    rightNow,
    session: session.session,
    recovery: session.recovery,
    // The counterpart to `momentum`, which counts finishing. Nick's blocker is
    // initiation, so the half of the loop that is actually hard had no number
    // anywhere until this landed.
    signals,
    momentum: _momentum(dateKey),
    winsToday: _winsToday(dateKey),
    avoidance: _avoidance(dateKey),
    quickWins: _quickWins(todos, dateKey),
    openTasks: todos.length,
    gaps: winGaps,
  };

  console.log(`[ADHD] Built in ${Date.now() - t0}ms — done:${payload.momentum.doneToday} wins:${payload.winsToday.length} avoid:${payload.avoidance.signals.length} quick:${payload.quickWins.length} session:${payload.session ? payload.session.status : 'none'}`);
  return payload;
}

module.exports = {
  build,
  // Exported for tests — these carry the judgement worth pinning down.
  _momentum,
  _avoidance,
  _nudgeDestination,
  _quickWins,
  _winsToday,
  _shape,
};
