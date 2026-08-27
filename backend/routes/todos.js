const express = require('express');
const router = express.Router();
const obsidian = require('../services/obsidian');
const vaultCache = require('../services/vault-cache');
const { rankTasks } = require('../services/task-scoring');
const todoIntelligence = require('../services/todo-intelligence');
const taskStore = require('../services/task-store');
const microsoft = require('../services/microsoft');

// How many pending capture_todo suggestions the todos payload will carry. The
// queue hit 930 in August and collapsed to single figures once #108 made it
// reachable, so this is a render bound, not a storage one.
const SUGGESTION_CAP = 200;

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
      mustdo: t.mustdo || false,
      vault_task: true,
      filePath: t.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null,
      meta: t.meta || {},
      moscow: t.moscow || null,
      moscowProposed: Boolean(t.moscowProposed),
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

    const enriched = mapped.map((task) => todoIntelligence.decorateTask(task));
    const todayLane = todoIntelligence.buildTodayLane(rankTasks(enriched.filter((task) => !task.done), new Date().toISOString().split('T')[0]));

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
        vault_task: true,
        filePath: t.filePath || null,
        lineNumber: t.lineNumber != null ? t.lineNumber : null,
      }));

      // The second copy of the 90-day plan injection is gone too (#52) — this
      // one was on /focus, so the dead vault walk ran on the hottest path in
      // the app.

      // Apply filter
      if (filter === 'overdue') {
        tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] < todayStr && !t.done);
      } else if (filter === 'today') {
        tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] === todayStr && !t.done);
      } else {
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
    const newStatus = obsidian.toggleTask(filePath, lineNumber);
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

// POST /api/todos/complete-ms — complete a Microsoft To-Do/Planner task and
// toggle the vault mirror. Pushes over Graph and reports whether it landed;
// Power Automate stays as the fallback for when Graph auth is expired.
router.post('/complete-ms', async (req, res) => {
  try {
    const { msId, source, filePath, lineNumber, listId } = req.body;
    if (!msId) return res.status(400).json({ error: 'msId required' });

    // Toggle in vault first (instant)
    if (filePath && lineNumber != null) {
      obsidian.toggleTask(filePath, lineNumber);
    }

    const result = await microsoft.completeMicrosoftTask(msId, source, listId || null);
    if (result.completed) {
      return res.json({ ok: true, pushed: result.kind || 'graph' });
    }

    // Graph refused — fall back to the Power Automate flow.
    const webhookOk = await _fireWebhook(msId, source);
    const reasons = {
      auth: 'Microsoft sign-in expired — reconnect 365.',
      scope: 'Tasks permission not granted — re-consent to Microsoft.',
      list_not_found: 'Could not find the task in any To Do list.',
      not_found: 'Task not found in Planner.',
    };
    res.json({
      ok: true,
      pushed: webhookOk ? 'webhook' : 'none',
      warning: webhookOk ? null : (reasons[result.reason] || `Microsoft push failed (${result.reason})`),
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
