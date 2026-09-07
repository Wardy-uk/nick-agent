import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './SessionBadge.css';

/**
 * The running focus session, visible from EVERY page.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `focus-session` was built on one argument: for an ADHD brain the interruption
 * is not the cost, the FAILURE TO RETURN is — you get pulled onto an escalation
 * and nothing anywhere says "you were twenty minutes into X". The session
 * container answers that, and then only `AdhdPanel` ever rendered it. Three
 * surfaces could START a session (the Now card, quick wins, TimeFitCard) and
 * exactly one could show you were in one, so navigating to Todos or the Inbox —
 * which is what an interruption looks like — hid the very thing that exists to
 * survive it.
 *
 * The state is server-side (`agent_state.focus_session`, one row), so a session
 * already survives navigation, a refresh and a backend restart. What was missing
 * was somewhere to SEE it.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * 1. AMBIENT, NEVER A NAG. It renders and it links. No push, no sound, no
 *    growing urgency — `focus-session` is pull-only by design, and nudge volume
 *    is the one signal allowed to argue against building more of this system.
 *
 * 2. ONE MINUTE, NOT ONE SECOND. A ticking clock on permanent display is a
 *    distraction wearing the clothes of feedback. Same granularity AdhdPanel
 *    already chose for the session card.
 *
 * 3. IT SAYS WHICH STATE IT IS IN. Active, paused, pulled away and
 *    "too big to start" are different situations with different ways back, and
 *    a badge that renders all four identically would say a parked session is
 *    running work.
 *
 * 4. A FAILED READ RENDERS NOTHING. Deliberately NOT the house "name the gap"
 *    rule, and the exception is argued: this is chrome on every page, so an
 *    error state here would put a permanent warning in front of Nick on screens
 *    that have nothing to do with sessions. The authoritative surface — Now —
 *    still reports the failure. Chrome may be silent; the panel may not.
 *
 * 5. IT NEVER WRITES. No finish, no pause, no abandon. Those change what the
 *    ledger says about the work and belong on the session card where the whole
 *    context is, not on a badge that is one mis-tap away on every screen.
 */

const POLL_MS = 60000;

const STATE_WORDS = {
  active: 'in progress',
  paused: 'paused',
  interrupted: 'you were pulled off this',
  'needs-smaller': 'too big to start',
};

export default function SessionBadge({ onNavigate, activeView }) {
  const [session, setSession] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/session');
      if (!res.ok) { setSession(null); return; }
      const data = await res.json();
      setSession(data?.session || null);
    } catch {
      // Rule 4: silent. Now still reports it.
      setSession(null);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Re-read on navigation as well as on the timer. Arriving somewhere new is
  // exactly when the badge is worth being current, and it costs one read of a
  // single KV row.
  useEffect(() => { load(); }, [activeView, load]);

  if (!session) return null;

  const word = session.stale ? 'still open from earlier' : (STATE_WORDS[session.status] || session.status);
  // `plannedAssumed` rides on every read for a reason (#87): a "halfway" built
  // on a length NEURO guessed must say it was guessed. Here that is the
  // difference between "18 of 30" and "18 min in".
  const time = session.plannedAssumed
    ? `${session.elapsedMinutes} min in`
    : `${session.elapsedMinutes} of ${session.plannedMinutes} min`;

  return (
    <button
      type="button"
      className={`session-badge session-badge--${session.stale ? 'stale' : session.status}`}
      onClick={() => onNavigate?.('today')}
      title={`${session.text} — ${word}. Open Now.`}
    >
      <span className="session-badge__dot" aria-hidden="true" />
      <span className="session-badge__text">
        {/* The next concrete step when there is one — it is what makes picking
            the thread back up possible, and it is shorter than the task. */}
        <strong>{session.nextStep || session.text}</strong>
        <em>{time} · {word}</em>
      </span>
    </button>
  );
}
