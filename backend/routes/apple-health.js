'use strict';

/**
 * The FreeReps iOS app's wire API, served by NEURO itself (#40).
 *
 *   POST /api/v1/ingest/  — HealthKit payload from the phone
 *   GET  /api/v1/me       — the app's "test connection" probe
 *   GET  /api/v1/version  — served for completeness; the real server has it
 *
 * These paths are NOT chosen by us — they are what the app hard-codes, so they
 * are fixed by the client and cannot be moved under a nicer prefix.
 *
 * ── Why this is unauthenticated ──────────────────────────────────────────────
 * The app has no way to send a credential. Its entire config model is host,
 * port, useHTTPS, testMode, testHost, testPort and backfillMonths — there is no
 * token field, no header, and no path component to smuggle one through. Real
 * FreeReps solves this with Tailscale identity (tsnet) at the transport layer.
 *
 * NEURO is not a tsnet server, so the equivalent guard here is the network: the
 * request must come from the tailnet's CGNAT range or from loopback. That is a
 * real boundary — the Pi's 3001 is not published to the internet — but it is
 * weaker than a token, so it is stated plainly rather than implied, and the
 * route accepts writes to ONE table and can do nothing else.
 *
 * `routes/health.js`'s own /ingest keeps its Bearer token and is untouched; this
 * is a second door for a client that cannot knock.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const appleHealth = require('../services/apple-health');

// Tailscale hands out 100.64.0.0/10. Loopback is allowed so the endpoint can be
// exercised with curl on the Pi during a deploy without opening it further.
function isAllowedSource(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '');
  const ip = raw.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 100 && b >= 64 && b <= 127;
}

function guard(req, res, next) {
  if (String(process.env.APPLE_HEALTH_INGEST || '').toLowerCase() === 'off') {
    return res.status(503).json({ error: 'Apple Health ingest disabled' });
  }
  if (!isAllowedSource(req)) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    console.warn(`[AppleHealth] Refused ${req.method} ${req.path} from off-tailnet ${ip}`);
    return res.status(403).json({ error: 'Not on the tailnet' });
  }
  next();
}

router.use(guard);

// The app calls this to "test connection" and does NOT parse the body — it
// shows the raw JSON. It only needs HTTP 200.
router.get('/me', (req, res) => {
  res.json({ login: 'nick', display_name: 'Nick Ward' });
});

router.get('/version', (req, res) => {
  res.json({ version: 'neuro-apple-health-1', server: 'NEURO' });
});

router.post('/ingest', (req, res) => {
  const started = Date.now();
  try {
    const parsed = appleHealth.parsePayload(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    let inserted = 0;
    for (const s of parsed.samples) {
      try {
        if (db.insertHealthSampleWithUuid(s.metric, s.value, s.recordedAt, 'apple-health', s.sourceUuid)) {
          inserted++;
        }
      } catch (e) {
        // One bad row must not lose the rest of a backfill batch.
        parsed.rejected.push({ metric: s.metric, reason: e.message });
      }
    }

    const skipped = parsed.samples.length - inserted;

    // Rejections are grouped and logged rather than returned one by one: a
    // backfill can carry tens of thousands of points, and a response listing
    // every one is unreadable. A silent rejection would be worse, so the COUNT
    // is always reported and the distinct reasons are always logged.
    const reasons = {};
    for (const r of parsed.rejected) {
      const key = `${r.metric}: ${r.reason}`;
      reasons[key] = (reasons[key] || 0) + 1;
    }
    if (parsed.rejected.length) {
      console.warn('[AppleHealth] Rejected points:', JSON.stringify(reasons).slice(0, 600));
    }
    if (Object.keys(parsed.unstored).length) {
      console.log('[AppleHealth] Received but not stored:', JSON.stringify(parsed.unstored));
    }
    console.log(
      `[AppleHealth] ${parsed.received} points → ${inserted} new, ${skipped} already had, ` +
      `${parsed.rejected.length} rejected (${Date.now() - started}ms)`
    );

    // Field names match the app's IngestResult so it can render a real summary.
    // Every field there is optional, so the extras are ignored by the app and
    // useful to us when curling it.
    res.json({
      metrics_received: parsed.received,
      metrics_inserted: inserted,
      metrics_skipped: skipped,
      metrics_rejected: parsed.rejected.length,
      message: `${inserted} new, ${skipped} duplicate, ${parsed.rejected.length} rejected`,
      neuro: {
        rejectedReasons: reasons,
        receivedNotStored: parsed.unstored,
        ignoredCategorySamples: parsed.ignoredCategory,
      },
    });
  } catch (e) {
    console.error('[AppleHealth] Ingest failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
