'use strict';

/**
 * Reading captured features back (#114).
 *
 * Deliberately its own router rather than another handler on `/api/capture`:
 * that file owns the WRITE side, and this is the read. Keeping them apart also
 * means the capture routes and this one can be reasoned about separately when
 * one of them is being changed.
 */

const express = require('express');
const router = express.Router();
const tracker = require('../services/feature-tracker');

// GET /api/features/captured?limit=5 — the last few captured items and the total.
//
// The total is the number in the CAPTURE section, not in the tracker: it answers
// "what have I thrown at this lately", not "how big is the backlog". A count of
// the whole file would be a different and much less useful number, and would
// quietly become a second backlog view.
router.get('/captured', (req, res) => {
  const result = tracker.listCaptured({ limit: req.query.limit });
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

module.exports = router;
