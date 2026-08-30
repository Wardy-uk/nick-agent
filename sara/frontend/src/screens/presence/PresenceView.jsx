import { useSaraState } from '../../state/saraState';
import Field from '../../../../shared-ui/Field';
import './PresenceView.css';

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
      return { confidenceLevel: 'high', degraded: false };
    case 'neuro-stale':
      // We are looking at a real read, just an old one. It settles, barely.
      return { confidenceLevel: 'low', degraded: false };
    case 'demo':
      // Seeded content. It must never look like a working day.
      return { confidenceLevel: 'low', degraded: true };
    case 'unavailable':
    default:
      return { confidenceLevel: 'low', degraded: true };
  }
}

export default function PresenceView() {
  const { provenance, model, status } = useSaraState();
  const state = provenance?.state || 'unavailable';
  const { confidenceLevel, degraded } = fieldStateFor(state);

  // SARA's own line, taken verbatim from the backend. It is NOT rebuilt here:
  // three surfaces phrasing the same fact differently is how they drift, and
  // the phone already renders the brain's pre-composed wording.
  const line = model?.briefing?.headline || model?.summary || null;

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

        {status === 'connecting' && <p className="presence__line">Waking…</p>}

        {status !== 'connecting' && degraded && (
          // ⚠ Never an all-clear. "I can't see your work" and "there is nothing
          // to see" are different facts, and only one of them is good news.
          <p className="presence__line presence__line--degraded">
            I can’t see the brain right now — this isn’t an all-clear.
          </p>
        )}

        {status !== 'connecting' && !degraded && line && (
          <p className="presence__line">{line}</p>
        )}

        {state === 'neuro-stale' && (
          <p className="presence__note">Last good read — not live.</p>
        )}
      </div>
    </section>
  );
}
