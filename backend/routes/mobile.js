'use strict';

/**
 * The Neuro Mobile contract. Mounted at /api/mobile.
 *
 * VERSIONED IN THE PATH (`/v1/…`) rather than by a header, because the phone
 * caches responses and replays operations across app upgrades: a client running
 * an old bundle must keep talking to the endpoint it was written against, not
 * silently receive a newer shape it will mis-parse. The payload carries its own
 * `schema` too, so a cached snapshot on disk can be identified without knowing
 * which URL fetched it.
 *
 * ⚠ ROUTE ORDER: literal paths are registered before any parameterised sibling.
 * Express matches in registration order and a literal registered second is read
 * as the parameter (16 Aug — `/triage/feedback` parsed as an email id).
 *
 * Auth is the app-level PIN / API-token middleware in server.js. Nothing here
 * is exempted, and nothing here logs capture text, a PIN or a token.
 */

const express = require('express');

const router = express.Router();

const mobileSync = require('../services/mobile-sync');
const mobileSnapshot = require('../services/mobile-snapshot');

// ── Readiness ────────────────────────────────────────────────────────────────

/**
 * GET /api/mobile/v1/readiness — is the contract usable right now?
 *
 * Reports what was OBSERVED, never a configured boolean (#65's rule: "configured"
 * was never the same claim as "works"). No secrets: names of things, states of
 * things, counts. Nothing that could be a credential.
 */
router.get('/v1/readiness', (req, res) => {
  const checks = {};

  try {
    const captureStore = require('../services/capture-store');
    const fs = require('fs');
    const dir = captureStore.importsDir();
    const vault = process.env.OBSIDIAN_VAULT_PATH || '';
    checks.vault = {
      configured: !!vault,
      reachable: !!vault && fs.existsSync(vault),
      importsDir: !!vault && fs.existsSync(dir),
    };
  } catch (e) {
    checks.vault = { configured: false, reachable: false, error: e.message };
  }

  try {
    const counts = require('../services/task-store').counts();
    checks.tasks = { readable: true, open: counts && counts.open != null ? counts.open : null };
  } catch (e) {
    checks.tasks = { readable: false, error: e.message };
  }

  let outbox = null;
  try {
    outbox = mobileSync.diagnostics({ limit: 1 });
    checks.outbox = { readable: true, byStatus: outbox.byStatus };
  } catch (e) {
    checks.outbox = { readable: false, error: e.message };
  }

  const ready = checks.vault.reachable === true && checks.tasks.readable === true && checks.outbox.readable === true;

  res.json({
    ok: true,
    ready,
    contract: mobileSync.CONTRACT_VERSION,
    snapshotSchema: mobileSnapshot.SNAPSHOT_SCHEMA,
    supportedKinds: Array.from(mobileSync.KNOWN_KINDS),
    maxOperationsPerRequest: mobileSync.MAX_OPERATIONS_PER_REQUEST,
    checks,
    // Said out loud rather than left for a client to discover: iOS cannot run
    // guaranteed background work in a PWA, so replay is foreground-only.
    replay: 'foreground-only — iOS PWAs have no guaranteed background sync',
    serverTime: new Date().toISOString(),
  });
});

// ── Nick Now ─────────────────────────────────────────────────────────────────

/**
 * GET /api/mobile/v1/nick-now — the compact mobile working set.
 *
 * An error is NOT an empty snapshot. Returning a payload with empty sections on
 * failure would be indistinguishable from a genuinely calm day, which is the
 * false all-clear this whole layer exists to avoid.
 */
router.get('/v1/nick-now', async (req, res) => {
  try {
    res.json(await mobileSnapshot.build({}));
  } catch (e) {
    console.error('[Mobile] nick-now failed:', e.message);
    res.status(500).json({ ok: false, error: e.message, schema: mobileSnapshot.SNAPSHOT_SCHEMA });
  }
});

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/mobile/v1/sync/diagnostics — what the outbox has seen.
 * Registered BEFORE /sync/operations for clarity; both are literal, so order is
 * not load-bearing here, but the habit is.
 */
router.get('/v1/sync/diagnostics', (req, res) => {
  try {
    const deviceId = typeof req.query.deviceId === 'string' && req.query.deviceId.trim()
      ? req.query.deviceId.trim()
      : null;
    res.json({ ok: true, ...mobileSync.diagnostics({ deviceId, limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/mobile/v1/sync/operations — the append-only, idempotent outbox.
 *
 * Body: { deviceId, clientSchema?, operations: [{ operationId, kind, createdAt, payload }] }
 * Returns a receipt per operationId. Re-sending is always safe.
 *
 * ⚠ The whole batch is applied SYNCHRONOUSLY inside the service; see the note
 * there. Do not wrap this in anything that awaits between operations.
 */
router.post('/v1/sync/operations', (req, res) => {
  const body = req.body || {};
  try {
    const result = mobileSync.applyBatch({
      deviceId: body.deviceId,
      operations: body.operations,
      clientSchema: body.clientSchema,
    });
    if (!result.ok) return res.status(400).json(result);

    // 200 even when individual operations were rejected or failed: the BATCH was
    // accepted and every operation has a receipt. A non-2xx here would make the
    // client discard receipts it needs in order to stop retrying a rejection.
    res.json(result);
  } catch (e) {
    // A failure here means NOTHING was recorded, so the device must retry.
    // Never log the payload.
    console.error('[Mobile] sync batch failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

module.exports = router;
