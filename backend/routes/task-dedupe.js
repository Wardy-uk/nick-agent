'use strict';

/**
 * /api/task-dedupe — the review surface for NEURO-vs-Microsoft duplicate tasks.
 *
 * Suggests, never merges. Every link and every rejection is Nick's, and both are
 * remembered so the same pair is not put in front of him twice.
 */

const express = require('express');
const router = express.Router();
const taskStore = require('../services/task-store');
const dedupe = require('../services/task-dedupe');
const vaultCache = require('../services/vault-cache');

/**
 * The Microsoft half. Read from the vault's Microsoft Tasks.md via the same parser
 * everything else uses, NOT from Graph directly: it is the copy already on disk, so
 * the screen opens instantly and still works with Graph down or the token expired.
 * The file is refreshed by syncMicrosoftTasks() on the normal schedule.
 */
function microsoftTasks() {
  const { active } = vaultCache.getTodos();
  return active
    .filter(t => t.ms_id && /^MS /.test(t.source || ''))
    .map(t => ({
      ms_id: t.ms_id,
      text: t.text,
      due_date: t.due_date || null,
      source: t.source || null,
    }));
}

function neuroTasks() {
  return taskStore.listTasks({ status: 'open' });
}

// GET /api/task-dedupe/candidates — ?minScore= to look under the line deliberately
router.get('/candidates', (req, res) => {
  try {
    const ms = microsoftTasks();
    const neuro = neuroTasks();

    // A floor on the floor. Below ~0.15 every pair sharing one stock word matches
    // and the list stops being a list, so a caller asking for 0 gets the weak tier
    // rather than 2,544 rows of noise.
    const asked = Number(req.query.minScore);
    const minScore = Number.isFinite(asked)
      ? Math.min(Math.max(asked, 0.15), 1)
      : dedupe.MIN_SCORE;

    const candidates = dedupe.rankCandidates({
      neuroTasks: neuro,
      msTasks: ms,
      dismissed: dedupe.dismissedKeySet(),
      minScore,
    });

    res.json({
      candidates,
      minScore,
      defaultMinScore: dedupe.MIN_SCORE,
      strongScore: dedupe.STRONG_SCORE,
      // Counts so an empty list is readable. "No duplicates found" and "Microsoft
      // is unreachable so there was nothing to compare" look identical otherwise,
      // and only one of them means the screen is telling the truth.
      compared: { neuro: neuro.length, microsoft: ms.length, pairs: neuro.length * ms.length },
      microsoftAvailable: ms.length > 0,
      links: dedupe.listLinks(),
      dismissedCount: dedupe.dismissedKeySet().size,
    });
  } catch (e) {
    console.error('[TaskDedupe] Candidates error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/task-dedupe/match — { texts: [{ id, text }], minScore, limit }
 *
 * "Does a task already exist for this?" Read-only, and it decides nothing: the
 * caller gets scored candidates and a human picks. VANTAGE uses it to check the
 * Support Review's 35 actions against the task store before offering to create
 * anything, so an action Mel already put in Planner is adopted rather than
 * duplicated.
 *
 * Scores against ALL open tasks including Microsoft-linked ones — see matchText.
 */
router.post('/match', (req, res) => {
  try {
    const { texts, minScore, limit } = req.body || {};
    if (!Array.isArray(texts)) return res.status(400).json({ error: 'texts must be an array of { id, text }' });
    if (texts.length > 200) return res.status(400).json({ error: 'texts is limited to 200 per call' });

    const tasks = taskStore.listTasks({ status: 'open' });
    // BOTH lists. The Microsoft mirror is where Mel's Planner board actually
    // lives until someone links a pair, and on 20 Aug 2026 nothing was linked —
    // so searching only the task store would answer "nothing exists" for work
    // that is on the board with a due date.
    const ms = microsoftTasks();

    const asked = Number(minScore);
    const results = dedupe.matchText({
      texts,
      tasks,
      msTasks: ms,
      minScore: Number.isFinite(asked) ? Math.min(Math.max(asked, 0.15), 1) : dedupe.MIN_SCORE,
      limit: Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 10) : 3,
    });

    // `compared` so a caller can tell "nothing matched" from "there was nothing
    // to match against" — the same distinction /candidates makes. A zero
    // microsoft count means the sync has not run or Graph is unauthorised, and
    // the caller must not report that as "not on the board".
    res.json({
      results,
      compared: { tasks: tasks.length, microsoft: ms.length, texts: texts.length },
      microsoftAvailable: ms.length > 0,
    });
  } catch (e) {
    console.error('[TaskDedupe] Match error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/task-dedupe/link — { taskId, msId, msSource } — these ARE the same task
router.post('/link', (req, res) => {
  try {
    const { taskId, msId, msSource } = req.body || {};
    const result = dedupe.linkPair(taskId, msId, msSource || null);
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/task-dedupe/unlink — { taskId } — undo a link; the Microsoft line returns
router.post('/unlink', (req, res) => {
  try {
    const result = dedupe.unlinkPair((req.body || {}).taskId);
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/task-dedupe/dismiss — { taskId, msId, reason } — these are NOT the same
router.post('/dismiss', (req, res) => {
  try {
    const { taskId, msId, reason } = req.body || {};
    res.json(dedupe.dismissPair(taskId, msId, reason || null));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/task-dedupe/undismiss — { taskId, msId } — put a rejected pair back
router.post('/undismiss', (req, res) => {
  try {
    const { taskId, msId } = req.body || {};
    const result = dedupe.undismissPair(taskId, msId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
