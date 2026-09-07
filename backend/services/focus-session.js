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

// How long into a running session before it is worth asking "still on this?".
//
// ⚠ This is a PULL, never a push. Nothing here notifies — the whole service is
// pull-only, because nudge volume is the one signal allowed to argue against
// building more of this system, and body-doubling is precisely the feature that
// would justify a timer to itself. The prompt appears when Nick has already
// opened a surface; if he is not looking, it costs nothing.
const CHECK_IN_MINUTES = 20;

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
    // The outcome that is actually worth reading back. A task shrunk twice
    // before it moved is the most useful thing this session recorded, and it is
    // the ONLY place that survives once the live session is archived — so it
    // travels with the record rather than being left behind as a live-only field.
    // Kept as evidence, never as a score.
    shrinks: (session.shrinks || []).length,
    finalStep: session.nextStep || null,
    originalText: session.originalText || null,
    checkIns: (session.checkIns || []).length,
    steppedAway: (session.stepAways || []).length,
    // Optional, always. An empty reflection is a perfectly good outcome and
    // must never block finishing — a box you have to fill to close a session is
    // a reason not to close sessions.
    reflection: session.reflection || null,
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
  // ⚠ `interrupted` and `needs-smaller` are banked states too — the clock is
  // not running in any of them. Testing only for 'paused' would drop the other
  // two through to the wall-clock branch below, where a session Nick was pulled
  // out of at 9am goes stale by mid-morning and asks "did this happen?" about
  // something he is still perfectly likely to come back to after lunch.
  if (session.status === 'paused' || session.status === 'interrupted' || session.status === 'needs-smaller') {
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
    // Only the times he SAID he stepped away — see `stepAway`. The friction
    // read reports on this and never on `interruptions`.
    steppedAway: (session.stepAways || []).length,
    lastStepAway: (session.stepAways || [])[0] || null,
    // Gate 3. The next concrete step is what makes starting possible at all, so
    // it rides on every read rather than needing a second call.
    nextStep: session.nextStep || null,
    // ⚠ Reported as INFORMATION, never as a score. A task shrunk three times is
    // a task that was never one task — that is a finding about the work, not a
    // mark against Nick, and nothing downstream may present it as one.
    shrinks: (session.shrinks || []).length,
    lastShrink: (session.shrinks || [])[0] || null,
    // The wording he started with, kept so a shrunk session can still say what
    // it came from. Null until something is actually shrunk.
    originalText: session.originalText || null,
    // Body-doubling, the private kind. A count of the times he said he was
    // still on it — never a target, never a streak, and nothing is inferred
    // from a missed one: being heads-down is exactly why a check-in gets
    // skipped, so treating that as a signal would punish the good case.
    checkIns: (session.checkIns || []).length,
    lastCheckInAt: (session.checkIns || [])[0]?.at || null,
    // Only ever true on a RUNNING session. Asking "still on this?" about
    // something paused is noise, and asking it in the first minutes is worse.
    dueCheckIn: session.status === 'active'
      && !stale
      && minutesSinceLastCheckIn(session, now) >= CHECK_IN_MINUTES,
    minutesSinceCheckIn: minutesSinceLastCheckIn(session, now),
  };
}

/** Minutes since the last check-in, or since the session began. */
function minutesSinceLastCheckIn(session, now) {
  const last = (session.checkIns || [])[0]?.at || session.resumedAt || session.startedAt;
  const at = parseTime(last);
  return at == null ? 0 : minutesBetween(at, now);
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

  // Stuck on SIZE, not on time. A different question entirely, and answering it
  // with "back to it?" is how the prompt becomes noise — he already knows he
  // could go back to it; that is the problem.
  if (session.status === 'needs-smaller') {
    return {
      kind: 'shrink',
      session: view,
      prompt: `"${session.text}" was too big to start.`,
      question: 'What is the smallest next bit of it?',
      // `shrink` first, because it is the answer. `abandon` is offered without
      // ceremony — letting something go is a legitimate outcome, not a failure.
      options: ['shrink', 'resume', 'abandon'],
    };
  }

  if (session.status === 'paused' || session.status === 'interrupted') {
    const last = (session.interruptions || [])[0];
    const because = last && last.detail ? ` — ${last.detail}` : '';
    // "0 minutes into" is a real read — start something, get pulled away inside
    // the minute — and it makes the prompt sound broken rather than helpful.
    const howFar = view.elapsedMinutes < 1
      ? 'You had just started'
      : `You were ${view.elapsedMinutes} minute${view.elapsedMinutes === 1 ? '' : 's'} into`;
    // ⚠ "You were pulled away" and "you stopped" are not the same sentence. The
    // first is not something he did, and saying it back to him as though it
    // were is the register this whole voice rejects.
    const opener = session.status === 'interrupted'
      ? `${howFar} "${session.text}" when you were pulled away${because}.`
      : `${howFar} "${session.text}"${because}.`;
    return {
      kind: 'resume',
      session: view,
      prompt: opener,
      // The next step, if he left one. Coming back to "the task" is a wall;
      // coming back to a named physical action is a decision.
      nextStep: session.nextStep || null,
      // The number that makes coming back thinkable. Twenty minutes left is a
      // decision; "the task" is a wall.
      question: view.remainingMinutes > 0
        ? `About ${view.remainingMinutes} minutes left${view.plannedAssumed ? ' (assuming half an hour for it)' : ''}. Back to it?`
        : 'Back to it?',
      // `shrink` is offered on EVERY return prompt, deliberately. The moment he
      // is looking at a thing he walked away from is exactly the moment "this
      // is too big" is the true answer, and a menu without that option pushes
      // him to abandon instead — which loses the thread and reads as failure.
      options: ['resume', 'shrink', 'done', 'abandon'],
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
function start({ taskId = null, text = '', minutes = null, force = false, source = 'manual', nextStep = null } = {}, now = Date.now()) {
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
    // The concrete physical step, if he named one at the start. Never invented
    // by NEURO: a step it made up is a step he has no reason to believe in, and
    // the whole point is that it is small enough to actually begin.
    nextStep: String(nextStep || '').trim().slice(0, 200) || null,
    shrinks: [],
    originalText: null,
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

// ── Gate 3: making it smaller ────────────────────────────────────────────────
//
// The one action this whole feature is missing, and the reason it is missing is
// instructive: every other control here answers "when", and the ADHD-native
// problem is not WHEN, it is SIZE. Nick's own framing — the difficulty is
// INITIATION, and "anything that raises awareness without lowering the barrier
// is the wrong shape". Pause, resume and abandon all raise awareness. Only this
// lowers the barrier.
//
// ⚠ SHRINKING IS NOT FAILURE, and nothing here may record it as one. It is the
// single most useful signal the session produces: a task shrunk three times is
// a task that was never one task. So the shrink is kept as HISTORY on the
// session (`shrinks`), the original wording is preserved (`originalText`), and
// the outcome is logged as its own event rather than folded into an abandon.
//
// Two shapes, and the difference matters:
//   * `shrink({ step })`   — Nick knows the smaller thing. It becomes the next
//                            step and the session carries on.
//   * `shrink({})`         — he knows it is too big and does NOT yet know the
//                            smaller thing. That is `needs-smaller`: a real,
//                            honest state, and NOT the same as paused. Paused
//                            means "not now"; this means "I'm stuck on size",
//                            which is a different question and needs a
//                            different prompt.

/** The next concrete, physical step. Freeform, bounded, never invented by NEURO. */
function setNextStep(step, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  const text = String(step || '').trim().slice(0, 200);
  session.nextStep = text || null;
  _write(session);
  return { ok: true, session: _decorate(session, now) };
}

function shrink({ step = null, note = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.status === 'done' || session.status === 'abandoned') {
    return { ok: false, reason: 'session-closed' };
  }

  const smaller = String(step || '').trim().slice(0, 200);
  session.originalText = session.originalText || session.text;
  session.shrinks = session.shrinks || [];
  session.shrinks.unshift({
    at: new Date(now).toISOString(),
    atMinutes: Math.round(_elapsedMs(session, now) / 60000),
    from: session.nextStep || session.text,
    to: smaller || null,
    note: note ? String(note).slice(0, 200) : null,
  });

  if (smaller) {
    session.nextStep = smaller;
    // Back to work. If he was stuck on size, naming the smaller thing IS the
    // unblocking, so the clock starts again rather than making him press a
    // second button to say what he has just said.
    if (session.status === 'needs-smaller' || session.status === 'paused' || session.status === 'interrupted') {
      session.status = 'active';
      session.resumedAt = new Date(now).toISOString();
      session.pausedAt = null;
    }
  } else {
    // Stuck on size. Bank the clock — he is not working while deciding — but
    // keep the session, because the thread is the thing worth not losing.
    if (session.status === 'active') _pause(session, { source: 'manual', detail: 'too big' }, now);
    session.status = 'needs-smaller';
  }

  _write(session);
  try {
    db.logActivity('focus_session_shrunk', {
      sessionId: session.id, taskId: session.taskId,
      to: smaller || null, shrinks: session.shrinks.length,
    });
  } catch { /* the session is the point; the log is bookkeeping */ }

  return { ok: true, session: _decorate(session, now) };
}

/**
 * Something pulled him away, and he SAID so.
 *
 * ⚠ NOT `noteInterruption`, and the distinction is load-bearing. That one
 * records that something ARRIVED and deliberately leaves the clock running,
 * because NEURO cannot know whether he actually switched — guessing there would
 * corrupt the one number the return prompt rests on. This is Nick saying he
 * did. It is also not `pause`: "I was pulled away" and "I chose to stop" are
 * different facts and deserve different words when he comes back, because the
 * first is not something he did.
 *
 * Named `stepAway` rather than `interrupt` on purpose — `/api/session/interrupt`
 * already means noteInterruption, and quietly changing what that route does
 * would be a silent behaviour change to every existing caller.
 */
function stepAway({ source = 'manual', detail = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.status !== 'active') return { ok: true, session: _decorate(session, now) };

  _pause(session, { source, detail }, now);
  session.status = 'interrupted';
  // ⚠ Counted SEPARATELY from `interruptions`. That array also holds pauses and
  // arrivals; this one holds only the times Nick SAID he was pulled off it, and
  // the friction read is allowed to use nothing else. Folding the two would let
  // other people's timing become a claim about his attention.
  session.stepAways = session.stepAways || [];
  session.stepAways.unshift({
    at: new Date(now).toISOString(),
    source: VALID_SOURCES.includes(source) ? source : 'unknown',
    detail,
    atMinutes: Math.round(session.elapsedMs / 60000),
  });
  _write(session);
  try {
    db.logActivity('focus_session_interrupted', {
      sessionId: session.id, source, detail, atMinutes: Math.round(session.elapsedMs / 60000),
    });
  } catch {}
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

/**
 * "Still here." — the body-double, answered by Nick rather than assumed.
 *
 * Records that he confirmed he is still on it. Deliberately does NOT extend,
 * reset or otherwise touch the clock: this is a statement about presence, not
 * about time, and quietly moving the estimate because he said hello would make
 * the one honest number here dishonest.
 */
function checkIn({ note = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };
  if (session.status !== 'active') return { ok: false, reason: 'not-running' };

  session.checkIns = session.checkIns || [];
  session.checkIns.unshift({
    at: new Date(now).toISOString(),
    atMinutes: Math.round(_elapsedMs(session, now) / 60000),
    note: note ? String(note).slice(0, 200) : null,
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
function finish({ completeTask = false, reflection = null } = {}, now = Date.now()) {
  const session = _read();
  if (!session) return { ok: false, reason: 'no-session' };

  // Written onto the session BEFORE it is archived, so it travels into history
  // with everything else. Optional, always: a box you have to fill in to close
  // a session is a reason not to close sessions.
  if (reflection) {
    session.reflection = String(reflection).slice(0, 500);
    _write(session);
  }

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
  checkIn,
  shrink,
  setNextStep,
  stepAway,
  ASSUMED_MINUTES,
  HISTORY_LIMIT,
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
