import { useCallback, useEffect, useState } from 'react';
import { useSaraState } from '../../state/saraState';
import Field from '../../../../shared-ui/Field';
import './PresenceView.css';

// How often the kiosk re-reads the feed. Matches the phone's Surface, so the two
// cannot drift into showing different vintages of the same decision.
const POLL_MS = 60_000;

// Presence — SARA on the desk, and the screen the kiosk opens on.
//
// This is the Pi's half of "the phone and the Pi are essentially the same app"
// (Nick, 30 Aug 2026). The field is the SAME FILE the phone renders
// (`sara/shared-ui/Field`), not a copy: two copies of her presence would drift
// exactly the way `voiceUtils.js` drifted once the phone and the desktop each
// kept their own. It needs no re-tuning for the bigger panel because its
// density is per AREA rather than a fixed node count.
//
// ⚠ What is NOT here, deliberately: the attention feed. `sara/backend` has no
// route to NEURO's `/api/attention`, so the kiosk cannot yet render the same
// cards the phone does. Rather than invent a second ranking on this side — the
// precise mistake `state/inference.js` was retired for — this screen shows her
// presence and the honest state of the connection, and the feed follows once
// the kiosk can read it. A screen that shows less is fine; a screen that makes
// something up is not.
//
// ── The coherence on screen is the coherence of the READ ────────────────────
// The field is driven by `provenance`, which is the backend's own statement
// about whether it can see NEURO. So an unreachable brain LOOKS unresolved:
// pure noise, no settle. That is the honest picture, and it is the reason this
// is not a screensaver.

/**
 * provenance → what the field should look like. PURE.
 *
 * The four provenances are the ones `src/state/provenance.js` defines, and they
 * are exhaustive on purpose. Anything unrecognised is treated as UNREADABLE
 * rather than fine: a state we cannot name must never render as a confident
 * one, which is the whole rule that block exists to enforce.
 */
export function fieldStateFor(provenanceState) {
  switch (provenanceState) {
    case 'neuro':
      return { confidenceLevel: 'high', degraded: false, partial: false };
    case 'neuro-stale':
      // A real read, just an old one. It settles, barely.
      return { confidenceLevel: 'low', degraded: false, partial: false };
    // ⚠ `mixed` is a FIFTH state and it is the one the live kiosk was actually
    // in. `provenance.js` rolls up to neuro / neuro-stale / unavailable / demo
    // AND 'mixed' — "partly live, and the parts we could not read are blank
    // rather than guessed". The first cut had no case for it, so it fell to the
    // default and rendered "I can't see the brain", which is a FALSE NEGATIVE:
    // most of the read was fine. Partly-seen must not read as blind, for the
    // same reason blind must not read as calm.
    case 'mixed':
      return { confidenceLevel: 'low', degraded: false, partial: true };
    case 'demo':
      // Seeded content. It must never look like a working day.
      return { confidenceLevel: 'low', degraded: true, partial: false };
    case 'unavailable':
    default:
      return { confidenceLevel: 'low', degraded: true, partial: false };
  }
}

export default function PresenceView() {
  const { provenance, model, status } = useSaraState();
  const state = provenance?.state || 'unavailable';
  const { confidenceLevel, degraded, partial } = fieldStateFor(state);

  // ── The attention feed ─────────────────────────────────────────────────────
  // Read straight from NEURO through the backend passthrough, and rendered
  // VERBATIM. `title`, `say` and the decision behind them are all composed
  // server-side, so the kiosk, the phone, the widget and the notification for
  // one thing cannot phrase it four ways.
  const [feed, setFeed] = useState(null);

  const loadFeed = useCallback(async () => {
    try {
      const res = await fetch('/api/attention');
      setFeed(await res.json());
    } catch (e) {
      // "I couldn't ask" is its own fact and must not read as "nothing to say".
      setFeed({ available: false, reason: 'unreachable', detail: e.message });
    }
  }, []);

  useEffect(() => {
    loadFeed();
    const t = setInterval(loadFeed, POLL_MS);
    return () => clearInterval(t);
  }, [loadFeed]);

  const feedOk = feed?.available === true;
  const primary = feedOk ? feed.primary : null;
  // ⚠ `poolAvailable:false` means NEURO could not see his work. It must never
  // render as a calm day — the same three-way distinction the phone's Surface
  // keeps: unavailable / quiet / genuinely nothing.
  const poolBlind = feedOk && feed.poolAvailable === false;

  // SARA's own line, taken verbatim. The attention feed leads when it has
  // something; the shared model's headline is the fallback.
  const line = primary?.title || model?.briefing?.headline || model?.summary || null;
  const sub = primary?.say || null;

  return (
    <section className="presence">
      <Field
        activity={model?.activity}
        confidenceLevel={confidenceLevel}
        quiet={model?.quiet === true}
        degraded={degraded}
      />

      <div className="presence__content">
        <span className="presence__mark">SARA</span>

        {/* ⚠ EXACTLY ONE of these always renders. The first cut had no branch for
            a live read with no headline, so the screen showed the field and NOT
            ONE WORD — indistinguishable from a broken view, on the surface whose
            whole job is to make the state legible. Silence is a valid answer for
            a NOTIFICATION; it is never a valid answer for a screen. */}
        {status === 'connecting' ? (
          <p className="presence__line">Waking…</p>
        ) : degraded ? (
          // ⚠ Never an all-clear. "I can't see the brain" and "there is nothing
          // to see" are different facts, and only one of them is good news.
          <p className="presence__line presence__line--degraded">
            I can’t see the brain right now — this isn’t an all-clear.
          </p>
        ) : poolBlind ? (
          <p className="presence__line presence__line--degraded">
            I can’t see your work right now — don’t read this as an all-clear.
          </p>
        ) : line ? (
          <>
            <p className="presence__line">{line}</p>
            {sub && <p className="presence__sub">{sub}</p>}
          </>
        ) : partial ? (
          <p className="presence__line">Partly live. What I couldn’t read is blank, not guessed.</p>
        ) : (
          // Live, and nothing to say. Deliberately says NOTHING about his work —
          // this screen cannot see the pool, so "you're all clear" would be a
          // claim it has no standing to make.
          <p className="presence__line">Here, and reading.</p>
        )}

        {state === 'neuro-stale' && (
          <p className="presence__note">Last good read — not live.</p>
        )}
        {partial && line && (
          <p className="presence__note">Some of NEURO could not be read.</p>
        )}
      </div>
    </section>
  );
}
