'use strict';

/**
 * NOVA signals route.
 *
 *   POST /api/nova-signals
 *     Body: the grouped "look at this" payload from NOVA's risk scorer —
 *           { total, groups: [{ key, label, emoji, tickets: [...] }] }
 *           (a flat { tickets: [...] } body is also accepted).
 *     Auth: X-Neuro-Api-Token (machine clients only — rejects interactive PIN)
 *
 * NOVA pushes its flagged tickets here on a timer. NOVA is the source of
 * truth, so each push REPLACES the whole active set — tickets NOVA no longer
 * flags (resolved / reviewed) drop off. Surfaces in Focus via collectNovaFlags.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.post('/', (req, res, next) => {
  const guard = req.app.locals.requireApiClient;
  if (typeof guard === 'function') return guard(req, res, next);
  return next();
}, (req, res) => {
  try {
    const body = req.body || {};
    // Accept either the grouped payload or a flat list.
    const tickets = Array.isArray(body.tickets)
      ? body.tickets
      : (Array.isArray(body.groups) ? body.groups.flatMap(g => g.tickets || []) : []);
    const count = db.replaceNovaFlags(tickets);
    res.json({ ok: true, stored: count });
  } catch (e) {
    console.error('[nova-signals]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
