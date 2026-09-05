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

// ── Source guard ─────────────────────────────────────────────────────────────
//
// A source-IP check is NOT sufficient here, and getting this wrong exposed an
// unauthenticated write endpoint to the public internet for one deploy.
//
// pi5 already runs `tailscale serve` with **Funnel ON** for
// https://pi5.tailecb90f.ts.net → 127.0.0.1:3001. Funnel means the whole
// internet, not the tailnet. Everything under /api was fine because it needs the
// PIN; these routes cannot take a PIN, so they need their own answer.
//
// The trap: Tailscale proxies BOTH tailnet and Funnel traffic from 127.0.0.1, so
// "is the peer address local or 100.64/10" cannot tell a colleague's browser
// from a stranger's. Trusting loopback let Funnel straight through.
//
// So this fails CLOSED and identifies the caller from what Tailscale adds:
//   - `Tailscale-Funnel-Request` is set on Funnel traffic  → always refused.
//   - `Tailscale-User-Login` is added by Serve for tailnet peers → accepted.
//   - A direct connection from 100.64.0.0/10 (not via Serve) → accepted.
//   - Bare loopback is NOT trusted by default, because that is exactly what a
//     Funnel request looks like if the header is ever absent. Set
//     APPLE_HEALTH_ALLOW_LOOPBACK=1 to curl it on the Pi.
function classifySource(req) {
  if (req.headers['tailscale-funnel-request'] !== undefined) {
    return { ok: false, why: 'funnel (public internet)' };
  }

  const login = req.headers['tailscale-user-login'];
  if (login) return { ok: true, via: `tailnet:${login}` };

  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) {
    return { ok: true, via: `tailnet-ip:${ip}` };
  }

  if ((ip === '127.0.0.1' || ip === '::1') && process.env.APPLE_HEALTH_ALLOW_LOOPBACK === '1') {
    return { ok: true, via: 'loopback (explicitly enabled)' };
  }

  return { ok: false, why: `untrusted source ${ip || 'unknown'}` };
}

function guard(req, res, next) {
  if (String(process.env.APPLE_HEALTH_INGEST || '').toLowerCase() === 'off') {
    return res.status(503).json({ error: 'Apple Health ingest disabled' });
  }

  const src = classifySource(req);
  if (!src.ok) {
    // Logged with the Tailscale headers present, because the whole guard turns
    // on them and a silent refusal would be indistinguishable from the app
    // simply not reaching the Pi.
    const seen = Object.keys(req.headers).filter(h => h.startsWith('tailscale-')).join(',') || 'none';
    console.warn(`[AppleHealth] Refused ${req.method} ${req.path} — ${src.why} (tailscale headers: ${seen})`);
    return res.status(403).json({ error: `Refused: ${src.why}` });
  }
  req.appleHealthSource = src.via;
  next();
}

router.use(guard);

// The app calls this to "test connection" and does NOT parse the body — it
// shows the raw JSON. It only needs HTTP 200.
router.get('/me', (req, res) => {
  // The app shows this response verbatim on "Test Connection", so `via` is the
  // one place Nick can see HOW he got in — tailnet identity, direct tailnet IP,
  // or loopback. If that ever reads differently than expected, the guard is the
  // first thing to look at.
  res.json({ login: 'nick', display_name: 'Nick Ward', via: req.appleHealthSource || 'unknown' });
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

    // Workouts are records rather than scalars and go to their own table. This
    // is what retires Strava — the section has been arriving all along and was
    // counted and discarded until 5 Sep 2026.
    let workoutsInserted = 0;
    try {
      workoutsInserted = db.insertWorkouts(parsed.workouts);
    } catch (e) {
      // A workout failure must not lose the metrics that parsed alongside it.
      console.error('[AppleHealth] Workout insert failed:', e.message);
      parsed.rejected.push({ metric: 'workout', reason: e.message });
    }
    if (Object.keys(parsed.unknownWorkoutFields).length) {
      // ⚠ Deliberately loud. The workout parser was written without a real HAE
      // payload to read, so an unrecognised field is the only signal that a
      // spelling was guessed wrong — and a workout stored with three null
      // columns otherwise looks perfectly healthy.
      console.warn('[AppleHealth] Unrecognised workout fields:', JSON.stringify(parsed.unknownWorkoutFields));
    }

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
    if (Object.keys(parsed.excluded).length) {
      console.log('[AppleHealth] Excluded by APPLE_HEALTH_EXCLUDE:', JSON.stringify(parsed.excluded));
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
        excludedByConfig: parsed.excluded,
        ignoredCategorySamples: parsed.ignoredCategory,
        workoutsReceived: parsed.workoutsReceived,
        workoutsInserted,
        unknownWorkoutFields: parsed.unknownWorkoutFields,
      },
    });
  } catch (e) {
    console.error('[AppleHealth] Ingest failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
