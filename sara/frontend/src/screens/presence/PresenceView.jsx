import { useCallback, useEffect, useState } from 'react';
import { useSaraState } from '../../state/saraState';
import AttentionSurface from '../../../../shared-ui/AttentionSurface';
import './PresenceView.css';

// Presence — SARA on the desk, and the screen the kiosk opens on.
//
// ⚠ This renders the PHONE'S ACTUAL SCREEN. `AttentionSurface` is one shared
// file (`sara/shared-ui`), so the kiosk and the phone cannot come to disagree
// about what a payload means: the three distinct silences, the transition, the
// defer row and its reasons, and what the gate held back are defined once.
//
// Nick's steer on 30 Aug was that the two "should essentially be the same app".
// The half that matters is the rules and the words, and that is what is shared.
// The chrome is NOT: the phone brings a mic, a speech toggle and a
// notification-arrival card, and a kiosk carrying a mic it cannot use would be
// worse than one without.
//
// ⚠ It still reads through `sara/backend`'s passthrough rather than talking to
// NEURO directly. That is deliberate, and it is a decision about where the
// CREDENTIAL lives, not about how alike the two apps are: a direct client would
// put a NEURO token in a browser on an always-on desk screen. Sharing the
// components never required sharing the transport.
//
// ── The field is driven by whether the brain can be SEEN ────────────────────
// `AttentionSurface` drives it from `poolAvailable` and the context's own
// confidence, so an unreadable pool LOOKS unresolved. When the feed cannot be
// reached at all, the provenance read below stands in — that is the kiosk's own
// fact, and NEURO is not there to tell it.

const POLL_MS = 60_000;

/**
 * provenance → what a field with no feed should look like. PURE.
 *
 * ⚠ `provenance.js` rolls up to FIVE values, not the four CLAUDE.md claimed —
 * `mixed` is real and is what the live kiosk usually sits in. Without a case
 * for it this fell to the default and would have rendered total blindness over
 * a read that was mostly fine. Anything unrecognised is still treated as
 * unreadable: a state we cannot name must never render as a confident one.
 */
export function fieldStateFor(provenanceState) {
  switch (provenanceState) {
    case 'neuro':
      return { confidenceLevel: 'high', degraded: false, partial: false };
    case 'neuro-stale':
      return { confidenceLevel: 'low', degraded: false, partial: false };
    case 'mixed':
      return { confidenceLevel: 'low', degraded: false, partial: true };
    case 'demo':
      return { confidenceLevel: 'low', degraded: true, partial: false };
    case 'unavailable':
    default:
      return { confidenceLevel: 'low', degraded: true, partial: false };
  }
}

export default function PresenceView() {
  const { provenance, status } = useSaraState();
  const [feed, setFeed] = useState(null);
  const [actError, setActError] = useState(null);

  const loadFeed = useCallback(async () => {
    try {
      const res = await fetch('/api/attention');
      setFeed(await res.json());
    } catch (e) {
      // "I couldn't ask" is its own fact and must not read as "nothing to say".
      setFeed({ available: false, reason: 'unreachable', detail: e.message });
    }
  }, []);

  /**
   * Act on the card's RECORD, through `sara/backend`'s passthrough.
   *
   * The action is submitted and NEURO decides the state — clients never write
   * state directly. ⚠ There is no legacy fallback here on purpose: the engine's
   * suppression is a TIMER and cannot express "seen it" or "this is finished",
   * so substituting it for a completion is exactly the bug being removed. A
   * card with no record simply cannot be acted on, and it says so.
   */
  const act = useCallback(async (card, action, opts = {}) => {
    setActError(null);
    if (!card || card.kind !== 'item') return;
    if (!card.recordId) {
      setActError("No attention record for that card yet — nothing recorded.");
      return;
    }
    try {
      const res = await fetch(`/api/attention/records/${card.recordId}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...opts }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setActError(body.error || `HTTP ${res.status}`); return; }
      await loadFeed();
    } catch (e) {
      // Left on screen deliberately — see the note on the render below.
      setActError(e.message);
    }
  }, [loadFeed]);

  useEffect(() => {
    loadFeed();
    const t = setInterval(loadFeed, POLL_MS);
    return () => clearInterval(t);
  }, [loadFeed]);

  const feedOk = feed && feed.available === true;
  const state = provenance?.state || 'unavailable';
  const { degraded, partial } = fieldStateFor(state);

  // ⚠ EXACTLY ONE of these renders, always. An earlier cut had no branch for a
  // live read with no headline, so the panel drew the field and NOT ONE WORD —
  // indistinguishable from a broken view, on the surface whose whole job is
  // making the state legible. Silence is a valid answer for a NOTIFICATION; it
  // is never one for a screen.
  if (status === 'connecting' && !feedOk) {
    return (
      <section className="presence presence--bare">
        <p className="presence__line">Waking…</p>
      </section>
    );
  }

  if (!feedOk) {
    const why = feed && feed.reason ? feed.reason : null;
    return (
      <section className="presence presence--bare">
        <span className="presence__mark">SARA</span>
        {degraded ? (
          <p className="presence__line presence__line--degraded">
            I can’t see the brain right now — this isn’t an all-clear.
          </p>
        ) : partial ? (
          <p className="presence__line">Partly live. What I couldn’t read is blank, not guessed.</p>
        ) : (
          <p className="presence__line">Here, and reading.</p>
        )}
        {why && <p className="presence__note">The feed said: {why}.</p>}
      </section>
    );
  }

  // The feed is good — render the same surface the phone renders, with the same
  // actions.
  //
  // ⚠ `onAct` was withheld here on the grounds that acting needs a credential
  // the kiosk does not hold. That was true of the BROWSER and never of SARA:
  // `sara/backend` already holds the credential and already proxies the feed,
  // so the act passthrough (`POST /api/attention/records/:id/act`) closes the
  // gap without putting a NEURO token on an always-on desk screen. The
  // alternative was leaving the kiosk with `/api/focus/action-done`, which
  // recorded work as finished the moment it was opened.
  //
  // A failure leaves the card ON SCREEN. A card that vanishes on an error is a
  // card Nick believes he has dealt with.
  return (
    <AttentionSurface
      data={feed}
      rootClassName="presence"
      onAct={act}
      footAside={
        <>
          {state === 'neuro-stale' && <p className="presence__note">Last good read — not live.</p>}
          {actError && <p className="presence__note">{actError}</p>}
        </>
      }
    />
  );
}
