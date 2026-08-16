/**
 * /api/vault-hygiene — NEURO's vault-hygiene engine, exposed over HTTP.
 *
 * Thin wrapper over services/vault-hygiene.js. All routes inherit the app-level
 * PIN auth in server.js. Mutating routes (contextual-link/apply) re-index touched
 * files through vault-hooks so embeddings/entities stay in sync — the whole point
 * of NEURO owning this rather than a throwaway script.
 *
 *   GET  /lint                  read-only health scan (+ dated report)
 *   POST /contextual-link/plan  propose links (cards) — read-only
 *   POST /contextual-link/apply append "## Mentioned" blocks (backed up, idempotent)
 *   GET  /alias-suggest         propose People aliases for near-match variants
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const hygiene = require('../services/vault-hygiene');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

function requireVault(req, res) {
  if (!VAULT_PATH) {
    res.status(503).json({ error: 'OBSIDIAN_VAULT_PATH not configured' });
    return false;
  }
  return true;
}

// GET /api/vault-hygiene/lint
router.get('/lint', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const r = hygiene.lint(VAULT_PATH);
    res.json({
      ok: true,
      scanned: r.scanned,
      counts: {
        broken: r.broken.length,
        archivedTargets: r.archivedTargets.length,
        orphans: r.orphans.length,
        underlinkedPeople: r.underlinkedPeople.length,
        stale: r.stale.length,
      },
      broken: r.broken,
      archivedTargets: r.archivedTargets,
      orphans: r.orphans,
      underlinkedPeople: r.underlinkedPeople,
      stale: r.stale,
      reportPath: r.reportPath,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/contextual-link/plan   { roots?: string[] }
router.post('/contextual-link/plan', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const { roots } = req.body || {};
    const r = hygiene.contextualLinkPlan(VAULT_PATH, { roots });
    res.json({ ok: true, scanned: r.scanned, notesTouched: r.notesTouched, total: r.total, byRoot: r.byRoot, perNote: r.perNote, reportPath: r.reportPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/contextual-link/apply  { roots?: string[], only?: string[] }
router.post('/contextual-link/apply', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const { roots, only } = req.body || {};
    const r = hygiene.contextualLinkApply(VAULT_PATH, { roots, only });
    // Re-index every touched file so embeddings/entities stay current.
    try {
      const hooks = require('../services/vault-hooks');
      for (const a of r.applied) hooks.onVaultWrite(path.join(VAULT_PATH, a.rel), 'vault-hygiene-ctxlink');
    } catch (e) {
      console.error('[vault-hygiene] re-index hook failed:', e.message);
    }
    res.json({ ok: true, notesDone: r.notesDone, totalLinks: r.totalLinks, backupDir: r.backupDir, changelogPath: r.changelogPath, applied: r.applied });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/fix/plan
router.post('/fix/plan', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const p = hygiene.fixPlan(VAULT_PATH);
    res.json({ ok: true, summary: p.summary, linkFixes: p.linkFixes, archived: p.archived, missing: p.missing, content: p.content, reportPath: p.reportPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/fix/apply  { links?, archived?, expected?, missing? }  (tiers; default skip)
router.post('/fix/apply', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const flags = req.body || {};
    const r = hygiene.fixApply(VAULT_PATH, flags);
    try {
      const hooks = require('../services/vault-hooks');
      for (const t of r.touched || []) hooks.onVaultWrite(path.join(VAULT_PATH, t), 'vault-hygiene-fix');
    } catch (e) { console.error('[vault-hygiene] re-index hook failed:', e.message); }
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/connect-orphans  { nova?, daily? }
router.post('/connect-orphans', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const { nova, daily } = req.body || {};
    const r = hygiene.connectOrphans(VAULT_PATH, { nova, daily });
    try {
      const hooks = require('../services/vault-hooks');
      for (const t of r.touched || []) hooks.onVaultWrite(path.join(VAULT_PATH, t), 'vault-hygiene-connect');
    } catch (e) { console.error('[vault-hygiene] re-index hook failed:', e.message); }
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault-hygiene/graph-config  { apply?, display?, forces?, colorGroups? }
router.post('/graph-config', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const r = hygiene.graphConfig(VAULT_PATH, req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault-hygiene/alias-suggest
router.get('/alias-suggest', (req, res) => {
  if (!requireVault(req, res)) return;
  try {
    const threshold = req.query.threshold ? Number(req.query.threshold) : undefined;
    const r = hygiene.aliasSuggest(VAULT_PATH, threshold ? { threshold } : {});
    res.json({ ok: true, count: r.suggestions.length, suggestions: r.suggestions, reportPath: r.reportPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
