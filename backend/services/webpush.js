const webpush = require('web-push');
const db = require('../db/database');

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function init() {
  if (!isConfigured()) {
    console.log('[WebPush] Not configured — VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY required');
    return;
  }
  webpush.setVapidDetails(
    'mailto:nick.ward@nurtur.tech',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('[WebPush] Initialized');
}

// ── Notification governor ────────────────────────────────────────────────────
//
// 25 call sites across the codebase send push, and until this existed none of
// them knew about the others. Nagging every 15 minutes, alert checks every 5,
// meeting-prep checks every 5, two briefs, plus the weekly/nightly jobs — an
// escalation alone could arrive three ways. Notification fatigue is the failure
// mode that kills the whole tool: you mute it, and then it is worse than nothing.
//
// Three limits, in order: quiet hours, dedupe, hourly cap. State is persisted,
// because an in-memory budget resets on every restart and the backend restarts
// several times a day.

const GOVERNOR_KEY = 'push_governor';
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const HOURLY_CAP = parseInt(process.env.PUSH_HOURLY_CAP, 10) || 6;

// Things that must arrive whatever else is going on: something is on fire, or
// about to start, or the system itself is broken. Everything else can wait.
const ALWAYS_DELIVER = new Set([
  'escalation_alert',
  'meeting_alert',
  'system_alert',
  'capture_failed',
  'test',
]);

/** "22:00-07:00" — quiet by default overnight. Set PUSH_QUIET_HOURS=off to disable. */
function _quietHours() {
  const raw = process.env.PUSH_QUIET_HOURS || '22:00-07:00';
  if (raw === 'off') return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return {
    startMins: Number(m[1]) * 60 + Number(m[2]),
    endMins: Number(m[3]) * 60 + Number(m[4]),
  };
}

function _isQuietNow(now = new Date()) {
  const window = _quietHours();
  if (!window) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  // Wraps midnight, so "after start OR before end" rather than a simple range.
  return window.startMins > window.endMins
    ? (mins >= window.startMins || mins < window.endMins)
    : (mins >= window.startMins && mins < window.endMins);
}

function _readGovernor() {
  try {
    const parsed = JSON.parse(db.getState(GOVERNOR_KEY) || '{}');
    return { sent: Array.isArray(parsed.sent) ? parsed.sent : [], recent: parsed.recent || {} };
  } catch {
    return { sent: [], recent: {} };
  }
}

function _writeGovernor(state) {
  try {
    db.setState(GOVERNOR_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[WebPush] Could not persist governor state:', e.message);
  }
}

function _fingerprint(title, body, type) {
  return `${type || 'none'}|${title}|${String(body || '').slice(0, 80)}`;
}

/**
 * Decide whether this notification goes out, and record it if so.
 * Returns { allowed, reason }.
 */
function _governor(title, body, data) {
  const type = data?.type || null;
  const now = Date.now();
  const state = _readGovernor();

  // Prune first so both checks work off a clean window.
  state.sent = state.sent.filter(ts => now - ts < 60 * 60 * 1000);
  for (const [key, ts] of Object.entries(state.recent)) {
    if (now - ts >= DEDUPE_WINDOW_MS) delete state.recent[key];
  }

  const critical = ALWAYS_DELIVER.has(type);

  if (!critical && _isQuietNow()) {
    _writeGovernor(state);
    return { allowed: false, reason: 'quiet hours' };
  }

  // Dedupe applies to critical items too — the same escalation arriving from the
  // nudge path and the alert path is still one escalation.
  const fp = _fingerprint(title, body, type);
  if (state.recent[fp]) {
    _writeGovernor(state);
    return { allowed: false, reason: 'duplicate within 30 min' };
  }

  if (!critical && state.sent.length >= HOURLY_CAP) {
    _writeGovernor(state);
    return { allowed: false, reason: `hourly cap (${HOURLY_CAP}) reached` };
  }

  state.recent[fp] = now;
  state.sent.push(now);
  _writeGovernor(state);
  return { allowed: true };
}

async function sendToAll(title, body, data = {}) {
  if (!isConfigured()) return;

  const verdict = _governor(title, body, data);
  if (!verdict.allowed) {
    console.log(`[WebPush] Suppressed (${verdict.reason}): "${title}"`);
    return;
  }

  const subscriptions = db.getAllPushSubscriptions();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    data,
    icon: '/favicon.svg',
    badge: '/favicon.svg'
  });

  const results = await Promise.allSettled(
    subscriptions.map(sub => {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys_p256dh,
          auth: sub.keys_auth
        }
      };
      return webpush.sendNotification(pushSub, payload).catch(err => {
        console.error(`[WebPush] Push failed: ${err.statusCode || err.code || 'unknown'} — ${err.body || err.message}`);
        // 410 Gone or 404 = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log('[WebPush] Removing expired subscription:', sub.endpoint.slice(0, 60));
          db.removePushSubscription(sub.endpoint);
        }
        throw err;
      });
    })
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  if (sent > 0 || failed > 0) {
    console.log(`[WebPush] Sent: ${sent}, Failed: ${failed}`);
  }
}

module.exports = { isConfigured, init, sendToAll, _governor, _isQuietNow, ALWAYS_DELIVER, HOURLY_CAP };
