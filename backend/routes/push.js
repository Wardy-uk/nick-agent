const express = require('express');
const router = express.Router();
const db = require('../db/database');
const webpush = require('../services/webpush');

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe
router.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  try {
    db.savePushSubscription(subscription);
    console.log('[Push] New subscription registered');
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Subscribe error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/test — send a test notification
router.post('/test', async (req, res) => {
  try {
    await webpush.sendToAll('SARA', 'Push notifications are working.', { type: 'test' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] Test error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/push/log — what NEURO tried to tell you, and what became of it.
//
// This answers "why didn't I get that?", which nothing could answer before:
// the only record was console.log, and two paths dropped silently.
// `?limit=` caps at 500; `?since=` (ISO) scopes the stats. Read-only.
router.get('/log', (req, res) => {
  try {
    res.json({
      subscriptions: db.getAllPushSubscriptions().length,
      stats: db.getPushStats(req.query.since),
      recent: db.getPushLog(req.query.limit),
    });
  } catch (e) {
    console.error('[Push] Log error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/push/subscriptions — diagnostic endpoint
router.get('/subscriptions', (req, res) => {
  const subs = db.getAllPushSubscriptions();
  res.json({
    count: subs.length,
    endpoints: subs.map(s => ({ prefix: s.endpoint.substring(0, 50) + '...', created: s.created_at }))
  });
});

// POST /api/push/unsubscribe — remove a specific subscription
router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    db.removePushSubscription(endpoint);
    console.log('[Push] Unsubscribed:', endpoint.slice(0, 50));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/push/subscriptions — clear all subscriptions (re-subscribe fresh)
router.delete('/subscriptions', (req, res) => {
  try {
    const subs = db.getAllPushSubscriptions();
    for (const sub of subs) {
      db.removePushSubscription(sub.endpoint);
    }
    console.log(`[Push] Cleared ${subs.length} subscriptions`);
    res.json({ ok: true, cleared: subs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── APNs, for the native apps ────────────────────────────────────────────────
//
// ⚠ Web Push cannot reach a native iOS app, so without these SARA has no way to
// COME TO NICK — which is her whole premise. This is the REGISTRY half; the
// sender needs an APNs signing key and therefore a paid Apple Developer
// account. See `services/apns.js` for why stopping here is deliberate.
//
// ⚠ These sit on a router that is EXEMPT from the PIN middleware, because the
// service worker cannot set headers. That exemption was written for Web Push
// and these routes inherit it, which is why `/apns/status` truncates every
// token it returns: a device token is the address of a push that bypasses the
// lock screen, and this mount is reachable without a credential.

/**
 * POST /api/push/apns/register — record a device token.
 *
 * Body: `{ token, app?, environment?, deviceId?, bundleId? }`
 *
 * Re-registering the same token is a HEARTBEAT, not a duplicate — the app
 * registers on every launch — and it clears any previous failure, because a
 * token being presented by a live app is working now.
 */
router.post('/apns/register', (req, res) => {
  const apns = require('../services/apns');
  const v = apns.validate(req.body || {});
  if (!v.ok) return res.status(400).json({ ok: false, error: v.reason });

  try {
    apns.register(v.registration);
    // Never log the token itself.
    console.log(`[APNs] Registered ${v.registration.app} (${v.registration.environment})`);
    res.json({
      ok: true,
      // ⚠ Told plainly that nothing can be delivered yet. An app that registers
      // successfully and then never receives anything would otherwise have no
      // way to tell a broken push path from a quiet week.
      canDeliver: false,
      blockedBy: 'no APNs sender yet — needs a paid Apple Developer account',
    });
  } catch (e) {
    console.error('[APNs] register failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/**
 * DELETE /api/push/apns/register — forget a token.
 * Used on sign-out, so a signed-out phone stops being a delivery target.
 */
router.delete('/apns/register', (req, res) => {
  const token = (req.body && req.body.token) || req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: 'token is required' });
  try {
    res.json({ ok: true, removed: db.deleteApnsToken(String(token).toLowerCase()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/push/apns/status — what is registered, and why nothing arrives.
 *
 * ⚠ Reports `canDeliver: false` out loud rather than staying quiet. "NEURO has
 * nothing to say" and "NEURO cannot say anything" are different facts.
 */
router.get('/apns/status', (req, res) => {
  res.json({ ok: true, ...require('../services/apns').status() });
});

module.exports = router;
