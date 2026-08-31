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
      // WHERE the credential came from, never what it is. 'env' means the panel
      // cannot change it, which the UI needs to say rather than offering a field
      // that silently does nothing.
      credentialSource: notion.credentialSource(),
      autoSync: config.autoSyncEnabled(),
      // Pages deliberately not mapped, so a coverage list can tell "a gap" from
      // "handled somewhere else" — the D&D tree being the case in point.
      ignoredPages: config.ignoredPages(),
      autoSyncForcedByEnv: config.autoSyncForcedByEnv(),
      mappings: config.list(),
      vaultFolders: folders.folders,
      vaultReadable: folders.known,
      lastRun: sync.lastRun(),
      // A stuck lock means every pass is silently refused — from the outside
      // indistinguishable from a sync with nothing to do.
      lock: sync.lockStatus(),
      // What a `generated` mapping can be pointed at.
      generators: Object.entries(require('../services/notion-sync/generators').GENERATORS)
        .map(([key, g]) => ({ key, label: g.label })),
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
 * GET /api/notion-sync/notes?folder=X — notes in one folder, for the page picker.
 *
 * Declared above the parameterised routes, like every literal path here.
 */
router.get('/notes', (req, res) => {
  res.json(config.vaultNotes(config.normaliseFolder(req.query.folder)));
});

/**
 * POST /api/notion-sync/token — store the integration token.
 *
 * Stored in `agent_state`, following the OpenRouter key in `routes/ai-settings.js`
 * rather than inventing a second way. It is read at call time, so it takes effect
 * immediately — no restart, and no SSH to set one value.
 *
 * ⚠ The token is NEVER returned by any route, including this one. The response
 * says only that it landed and which source is now answering.
 */
router.post('/token', (req, res) => {
  const result = notion.setStoredToken(req.body?.token);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, configured: notion.isConfigured(), credentialSource: notion.credentialSource() });
});

/** DELETE /api/notion-sync/token — forget a stored token. */
router.delete('/token', (req, res) => {
  const result = notion.clearStoredToken();
  // `stillInEnv` matters: clearing the stored copy does NOT disconnect when the
  // environment also sets one, and a UI that claimed otherwise would be lying.
  res.json({ ...result, configured: notion.isConfigured(), credentialSource: notion.credentialSource() });
});

/**
 * POST /api/notion-sync/ignore — mark a Notion page as deliberately not mapped.
 *
 * A coverage list is only worth reading if "not mapped" means "a gap". Without
 * this, the D&D tree — which the standalone notion-dnd-sync service owns — would
 * sit in the unmapped column for ever, inviting exactly the mistake it must not
 * invite: mapping it here and putting two writers on one page tree.
 */
router.post('/ignore', (req, res) => {
  const result = config.setIgnored(req.body?.pageId, req.body?.ignored !== false, req.body?.note);
  res.status(result.ok ? 200 : 400).json(result);
});

/** POST /api/notion-sync/auto — turn the 15-minute pass on or off. */
router.post('/auto', (req, res) => {
  if (config.autoSyncForcedByEnv()) {
    return res.status(409).json({
      ok: false,
      error: 'NOTION_SYNC_ENABLED=true in the environment is forcing automatic sync on; the toggle cannot override it.',
    });
  }
  res.json({ ok: true, autoSync: config.setAutoSync(req.body?.enabled === true) });
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

/**
 * POST /api/notion-sync/unlock — release a lock left by a killed run.
 *
 * The stale window (15 min) already recovers this on its own; this is for when
 * waiting it out is silly, which on a box that redeploys several times a day is
 * most of the time.
 */
router.post('/unlock', (req, res) => {
  res.json(sync.releaseLockManually());
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
