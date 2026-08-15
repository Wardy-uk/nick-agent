'use strict';

/**
 * The focus session — one thing, started, held as state.
 *
 * The gap this closes: `adhd-dashboard.js` names activation energy as *the*
 * blocker and then answers it with quick wins — a SMALLER thing. That helps on
 * some days and on others it just relocates the avoidance onto an easier
 * target. What was missing is a container: pick the one thing, start it, and
 * have NEURO hold that as state so every surface knows what Nick is mid-way
 * through. The vault has had a hand-maintained `Focus Sessions/` folder since
 * long before this existed, which is the evidence it was wanted.
 *
 * And the reason to build it (#89): get pulled into an escalation mid-task and
 * nothing anywhere says *"you were twenty minutes into X — back to it?"*. For an
 * ADHD brain the interruption is not the cost, the FAILURE TO RETURN is: the
 * thread is gone and the task silently rejoins the pile of 128. Everything
 * needed was already tracked; nothing joined it up. `recovery()` is that join.
 *
 * Six rules, each of them a thing that would otherwise make this untrustworthy:
 *
 * 1. ONE session at a time. Two "current things" is no current thing.
 *
 * 2. Elapsed counts FOCUS time, not wall clock — paused stretches are excluded.
 *    Wall clock would make "twenty minutes into a thirty-minute thing" wrong the
 *    instant you were pulled away, which is precisely the case this exists for.
 *
 * 3. An un-estimated task is assumed thirty minutes and SAYS SO, exactly as in
 *    time-fit (#87). `plannedAssumed` rides on every read and the caller is
 *    expected to show it. Same constant, deliberately imported rather than
 *    re-declared, so the two can never drift.
 *
 * 4. A session that runs away goes STALE — it never auto-completes and never
 *    silently disappears. Auto-completing invents a win Nick did not earn;
 *    deleting loses the thread this whole feature exists to keep. Stale asks.
 *
 * 5. Starting something else INTERRUPTS the current session rather than being
 *    refused or silently replacing it. Being pulled onto another thing is the
 *    normal case, not an error, and it is the moment the return-prompt is born.
 *
 * 6. PULL-ONLY. Nothing here notifies or pushes. The recovery prompt appears on
 *    surfaces Nick has chosen to open. Same call as waiting-on, and for the
 *    stronger reason: nudge volume is the one signal allowed to argue against
 *    building more of this system, so a new feature does not get to raise it.
 *
 * Stored in `agent_state` rather than a table, following standup-session: a
 * schema migration on the live DB is a bigger risk than the query convenience is
 * worth, and there is exactly one live row.
 *
 * NOT built, deliberately: nothing learns durations from the actual times
 * recorded here. #87 ruled that out for want of a body of finished, estimated
 * work to calibrate against — this is what starts creating that body. Consuming
 * it before it exists would be the same mistake as the MoSCoW classifier, a
 * confident number nobody can check.
 */

const db = require('../db/database');
const { ASSUMED_MINUTES } = require('./time-fit');

const STATE_KEY = 'focus_session';
const HISTORY_KEY = 'focus_session_history';
const HISTORY_LIMIT = 50;

// When a running session stops being believable. Three times its own estimate,
// but never less than 90 minutes — a 5-minute task overrunning to 15 is an
// ordinary Tuesday, not a lost thread.
const STALE_MULTIPLE = 3;
const STALE_FLOOR_MINUTES = 90;

// A paused session is a live intention to come back. After this long it is not
// one any more, and the prompt changes from "back to it?" to "did this happen?".
const PAUSE_STALE_MINUTES = 8 * 60;

const VALID_SOURCES = ['manual', 'task-switch', 'escalation', 'meeting', 'unknown'];

function pad(n) { return String(n).padStart(2, '0'); }

/** Local date string — never toISOString(), which shifts the day on BST evenings. */
function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutesBetween(fromMs, toMs) {
  return Math.max(0, Math.round((toMs - fromMs) / 60000));
}

function parseTime(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function _read() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session && session.id ? session : null;
  } catch {
    return null;
  }
}

function _write(session) {
  if (session) db.setState(STATE_KEY, JSON.stringify(session));
  else db.setState(STATE_KEY, '');
}

function history() {
  try {
    const raw = db.getState(HISTORY_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function _archive(session, now) {
  const rows = history();
  rows.unshift({
    id: session.id,
    taskId: session.taskId,
    text: session.text,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    plannedMinutes: session.plannedMinutes,
    plannedAssumed: session.plannedAssumed,
    // The honest number: focus time, excluding every paused stretch.
    actualMinutes: Math.round(_elapsedMs(session, now) / 60000),
    endedReason: session.endedReason,
    interruptions: (session.interruptions || []).length,
  });
  db.setState(HISTORY_KEY, JSON.stringify(rows.slice(0, HISTORY_LIMIT)));
}

// ── Derived state ────────────────────────────────────────────────────────────

/** Focus time so far: banked stretches plus the one currently running. */
function _elapsedMs(session, now) {
  const banked = session.elapsedMs || 0;
  if (session.status !== 'active') return banked;
  const from = parseTime(session.resumedAt || session.startedAt);
  return from == null ? banked : banked + Math.max(0, now - from);
}

function _staleAfterMinutes(session) {
  return Math.max(STALE_FLOOR_MINUTES, (session.plannedMinutes || ASSUMED_MINUTES) * STALE_MULTIPLE);
}

/**
 * Has this session stopped describing reality?
 *
 * Two ways in. An active session that has run far past its estimate was almost
 * certainly abandoned at a desk rather than worked on for four hours. And any
 * session started on an earlier day is stale whatever the numbers say — nobody
 * is still twenty minutes into yesterday.
 */
function _isStale(session, now) {
  const started = parseTime(session.startedAt);
  if (started != null && dateStr(new Date(started)) !== dateStr(new Date(now))) return true;
  if (session.status === 'paused') {
    const since = parseTime(session.pausedAt);
    return since != null && minutesBetween(since, now) > PAUSE_STALE_MINUTES;
  }
  return minutesBetween(started ?? now, now) > _staleAfterMinutes(session);
}

function _decorate(session, now) {
  if (!session) return null;

  const elapsedMs = _elapsedMs(session, now);
  const elapsedMinutes = Math.round(elapsedMs / 60000);
  const planned = session.plannedMinutes || ASSUMED_MINUTES;
  const stale = _isStale(session, now);
  const started = parseTime(session.startedAt);

  return {
    id: session.id,
    taskId: session.taskId ?? null,
    text: session.text,
    status: session.status,
    stale,
    startedAt: session.startedAt,
    startedTime: started == null ? null : `${pad(new Date(started).getHours())}:${pad(new Date(started).getMinutes())}`,
    pausedAt: session.pausedAt || null,
    plannedMinutes: planned,
    // The #87 rule, carried through unchanged: a "you're halfway" built on an
    // assumed length must say that it is assumed, every time it is read.
    plannedAssumed: Boolean(session.plannedAssumed),
    elapsedMinutes,
    remainingMinutes: Math.max(0, planned - elapsedMinutes),
    overrun: elapsedMinutes > planned,
    overrunMinutes: Math.max(0, elapsedMinutes - planned),
    interruptions: (session.interruptions || []).length,
    lastInterruption: (session.interruptions || [])[0] || null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The current session, decorated, or null. The read every surface uses. */
function current(now = Date.now()) {
  return _decorate(_read(), now);
}

/**
 * The return prompt (#89).
 *
 * Three shapes, and they are genuinely different questions:
 *   - `resume`  a paused session, still live. "You were 20 minutes into X."
 *   - `settle`  a session that ran away or crossed midnight. "Did this happen?"
 *   - null      nothing to come back to, which is most of the time.
 *
 * An ACTIVE, non-stale session is deliberately not a recovery prompt. Nick is
 * doing it; telling him to get back to the thing he is currently doing is the
 * kind of noise that gets a feature switched off.
 */
function recovery(now = Date.now()) {
  const session = _read();
  if (!session) return null;
  const view = _decorate(session, now);

  if (view.stale) {
    const started = view.startedTime ? ` at ${view.startedTime}` : '';
    const sameDay = parseTime(session.startedAt) != null
      && dateStr(new Date(parseTime(session.startedAt))) === dateStr(new Date(now));
    return {
      kind: 'settle',
      session: view,
      // States what is known and asks. It does not assert that nothing happened
      // — an unclosed session is missing data, not evidence of failure.
      prompt: `You started "${session.text}"${started}${sameDay ? '' : ' yesterday or earlier'} and never closed it.`,
      question: 'Did that get done?',
      options: ['done', 'abandon', 'restart'],
    };
  }

  if (session.status === 'paused') {
    const last = (session.interruptions || [])[0];
    const because = last && last.detail ? ` — ${last.detail}` : '';
    // "0 minutes into" is a real read — start something, get pulled away inside
    // the minute — and it makes the prompt sound broken rather than helpful.
    const howFar = view.elapsedMinutes < 1
      ? 'You had just started'
      : `You were ${view.elapsedMinutes} minute${view.elapsedMinutes === 1 ? '' : 's'} into`;
    return {
      kind: 'resume',
      session: view,
      prompt: `${howFar} "${session.text}"${because}.`,
      // The number that makes coming back thinkable. Twenty minutes left is a
      // decision; "the task" is a wall.
      question: view.remainingMinutes > 0
        ? `About ${view.remainingMinutes} minutes left${view.plannedAssumed ? ' (assuming half an hour for it)' : ''}. Back to it?`
        : 'Back to it?',
      options: ['resume', 'done', 'abandon'],
    };
  }

  return null;
}

/** Everything a panel needs, in one read. */
function status(now = Date.now()) {
  return {
    session: current(now),
    recovery: recovery(now),
    assumedMinutes: ASSUMED_MINUTES,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * How long to hold. A task's own estimate when it has one; otherwise the same
 * thirty minutes time-fit assumes — flagged, never quietly applied.
 */
function _plan(taskId, minutes) {
  if (Number.isFinite(minutes) && minutes > 0) {
    return { plannedMinutes: Math.round(minutes), plannedAssumed: false };
  }
  if (taskId != null) {
    try {
      const row = db.getTaskRow(taskId);
      if (row && row.estimate_minutes != null) {
        return { plannedMinutes: row.estimate_minutes, plannedAssumed: false };
      }
    } catch { /* no task, or the store is unavailable — fall through to assumed */ }
  }
  return { plannedMinutes: ASSUMED_MINUTES, plannedAssumed: true };
}

/**
 * Start the one thing.
 *
 * A session already running is not an error — it is the interruption case, and
 * the whole point of #89. Without `force` this reports the conflict so the
 * caller can ask; with it, the running session is PAUSED and marked interrupted
 * (never discarded), so it is still there to come back to afterwards.
 */
function start({ taskId = null, text = '', minutes = null, force = false, source = 'manual' } = {}, now = Date.now()) {
  const existing = _read();

  if (existing && !_isStale(existing, now)) {
    if (!force) {
      return { ok: false, reason: 'session-active', session: _decorate(existing, now) };
    }
    _pause(existing, {
      source: 'task-switch',
      detail: `switched to "${String(text).slice(0, 60)}"`,
    }, now);
    _write(existing);
  } else if (existing) {
    // A stale session cannot silently vanish because something new started —
    // that is exactly the thread this feature exists to keep. It is closed as
    // unresolved and kept in history, so it can still be read back.
    existing.status = 'abandoned';
    existing.endedAt = new Date(now).toISOString();
    existing.endedReason = 'expired';
    _archive(existing, now);
  }

  let label = String(text || '').trim();
  if (!label && taskId != null) {
    try { label = db.getTaskRow(taskId)?.text || ''; } catch { /* label stays empty */ }
  }
  if (!label) throw new Error('a session needs something to be about');

  // Callers often have the words but not the id — the decision engine's items
  // carry a slug like `todo-overdue-top`, not a task row. Match on the same
  // normalised key the task store dedupes on, so "start on this" links to the
  // real task (and so picks up its estimate, and can close it on finish)
  // wherever the text is genuinely the same action. No match is fine: a
  // session about something that is not a task is still a session.
  let resolvedTaskId = taskId == null ? null : Number(taskId);
  if (resolvedTaskId == null) {
    try {
      const taskStore = require('./task-store');
      const match = db.getTaskByDedupeKey(taskStore.dedupeKey(label));
      if (match && (match.status === 'open' || match.status === 'in-progress')) resolvedTaskId = match.id;
    } catch { /* unmatched, which is a normal outcome */ }
  }

  const plan = _plan(resolvedTaskId, minutes);
  const startedAt = new Date(now).toISOString();

  const session = {
    id: `fs_${now}`,
    taskId: resolvedTaskId,
    text: label,
    status: 'active',
    startedAt,
    resumedAt: startedAt,
    pausedAt: null,
    elapsedMs: 0,
    plannedMinutes: plan.plannedMinutes,
    plannedAssumed: plan.plannedAssumed,
    interruptions: [],
    source: VALID_SOURCES.includes(source) ? source : 'unknown',
    endedAt: null,
    endedReason: null,
  };

  _write(session);
  try {
    db.logActivity('focus_session_started', {
      sessionId: session.id, taskId: session.taskId, text: session.text,
      plannedMinutes: plan.plannedMinutes, plannedAssumed: plan.plannedAssumed,
    });
  } catch { /* the session is the point; the log is bookkeeping */ }

  return { ok: true, session: _decorate(session, now), interrupted: Boolean(existing && force) };
}

/** Bank the running stretch and record why it stopped. Mutates in place. */
function _pause(session, { source = 'manual', detail = null } = {}, now = Date.now()) {
  if (session.status !== 'active') return session;
  session.elapsedMs = _elapsedMs(session, now);
  session.status = 'paused';
  session.pausedAt = new Date(now).toISOString();
  session.resumedAt = null;
  session.interruptions = session.interruptions || [];
  session.interruptions.unshift({
    at: session.pausedAt,
    source: VALID_SOURCES.includes(source) ? source : 'unknown',
    detail,
    // Where in the task it happened — the number the return prompt is built on.
    atMinutes: Math.round(session.elapsedMs / 60000),
    resumedAt: null,
    paused: true,
  });
  return session;
}

function pause({ source = 'manual', detail = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.status !== 'active') return { ok: true, session: _decorate(session, now) };

  _pause(session, { source, detail }, now);
  _write(session);
  try {
    db.logActivity('focus_session_paused', {
      sessionId: session.id, source, detail, atMinutes: Math.round(session.elapsedMs / 60000),
    });
  } catch {}
  return { ok: true, session: _decorate(session, now) };
}

function resume(now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.status === 'active') return { ok: true, session: _decorate(session, now) };

  session.status = 'active';
  session.resumedAt = new Date(now).toISOString();
  session.pausedAt = null;
  // Coming back is the outcome this feature is for, so it is recorded against
  // the interruption that caused the break rather than logged as a fresh start.
  if (session.interruptions && session.interruptions[0] && !session.interruptions[0].resumedAt) {
    session.interruptions[0].resumedAt = session.resumedAt;
  }
  _write(session);
  try { db.logActivity('focus_session_resumed', { sessionId: session.id, text: session.text }); } catch {}
  return { ok: true, session: _decorate(session, now) };
}

/**
 * Note that something landed, WITHOUT stopping the session.
 *
 * An escalation arriving does not mean Nick switched to it, and NEURO cannot
 * know whether he did. Pausing on his behalf would put the system's guess into
 * the one number the return prompt rests on. So this records the arrival
 * against the session and leaves the clock running; if he did switch, the next
 * `start()` or `pause()` says so properly.
 */
function noteInterruption({ source = 'unknown', detail = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session || session.status !== 'active') return { ok: false, reason: 'no-active-session' };
  if (_isStale(session, now)) return { ok: false, reason: 'stale' };

  session.interruptions = session.interruptions || [];
  session.interruptions.unshift({
    at: new Date(now).toISOString(),
    source: VALID_SOURCES.includes(source) ? source : 'unknown',
    detail,
    atMinutes: Math.round(_elapsedMs(session, now) / 60000),
    resumedAt: null,
    paused: false,
  });
  _write(session);
  return { ok: true, session: _decorate(session, now) };
}

function _end(reason, now) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };

  const view = _decorate(session, now);
  session.elapsedMs = _elapsedMs(session, now);
  session.status = reason === 'completed' ? 'done' : 'abandoned';
  session.endedAt = new Date(now).toISOString();
  session.endedReason = reason;

  _archive(session, now);
  _write(null);
  return { ok: true, session: view, actualMinutes: view.elapsedMinutes };
}

/**
 * Finish. `completeTask` also closes the underlying task — the common case, and
 * the reason the session is worth having a button for at all.
 *
 * The task is completed through task-store, so it logs `task_done` and shows up
 * in momentum and wins exactly like every other completion. A session that
 * quietly closed tasks by a private route would be invisible to the panel that
 * asked for it.
 */
function finish({ completeTask = false } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };

  const result = _end('completed', now);
  let taskCompleted = false;

  if (completeTask && session.taskId != null) {
    try {
      require('./task-store').setStatus(session.taskId, 'done');
      taskCompleted = true;
    } catch (e) {
      console.warn('[Focus] Session finished but task completion failed:', e.message);
    }
  }

  try {
    db.logActivity('focus_session_done', {
      sessionId: session.id,
      taskId: session.taskId,
      text: session.text,
      plannedMinutes: session.plannedMinutes,
      plannedAssumed: session.plannedAssumed,
      actualMinutes: result.actualMinutes,
      interruptions: (session.interruptions || []).length,
      taskCompleted,
    });
  } catch {}

  return { ...result, taskCompleted };
}

function abandon(now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  const result = _end('abandoned', now);
  try {
    db.logActivity('focus_session_abandoned', {
      sessionId: session.id, text: session.text, actualMinutes: result.actualMinutes,
    });
  } catch {}
  return result;
}

module.exports = {
  ASSUMED_MINUTES,
  PAUSE_STALE_MINUTES,
  STALE_FLOOR_MINUTES,
  STALE_MULTIPLE,
  abandon,
  current,
  finish,
  history,
  noteInterruption,
  pause,
  recovery,
  resume,
  start,
  status,
  // Exported for tests — these carry the judgement worth pinning down.
  _decorate,
  _elapsedMs,
  _isStale,
  _plan,
};
