const express = require('express');
const router = express.Router();
const plaudSync = require('../services/plaud-sync');

router.get('/status', (req, res) => {
  try {
    res.json(plaudSync.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await plaudSync.syncPlaudRecordings({
      incremental: req.body?.incremental !== false
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Manual sync failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/cleanup', async (req, res) => {
  try {
    const importsService = require('../services/imports');
    const result = await importsService.backfillPlaudNotes({
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : 500,
      dryRun: req.body?.dryRun === true,
      archiveDuplicates: req.body?.archiveDuplicates !== false
    });
    if (result.status === 'error') return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Cleanup failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/reconcile  — read-only; find recordings with no active note
router.post('/reconcile', async (req, res) => {
  try {
    const result = await plaudSync.reconcilePlaudRecordings({
      minJaccard: req.body?.minJaccard != null ? Number(req.body.minJaccard) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Reconcile failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/repull  { ids?: string[], limit?: number }  — throttled, resumable
router.post('/repull', async (req, res) => {
  try {
    const result = await plaudSync.repullPlaudRecordings({
      ids: Array.isArray(req.body?.ids) ? req.body.ids : null,
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : null,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Re-pull failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/repull-stubs  { limit?: number }  — recover "No transcript returned" notes
router.post('/repull-stubs', async (req, res) => {
  try {
    const result = await plaudSync.repullStubTranscripts({
      limit: req.body?.limit ? parseInt(req.body.limit, 10) : null,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudSync] Stub re-fetch failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Admin blocks ────────────────────────────────────────────────────────────
// The 5-minute "process and update Plaud meeting for X" block after every real
// meeting. Lives here rather than in a router of its own because server.js is
// held by a concurrent session; /api/plaud is already mounted and this is
// squarely Plaud workflow. No parameterised sibling above, so no shadowing.

// GET /api/plaud/admin-blocks — what the ledger holds, and whether it is armed.
router.get('/admin-blocks', (req, res) => {
  try {
    res.json(require('../services/plaud-admin-blocks').status());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/plaud/admin-blocks/plan?days=14 — read-only. Creates nothing.
router.get('/admin-blocks/plan', async (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : undefined;
    const result = await require('../services/plaud-admin-blocks').plan({
      // Nonsense falls back to the default rather than to the nearest legal
      // value — a window of 1 returned as if asked for reads as the truth.
      days: Number.isFinite(days) && days > 0 && days <= 60 ? days : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudAdmin] Plan failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/admin-blocks/apply  { dryRun?: boolean, days?: number }
// dryRun defaults to TRUE — creating real calendar events is not the default
// answer to an empty body.
router.post('/admin-blocks/apply', async (req, res) => {
  try {
    const days = req.body?.days ? parseInt(req.body.days, 10) : undefined;
    const result = await require('../services/plaud-admin-blocks').apply({
      days: Number.isFinite(days) && days > 0 && days <= 60 ? days : undefined,
      dryRun: req.body?.dryRun !== false,
    });
    res.json(result);
  } catch (error) {
    console.error('[PlaudAdmin] Apply failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/plaud/admin-blocks/forget  { meetingId }
// Reconsider a meeting on the next pass — the way back from a block that was
// created wrongly and deleted.
router.post('/admin-blocks/forget', (req, res) => {
  try {
    const meetingId = req.body?.meetingId;
    if (!meetingId) return res.status(400).json({ error: 'meetingId is required' });
    res.json(require('../services/plaud-admin-blocks').forget(meetingId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
