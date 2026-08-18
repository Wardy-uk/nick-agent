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
