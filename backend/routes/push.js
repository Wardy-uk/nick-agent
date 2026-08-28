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

module.exports = router;
