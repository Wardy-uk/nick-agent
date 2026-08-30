'use strict';

const express = require('express');

const router = express.Router();
const config = require('../services/notion-sync/config');
const notion = require('../services/notion-sync/notion-api');
const sync = require('../services/notion-sync');

// ⚠ Express matches in registration order, so every literal path is declared
// BEFORE any parameterised one. `/pages` under a `/:id` would be read as an id —
// the lesson from the triage `feedback` route, which spent a week being parsed
// as an email id.

/** GET /api/notion-sync — mappings, config health and the last run. */
router.get('/', (req, res) => {
  try {
    const folders = config.vaultFolders();
    res.json({
      ok: true,
      configured: notion.isConfigured(),
      mappings: config.list(),
      vaultFolders: folders.folders,
      vaultReadable: folders.known,
      lastRun: sync.lastRun(),
    });
  } catch (e) {
    console.error('[notion-sync] read failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/notion-sync/pages — Notion pages the integration can see.
 *
 * An empty list is NOT the same as "no pages": far more often it means nothing
 * has been shared with the integration yet, which is a setup step with a
 * different fix. The two are reported separately rather than both rendering as
 * an empty dropdown.
 */
router.get('/pages', async (req, res) => {
  if (!notion.isConfigured()) {
    return res.status(503).json({ ok: false, configured: false, error: 'NOTION_TOKEN is not set in backend/.env' });
  }
  try {
    const pages = await notion.searchPages(String(req.query.q || ''));
    res.json({
      ok: true,
      configured: true,
      pages: pages.filter((p) => !p.archived),
      shared: pages.length > 0,
      note: pages.length ? null : 'No pages are shared with the NEURO integration yet.',
    });
  } catch (e) {
    console.error('[notion-sync] page search failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * PUT /api/notion-sync/mappings — replace the whole mapping table.
 *
 * All-or-nothing because the rules (overlap, duplicate page) are relationships
 * BETWEEN rows; a per-row save can reach a state no single edit was invalid for.
 * A rejection returns the reasons AND the mappings still in force, so the panel
 * never renders a saved state that was not saved.
 */
router.put('/mappings', (req, res) => {
  try {
    const result = config.save(req.body?.mappings || []);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[notion-sync] save failed:', e.message);
    res.status(500).json({ ok: false, errors: [e.message] });
  }
});

/** POST /api/notion-sync/run — dry run by default; `?apply=1` writes. */
router.post('/run', async (req, res) => {
  try {
    const dryRun = req.query.apply !== '1' && req.body?.apply !== true;
    res.json(await sync.run({ dryRun }));
  } catch (e) {
    console.error('[notion-sync] run failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/notion-sync/forget/:pageId — drop one note's pairing record.
 *
 * The way back from a conflict Nick has resolved by hand: the next pass re-pairs
 * from scratch instead of comparing against a state that no longer describes
 * either side. Deliberately never deletes anything.
 */
router.post('/forget/:pageId', (req, res) => {
  const id = config.normalisePageId(req.params.pageId);
  if (!id) return res.status(400).json({ ok: false, error: 'Not a Notion page id.' });
  res.json({ ok: true, forgotten: sync.forget(id) });
});

module.exports = router;
