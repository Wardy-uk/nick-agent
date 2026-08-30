'use strict';

/**
 * GET  /api/attention              — the kiosk's read of NEURO's attention feed
 * GET  /api/attention/records      — every OPEN record, so a legacy screen holding
 *                                    only a decision-engine item id can find the
 *                                    canonical record to act on
 * POST /api/attention/records/:id/act — acknowledge | defer | dismiss | complete | start
 *
 * The read half of this is a passthrough. So is the write half: the kiosk sends
 * an ACTION and NEURO decides what it means. Nothing here interprets, maps or
 * substitutes one action for another.
 *
 * A PASSTHROUGH, and deliberately nothing more. It stores nothing, ranks
 * nothing, and re-words nothing: the payload is returned verbatim, exactly as
 * `neuroCapture` forwards a capture rather than keeping a copy.
 *
 * ⚠ This is the seam where `sara/backend` last grew a second brain.
 * `state/inference.js` was retired for computing its own activity enum,
 * confidence model and recommended-view map from SEEDED inputs — a second
 * opinion about data that did not exist. NEURO owns the attention decision now
 * (`docs/attention-contract.md`), so anything here that re-ranked or re-phrased
 * would recreate that mistake with the same shape and a different name.
 *
 * ⚠ It is also NOT part of `neuroSnapshot`'s bounded poll set. That set feeds
 * the State Engine, and folding attention into the shared model would make the
 * kiosk's own state a competing account of what deserves Nick's attention. The
 * screen reads this directly, so there is exactly one account and it is NEURO's.
 *
 * Every failure is NAMED and carries `available: false`. A blank feed and an
 * unreadable one are different facts and only one of them is good news — the
 * rule the whole provenance block exists to enforce.
 *
 * CommonJS only.
 */

const express = require('express');

const neuroConfig = require('../integrations/neuroConfig');

function fail(res, status, reason, detail) {
  // 200 with `available:false` is deliberate: the kiosk polls this, and a non-2xx
  // makes a fetch wrapper throw into a generic "something broke" branch that
  // cannot tell "NEURO is down" from "SARA is misconfigured". The reason is the
  // point, so it must survive to the screen.
  return res.status(200).json({ available: false, reason, detail: detail || null, status: status || null });
}

/**
 * `fetchImpl` and `env` are injectable for the same reason `capture.js` makes
 * them injectable: the failure paths ARE the feature here, and each one has to
 * be driven deliberately. A route that can only be tested against a real NEURO
 * is a route whose honesty is never tested at all.
 */
function createRouter(options = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const env = options.env || process.env;
  const timeoutMs = Number(env.SARA_NEURO_TIMEOUT_MS) || 5000;

  router.get('/', async (req, res) => {
  const ready = neuroConfig.readiness(env);
  if (!ready.baseUrlConfigured || !ready.credentialConfigured) {
    // Refuse BEFORE the network. "We were never told where NEURO is" needs a
    // different fix from "NEURO is down", and firing blind blurs the two.
    return fail(res, null, 'not-configured', ready.problems.join(' '));
  }

  const base = neuroConfig.getBaseUrl(env);
  // `view` is passed through so a kiosk pinned to one side of the work/personal
  // split gets the diary it asked for. Anything unrecognised is dropped rather
  // than forwarded — NEURO ignores it, but a proxy should not invent parameters.
  const asked = String(req.query.view || '').toLowerCase();
  const view = ['work', 'personal', 'flip'].includes(asked) ? `?view=${asked}` : '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(`${base}/api/attention${view}`, {
      headers: { accept: 'application/json', ...neuroConfig.authHeaders(env) },
      signal: controller.signal,
    });

    if (upstream.status === 401 || upstream.status === 403) {
      return fail(res, upstream.status, 'unauthorized', 'NEURO refused SARA’s credential.');
    }
    if (!upstream.ok) {
      return fail(res, upstream.status, 'upstream-error');
    }

    const payload = await upstream.json();
    // ⚠ A 200 carrying something other than the attention shape is NOT an
    // answer. `neuroCapture` learned this the hard way: a proxy error page or a
    // login redirect arrives as a perfectly good 200, and treating it as data is
    // how a broken feed renders as a calm day.
    if (!payload || typeof payload !== 'object' || typeof payload.generatedAt !== 'string') {
      return fail(res, upstream.status, 'unexpected-shape');
    }

    return res.json({ available: true, ...payload });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return fail(res, null, aborted ? 'timeout' : 'unreachable', aborted ? null : e.message);
  } finally {
    clearTimeout(timer);
  }
  });

  // ── Records ────────────────────────────────────────────────────────────────
  //
  // ⚠ Why the kiosk needs this at all. `screens/focus/FocusView` is a legacy
  // screen built on `/api/focus`, so the only handle it holds on a card is the
  // decision-engine item id — which is not the identity of anything
  // (`todo-overdue-top` becomes `todo-overdue-summary` the moment a second task
  // goes overdue). `present().engineId` is exposed by NEURO for exactly this
  // lookup, and the kiosk uses it to find the record and then acts on the
  // record. Anything holding a `recordId` already must use that instead.
  router.get('/records', async (_req, res) => {
    const ready = neuroConfig.readiness(env);
    if (!ready.baseUrlConfigured || !ready.credentialConfigured) {
      return fail(res, null, 'not-configured', ready.problems.join(' '));
    }
    const base = neuroConfig.getBaseUrl(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(`${base}/api/attention/records`, {
        headers: { accept: 'application/json', ...neuroConfig.authHeaders(env) },
        signal: controller.signal,
      });
      if (upstream.status === 401 || upstream.status === 403) {
        return fail(res, upstream.status, 'unauthorized', 'NEURO refused SARA\u2019s credential.');
      }
      if (!upstream.ok) return fail(res, upstream.status, 'upstream-error');
      const payload = await upstream.json();
      // Same rule as the feed: a 200 carrying the wrong shape is not an answer.
      if (!payload || !Array.isArray(payload.records)) {
        return fail(res, upstream.status, 'unexpected-shape');
      }
      return res.json({ available: true, ...payload });
    } catch (e) {
      const aborted = e.name === 'AbortError';
      return fail(res, null, aborted ? 'timeout' : 'unreachable', aborted ? null : e.message);
    } finally {
      clearTimeout(timer);
    }
  });

  // ── Acting ─────────────────────────────────────────────────────────────────
  //
  // ⚠ This route replaces `POST /api/actions/focus/done`, which proxied
  // `/api/focus/action-done` — a route that logs a COMPLETED OUTCOME and
  // dismisses the item. The kiosk's "Done" button therefore recorded work as
  // finished and hid the card, and its "Defer" POSTed `/dismiss`, so "not now"
  // and "not mine" were one gesture. Both are the desktop bug, one surface
  // along, and both are gone.
  //
  // ⚠ It is a PASSTHROUGH and must stay one. The action is forwarded verbatim
  // and NEURO decides what it means — an unknown action comes back as NEURO's
  // 400, never as a local guess. Substituting one action for another here is
  // precisely how `focus/done` came to mean something nobody asked for.
  //
  // ⚠ A write is NOT given the read's `200 + available:false` treatment. The
  // feed is POLLED, so a non-2xx there lands in a generic "something broke"
  // branch that cannot name the reason; a write is a deliberate press of a
  // button, and reporting a refusal as a success is how a card looks acted-on
  // when nothing happened.
  router.post('/records/:id/act', async (req, res) => {
    const ready = neuroConfig.readiness(env);
    if (!ready.baseUrlConfigured || !ready.credentialConfigured) {
      return res.status(503).json({ ok: false, reason: 'not-configured', error: ready.problems.join(' ') });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'a record id is required' });

    const base = neuroConfig.getBaseUrl(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(`${base}/api/attention/records/${encodeURIComponent(id)}/act`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...neuroConfig.authHeaders(env),
        },
        // Forwarded verbatim, and bounded to the fields the contract defines —
        // a proxy that passes an arbitrary body through is a proxy that will
        // one day carry a field NEURO trusts and the kiosk should not set.
        body: JSON.stringify({
          action: req.body?.action,
          minutes: req.body?.minutes,
          reason: req.body?.reason,
          note: req.body?.note,
        }),
        signal: controller.signal,
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          ok: false,
          reason: upstream.status === 401 || upstream.status === 403 ? 'unauthorized' : 'upstream-error',
          error: payload.error || `HTTP ${upstream.status}`,
        });
      }
      // `taskCompleted` / `taskWhy` ride back untouched: "done, and I closed the
      // task" and "done, there was no task to close" are different outcomes and
      // the screen has to be able to say which.
      return res.json(payload);
    } catch (e) {
      const aborted = e.name === 'AbortError';
      return res.status(504).json({ ok: false, reason: aborted ? 'timeout' : 'unreachable', error: aborted ? 'NEURO did not answer in time' : e.message });
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
