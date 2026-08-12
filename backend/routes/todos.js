const express = require('express');
const router = express.Router();
const obsidian = require('../services/obsidian');
const vaultCache = require('../services/vault-cache');
const { rankTasks } = require('../services/task-scoring');
const todoIntelligence = require('../services/todo-intelligence');

// GET /api/todos — reads tasks from Obsidian vault + 90-day plan
router.get('/', (req, res) => {
  try {
    const showDone = req.query.all === 'true';
    const { active, done } = vaultCache.getTodos();

    const todos = showDone ? [...active, ...done] : active;

    // Map to shape the frontend expects
    const mapped = todos.map((t, i) => ({
      id: i + 1,
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
    for (const action of db.getPendingSaraActions(200)) {
      if (action.type !== 'capture_todo') continue;
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

    res.json({ todos: enriched, suggested, todayLane });
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

// POST /api/todos/complete-ms — complete a Microsoft task via Power Automate webhook + toggle in vault
router.post('/complete-ms', async (req, res) => {
  try {
    const { msId, source, filePath, lineNumber } = req.body;
    if (!msId) return res.status(400).json({ error: 'msId required' });

    // Toggle in vault first (instant)
    if (filePath && lineNumber != null) {
      obsidian.toggleTask(filePath, lineNumber);
    }

    // Fire-and-forget webhook to Power Automate to complete in Microsoft
    _fireWebhook(msId, source).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    console.error('[Todos] MS complete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Power Automate webhook — fire and forget
async function _fireWebhook(taskId, source) {
  const webhookUrl = process.env.PA_TASK_COMPLETE_WEBHOOK;
  if (!webhookUrl) {
    console.warn('[Todos] PA_TASK_COMPLETE_WEBHOOK not configured — skipping MS completion');
    return;
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
    } else {
      console.warn(`[Todos] PA webhook returned ${res.status}`);
    }
  } catch (e) {
    console.warn(`[Todos] PA webhook failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// MoSCoW Review
// ═══════════════════════════════════════════════════════

const db = require('../db/database');

// GET /api/todos/moscow — get all MoSCoW ratings
router.get('/moscow', (req, res) => {
  try {
    const ratings = db.getAllTaskMoscow();
    // Build a lookup map keyed by task_key
    const map = {};
    for (const r of ratings) map[r.task_key] = r.moscow;
    res.json({ ratings: map, total: ratings.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/todos/moscow — set MoSCoW for a task
router.post('/moscow', (req, res) => {
  try {
    const { filePath, lineNumber, text, moscow } = req.body;
    if (!moscow || !['must', 'should', 'could', 'wont'].includes(moscow)) {
      return res.status(400).json({ error: 'moscow must be: must, should, could, wont' });
    }
    if (!text) return res.status(400).json({ error: 'text required' });
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

// GET /api/todos/moscow/review — get untriaged tasks for review
router.get('/moscow/review', (req, res) => {
  try {
    const { active } = vaultCache.getTodos();
    const allRatings = db.getAllTaskMoscow();
    const ratedKeys = new Set(allRatings.map(r => r.task_key));

    // Build task key the same way the DB does
    const taskKey = (t) => `${t.filePath || 'unknown'}::${(t.text || '').substring(0, 60).replace(/\s+/g, ' ').trim()}`;

    // Also include 90-day plan tasks
    let allTasks = active.map(t => ({
      text: t.text,
      source: t.source || null,
      due_date: t.due_date || null,
      filePath: t.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null,
      priority: t.priority || 'normal',
    }));

    try {
      const plan = vaultCache.getPlan();
      if (plan) {
        for (const t of (plan.allTasks || [])) {
          if (t.isCheckpoint || t.status === 'x') continue;
          allTasks.push({
            text: t.text,
            source: '90-Day Plan',
            due_date: t.calendarDate || null,
            filePath: plan.filePath || null,
            lineNumber: t.lineNumber != null ? t.lineNumber : null,
            priority: 'normal',
          });
        }
      }
    } catch {}

    // Filter to untriaged only
    const untriaged = allTasks.filter(t => !ratedKeys.has(taskKey(t)));

    res.json({
      total: allTasks.length,
      triaged: allRatings.length,
      untriaged: untriaged.length,
      tasks: untriaged,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
