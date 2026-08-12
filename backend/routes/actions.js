'use strict';

/**
 * SARA Actions API — approve, reject, and list action suggestions.
 *
 * GET  /api/actions         — list pending + recent actions
 * POST /api/actions/:id/approve — execute an approved action
 * POST /api/actions/:id/reject  — reject and suppress an action
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const suggestionEngine = require('../services/suggestion-engine');
const workingMemory = require('../services/working-memory');
const actionCandidates = require('../services/action-candidates');

// GET /api/actions — list pending actions + recent history
router.get('/', (req, res) => {
  try {
    const pending = db.getPendingSaraActions();
    const recent = db.getRecentSaraActions(10);
    res.json({ pending, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve one action. Throws nothing — returns { status, body } for the caller
// to send or tally, so single and batch approval can't drift apart.
function approveAction(id) {
  const action = db.getSaraAction(parseInt(id));
  if (!action) return { status: 404, body: { error: 'Action not found' } };
  if (action.status !== 'pending') {
    return { status: 400, body: { error: `Action is ${action.status}, not pending` } };
  }

  // Execute
  const result = suggestionEngine.executeAction(action);

  // Update status
  db.updateSaraActionStatus(action.id, result.ok ? 'executed' : 'failed');

  // Log
  suggestionEngine.logActionExecution(action, result);
  if (result.ok && action.type === 'capture_todo') {
    actionCandidates.rememberReviewedAction(action, 'executed');
  }

  return {
    status: result.ok ? 200 : 500,
    body: {
      ok: result.ok,
      detail: result.detail,
      navigate: result.navigate || null,
      navigateContext: result.navigateContext || null,
      url: result.url || null,
      action,
    },
  };
}

function rejectAction(id) {
  const action = db.getSaraAction(parseInt(id));
  if (!action) return { status: 404, body: { error: 'Action not found' } };
  if (action.status !== 'pending') {
    return { status: 400, body: { error: `Action is ${action.status}, not pending` } };
  }

  db.updateSaraActionStatus(action.id, 'rejected');
  if (action.type === 'capture_todo') {
    actionCandidates.rememberReviewedAction(action, 'rejected');
  }

  // Log rejection to activity
  try {
    db.logActivity('sara_action_rejected', {
      actionId: action.id,
      type: action.type,
      reason: action.reason,
    });
  } catch {}

  return { status: 200, body: { ok: true, rejected: action.id } };
}

// POST /api/actions/:id/approve — approve and execute
router.post('/:id/approve', (req, res) => {
  try {
    const { status, body } = approveAction(req.params.id);
    // Invalidate working memory so focus fingerprint changes
    workingMemory.invalidate('sara action approved');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/actions/:id/reject — reject and optionally suppress
router.post('/:id/reject', (req, res) => {
  try {
    const { status, body } = rejectAction(req.params.id);
    // Invalidate working memory so focus fingerprint changes
    workingMemory.invalidate('sara action rejected');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/actions/batch — approve or reject many at once
// Body: { ids: [1,2,3], verb: "approve" | "reject" }
// Always 200 with a per-id breakdown: a batch is partially-successful by nature,
// and the caller needs to know which ones landed.
router.post('/batch', (req, res) => {
  try {
    const { ids, verb } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (verb !== 'approve' && verb !== 'reject') {
      return res.status(400).json({ error: 'verb must be "approve" or "reject"' });
    }

    const succeeded = [];
    const failed = [];
    for (const id of ids) {
      let outcome;
      try {
        outcome = verb === 'approve' ? approveAction(id) : rejectAction(id);
      } catch (e) {
        outcome = { status: 500, body: { error: e.message } };
      }
      if (outcome.status === 200) succeeded.push(Number(id));
      else failed.push({ id: Number(id), error: outcome.body.error || 'failed', status: outcome.status });
    }

    workingMemory.invalidate(`sara actions batch ${verb}`);

    res.json({ ok: failed.length === 0, verb, succeeded, failed, total: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
