const express = require('express');
const router = express.Router();
const obsidian = require('../services/obsidian');
const vaultCache = require('../services/vault-cache');
const { rankTasks } = require('../services/task-scoring');
const todoIntelligence = require('../services/todo-intelligence');
const taskStore = require('../services/task-store');
const microsoft = require('../services/microsoft');
const msQueue = require('../services/ms-push-queue');
const msTask = require('../../shared/ms-task.cjs');
const msLocal = require('../services/ms-task-local');
const lifecycle = require('../services/attention-lifecycle');

// How many pending capture_todo suggestions the todos payload will carry. The
// queue hit 930 in August and collapsed to single figures once #108 made it
// reachable, so this is a render bound, not a storage one.
const SUGGESTION_CAP = 200;

// What a Graph failure MEANS, in words Nick can act on. `conflict` is the one
// worth reading twice: Planner refused the write because somebody else changed
// the task while the editor was open, which is the etag doing its job.
const MS_EDIT_REASONS = {
  auth: 'Microsoft sign-in expired — reconnect 365.',
  scope: 'Tasks permission not granted — re-consent to Microsoft.',
  conflict: 'Someone changed this task in Planner while you were editing — reopen it and try again.',
  list_not_found: 'Could not find the task in any To Do list.',
  not_found: 'Microsoft no longer has this task — it may have been completed or deleted.',
  empty_title: 'A task needs a title.',
  bad_due_date: 'Due date must be YYYY-MM-DD.',
  nothing_to_change: 'Nothing was changed.',
};

// Refused by NEURO before the request ever left the building — a 400, not a
// 502. The distinction is the point of the endpoint: "we would not send this"
// and "Microsoft would not take it" are different problems with different fixes.
const REFUSED_LOCALLY = new Set(['empty_title', 'bad_due_date', 'nothing_to_change', 'no_task_id']);

/**
 * Record that a task NEURO does not own was finished.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `task-store.updateTask` logs `task_done`, and the whole wins ledger — the
 * Momentum count, "Done today", the weekly-target ring — is built on that one
 * event. But task-store only owns ONE of the three things SARA's task list can
 * complete. The other two, a Microsoft task and a plain vault checkbox, closed
 * through these routes and logged NOTHING, so finishing them moved no number
 * anywhere. Measured on the live DB the morning this was found: two NEURO
 * completions recorded against five-plus ticks in SARA, and the card said 2.
 *
 * That is the same failure the ledger was built to remove, one owner along: the
 * count was not wrong about what it could see, it was blind to two thirds of
 * what Nick can tick. A number that undercounts on the days he clears the
 * Microsoft lane is a number he stops believing, and then the surface is dead.
 *
 * ── The one thing it must not do ────────────────────────────────────────────
 *
 * ⚠ Double-count a LINKED task. `sara/app`'s completeTask calls
 * `/api/tasks/:id/complete` AND `/api/todos/complete-ms` for a row carrying
 * both ids (task-dedupe links them, NEURO leading) — so task-store has already
 * logged that completion by the time this runs. `tasks.ms_id` is the single
 * answer to "is this linked", so it is what gets asked. Inflating the count is
 * strictly worse than missing one: a missed win is a visible absence, an
 * invented one makes every other number suspect.
 *
 * Failure is swallowed. The task is closed by the time this runs; a bookkeeping
 * error must never surface as "that didn't work" and send Nick back to tick it
 * again — sent-replies' rule, and completeTask's.
 */
function _recordCompletion({ text, msId = null, msSource = null, filePath = null, lineNumber = null, owner }) {
  try {
    if (msId) {
      const linked = db.get('SELECT id FROM tasks WHERE ms_id = ? LIMIT 1', [msId]);
      if (linked) return; // task-store already logged it
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
    console.warn('[Todos] Could not record completion:', e.message);
  }
}

/**
 * The attention record a lane row is about.
 *
 * ⚠ Built through `dedupeKeyFor` rather than slugged here, so the lane and the
 * decision-engine's own `todo` cards land on the SAME record. That is the point
 * of reusing the lifecycle instead of inventing a second suppression map: "not
 * today" said in the Must Move lane is the same statement as deferring the same
 * task on the Now page, and two stores would let one surface contradict the
 * other about a decision Nick made once.
 */
function laneKeyFor(row) {
  return lifecycle.dedupeKeyFor({ type: 'todo', title: row.text });
}

// GET /api/todos — reads tasks from Obsidian vault + 90-day plan
router.get('/', (req, res) => {
  try {
    const showDone = req.query.all === 'true';
    const { active, done } = vaultCache.getTodos();

    const todos = showDone ? [...active, ...done] : active;

    // Map to shape the frontend expects. `task_id` marks the rows NEURO owns —
    // those are editable (MoSCoW / priority / due) and complete via /api/tasks;
    // the rest are still file-backed mirrors (Microsoft, daily notes, the plan).
    const mapped = todos.map((t, i) => ({
      id: i + 1,
      task_id: t.task_id || null,
      taskPriority: t.taskPriority || null,
      taskSource: t.taskSource || null,
      notes: t.notes || null,
      originPath: t.originPath || null,
      text: t.text,
      priority: t.priority || 'normal',
      due_date: t.due_date || null,
      source: t.source || null,
      done: t.status === 'done' ? 1 : 0,
      ms_id: t.ms_id || null,
      // Which Planner board / To Do list it belongs to. Null is a real answer —
      // the card says nothing rather than naming a board NEURO could not read.
      msPlan: t.msPlan || null,
      msSource: t.msSource || null,
      // The Microsoft half a LINKED row now stands for — its wording and due
      // date, read live off the mirror. Without it the card says which board
      // the work is on and never what the board calls it, which is the half
      // Nick needs to recognise the pair he merged.
      msCounterpart: t.msCounterpart || null,
      // Whether Microsoft brings this one back. Completing a recurring task
      // closes the occurrence and rolls the same task forward, so a card that
      // does not say so reads as a completion that failed — see shared/ms-task.
      recurrence: t.recurrence || null,
      mustdo: t.mustdo || false,
      vault_task: true,
      filePath: t.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null,
      meta: t.meta || {},
      moscow: t.moscow || null,
      moscowProposed: Boolean(t.moscowProposed),
      // ⚠ A FOURTH whitelist, and a field missing from it is dropped IN
      // SILENCE — the way estimateMinutes vanished from POST /api/tasks. This
      // is what the panel renders, so anything not listed here simply does not
      // exist as far as every badge, filter and control is concerned.
      //
      // Commitment or continual improvement. Raw and undefaulted: null means
      // "not classified", and the panel's filter counts it as its own pile.
      origin: t.origin || null,
      originProposed: Boolean(t.originProposed),
      // Work or personal. Added at the same time because it was missing too, so
      // `domainBadge` in TodoPanel could never fire in full mode — the personal
      // chip has never once rendered on this screen. Same whitelist, same
      // silent drop, one line to close it.
      domain: t.domain || null,
      context: t.context || null,
      needsToday: Boolean(t.needsToday),
      createdAt: t.createdAt || null,
    }));

    // The 90-day plan injection that used to sit here is gone (#52). The plan
    // ended in July and its folder was archived on 12 Aug, so
    // `parseNinetyDayPlan()` returns null and this block has been mapping an
    // empty list ever since — while still walking the vault looking for the
    // archived folder on EVERY request, because a null result is not cached.
    // Verified against the live vault before removing: getPlan() -> null,
    // getPlanTasks() -> [].

    // What NEURO thinks about the rows it does not own — MoSCoW, priority, and
    // whether Nick is mid-way through one or stuck on it. Folded in BEFORE
    // decoration and the lane, or the letter he just set would render on the
    // badge and change no ranking, which is the half-working shape.
    const enriched = msLocal.annotate(mapped).map((task) => todoIntelligence.decorateTask(task));
    // What Nick has said "not today" to. A cheap read of open records — no
    // writes on this path, and a record whose window has already passed is not
    // returned, so a poll arriving before `releaseDeferrals` runs cannot hide
    // something that is due back.
    //
    // ⚠ Failing to read it must never HIDE the lane's own failure: an
    // unreadable lifecycle means "we could not check what you snoozed", so the
    // lane shows everything (nothing hidden on the strength of not having
    // looked) and says so in `laneGaps`.
    let deferred = new Map();
    const laneGaps = [];
    try {
      deferred = lifecycle.deferredKeys();
    } catch (e) {
      laneGaps.push({ source: 'attention-lifecycle', why: e.message });
      console.warn('[Todos] Could not read deferrals — showing the whole lane:', e.message);
    }
    const laneHeld = [];
    const todayLane = todoIntelligence.buildTodayLane(
      rankTasks(enriched.filter((task) => !task.done), new Date().toISOString().split('T')[0]),
      new Date().toISOString().split('T')[0],
      5,
      { deferred, held: laneHeld, keyFor: laneKeyFor },
    );

    // The same action often gets extracted from more than one note — a Plaud
    // summary and the meeting note built from it, say. Show it once, and carry
    // the twins' ids so approving/dismissing resolves the whole set.
    const bySignature = new Map();
    // #83 — this used to ask for 1,000 pending actions of EVERY type and then
    // discard all but capture_todo, so the bound had to swallow the whole queue
    // to be safe and silently dropped the tail once it did not. Ask the DB for
    // the type instead: the cap now bounds the rows actually rendered, and it
    // cuts by confidence rather than by whatever else happened to be pending.
    // Small on purpose — this is a review list, not an archive; #108's filtered
    // /api/actions is the way to reach past it.
    const pending = db.getPendingSaraActionsByType('capture_todo', SUGGESTION_CAP);
    const pendingTotal = db.countPendingSaraActionsByType('capture_todo');
    if (pending.length >= SUGGESTION_CAP) {
      // Loud, because a capped list looks exactly like a complete one.
      console.warn(`[Todos] Suggestion list capped at ${SUGGESTION_CAP} of ${pendingTotal} pending `
        + `capture_todo actions — the rest are reachable via /api/actions?type=capture_todo`);
    }
    for (const action of pending) {
      const text = action.payload?.text || action.reason || 'Suggested task';
      const signature = action.payload?.semanticSignature || text.toLowerCase();
      const seen = bySignature.get(signature);
      if (seen) {
        seen.duplicateIds.push(action.id);
        continue;
      }
      bySignature.set(signature, {
        id: action.id,
        text,
        reason: action.reason || 'Suggested from a note',
        confidence: action.confidence || 0,
        sourcePath: action.payload?.sourcePath || null,
        sourceLine: action.payload?.sourceLine || null,
        createdAt: action.created_at || null,
        duplicateIds: [],
      });
    }
    const suggested = [...bySignature.values()];

    // suggested.length is post-dedupe and post-cap, so it is not a count of
    // what is waiting. Send the real total rather than letting the screen imply
    // one — the same reason /api/actions carries pendingTotal (#97).
    res.json({
      todos: enriched,
      suggested,
      todayLane,
      // Held back, never silently dropped — a lane that is simply shorter is
      // indistinguishable from one that found less work.
      laneHeld,
      laneGaps,
      suggestedTotal: pendingTotal,
      suggestedCapped: pending.length >= SUGGESTION_CAP,
    });
  } catch (e) {
    console.error('[Todos] Error parsing vault todos:', e);
    res.status(500).json({ error: 'Failed to parse vault todos' });
  }
});

// GET /api/todos/focus — smart prioritised shortlist for drill-downs
// Query params:
//   ?filter=overdue|today|all (default: overdue)
//   ?limit=N (default: 10, max: 30)
//   ?showAll=true (bypass limit, return everything ranked)
router.get('/focus', async (req, res) => {
  const t0 = Date.now();
  try {
    const filter = req.query.filter || 'overdue';
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const showAll = req.query.showAll === 'true';
    const todayStr = new Date().toISOString().split('T')[0];

    // CACHED: scored tasks (only recomputed if vault files changed or date rolled)
    const ranked = vaultCache.getScoredTasks(filter, () => {
      const { active } = vaultCache.getTodos();

      let tasks = active.map((t, i) => ({
        id: i + 1,
        task_id: t.task_id || null,
        taskPriority: t.taskPriority || null,
        text: t.text,
        priority: t.priority || 'normal',
        due_date: t.due_date || null,
        source: t.source || null,
        done: t.status === 'done' ? 1 : 0,
        ms_id: t.ms_id || null,
        msPlan: t.msPlan || null,
        msSource: t.msSource || null,
        recurrence: t.recurrence || null,
        vault_task: true,
        filePath: t.filePath || null,
        lineNumber: t.lineNumber != null ? t.lineNumber : null,
      }));

      // The second copy of the 90-day plan injection is gone too (#52) — this
      // one was on /focus, so the dead vault walk ran on the hottest path in
      // the app.

      // ⚠ Annotate BEFORE the filter, not after. The date filters below are the
      // one place a task can be excluded outright, so a row Nick has marked
      // "my part done" has to be knowable by then — annotating afterwards
      // leaves it ranked correctly and still sitting at the top of the Overdue
      // tab, which is the screen the whole point was to get it off.
      tasks = msLocal.annotate(tasks);

      // Apply filter
      if (filter === 'overdue') {
        tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] < todayStr && !t.done && !t.myPartDone);
      } else if (filter === 'today') {
        tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] === todayStr && !t.done && !t.myPartDone);
      } else {
        // ⚠ Still in ALL, always. A card whose other half is outstanding has
        // not gone anywhere, and dropping it from every view would trade a
        // false "you are late" for a false "there is nothing there" — the
        // worse of the two, because the first is at least visible.
        tasks = tasks.filter(t => !t.done);
      }

      return rankTasks(tasks.map((task) => todoIntelligence.decorateTask(task, todayStr)), todayStr);
    });
    const totalCount = ranked.length;

    // Apply limit
    const items = showAll ? ranked : ranked.slice(0, limit);

    // Categorise the backlog
    const staleCount = ranked.filter(t => (t._score || 0) < 20).length;
    const recentCount = ranked.filter(t => (t._score || 0) >= 40).length;

    // Generate AI framing (non-blocking, with timeout)
    let framing = '';
    if (!showAll && items.length > 0) {
      try {
        const aiProvider = require('../services/ai-provider');
        const topSource = items[0]?._scoreReason || 'current priorities';
        const context = `${items.length} ${filter} tasks shown of ${totalCount} total. ${staleCount} stale. Top items: ${topSource}`;
        const framingPromise = aiProvider.generateDrilldownFraming(context);
        const timeout = new Promise(resolve => setTimeout(() => resolve({ text: '' }), 5000));
        const result = await Promise.race([framingPromise, timeout]);
        framing = result.text || '';
      } catch {}
    }

    console.log(`[Todos/Focus] Built in ${Date.now() - t0}ms (${totalCount} total, ${items.length} returned)`);

    res.json({
      filter,
      totalCount,
      returned: items.length,
      hidden: totalCount - items.length,
      breakdown: {
        pressing: recentCount,
        moderate: totalCount - recentCount - staleCount,
        stale: staleCount,
      },
      framing,
      items,
    });
  } catch (e) {
    console.error('[Todos] Focus error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/todos/toggle — toggle a task's done status in the vault
router.post('/toggle', (req, res) => {
  try {
    const { filePath, lineNumber } = req.body;
    if (!filePath || lineNumber == null) {
      return res.status(400).json({ error: 'filePath and lineNumber required' });
    }
    const { status: newStatus, text } = obsidian.toggleTask(filePath, lineNumber);
    if (newStatus === 'done') _recordCompletion({ text, filePath, lineNumber, owner: 'vault' });
    res.json({ status: newStatus });
  } catch (e) {
    console.error('[Todos] Toggle error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/todos/wip-ms — mark a Microsoft-owned task started, or put it back.
 *
 * Four of the five rows in Nick's Must Move lane are MS Planner tasks, so a WIP
 * button that only worked on NEURO-owned rows would be missing from exactly the
 * work he wanted to mark. Microsoft owns those tasks, so the status belongs
 * there — Planner's own in-progress state — rather than in a shadow copy NEURO
 * keeps beside it. Storing it locally would be a second source of truth for a
 * field Microsoft already has, which is the thing task-dedupe exists to undo.
 *
 * ⚠ NO webhook fallback, unlike complete-ms. Power Automate's flow completes a
 * task; there is nothing behind it for progress, and reporting `pushed: none`
 * honestly beats inventing a path that does not exist.
 */
router.post('/wip-ms', async (req, res) => {
  try {
    const { msId, source, listId, started, filePath, lineNumber } = req.body || {};
    if (!msId) return res.status(400).json({ error: 'msId required' });

    const wantStarted = started !== false;

    // Mirror FIRST, exactly as complete-ms does. The lane reads this file, not
    // Graph, and it is only rewritten by syncMicrosoftTasks on a schedule — so
    // without this the push lands on Planner and NEURO shows the old value for
    // up to an hour. Four clicks reached Graph with nothing changing on screen,
    // which is indistinguishable from a dead button.
    let mirrored = false;
    if (filePath && lineNumber != null) {
      try {
        // msId is passed as the expected id: the mirror line must be the task
        // Graph is about to be told about, not merely the line at that offset.
        obsidian.setTaskPercent(filePath, lineNumber, wantStarted ? 50 : 0, msId);
        mirrored = true;
      } catch (e) {
        console.warn('[Todos] Could not update the mirror line:', e.message);
      }
    }

    const result = await microsoft.setMicrosoftTaskProgress(
      msId, wantStarted, source || null, listId || null
    );
    if (result.ok) return res.json({ ok: true, pushed: result.kind || 'graph', started: wantStarted, mirrored });

    // Graph refused, so put the mirror back rather than leaving NEURO claiming
    // a state Planner does not hold.
    if (mirrored) {
      try { obsidian.setTaskPercent(filePath, lineNumber, wantStarted ? 0 : 50, msId); } catch { /* best effort */ }
    }

    const reasons = {
      auth: 'Microsoft sign-in expired — reconnect 365.',
      scope: 'Tasks permission not granted — re-consent to Microsoft.',
      list_not_found: 'Could not find the task in any To Do list.',
      not_found: 'Task not found in Planner.',
    };
    // The click did nothing, and says so. A silent failure here would leave the
    // button looking like it worked while Planner still reads "not started".
    res.status(502).json({
      ok: false,
      pushed: 'none',
      error: reasons[result.reason] || `Microsoft push failed (${result.reason})`,
    });
  } catch (e) {
    console.error('[Todos] MS WIP error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/todos/ms/:msId — the editable fields of one Microsoft task, LIVE.
 *
 * Deliberately not served from the mirror. `Tasks/Microsoft Tasks.md` carries
 * the title and the due date but never the description, so an editor built on it
 * would show an empty notes box over a Planner description that has content —
 * and the first save would erase it. `notesReadable: false` is the honest answer
 * when the description could not be fetched, and the client refuses to edit what
 * it could not read rather than offering an empty box.
 *
 * It is also the freshest read available, which matters on To Do: those PATCHes
 * carry no etag, so what is on screen at save time is what wins.
 */
/**
 * Completions Microsoft would not take, and what is being done about them.
 *
 * ⚠ `/ms-queue`, NOT `/ms/queue`. Express matches in registration order and
 * `/ms/:msId` sits directly below — a `/ms/queue` would be read as a task whose
 * id is the word "queue", which is the trap `/triage/feedback` already fell into
 * once. A separate segment cannot collide whatever the order.
 *
 * GET reports; POST forces a drain now rather than waiting for the ten-minute
 * pass, which is what Nick wants the moment he has just reconnected 365.
 * DELETE forgets one — the way back when the task was dealt with in Microsoft
 * directly and the held push is chasing something that is gone.
 */
router.get('/ms-queue', (req, res) => {
  try {
    res.json(msQueue.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ms-queue/drain', async (req, res) => {
  try {
    // ⚠ Nested, not spread. `drain()` returns `failed` as a COUNT and `status()`
    // returns it as a LIST, so spreading both silently hands the client one
    // shape where it expects the other — and the number it would lose is how
    // many completions were just given up on.
    const run = await msQueue.drain();
    res.json({ run, ...msQueue.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/ms-queue/:msId', (req, res) => {
  try {
    const forgotten = msQueue.forget(req.params.msId);
    if (!forgotten) return res.status(404).json({ error: 'Nothing held for that task' });
    res.json({ ok: true, ...msQueue.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * "This isn't a must-do today."
 *
 * ── Why it goes through the attention lifecycle ─────────────────────────────
 *
 * The lane had no way to disagree with it at all. Membership is recomputed on
 * every read (`moscow === 'must' || overdue || dueToday || priority high`), so
 * there was nothing to override, and the indirect levers do not work either:
 * dropping the MoSCoW leaves `overdue` carrying `needsToday` on its own, so the
 * only exit for an overdue task was to move its due date — a lie about when it
 * was committed to — or to abandon it.
 *
 * The rest of NEURO already solved this properly. `attention_records` keeps
 * "I've seen it", "not now" and "not mine" apart, carries a REASON on a
 * deferral, and `friction.js` reads those reasons back as evidence about the
 * WORK (a task put off three times for `too-big` is a finding). So this reuses
 * that rather than adding a second suppression map — and because the key is
 * `todo:<slug of text>`, the same key the decision engine uses, "not today"
 * here is the same statement as deferring the task on the Now page. Two stores
 * would let one surface contradict the other about a decision made once.
 *
 * ⚠ The record is created HERE, at the moment Nick decides — never on the read
 * path. `GET /api/todos` is polled; opening a record per lane row per poll
 * would write continuously to say nothing, and the honest position is that a
 * task has no lifecycle record until somebody has an opinion about it.
 *
 * ⚠ Only DEFER is offered, not dismiss. "Not today" is a statement about
 * timing; "never show me this" is a statement about the task, and the task is
 * still open and still owed. Conflating them is how work disappears from the
 * one place Nick looks to find what he owes.
 */

// 07:00 tomorrow, in local time — never toISOString(), the Pi may run UTC.
//
// Tomorrow morning rather than "+24h": the lane is called Must move TODAY, so
// the natural unit is a day, and a rolling 24 hours would bring it back mid
// afternoon on a day it had already been excused from.
function _minutesUntilTomorrowMorning(now = new Date()) {
  const then = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 7, 0, 0, 0);
  return Math.max(1, Math.round((then.getTime() - now.getTime()) / 60000));
}

/**
 * POST /api/todos/lane/defer — { text, reason?, minutes? }
 *
 * Keyed on the task's TEXT, because that is what `dedupeKeyFor` uses for a
 * `todo` card and the whole value here is sharing one record with the other
 * surfaces. The client sends the row's text verbatim.
 */
router.post('/lane/defer', (req, res) => {
  try {
    const { text, reason, minutes } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'text is required' });

    // A reason NEURO does not recognise is REFUSED rather than stored as
    // 'unspecified'. The reasons are the payoff — friction reads them back as
    // evidence about the work — and quietly downgrading a typo to "no reason
    // given" loses exactly the signal this exists to collect.
    if (reason != null && reason !== '' && !lifecycle.DEFER_REASONS.has(reason)) {
      return res.status(400).json({
        ok: false,
        error: `Unknown reason — expected one of ${[...lifecycle.DEFER_REASONS].join(', ')}.`,
      });
    }

    const record = lifecycle.upsert({
      type: 'todo',
      title: String(text).trim(),
      reason: 'Must move today',
      tab: 'todos',
    });
    if (!record) return res.status(400).json({ ok: false, error: 'Could not open a record for that task' });

    const mins = Number.isFinite(Number(minutes)) && Number(minutes) > 0
      ? Number(minutes)
      : _minutesUntilTomorrowMorning();
    const result = lifecycle.act(record.id, 'defer', { minutes: mins, reason: reason || 'unspecified' });
    if (!result.ok) return res.status(400).json(result);

    res.json({
      ok: true,
      recordId: record.id,
      until: result.record.defer_until,
      reason: result.record.defer_reason,
    });
  } catch (e) {
    console.error('[Todos] Lane defer error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/todos/lane/undefer — { text }
 *
 * The way back. Every other decision in this codebase has one (`restore`,
 * `unmerge`, `unlink`, `forget`), and a snooze that could only be waited out
 * would be the exception. The deferral itself is NOT erased — the event stays
 * in the history, so the friction read still counts that Nick put it off.
 */
router.post('/lane/undefer', (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'text is required' });
    const key = lifecycle.dedupeKeyFor({ type: 'todo', title: String(text).trim() });
    const row = db.getOpenAttentionRecord(key);
    if (!row) return res.status(404).json({ ok: false, error: 'Nothing is snoozed for that task' });
    const result = lifecycle.act(row.id, 'undefer', {});
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, recordId: row.id });
  } catch (e) {
    console.error('[Todos] Lane undefer error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * PATCH /api/todos/ms/:msId/local — what NEURO thinks about a Microsoft task.
 *
 * ⚠ NOTHING HERE IS SENT TO MICROSOFT, and that is the feature rather than a
 * shortcut. `wip-ms` one route up is the public version — it writes
 * percentComplete to Planner, which Nick's team reads. This is the private one:
 * "working on" without telling the board, "blocked" which Planner cannot
 * express at all, and a MoSCoW letter and priority that are NEURO's ranking
 * vocabulary and have no business on somebody else's card.
 *
 * Registered ABOVE `/ms/:msId` — Express matches in registration order and this
 * codebase has shipped a literal path swallowed by a sibling parameter before.
 * The two paths differ in segment COUNT so they could not collide anyway, but
 * the ordering costs nothing and the test pins it.
 *
 * Only the fields present in the body are touched; an explicit null clears one.
 * Omission and null are deliberately different — a control that sets MoSCoW
 * must not wipe the state beside it just by not mentioning it.
 */
router.patch('/ms/:msId/local', (req, res) => {
  try {
    const { msId } = req.params;
    if (!msId) return res.status(400).json({ error: 'msId required' });

    const body = req.body || {};
    const fields = {};
    for (const key of ['state', 'moscow', 'priority']) {
      if (key in body) fields[key] = body[key];
    }
    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: 'Nothing to change — send state, moscow or priority.' });
    }
    // A value NEURO does not recognise is REFUSED, never silently stored as
    // null: "clear it" and "I sent you something you did not understand" are
    // different requests, and normalising the second into the first is how a
    // typo reads back as a decision Nick made.
    if (fields.state != null && fields.state !== '' && msLocal.normState(fields.state) === null) {
      return res.status(400).json({ error: `Unknown state — expected one of ${msLocal.VALID_STATE.join(', ')}.` });
    }

    const entry = msLocal.set(msId, fields);
    // The focus lane ranks off a cached scored list, so without this the letter
    // lands, the badge changes and the ordering stays exactly as it was until
    // the vault next moves — a change that looks half-applied.
    vaultCache.invalidateType('todos');
    res.json({ ok: true, local: entry });
  } catch (e) {
    console.error('[Todos] MS local annotation error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/ms/:msId', async (req, res) => {
  try {
    const { msId } = req.params;
    const { source, listId } = req.query;
    const result = await microsoft.readMicrosoftTask(msId, source || null, listId || null);
    if (!result.ok) {
      return res.status(result.reason === 'auth' ? 503 : 404).json({
        ok: false,
        error: MS_EDIT_REASONS[result.reason] || `Could not read the task (${result.reason})`,
      });
    }
    res.json(result);
  } catch (e) {
    console.error('[Todos] MS read error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/todos/ms/:msId — edit a Microsoft task from NEURO.
 *
 * Microsoft still owns it: this PATCHes Graph and then repaints the mirror line,
 * and nothing is stored locally. Only the fields present in the body are sent,
 * so an editor open on a stale row cannot write back three fields when one
 * changed — the only defence there is on To Do, which has no etag.
 *
 * ⚠ GRAPH FIRST, mirror second — the opposite order to `wip-ms` and
 * `complete-ms`, on purpose. Those write a state that is trivially reversible
 * and where instant feedback is the whole point. A rename is neither: on Planner
 * it is visible to Nick's team, and painting it into the vault before Graph has
 * accepted it would show an edit that may never have landed. Only a field that
 * actually SAVED reaches the mirror.
 */
router.patch('/ms/:msId', async (req, res) => {
  try {
    const { msId } = req.params;
    const { source, listId, title, dueDate, notes, filePath, lineNumber } = req.body || {};
    if (!msId) return res.status(400).json({ error: 'msId required' });

    const patch = {};
    if (title !== undefined) patch.title = title;
    // null clears the date and undefined leaves it alone — the difference has to
    // survive JSON, so it is only ever read as "was the key present".
    if (dueDate !== undefined) patch.dueDate = dueDate === null || dueDate === '' ? null : dueDate;
    if (notes !== undefined) patch.notes = notes;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });

    const result = await microsoft.updateMicrosoftTaskFields(msId, patch, source || null, listId || null);

    const applied = result.applied || [];
    if (!applied.length) {
      const first = (result.failed || [])[0];
      const reason = result.reason || first?.reason || 'unknown';
      // A 502 says the upstream failed. Our OWN input rules run before a token
      // is even fetched, so blaming Microsoft for them is a status code that
      // sends the reader to the wrong system — and this is the one endpoint
      // whose whole job is to be clear about which side refused.
      const status = REFUSED_LOCALLY.has(reason) ? 400
        : reason === 'conflict' ? 409
        : reason === 'auth' || reason === 'scope' ? 503
        : 502;
      return res.status(status).json({
        ok: false,
        pushed: 'none',
        error: MS_EDIT_REASONS[reason] || `Microsoft rejected the edit (${reason})`,
        failed: result.failed || [],
      });
    }

    // Repaint the one line, and only with what Graph took. A failed notes write
    // must not leave the title looking saved when it was not, or vice versa.
    let mirrored = false;
    if (filePath && lineNumber != null && (applied.includes('title') || applied.includes('dueDate'))) {
      try {
        const fields = {};
        if (applied.includes('title')) fields.title = patch.title;
        if (applied.includes('dueDate')) fields.dueDate = patch.dueDate;
        obsidian.setTaskFields(filePath, lineNumber, fields, msId);
        mirrored = true;
      } catch (e) {
        // The edit IS saved in Microsoft; only the local copy is stale, and the
        // next sync fixes it. Worth saying, never worth failing the request.
        console.warn('[Todos] Could not repaint the mirror line:', e.message);
      }
    }

    res.json({
      ok: (result.failed || []).length === 0,
      pushed: result.kind || 'graph',
      applied,
      failed: result.failed || [],
      mirrored,
    });
  } catch (e) {
    console.error('[Todos] MS edit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/todos/complete-ms — complete a Microsoft To-Do/Planner task and
// toggle the vault mirror. Pushes over Graph and reports whether it landed;
// Power Automate stays as the fallback for when Graph auth is expired.
router.post('/complete-ms', async (req, res) => {
  try {
    const { msId, source, filePath, lineNumber, listId } = req.body;
    if (!msId) return res.status(400).json({ error: 'msId required' });

    // Toggle in vault first (instant)
    let mirrorText = null;
    if (filePath && lineNumber != null) {
      mirrorText = obsidian.toggleTask(filePath, lineNumber).text;
    }

    // ⚠ Recorded BEFORE the Graph push, and deliberately. The task is closed
    // from Nick's point of view the moment the mirror flips — `complete-ms`
    // already returns ok:true with `pushed: 'none'` when Graph refuses, because
    // the vault line is what NEURO reads. A win conditional on Microsoft
    // answering would go missing on exactly the days Graph auth has expired,
    // silently, which is the shape of the bug this whole ledger exists to stop.
    _recordCompletion({ text: mirrorText, msId, msSource: source, filePath, lineNumber, owner: 'microsoft' });

    const result = await microsoft.completeMicrosoftTask(msId, source, listId || null);
    if (result.completed) {
      // ⚠ A recurring task is NOT finished by being completed. Microsoft closes
      // the occurrence and rolls the same task id forward — status back to
      // notStarted, due date advanced — so the next mirror sync reads it as open
      // and writes it back. Ticked, gone, back an hour later: exactly what a
      // LOST completion looks like, which is how three of these got ticked over
      // and over (1 Sep 2026).
      //
      // The tick did something real, so it is not undone — but the mirror is
      // repainted to what Microsoft now holds rather than left claiming a state
      // Graph does not agree with. Leaving it ticked would be NEURO showing the
      // wrong answer for up to half an hour and then appearing to lose it.
      if (result.rolled && filePath && lineNumber != null) {
        try {
          // Back to open: this is a repaint of Microsoft's truth, not a rollback
          // of Nick's action.
          obsidian.toggleTask(filePath, lineNumber);
          if (result.rolled.nextDue) {
            // The due date moved with the occurrence. Without this the line
            // keeps the old one and the card goes on reporting an overdue that
            // is no longer real — the 184-days-overdue figure that made this
            // look like a stuck task rather than a recurring one.
            obsidian.setTaskFields(filePath, lineNumber, { dueDate: result.rolled.nextDue }, msId);
          }
        } catch (e) {
          console.warn('[Todos] Could not repaint the rolled mirror line:', e.message);
        }
      }
      return res.json({
        ok: true,
        pushed: result.kind || 'graph',
        // Null for the ordinary case, so a client can treat its presence as the
        // whole signal: this task is still open and here is why.
        rolled: result.rolled || null,
        notice: msTask.rolledNotice(result.rolled || null),
      });
    }

    // Graph refused — fall back to the Power Automate flow.
    const webhookOk = await _fireWebhook(msId, source);
    const reasons = {
      auth: 'Microsoft sign-in expired — reconnect 365.',
      scope: 'Tasks permission not granted — re-consent to Microsoft.',
      list_not_found: 'Could not find the task in any To Do list.',
      not_found: 'Task not found in Planner.',
    };

    // Neither route landed. HOLD IT — the mirror is already ticked and is
    // regenerated from Graph every 30 minutes, so without this the task
    // reappears as open inside the half hour and the completion is silently
    // undone. Queued only when the webhook did not fire either: a webhook that
    // returned OK completed the task through Power Automate, and re-pushing on
    // top of that is chasing work already done.
    let held = false;
    if (!webhookOk) {
      held = !!msQueue.enqueue({ msId, source, listId: listId || null, text: mirrorText, reason: result.reason });
    }

    res.json({
      ok: true,
      pushed: webhookOk ? 'webhook' : 'none',
      // `held` is the difference between "this didn't reach Microsoft" and
      // "this didn't reach Microsoft and nothing is going to try again" — the
      // client says so, because a warning Nick reads as final when it is not
      // costs him a second tick.
      held,
      warning: webhookOk
        ? null
        : `${reasons[result.reason] || `Microsoft push failed (${result.reason})`}${held ? ' Held — NEURO will retry.' : ''}`,
    });
  } catch (e) {
    console.error('[Todos] MS complete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Power Automate webhook — fallback when Graph can't complete the task
async function _fireWebhook(taskId, source) {
  const webhookUrl = process.env.PA_TASK_COMPLETE_WEBHOOK;
  if (!webhookUrl) {
    console.warn('[Todos] PA_TASK_COMPLETE_WEBHOOK not configured — skipping MS completion');
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, source }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      console.log(`[Todos] PA webhook fired: ${source} ${taskId}`);
      return true;
    }
    console.warn(`[Todos] PA webhook returned ${res.status}`);
    return false;
  } catch (e) {
    console.warn(`[Todos] PA webhook failed: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// MoSCoW Review
// ═══════════════════════════════════════════════════════

const db = require('../db/database');

// GET /api/todos/moscow — MoSCoW ratings, keyed by task id for the tasks NEURO owns
// and by the legacy path key for file-backed lines (Microsoft, daily notes).
router.get('/moscow', (req, res) => {
  try {
    const map = {};
    for (const r of db.getAllTaskMoscow()) map[r.task_key] = r.moscow;
    for (const t of taskStore.listTasks({ status: 'all', includeDone: true })) {
      if (t.moscow) map[`task:${t.id}`] = t.moscow;
    }
    res.json({ ratings: map, total: Object.keys(map).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/todos/moscow — set MoSCoW on a task NEURO owns. Requires a taskId.
//
// #50: this used to fall through to a legacy path-keyed `task_moscow` row when
// no taskId was given, so that file-backed mirrors (Microsoft, daily notes)
// could be rated too. Nothing ever read those back for anything editable, so
// rating a mirror returned `{ok:true}` and then did nothing — the failure
// species this codebase keeps naming, in miniature: a write that reports
// success into a place with no readers.
//
// Measured before removing: the fallback wrote **one** row in the system's
// life (13 Aug, a Microsoft Tasks line), and it has had no caller since
// `/moscow/review` was scoped to NEURO-owned tasks — the swipe review is the
// only writer and every row it offers carries a task_id. Refusing loudly is
// better than a silent no-op, so an unowned line now gets a reason rather than
// a cheerful ok. The GET still surfaces the historical row, and DELETE still
// clears it, so nothing already recorded is stranded.
router.post('/moscow', (req, res) => {
  try {
    const { taskId, moscow } = req.body;
    if (!moscow || !['must', 'should', 'could', 'wont'].includes(moscow)) {
      return res.status(400).json({ error: 'moscow must be: must, should, could, wont' });
    }
    if (!taskId) {
      return res.status(400).json({
        error: 'taskId is required — only tasks NEURO owns can be rated. '
          + 'A file-backed line (Microsoft, a daily note) has no row to hold the rating, '
          + 'so this used to save nowhere and report success.',
      });
    }
    const task = taskStore.updateTask(Number(taskId), { moscow });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true, taskId: task.id, moscow: task.moscow });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/todos/moscow — remove MoSCoW rating for a task
router.delete('/moscow', (req, res) => {
  try {
    const { filePath, lineNumber, text } = req.body;
    db.deleteTaskMoscow(filePath, lineNumber, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/todos/moscow/review — untriaged tasks for the swipe review.
// Scoped to the tasks NEURO owns: they are the ones whose rating has somewhere to
// live. File-backed mirrors (Microsoft, daily notes, the finished plan) are excluded
// on purpose — rating them was writing metadata for rows that don't exist.
router.get('/moscow/review', (req, res) => {
  try {
    const counts = taskStore.counts();
    const untriaged = taskStore.listTasks({ status: 'open' })
      .filter(t => !t.moscow || t.moscow_proposed)
      .map(t => ({
        task_id: t.id,
        text: t.text,
        source: t.source,
        proposedMoscow: t.moscow_proposed ? t.moscow : null,
        due_date: t.due_date || null,
        priority: taskStore.legacyPriority(t),
        taskPriority: t.priority || null,
        filePath: null,
        lineNumber: null,
      }));

    res.json({
      total: counts.open,
      triaged: counts.open - counts.untriaged,
      untriaged: untriaged.length,
      tasks: untriaged,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
