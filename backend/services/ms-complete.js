'use strict';

/**
 * Completing a task Microsoft owns — the ONE implementation.
 *
 * ── Why it is a service and not a route body ────────────────────────────────
 * This was the body of `POST /api/todos/complete-ms` and nothing else could
 * reach it. That was fine while the only way to tick a Microsoft task was the
 * task list; it stopped being fine the moment the attention feed grew a "Done"
 * button, because the alternative was a second copy of the mirror flip, the
 * Graph push, the recurrence repaint, the webhook fallback and the retry queue —
 * five things that must agree, in two places, drifting from the first edit on.
 *
 * ── What "completing" a Microsoft task actually involves ────────────────────
 *   1. flip the mirror line in `Tasks/Microsoft Tasks.md` (what NEURO reads);
 *   2. record the win — the ledger is blind to two of the three task owners
 *      unless someone tells it;
 *   3. push to Graph;
 *   4. if the task RECURS, repaint the mirror to what Microsoft now holds;
 *   5. if Graph refused, try the Power Automate webhook;
 *   6. if neither landed, HOLD it in the push queue — the mirror is already
 *      ticked and is regenerated from Graph every 30 minutes, so without this
 *      the completion is silently undone inside the half hour.
 *
 * ── The one thing this file adds ────────────────────────────────────────────
 * ⚠ THE MIRROR LINE IS RESOLVED BY ID, NEVER BY A SUPPLIED OFFSET. A caller may
 * hand in a `lineNumber` captured minutes or hours ago — an attention card
 * generated at the last poll, a lane fetched before a resync — and this file is
 * rewritten wholesale every sync, so that offset can name a DIFFERENT task by
 * the time Nick presses the button, and `toggleTask` would tick that one. The
 * next sync does not undo it: it reads the wrong task as open again and the
 * right one as never done. A mirror line that cannot be found by id is skipped
 * with a reason — never a thrown error, because the Graph push is the half that
 * matters and an unreadable vault must not cost the completion.
 */

const db = require('../db/database');
const obsidian = require('./obsidian');
const microsoft = require('./microsoft');
const msQueue = require('./ms-push-queue');

// What a Graph refusal MEANS, in words Nick can act on.
const REASONS = {
  auth: 'Microsoft sign-in expired — reconnect 365.',
  scope: 'Tasks permission not granted — re-consent to Microsoft.',
  list_not_found: 'Could not find the task in any To Do list.',
  not_found: 'Task not found in Planner.',
};

/**
 * Record that a task NEURO does not own was finished.
 *
 * The wins ledger is built on the `task_done` activity event and `task-store` is
 * its only writer — but task-store owns just ONE of the three things a tick can
 * close. A Microsoft task and a plain vault checkbox logged nothing, so
 * finishing either moved no number anywhere: Momentum, "Done today" and the
 * weekly-target ring were all blind to two thirds of what Nick can tick.
 *
 * ⚠ It must not double-count a LINKED task. `sara/app`'s completeTask calls
 * `/api/tasks/:id/complete` AND the Microsoft path for a row carrying both ids
 * (task-dedupe links them, NEURO leading), so task-store has already logged that
 * completion by the time this runs. `tasks.ms_id` is the single answer to "is
 * this linked", so it is what gets asked. Inflating is strictly worse than
 * missing: a missed win is a visible absence, an invented one makes every other
 * number suspect.
 *
 * Failure is swallowed. The task is closed by the time this runs, and a
 * bookkeeping error must never surface as "that didn't work" and send Nick back
 * to tick it again (`sent-replies`' rule).
 */
function recordCompletion({ text, msId = null, msSource = null, filePath = null, lineNumber = null, owner }) {
  try {
    if (msId) {
      const linked = db.get('SELECT id FROM tasks WHERE ms_id = ? LIMIT 1', [msId]);
      if (linked) return;
    }
    db.logActivity('task_done', {
      text: text || (msId ? 'Microsoft task' : 'Task'),
      owner,
      msId,
      msSource: msSource || null,
      filePath,
      lineNumber,
      source: owner === 'microsoft' ? (msSource || 'Microsoft') : 'vault',
    });
  } catch (e) {
    console.warn('[MsComplete] Could not record completion:', e.message);
  }
}

/**
 * Where this task's mirror line is, right now. Found by id, never by offset.
 *
 * ⚠ A supplied offset is NOT used as a fallback when the id is absent from the
 * file. The id being missing is a real, ordinary state — a completed task leaves
 * the mirror on the next sync — and ticking a line nothing can identify is
 * precisely the bug this exists to prevent.
 */
function resolveMirror({ msId }) {
  if (!msId) return null;
  try {
    return obsidian.findMsTaskLine(msId);
  } catch (e) {
    console.warn('[MsComplete] Could not read the mirror:', e.message);
    return null;
  }
}

// Power Automate — the fallback when Graph will not take the completion.
async function fireWebhook(taskId, source) {
  const webhookUrl = process.env.PA_TASK_COMPLETE_WEBHOOK;
  if (!webhookUrl) {
    console.warn('[MsComplete] PA_TASK_COMPLETE_WEBHOOK not configured — skipping webhook fallback');
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, source }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return true;
    console.warn(`[MsComplete] Webhook returned ${res.status}`);
    return false;
  } catch (e) {
    console.warn('[MsComplete] Webhook failed:', e.message);
    return false;
  }
}

/**
 * Complete a Microsoft-owned task everywhere it is represented.
 *
 * @returns {Promise<{ok, pushed, rolled, held, warning, mirrored, text}>}
 *   `pushed` is 'graph' | 'todo' | 'planner' | 'webhook' | 'none';
 *   `rolled` is non-null ONLY when Microsoft rolled a recurrence forward, so a
 *   client may treat its presence as the whole signal that the task is open
 *   again on purpose rather than because the tick was lost.
 */
async function completeMicrosoftTask({ msId, source = null, listId = null }) {
  if (!msId) return { ok: false, error: 'msId required' };

  const mirror = resolveMirror({ msId });
  let mirrorText = null;
  let mirrored = false;
  if (mirror) {
    try {
      // The id is passed as the expectation as well as being how the line was
      // found — belt and braces, and it costs one regex.
      mirrorText = obsidian.toggleTask(mirror.filePath, mirror.lineNumber, msId).text;
      mirrored = true;
    } catch (e) {
      console.warn('[MsComplete] Could not flip the mirror line:', e.message);
    }
  }

  // ⚠ Recorded BEFORE the Graph push, and deliberately. The task is closed from
  // Nick's point of view the moment the mirror flips — this returns ok:true with
  // `pushed:'none'` when Graph refuses, because the vault line is what NEURO
  // reads. A win conditional on Microsoft answering would go missing on exactly
  // the days Graph auth has expired, silently, which is the shape of the bug the
  // whole ledger exists to stop.
  recordCompletion({
    text: mirrorText,
    msId,
    msSource: source,
    filePath: mirror ? mirror.filePath : null,
    lineNumber: mirror ? mirror.lineNumber : null,
    owner: 'microsoft',
  });

  const result = await microsoft.completeMicrosoftTask(msId, source, listId || null);
  if (result.completed) {
    // ⚠ A recurring task is NOT finished by being completed. Microsoft closes the
    // occurrence and rolls the same task id forward — status back to notStarted,
    // due date advanced — so the next mirror sync reads it as open and writes it
    // back. Ticked, gone, back an hour later: exactly what a LOST completion
    // looks like, which is how three of these got ticked over and over.
    //
    // The tick did something real, so it is not undone — but the mirror is
    // repainted to what Microsoft now holds rather than left claiming a state
    // Graph does not agree with.
    if (result.rolled && mirror && mirrored) {
      try {
        obsidian.toggleTask(mirror.filePath, mirror.lineNumber, msId);
        if (result.rolled.nextDue) {
          // The due date moved with the occurrence. Without this the line keeps
          // the old one and the card goes on reporting an overdue that is no
          // longer real.
          obsidian.setTaskFields(mirror.filePath, mirror.lineNumber, { dueDate: result.rolled.nextDue }, msId);
        }
      } catch (e) {
        console.warn('[MsComplete] Could not repaint the rolled mirror line:', e.message);
      }
    }
    return {
      ok: true,
      pushed: result.kind || 'graph',
      rolled: result.rolled || null,
      held: false,
      warning: null,
      mirrored,
      text: mirrorText,
    };
  }

  // Graph refused — fall back to the Power Automate flow.
  const webhookOk = await fireWebhook(msId, source);

  // Neither route landed. HOLD IT — the mirror is already ticked and is
  // regenerated from Graph every 30 minutes, so without this the task reappears
  // as open inside the half hour and the completion is silently undone. Queued
  // only when the webhook did not fire either: a webhook that returned OK
  // completed the task through Power Automate, and re-pushing on top of that is
  // chasing work already done.
  let held = false;
  if (!webhookOk) {
    held = !!msQueue.enqueue({ msId, source, listId: listId || null, text: mirrorText, reason: result.reason });
  }

  return {
    ok: true,
    pushed: webhookOk ? 'webhook' : 'none',
    rolled: null,
    // `held` is the difference between "this didn't reach Microsoft" and "this
    // didn't reach Microsoft and nothing is going to try again" — said out loud,
    // because a warning Nick reads as final when it is not costs him a second
    // tick on a task that is already closed.
    held,
    warning: webhookOk
      ? null
      : `${REASONS[result.reason] || `Microsoft push failed (${result.reason})`}${held ? ' Held — NEURO will retry.' : ''}`,
    mirrored,
    text: mirrorText,
  };
}

module.exports = { completeMicrosoftTask, recordCompletion, resolveMirror, REASONS };
