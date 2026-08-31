'use strict';

/**
 * The kiosk's door onto NEURO — `/api/*` for the paths the shared app needs.
 *
 * ⚠ WHY THIS EXISTS. Nick, 31 Aug 2026: "make the Pi version of SARA the same
 * as the phone app." Every phone view talks DIRECTLY to NEURO with a PIN in the
 * browser's localStorage. The kiosk cannot: it is an always-on, unauthenticated
 * touchscreen on a desk, and a NEURO credential sitting in that browser is the
 * one thing the whole `sara/backend` passthrough design exists to avoid. So the
 * credential stays here and the same views reach NEURO through this route.
 *
 * ⚠ IT IS A NAMED DOOR, NOT AN OPEN PROXY, and the ALLOWLIST is the entire
 * safety model. `neuroCapture` established the rule: a kind not in the table is
 * refused LOCALLY rather than passed through. A blanket `/api/*` forward would
 * put every NEURO route — `/api/capture-links` (VESTA accounts and PINs),
 * `/api/microsoft/auth`, the Notion token, `/api/actions/:id/approve` (which
 * SENDS EMAIL) — behind an unauthenticated screen on the desk, reachable by
 * anything on the tailnet, since `server.js` binds 0.0.0.0.
 *
 * The list below is derived from what the shared views actually call. Adding to
 * it is a decision; nothing gets in by being convenient.
 *
 * ⚠ NOTHING OUTBOUND IS REACHABLE. `/api/actions` is deliberately ABSENT even
 * though it looks like a natural fit: approving an action there can send email
 * as Nick, book a meeting with real attendees, or push a chase to a direct
 * report. `action-presenter`'s "leaves the building" test is the rule, and this
 * side of the door is where it is applied. The attention feed's own act
 * passthrough (`routes/attention.js`) stays the only write path onto a card,
 * because its verbs are bounded by the contract.
 *
 * ⚠ It stores nothing, re-words nothing and interprets nothing — the upstream
 * status and body are returned as they arrive. A proxy that rewrites a refusal
 * into a success is how a screen comes to look like it worked.
 *
 * CommonJS only.
 */

const express = require('express');

const neuroConfig = require('../integrations/neuroConfig');

/**
 * The doors. Each entry is a FIRST PATH SEGMENT under `/api`, matched exactly —
 * never a prefix test, or `/api/push` would also open `/api/push-anything`.
 *
 * Read the comment beside each one before adding a neighbour: the question is
 * not "does a screen want it" but "what is the worst thing reachable through it
 * from a screen nobody has to log in to".
 */
const DOORS = new Set([
  'attention',       // the feed. Its own act route is mounted ahead of this.
  'adhd',            // the Now screen's session + recovery cards
  'session',         // focus sessions — start, pause, shrink, step away
  'focus',           // the legacy focus read, still behind the Focus screen
  'todos',           // read + tick. Completion is internal and reversible.
  'tasks',           // create / patch a NEURO task
  'wins',            // the momentum ledger. Read-only in practice.
  'capture',         // notes, todos, features. The whole point of the kiosk.
  'journal',         // prompts + save
  'standup-session',  // the ritual, both kinds
  'meeting-prep',    // read-only prep. Drafts nothing outbound.
  'chat',            // ask SARA. Tool tiers are enforced by NEURO, not here.
  'tts',             // speech, if the kiosk ever gets a speaker
  'mobile',          // the v1 snapshot + sync contract
  'vault',           // read + write notes
  'vault-hygiene',   // lint / link / alias — all dry-run by default upstream
  'plaud',           // reconcile + repull
  'push',            // subscription. Harmless on a kiosk; kept so the shared
                     // shell does not have to special-case which app it is in.
]);

/**
 * Is this path one of the doors? PURE, and exported so the refusal is testable
 * without a network — the refusal IS the feature here.
 *
 * ⚠ Rejects any traversal outright rather than normalising it. A `..` that
 * resolves back inside an allowed segment is still someone trying, and this is
 * the one place where guessing charitably is expensive.
 */
function isAllowed(pathname) {
  const p = String(pathname || '');
  if (!p.startsWith('/')) return false;
  if (p.includes('..') || p.includes(String.fromCharCode(92))) return false;
  const segment = p.slice(1).split(/[/?#]/)[0];
  return DOORS.has(segment);
}

function createRouter(options = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const env = options.env || process.env;
  const timeoutMs = Number(env.SARA_NEURO_TIMEOUT_MS) || 15000;

  router.use(async (req, res) => {
    if (!isAllowed(req.path)) {
      // Named, so a missing door reads as a decision rather than a 404 from a
      // route that does not exist upstream either.
      return res.status(403).json({
        ok: false,
        reason: 'not-a-door',
        error: `SARA does not proxy ${req.path}. Add it to DOORS deliberately, or reach NEURO directly.`,
      });
    }

    const ready = neuroConfig.readiness(env);
    if (!ready.baseUrlConfigured || !ready.credentialConfigured) {
      // Refuse BEFORE the network — "we were never told where NEURO is" needs a
      // different fix from "NEURO is down".
      return res.status(503).json({ ok: false, reason: 'not-configured', error: ready.problems.join(' ') });
    }

    const base = neuroConfig.getBaseUrl(env);
    const url = `${base}/api${req.originalUrl.replace(/^\/api/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const upstream = await fetchImpl(url, {
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          // ⚠ The credential is attached HERE and the client's own is ignored.
          // The browser on the kiosk has none, which is the entire point.
          ...neuroConfig.authHeaders(env),
          // ⚠ NEURO's vault router sits behind its OWN key (`requireApiKey`),
          // separate from the PIN, and 503s everything when it is unset. The
          // phone carries it as `VITE_VAULT_API_KEY` in the browser; the kiosk
          // must not, so it is attached here for vault paths only — a key sent
          // on every route is a key handed to routes that never needed it.
          ...(req.path.startsWith('/vault') && env.NEURO_VAULT_KEY
            ? { 'x-api-key': env.NEURO_VAULT_KEY }
            : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: controller.signal,
      });

      const text = await upstream.text();
      // Status and body as they arrived. A screen has to be able to tell a 401
      // from a 500 from a 200 carrying `{ok:false}`, and flattening them here
      // is how it loses that.
      res.status(upstream.status);
      res.type(upstream.headers.get('content-type') || 'application/json');
      return res.send(text);
    } catch (e) {
      const aborted = e.name === 'AbortError';
      return res.status(504).json({
        ok: false,
        reason: aborted ? 'timeout' : 'unreachable',
        error: aborted ? 'NEURO did not answer in time' : e.message,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.isAllowed = isAllowed;
module.exports.DOORS = DOORS;
