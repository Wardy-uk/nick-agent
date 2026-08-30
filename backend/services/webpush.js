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
// ⚠ These are the strings production actually SENDS, not a tidy vocabulary.
// `meeting_prep` was missing for as long as this set has existed: briefing.js
// sends `meeting_alert` (listed) while meeting-prep.js sends `meeting_prep`
// (not), so the "Meeting in 25 min" alert carrying the prep notes was
// suppressible — and the live log shows the hourly cap swallowing seven real
// 1-2-1 reminders. The suite was green throughout because webpush.test.js
// asserted the bypass using `meeting_alert`, a type that path never sends.
// `push-types.test.js` now pins every sent type against this set.
const ALWAYS_DELIVER = new Set([
  'escalation_alert',
  'meeting_alert',
  'meeting_prep',
  'system_alert',
  'capture_failed',
  // Fires 07:30 on a Monday, once a week, and is a PIP deliverable owed to Chris
  // by midday. The live log shows the hourly cap dropping it once. One
  // notification a week cannot cause fatigue; a missed compliance report in
  // front of the person assessing the PIP is the expensive direction.
  'weekly_risk',
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

/**
 * Record what became of a notification. Never allowed to fail a send — the
 * push has already gone (or already been refused), and a bookkeeping error
 * must not turn into a delivery error. `sent-replies` rule, same reasoning.
 */
function _record(title, data, outcome, reason, sentCount = 0, failedCount = 0) {
  try {
    db.logPushOutcome({
      type: data?.type || null,
      title: String(title || '').slice(0, 200),
      outcome,
      reason,
      sentCount,
      failedCount,
    });
  } catch (e) {
    console.warn('[WebPush] Could not record outcome:', e.message);
  }
}

/**
 * Every notification must have an attention record behind it.
 *
 * This is enforced HERE rather than at the 30 call sites, which is the only
 * reason it is enforceable at all: `nudges`, `briefing`, `watchdog`, `scheduler`,
 * `imports` and `capture` all send free text and none of them know about each
 * other. A caller that names a record (`data.attentionRecordId`) gets that one;
 * anything else gets an OPERATIONAL record opened for it — a watchdog alert is a
 * real interruption and belongs in the history Nick reads, even though it never
 * came from the decision pool.
 *
 * ⚠ It fails OPEN, and that is a deliberate trade. If the lifecycle cannot be
 * reached, the push still goes and the failure is written to `push_log` by name.
 * The contract wants no notification without a record; it wants an unanswered
 * escalation more. A bookkeeping outage must not be able to silence NEURO —
 * that is the exact failure the push log was added to make visible.
 */
function _attentionFor(title, body, data) {
  try {
    const lifecycle = require('./attention-lifecycle');
    if (data && data.attentionRecordId) {
      const db2 = require('../db/database');
      const row = db2.getAttentionRecord(data.attentionRecordId);
      return row ? { lifecycle, row } : { lifecycle, row: null, why: 'named record not found' };
    }
    const type = data?.type || 'system';
    // `key` is what watchdog already passes to identify an alert; the title is
    // the fallback. Either way the identity is the ALERT, not its wording, so a
    // reworded disk-space warning is still the same interruption.
    const ref = data?.key || title;
    const dedupeKey = lifecycle.dedupeKeyForPush(type, ref);
    const row = lifecycle.upsert(
      {
        // The key is EXPLICIT rather than derived from the type, so a push about
        // a pool item finds that item's record and an operational alert lands in
        // its own namespace where it cannot collide with a real card.
        dedupeKey,
        id: `push:${type}`,
        type,
        title,
        reason: String(body || '').slice(0, 200) || null,
        urgency: ALWAYS_DELIVER.has(type) ? 'critical' : 'medium',
        tier: ALWAYS_DELIVER.has(type) ? 1 : 2,
        meta: { operational: true, ref },
      },
      { operational: true }
    );
    return { lifecycle, row };
  } catch (e) {
    return { lifecycle: null, row: null, why: e.message };
  }
}

async function sendToAll(title, body, data = {}) {
  // Both of the returns below were SILENT. A notification NEURO decided to send
  // and could not deliver is a fact worth keeping — without it, "SARA has gone
  // quiet" and "SARA has nothing to say" are the same observation.
  if (!isConfigured()) {
    console.warn(`[WebPush] Not configured — dropped: "${title}"`);
    _record(title, data, 'undeliverable', 'VAPID not configured');
    return;
  }

  // ── Gate 1: the attention lifecycle ────────────────────────────────────────
  // This is the gate that can tell a countdown from a state change. The governor
  // below deduped on a fingerprint of the TEXT, so "in 25 min" and "in 10 min"
  // were different notifications to it and both went out.
  const { lifecycle, row: record, why: recordWhy } = _attentionFor(title, body, data);
  if (lifecycle && record) {
    const settings = require('./attention-settings').read();
    const verdict = lifecycle.shouldNotify(record, settings, {
      now: new Date(),
      critical: ALWAYS_DELIVER.has(data?.type),
    });
    lifecycle.recordNotification(record.id, { ...verdict, now: new Date() });
    if (!verdict.allowed) {
      console.log(`[WebPush] Held by attention (${verdict.reason}): "${title}"`);
      _record(title, data, 'suppressed', verdict.reason);
      return;
    }
  } else if (recordWhy) {
    // Loud, and in the log — a send with no record behind it is a contract
    // violation we are choosing to make rather than one we failed to notice.
    console.warn(`[WebPush] No attention record (${recordWhy}) — sending anyway: "${title}"`);
  }

  const verdict = _governor(title, body, data);
  if (!verdict.allowed) {
    console.log(`[WebPush] Suppressed (${verdict.reason}): "${title}"`);
    _record(title, data, 'suppressed', verdict.reason);
    return;
  }

  const subscriptions = db.getAllPushSubscriptions();
  if (subscriptions.length === 0) {
    console.warn(`[WebPush] No subscriptions — dropped: "${title}"`);
    _record(title, data, 'undeliverable', 'no subscriptions');
    return;
  }

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

  // Reaching NO endpoint is a different fact from reaching some of them: with
  // several devices registered, a partial failure still got through to Nick.
  const reasons = [...new Set(
    results.filter(r => r.status === 'rejected')
      .map(r => String(r.reason?.statusCode || r.reason?.code || 'unknown'))
  )].join(', ');
  _record(
    title, data,
    sent > 0 ? 'sent' : 'failed',
    reasons || null,
    sent, failed
  );
}

module.exports = { isConfigured, init, sendToAll, _governor, _isQuietNow, ALWAYS_DELIVER, HOURLY_CAP };
