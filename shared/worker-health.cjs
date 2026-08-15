'use strict';

/**
 * One verdict on the Pi 4 worker, shared by the Topbar indicator and the Pi
 * Health panel.
 *
 * It lives here rather than in either component because the two used to derive
 * it separately from `lastHealthy`, and both derived it wrongly in the same way:
 * a timeout deliberately no longer marks the worker unreachable (it answers
 * /health in 0.2s while failing to finish a triage inside 60s), so `lastHealthy`
 * sits at `null` and both surfaces reported "unverified · background AI tasks
 * have not run". Neither half was true: the worker HAD been asked, repeatedly,
 * and the tasks HAD run — on the fallback providers.
 *
 * The states that actually matter are the ones pi4-worker-client tracks: how
 * many consecutive failures, whether it is in cooldown, and whether the last
 * failure was a timeout (up but too slow) or a connection error (down). Those
 * want different responses from Nick, so they get different words — "unreachable"
 * sends you to check the box, which is wasted effort when the box is fine.
 *
 * `level` is 'ok' | 'warn' | 'critical', matching the shape pi-health's assess()
 * emits so the panel can rank a struggling worker against a hot CPU.
 */
function assessWorker(w) {
  if (!w || !w.enabled) {
    return {
      state: 'disabled', up: null, level: 'ok',
      title: 'Pi 4 worker disabled',
      short: 'Pi 4 worker disabled',
      detail: 'background AI tasks run on the main stack',
    };
  }

  const where = w.url || '';
  const fails = w.consecutiveFailures || 0;
  const skipAfter = w.skipAfter || 3;
  const timedOut = Boolean(w.lastFailure && w.lastFailure.timedOut);
  const secs = w.timeout ? Math.round(w.timeout / 1000) : null;
  const kind = timedOut
    ? `not finishing tasks${secs ? ` inside ${secs}s` : ''}`
    : 'failing';

  if (w.skipping) {
    const until = w.skipUntil ? new Date(w.skipUntil).toLocaleTimeString() : 'shortly';
    return {
      state: 'cooldown', up: false, level: 'critical',
      title: `Pi 4 worker ${kind} — in cooldown`,
      short: 'Pi 4 worker in cooldown',
      detail: `${where} — ${fails} consecutive failures; background tasks are routed elsewhere until ${until}`,
    };
  }

  if (w.lastHealthy === false) {
    return {
      state: 'unreachable', up: false, level: 'critical',
      title: 'Pi 4 worker unreachable',
      short: 'Pi 4 worker unreachable',
      detail: `${where}${w.lastFailure && w.lastFailure.message ? ` — ${w.lastFailure.message}` : ''}`,
    };
  }

  if (fails > 0) {
    return {
      state: timedOut ? 'slow' : 'failing', up: false, level: 'warn',
      title: `Pi 4 worker ${kind}`,
      short: timedOut ? 'Pi 4 worker too slow' : 'Pi 4 worker failing',
      detail: `${where} — ${fails} consecutive failure${fails === 1 ? '' : 's'}, skipped at ${skipAfter}; background tasks are falling back`,
    };
  }

  if (w.lastHealthy === true) {
    return {
      state: 'ok', up: true, level: 'ok',
      title: 'Pi 4 worker healthy',
      short: 'Pi 4 worker healthy',
      detail: where,
    };
  }

  // Genuinely unknown: enabled, but nothing has asked it anything since restart.
  return {
    state: 'unknown', up: null, level: 'warn',
    title: 'Pi 4 worker unverified',
    short: 'Pi 4 worker unverified',
    detail: `${where} — no task sent since restart`,
  };
}

module.exports = { assessWorker };
