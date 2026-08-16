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

    // Inject 90-day plan tasks (CACHED)
    try {
      const plan = vaultCache.getPlan();
      if (plan) {
        const planTasks = plan.allTasks || [];
        const planPath = plan.filePath || null;
        const OUTCOMES = {
          1: 'Visibility & BI', 2: 'Tiered Model', 3: 'Quality & CX',
          4: 'People & Culture', 5: 'Cross-functional', 6: 'Production'
        };
        let planId = mapped.length + 1;
        for (const t of planTasks) {
          if (t.isCheckpoint) continue;
          const isDone = t.status === 'x';
          if (!showDone && isDone) continue;
          const isOverdue = t.day > 0 && t.day < plan.currentDay && !isDone;
          const outcomeLabel = t.outcome ? OUTCOMES[t.outcome] || '' : '';
          mapped.push({
            id: planId++,
            text: t.text,
            priority: isOverdue ? 'high' : (t.day === plan.currentDay ? 'normal' : 'low'),
            due_date: t.calendarDate || null,
            source: `90-Day Plan${outcomeLabel ? ` (${outcomeLabel})` : ''}`,
            done: isDone ? 1 : 0,
            ms_id: null,
            vault_task: true,
            filePath: planPath,
            lineNumber: t.lineNumber != null ? t.lineNumber : null,
            planDay: t.day
          });
        }
      }
    } catch (e) {
      console.error('[Todos] 90-day plan parse error:', e.message);
    }

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
        vault_task: true,
        filePath: t.filePath || null,
        lineNumber: t.lineNumber != null ? t.lineNumber : null,
      }));

      // Inject 90-day plan tasks (CACHED)
      try {
        const plan = vaultCache.getPlan();
        if (plan) {
          const OUTCOMES = {
            1: 'Visibility & BI', 2: 'Tiered Model', 3: 'Quality & CX',
            4: 'People & Culture', 5: 'Cross-functional', 6: 'Production'
          };
          let planId = tasks.length + 1;
          for (const t of (plan.allTasks || [])) {
            if (t.isCheckpoint || t.status === 'x') continue;
            const isOverdue = t.day > 0 && t.day < plan.currentDay;
            const outcomeLabel = t.outcome ? OUTCOMES[t.outcome] || '' : '';
            tasks.push({
              id: planId++,
              text: t.text,
              priority: isOverdue ? 'high' : (t.day === plan.currentDay ? 'normal' : 'low'),
              due_date: t.calendarDate || null,
              source: `90-Day Plan${outcomeLabel ? ` (${outcomeLabel})` : ''}`,
              done: 0,
              ms_id: null,
              vault_task: true,
              filePath: plan.filePath || null,
              lineNumber: t.lineNumber != null ? t.lineNumber : null,
              planDay: t.day,
            });
          }
        }
      } catch {}

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

// POST /api/todos/moscow — set MoSCoW. A task NEURO owns is a plain DB write; a
// file-backed line still uses the legacy path key, since there is no row to update.
router.post('/moscow', (req, res) => {
  try {
    const { taskId, filePath, lineNumber, text, moscow } = req.body;
    if (!moscow || !['must', 'should', 'could', 'wont'].includes(moscow)) {
      return res.status(400).json({ error: 'moscow must be: must, should, could, wont' });
    }
    if (taskId) {
      const task = taskStore.updateTask(Number(taskId), { moscow });
      if (!task) return res.status(404).json({ error: 'Task not found' });
      return res.json({ ok: true, taskId: task.id, moscow: task.moscow });
    }
    if (!text) return res.status(400).json({ error: 'text or taskId required' });
    const key = db.setTaskMoscow(filePath, lineNumber, text, moscow);
    res.json({ ok: true, key, moscow });
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
