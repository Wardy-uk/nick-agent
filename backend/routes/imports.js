const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const importsService = require('../services/imports');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

function isWithinVault(filePath) {
  return filePath.startsWith(path.resolve(VAULT_PATH));
}

// GET /api/imports/pending — list unprocessed files in Imports/
router.get('/pending', (req, res) => {
  try {
    const pending = importsService.getPending();
    res.json({ count: pending.length, files: pending });
  } catch (e) {
    console.error('[Imports] Error listing pending:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/imports/status — sweep status and pending count
router.get('/status', (req, res) => {
  try {
    const pending = importsService.getPending();
    const lastSweepRaw = db.getState('imports_last_sweep');
    const lastSweep = lastSweepRaw ? JSON.parse(lastSweepRaw) : null;
    const sweepRunning = db.getState('imports_sweep_running') === 'true';
    res.json({ pendingCount: pending.length, lastSweep, sweepRunning });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/classify — classify a single file using Ollama
router.post('/classify', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    const classification = await importsService.classifyFile(filePath);
    res.json(classification);
  } catch (e) {
    console.error('[Imports] Classify error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/classify-all — trigger batch sweep
router.post('/classify-all', async (req, res) => {
  const sweepRunning = db.getState('imports_sweep_running') === 'true';
  if (sweepRunning) {
    return res.json({ started: false, reason: 'Sweep already running' });
  }

  // Check if there are any classifiable files before starting
  const classifiable = importsService.getPending().filter(f => f.status !== 'needs-review');
  if (classifiable.length === 0) {
    return res.json({ started: false, reason: 'No classifiable files — all pending files need manual review' });
  }

  // Fire and forget
  importsService.autoClassify().catch(e => {
    console.error('[Imports] Batch classify error:', e);
  });
  res.json({ started: true, count: classifiable.length });
});

// POST /api/imports/route — move file to classified destination
router.post('/route', (req, res) => {
  const { filePath, destination, type } = req.body;
  if (!filePath || !destination) return res.status(400).json({ error: 'filePath and destination required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    const newPath = importsService.routeFile(filePath, destination, type);
    console.log(`[Imports] Routed ${path.basename(filePath)} → ${newPath}`);
    res.json({ success: true, newPath });
  } catch (e) {
    console.error('[Imports] Route error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/restamp-people — backfill `people:` on existing meeting notes.
// Defaults to a dry run; pass { dryRun: false } to write (files are backed up).
router.post('/restamp-people', (req, res) => {
  try {
    const { dryRun = true, limit = 1000 } = req.body || {};
    res.json(importsService.restampMeetingPeople({ dryRun, limit }));
  } catch (e) {
    console.error('[Imports] Restamp error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/flag — mark file as needs-review
router.post('/flag', (req, res) => {
  const { filePath, reason } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    importsService.updateFrontmatter(filePath, {
      status: 'needs-review',
      'review-reason': reason || 'Flagged manually'
    });
    const dbFlag = require('../db/database');
    const relativePathFlag = require('path').relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    dbFlag.deleteImportClassification(relativePathFlag);
    console.log(`[Imports] Flagged ${path.basename(filePath)} for review`);
    res.json({ success: true });
    try {
      require('../services/nudges').broadcast({
        type: 'file_actioned',
        filePath,
        action: 'flagged'
      });
    } catch {}
  } catch (e) {
    console.error('[Imports] Flag error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/dismiss — mark file as processed without moving
router.post('/dismiss', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  try {
    importsService.updateFrontmatter(filePath, { status: 'processed' });
    const dbDismiss = require('../db/database');
    const relativePathDismiss = require('path').relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    dbDismiss.deleteImportClassification(relativePathDismiss);
    console.log(`[Imports] Dismissed ${path.basename(filePath)}`);
    res.json({ success: true });
    try {
      require('../services/nudges').broadcast({
        type: 'file_actioned',
        filePath,
        action: 'dismissed'
      });
    } catch {}
  } catch (e) {
    console.error('[Imports] Dismiss error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/delete — permanently delete a file from Imports/
router.post('/delete', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!isWithinVault(filePath)) return res.status(403).json({ error: 'File must be within the vault' });

  // Extra safety — only allow deleting from Imports/ directory
  const importsDir = path.join(VAULT_PATH, 'Imports');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(importsDir))) {
    return res.status(403).json({ error: 'Can only delete files from Imports/' });
  }

  try {
    fs.unlinkSync(filePath);

    // Remove from DB
    const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');
    try { db.deleteImportClassification(relPath); } catch {}
    try { db.deleteEmbedding(relPath); } catch {}
    try { db.deleteEntitiesForPath(relPath); } catch {}
    try { db.deleteLinksForPath(relPath); } catch {}

    console.log(`[Imports] Deleted: ${path.basename(filePath)}`);

    try {
      require('../services/nudges').broadcast({
        type: 'file_actioned',
        filePath,
        action: 'deleted'
      });
    } catch {}

    res.json({ success: true });
  } catch (e) {
    console.error('[Imports] Delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/imports/transcript/:fileName — get transcript processing result
router.get('/transcript/:fileName', (req, res) => {
  try {
    const tp = require('../services/transcript-processor');
    const result = tp.getLastResult(req.params.fileName);
    if (!result) return res.json({ found: false });
    res.json({ found: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/imports/notify-complete — send push notification for sweep completion
// Called by frontend only when the app is not in focus
router.post('/notify-complete', async (req, res) => {
  const { routed = 0, flagged = 0, errors = 0 } = req.body;

  const parts = [];
  if (routed > 0) parts.push(`${routed} routed`);
  if (flagged > 0) parts.push(`${flagged} need review`);
  if (errors > 0) parts.push(`${errors} failed`);
  const body = parts.length > 0 ? parts.join(', ') : 'No files processed';

  try {
    const webpush = require('../services/webpush');
    await webpush.sendToAll(
      'SARA — Classify complete',
      body,
      { type: 'sweep_complete', url: '/imports' }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[Imports] Notify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
