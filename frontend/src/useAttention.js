import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

/**
 * The canonical attention feed, for the desktop.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/api/attention` is the NEURO-owned decision and lifecycle contract; the
 * phone, the kiosk, the widget and every push already consume it. Desktop
 * Briefing and Focus did not — they read `/api/focus` and wrote to
 * `/api/focus/{dismiss,snooze,hide-today,action-done}`, which is a suppression
 * TIMER, not a lifecycle. So "seen it", "not now" and "not mine" all collapsed
 * into one gesture on one surface and stayed distinct on the others, and a card
 * acknowledged on the phone came straight back on the desktop.
 *
 * ── The rules this hook enforces ────────────────────────────────────────────
 * 1. **No reranking, no rewording, no urgency invented in React.** `title`,
 *    `say`, `reason`, `tab`, `urgency` and the permitted `actions` all come off
 *    the record. A client that composes its own is a second opinion and drifts.
 * 2. **`actions` is a bounded set and it is honoured.** A button the record
 *    does not permit is not rendered — offering one the server will refuse is
 *    worse than not offering it (`action-presenter`'s blockers rule).
 * 3. **Opening is not an action.** `open` navigates and calls nothing. Giving
 *    it a request is how it acquires a side effect later, which is exactly how
 *    Briefing's "Do it" came to log a completed outcome at the moment work
 *    STARTED.
 * 4. **The legacy path is a fallback, never a parallel.** `/api/focus/dismiss`
 *    is used ONLY when a card carries no `recordId` — an old cached payload, or
 *    a lifecycle that could not be reconciled. It is reported, not silent.
 */

// Only these two legacy calls survive, and only for a card with no record.
// `action-done` is deliberately NOT among them: it logged an outcome, and there
// is no state of the world in which "I am starting this" should do that.
const LEGACY = {
  dismiss: '/api/focus/dismiss',
  defer: '/api/focus/snooze',
};

const DEFER_REASONS = {
  'not-now': 'Not now',
  'no-context': 'Needs context first',
  'waiting-on-someone': 'Waiting on someone',
  'too-big': 'Too big as it stands',
};

async function postJson(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

export default function useAttention({ interval = 30000 } = {}) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/attention');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${res.status}`);
      setState({ loading: false, error: null, data: json });
    } catch (e) {
      // ⚠ The previous payload is KEPT on a failed refresh. Blanking the feed
      // would render an outage as a calm day, which is the one thing every
      // layer of this contract refuses to do.
      setState((s) => ({ loading: false, error: e.message, data: s.data }));
    }
  }, []);

  useEffect(() => {
    load();
    if (!interval) return undefined;
    timer.current = setInterval(load, interval);
    return () => clearInterval(timer.current);
  }, [load, interval]);

  /**
   * Submit an action against a card.
   *
   * `action` is one of the record's own `actions`. Returns
   * `{ok, canonical, taskCompleted, taskWhy, why}` — `canonical:false` means
   * the legacy fallback ran, which the surface says out loud rather than
   * presenting as the same thing.
   */
  const act = useCallback(async (card, action, opts = {}) => {
    if (!card) return { ok: false, why: 'no card' };

    if (card.recordId) {
      const json = await postJson(`/api/attention/records/${card.recordId}/act`, {
        action,
        minutes: opts.minutes,
        reason: opts.reason,
        note: opts.note,
      });
      await load();
      return {
        ok: true,
        canonical: true,
        taskCompleted: json.taskCompleted ?? null,
        taskWhy: json.taskWhy ?? null,
        record: json.record || null,
      };
    }

    // ── Fallback ──────────────────────────────────────────────────────────────
    // No record means the lifecycle could not be reconciled for this card. The
    // engine's own suppression is all that is left, and it can express only
    // "hide it" — so `complete` and `acknowledge` have no legacy equivalent and
    // are refused with a reason rather than quietly mapped onto a dismissal.
    const legacyPath = LEGACY[action];
    if (!legacyPath) {
      return { ok: false, canonical: false, why: `"${action}" needs a canonical attention record and this card has none` };
    }
    await postJson(legacyPath, {
      itemId: card.id,
      itemType: card.type,
      ...(action === 'defer' ? { durationMinutes: opts.minutes || 60 } : {}),
    });
    await load();
    return { ok: true, canonical: false, why: 'no attention record — used legacy suppression' };
  }, [load]);

  const data = state.data;
  const primary = data && data.primary && data.primary.kind === 'item' ? data.primary : null;
  const contextCard = data && data.primary && data.primary.kind === 'context' ? data.primary : null;
  const secondary = (data?.secondary || []).filter((c) => c && c.kind === 'item');

  return {
    loading: state.loading,
    error: state.error,
    data,
    primary,
    contextCard,
    secondary,
    // Everything the surface may render as a card, primary first.
    cards: primary ? [primary, ...secondary] : secondary,
    // Carried straight through — a client must not re-derive any of these.
    quiet: data?.quiet ?? false,
    speech: data?.speech ?? null,
    poolAvailable: data?.poolAvailable ?? null,
    gaps: data?.gaps || [],
    dropped: data?.dropped || [],
    transition: data?.transition || null,
    lifecycleAvailable: data?.attention?.available ?? false,
    refresh: load,
    act,
  };
}

export { DEFER_REASONS };
