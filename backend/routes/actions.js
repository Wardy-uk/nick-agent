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
const actionPresenter = require('../services/action-presenter');

// getPendingSaraActions defaults to 10 and orders by confidence DESC. On an
// approval list that is a silent cliff, not a page — and it was actively
// lying: the queue reads 10 and is 930. Read all of them, then decide what to
// send with the totals attached.
const READ_ALL = 100000;
const RECENT_LIMIT = 40;

// How many decorated actions go over the wire. The queue is 930 deep, almost
// all of it meeting-promotion candidates, and this is a phone screen.
const PENDING_LIMIT = 120;

// Sort order, and the reason the cap is safe: outbound sorts first, so the
// things that leave the building are never what gets cut. Confidence — the old
// order — is meaningless here; a 0.8 chase and a 0.8 capture_todo need very
// different amounts of attention.
const KIND_RANK = { outbound: 0, write: 1, navigate: 3 };

// capture_todo sits below every other write. It is bulk-generated in hundreds
// by the nightly meeting sweep (926 of the 930 pending), it already has a home
// on the Tasks screen, and without this the ONE drafted reply — gate 1 of the
// two-gate outbound path, and the reason this screen exists — ranks below all
// 926 of them purely because it is also a write and happens to be older.
const TYPE_RANK = { capture_todo: 2 };

function rank(action) {
  return TYPE_RANK[action.type] ?? KIND_RANK[action.presentation.kind] ?? 1;
}

// ── Reaching past the cap ────────────────────────────────────────────────────
//
// The cap above is right and so is the ordering, but "show more" in the panel
// only ever revealed what had already been SENT — so 347 of 467 pending actions
// could not be reached from the UI at all. That blocked the plan of record for
// clearing the backfill by hand, and even inside the 120 it was two taps a row
// with no way to act on a group.
//
// The answer is not a bigger cap (that just moves the cliff, per the calendar).
// It is a filter the server understands, so the client asks for a slice by
// source note / month / owner and pages through it.

/** The note date a candidate came from — that is what "which month" means here,
 *  not when the row happened to be created by a sweep. */
function monthOf(action) {
  const src = action.payload?.sourcePath || '';
  const m = src.match(/(\d{4})-(\d{2})-\d{2}/);
  if (m) return `${m[1]}-${m[2]}`;
  const created = String(action.created_at || '');
  return created.slice(0, 7) || null;
}

function matchesFilter(action, f) {
  if (f.type && action.type !== f.type) return false;
  if (f.kind && action.presentation.kind !== f.kind) return false;
  if (f.owner && (action.payload?.owner || 'unowned') !== f.owner) return false;
  if (f.source && (action.payload?.sourcePath || '') !== f.source) return false;
  if (f.month && monthOf(action) !== f.month) return false;
  return true;
}

function readFilter(q) {
  const f = {};
  for (const key of ['type', 'kind', 'owner', 'source', 'month']) {
    if (q[key]) f[key] = String(q[key]);
  }
  return f;
}

/** What you can filter BY, counted over everything pending — so the picker
 *  offers real groups with honest sizes rather than whatever fitted on screen. */
function buildFacets(all) {
  const bump = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };
  const byMonth = {}, byOwner = {}, bySource = {};
  for (const a of all) {
    bump(byMonth, monthOf(a));
    bump(byOwner, a.payload?.owner || 'unowned');
    bump(bySource, a.payload?.sourcePath);
  }
  return {
    byMonth,
    byOwner,
    // Biggest first — a note that threw off 40 candidates is the one worth
    // dealing with in one go.
    bySource: Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([path, count]) => ({ path, count })),
  };
}

// GET /api/actions — list pending actions + recent history
//
// Each action carries a `presentation` built on the server from its STORED
// payload (see action-presenter). The approval screen renders that rather than
// reconstructing a summary client-side, so what is on screen cannot drift from
// what executeAction will read.
//
// `pendingTotal` and `pendingByType` are always the true numbers even when
// `pending` is capped. A cap that does not say what it dropped reads as
// "that's everything", which is how a queue of 930 looked like a queue of 10.
router.get('/', (req, res) => {
  try {
    const decorate = (a) => ({ ...a, presentation: actionPresenter.describe(a) });

    const all = db.getPendingSaraActions(READ_ALL).map(decorate);
    all.sort((a, b) => {
      const ka = rank(a);
      const kb = rank(b);
      if (ka !== kb) return ka - kb;
      // Newest first within a kind: a stale promotion candidate is the least
      // useful thing on the screen.
      return String(b.created_at).localeCompare(String(a.created_at));
    });

    // Both breakdowns are over ALL pending, not the capped slice — a group
    // header counting only what fits on screen is the same quiet lie one level
    // down from the cap itself.
    const pendingByType = {};
    const pendingByKind = {};
    for (const a of all) {
      pendingByType[a.type] = (pendingByType[a.type] || 0) + 1;
      const k = a.presentation.kind;
      pendingByKind[k] = (pendingByKind[k] || 0) + 1;
    }

    // getRecentSaraActions is every status, so it re-lists everything pending.
    // History means resolved: an executed or failed action is the outcome the
    // caller came here for, and a pending one is already above.
    const recent = db.getRecentSaraActions(RECENT_LIMIT)
      .filter(a => a.status !== 'pending')
      .map(decorate);

    // Filter + page. With no filter and no offset this returns exactly what it
    // always did, so every existing caller is unaffected.
    const filter = readFilter(req.query);
    const filtered = Object.keys(filter).length ? all.filter(a => matchesFilter(a, filter)) : all;
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || PENDING_LIMIT));
    const page = filtered.slice(offset, offset + limit);

    res.json({
      pending: page,
      pendingTotal: all.length,
      pendingByType,
      pendingByKind,
      // Everything needed to know whether there is more, and how much — the
      // absence of exactly this is what made 347 rows unreachable.
      filter,
      filteredTotal: filtered.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      facets: buildFacets(all),
      recent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve one action. Throws nothing — returns { status, body } for the caller
// to send or tally, so single and batch approval can't drift apart.
// Async since the real actuators (reply_email, complete_task, schedule_focus_block)
// go out over Graph.
async function approveAction(id) {
  const action = db.getSaraAction(parseInt(id));
  if (!action) return { status: 404, body: { error: 'Action not found' } };
  if (action.status !== 'pending') {
    return { status: 400, body: { error: `Action is ${action.status}, not pending` } };
  }

  // Execute
  const result = await suggestionEngine.executeAction(action);

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
      // draft_reply hands back the words plus the send action they belong to,
      // so the caller can show the draft and offer the second approval.
      draft: result.draft || null,
      pendingActionId: result.pendingActionId || null,
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
router.post('/:id/approve', async (req, res) => {
  try {
    const { status, body } = await approveAction(req.params.id);
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
router.post('/batch', async (req, res) => {
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
    // Sequential, and NOT inside batchSaves(): approvals now await Graph calls,
    // and better-sqlite3's transaction helper only wraps synchronous work. The
    // flush-batching this used to need died with the sql.js driver — writes
    // commit immediately now, so a loop is no longer the slow path it was.
    for (const id of ids) {
      let outcome;
      try {
        outcome = verb === 'approve' ? await approveAction(id) : rejectAction(id);
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

// POST /api/actions/bulk-reject — reject everything matching a filter.
// Body: { type?, kind?, owner?, source?, month?, dryRun? }
//
// Reject only, deliberately. There is no bulk APPROVE over a filter and there
// should not be: rejecting is internal and reversible-by-re-extraction, while
// approving runs executors — one of which sends email. "Select all and approve"
// across a filter nobody read is exactly the accident this queue's two-gate
// design exists to prevent. Individual approval stays one at a time.
//
// Three further guards, in order of how badly each would bite:
//   · at least one filter — an unfiltered bulk reject is "delete the queue"
//   · nothing outbound in the matched set, ever, even though it is only a reject
//   · dryRun first, so the UI can say "reject 191 items?" with a true number
router.post('/bulk-reject', (req, res) => {
  try {
    const { dryRun = false } = req.body || {};
    const filter = readFilter(req.body || {});
    if (!Object.keys(filter).length) {
      return res.status(400).json({ error: 'A filter is required — refusing to reject the whole queue' });
    }

    const decorate = (a) => ({ ...a, presentation: actionPresenter.describe(a) });
    const matched = db.getPendingSaraActions(READ_ALL).map(decorate).filter(a => matchesFilter(a, filter));

    const outbound = matched.filter(a => a.presentation.kind === 'outbound');
    if (outbound.length) {
      return res.status(400).json({
        error: `Refusing: ${outbound.length} of these leave the building. Reject those individually.`,
        outboundIds: outbound.map(a => a.id),
      });
    }

    if (dryRun) {
      return res.json({
        dryRun: true, filter, matched: matched.length,
        sample: matched.slice(0, 5).map(a => ({ id: a.id, text: a.payload?.text || a.reason })),
      });
    }

    const rejected = [];
    for (const a of matched) {
      const outcome = rejectAction(a.id);
      if (outcome.status === 200) rejected.push(a.id);
    }

    workingMemory.invalidate('sara actions bulk reject');
    res.json({ ok: true, filter, rejected: rejected.length, ids: rejected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
// The filter/facet logic is where the correctness is, so it is reachable from a
// test without standing up Express.
module.exports._internals = { monthOf, matchesFilter, readFilter, buildFacets };
