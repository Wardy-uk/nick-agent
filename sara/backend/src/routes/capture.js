// POST /api/capture/note , POST /api/capture/todo — SARA's capture surface.
//
// Thin. All the policy lives in integrations/neuroCapture: this layer turns one
// forwarding result into one HTTP answer, and the only rule it enforces itself is
// the one that matters — `saved` is echoed from the forwarder and is true ONLY when
// NEURO acknowledged the write. SARA owns no capture storage.
//
// CommonJS only.

const express = require('express');
const neuroCapture = require('../integrations/neuroCapture');

function createRouter(options = {}) {
  const router = express.Router();

  async function handle(kind, req, res) {
    let outcome;
    try {
      outcome = await neuroCapture.forward(kind, req.body, options);
    } catch (error) {
      // A throw here is a SARA bug, not an upstream outage — but it still must not
      // read as a save.
      console.error(`[SARA Capture] ${kind} forwarding threw:`, error?.message);
      outcome = {
        ok: false,
        saved: false,
        reason: 'upstream-error',
        detail: 'SARA failed while forwarding the capture to NEURO.',
        status: 502,
        upstream: null,
      };
    }

    if (outcome.ok) {
      console.log(`[SARA Capture] ${kind} accepted by NEURO.`);
    } else {
      // Reason and outcome only — never the captured text, never a credential.
      console.warn(`[SARA Capture] ${kind} NOT saved — ${outcome.reason}: ${outcome.detail}`);
    }

    return res.status(outcome.status).json({
      ok: outcome.ok,
      saved: outcome.saved,
      reason: outcome.reason,
      // The UI prints this, so it has to be a sentence a human can act on.
      error: outcome.ok ? null : outcome.detail,
      detail: outcome.detail,
      data: outcome.ok ? outcome.upstream?.body || null : null,
    });
  }

  router.post('/note', (req, res) => handle('note', req, res));
  router.post('/todo', (req, res) => handle('todo', req, res));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
