'use strict';

/**
 * The device self-report contract. Mounted at /api/device.
 *
 * What the phone knows about itself — battery, CoreMotion activity, steps,
 * connectivity, focus — reported directly instead of relayed through the Home
 * Assistant iOS Companion app. HA stays for smart-home ACTUATION, which is the
 * only thing it is uniquely able to do.
 *
 * Auth is the app-level PIN / API-token middleware in server.js. Nothing here
 * is exempted, and nothing here logs a credential, an SSID or a place name.
 *
 * ⚠ ROUTE ORDER: both paths are literal, but this router will grow a
 * parameterised sibling the moment a second device matters — register literals
 * first when it does. `routes/mobile.js` carries the incident this rule came
 * from (`/triage/feedback` parsed as an email id).
 */

const express = require('express');

const router = express.Router();

const deviceStatus = require('../services/device-status');

/**
 * POST /api/device/status — the phone's current self-report.
 *
 * Body: `{ deviceId, reportedAt, batteryLevel?, batteryState?, activity?,
 *          activitySince?, steps?, distanceM?, floorsAscended?,
 *          connectionType?, ssid?, geocodedLocation?, focusMode? }`
 *
 * ⚠ OMITTING A FIELD AND SENDING ZERO ARE DIFFERENT CLAIMS. Omitted means the
 * app could not read that sensor and the value falls through to Home
 * Assistant; zero means it read it and he has not moved. An app that defaults
 * its way out of the first into the second turns a dead pedometer into a
 * sedentary day.
 *
 * `stored: false` is a SUCCESS, not a failure: it means this report was older
 * than one already held, which happens whenever the offline queue drains out of
 * order. It is reported rather than swallowed because a device whose every
 * report is superseded is draining in the wrong order, and that is invisible
 * from a bare 200.
 */
router.post('/status', (req, res) => {
  const v = deviceStatus.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ ok: false, error: v.reason });

  try {
    const { stored } = deviceStatus.store(v.status);
    res.json({
      ok: true,
      stored,
      supersededBy: stored ? null : 'a more recent report is already held',
      reportedAt: v.status.reportedAt,
    });
  } catch (e) {
    // Nothing was written, so the device must send this again.
    console.error('[Device] status ingest failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/**
 * GET /api/device/status — the merged view, and where each field came from.
 *
 * Returns the same shape `ha.getPhoneStatus()` has always returned, plus a
 * `sources` block naming the origin of every field. Three states stay distinct:
 * the device feed never started, it started and went quiet, or the store could
 * not be read at all.
 */
router.get('/status', async (req, res) => {
  try {
    const ha = require('../services/ha');
    const merged = await ha.getPhoneStatus();
    res.json({
      ok: true,
      // ⚠ Never an empty object on failure. `null` says "nothing answered",
      // which is a different fact from a phone reporting all-nulls.
      status: merged,
      feed: deviceStatus.freshness(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, feed: deviceStatus.freshness() });
  }
});

module.exports = router;
