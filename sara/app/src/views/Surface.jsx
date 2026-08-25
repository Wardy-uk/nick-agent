import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
import { speakIfEnabled, isAudioUnlocked } from '../voiceUtils';
import Field from '../components/Field';
import './Surface.css';

// Surface — SARA without a menu.
//
// The rest of this app is a tab strip: Nick chooses, SARA renders. This is the
// other way round. It renders GET /api/attention — ONE thing the brain decided
// is worth his attention, in the context it decided it in — and the nine views
// become places the brain routes TO rather than things to go and find.
//
// ── Presence ────────────────────────────────────────────────────────────────
// SARA is `components/Field`: the vault as a pinned noisy substrate, with her
// visible only as order arriving in it. No orb, no avatar, no face. Crucially
// the field is driven by the brain's OWN state, so the coherence on screen is
// the coherence of the read — it is informative before a word is read, which is
// what keeps it from being a screensaver.
//
// ── What the first cut got wrong, and why ───────────────────────────────────
//   1. There was no SARA in it at all — a card on black, with `flex:1` voids
//      above and below that read as broken rather than calm.
//   2. The most prominent chrome was a DEBUG READOUT: "MODERATE CONFIDENCE",
//      "can't see 1". Honest, but instrumentation — a number where her presence
//      should be. The honesty stays; she says it, in a sentence, at the bottom.
//   3. She wasn't talking. "Marked high priority · 1 day overdue · 34 other
//      overdue" is a field dump. The brain now composes `say`, so the same
//      facts arrive as one line in her register — and composed SERVER-side, so
//      the phone, the kiosk and the notification cannot word it three ways.
//
// Three things it must still get right, all of them about honesty:
//   * SILENCE IS A CORRECT ANSWER. Most of a calm day has no primary.
//   * NOTHING IS HIDDEN SILENTLY. What was gated out is named.
//   * "COULDN'T LOOK" IS NOT "NOTHING THERE" — hence `context.cannotSee`.
const POLL_MS = 60_000;
const { resolveSaraLiteTab } = actionSurfaces;

// Where a card goes when tapped. Reuses the notification router, so a card and
// the notification for the same thing can never land on different tabs.
function tabFor(card) {
  if (!card || card.kind !== 'item') return null;
  return resolveSaraLiteTab({ type: card.type, meta: card.meta });
}

export default function Surface({ onNavigate, onShowAll }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch('/api/attention');
      setState({ loading: false, error: null, data });
    } catch (error) {
      // An error is NOT an empty feed. Keep the last good payload on screen
      // beside the error rather than blanking to something that looks calm.
      setState((s) => ({ loading: false, error: error.message, data: s.data }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll, and re-read the moment the phone comes back — the context this rests
  // on (in a meeting, mid-session, before a 1-2-1) is exactly what changed
  // while the screen was off.
  useEffect(() => {
    const timer = setInterval(() => load({ quiet: true }), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load({ quiet: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  // Speak the brain's line, once per distinct line. `speech` is already null
  // whenever it decided to stay quiet, so there is no second opinion here.
  // The gesture retry is what makes it work on iOS at all (#111): a cold start
  // lands here before any touch, so it is left UNSPOKEN and retried rather than
  // dropped — a dropped utterance is indistinguishable from a broken toggle.
  const spokenRef = useRef(null);
  const speech = state.data?.speech || null;
  useEffect(() => {
    if (!speech || speech === spokenRef.current) return;
    const say = () => { spokenRef.current = speech; speakIfEnabled(speech); };
    if (isAudioUnlocked()) { say(); return; }
    const onGesture = () => say();
    document.addEventListener('pointerdown', onGesture, { once: true });
    return () => document.removeEventListener('pointerdown', onGesture);
  }, [speech]);

  async function dismiss(card) {
    if (!card || card.kind !== 'item') return;
    setBusy(true);
    try {
      await apiFetch('/api/focus/dismiss', {
        method: 'POST',
        body: JSON.stringify({ itemId: card.id, itemType: card.type }),
      });
      await load({ quiet: true });
    } catch { /* leave it on screen if the dismiss failed */ }
    finally { setBusy(false); }
  }

  function open(card) {
    const tab = tabFor(card);
    if (tab) onNavigate?.(tab);
  }

  const { loading, error, data } = state;

  if (loading && !data) {
    return (
      <div className="surface surface--bare">
        <Field confidenceLevel="low" degraded />
        <p className="surface__bareline">Reading the room…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="surface surface--bare">
        <Field confidenceLevel="low" degraded />
        <p className="surface__saylead">I can't reach the brain.</p>
        {error && <p className="surface__whyline">{error}</p>}
        <button type="button" className="surface__btn" onClick={() => load()}>Try again</button>
      </div>
    );
  }

  const { context, primary, secondary = [], dropped = [], quiet, rationale, poolAvailable, gaps = [] } = data;

  return (
    <div className="surface">
      <Field
        activity={context?.activity}
        confidenceLevel={context?.confidence?.level}
        quiet={quiet}
        degraded={!poolAvailable}
      />

      <div className="surface__content">
        {/* Chrome, deliberately small and wordless about its own certainty.
            The state is one lowercase word; the reasoning is behind a tap. */}
        <div className="surface__crown">
          <span className="surface__mark">SARA</span>
          <button
            type="button"
            className="surface__state"
            onClick={() => setShowWhy((v) => !v)}
            aria-expanded={showWhy}
            aria-label="Why SARA is showing this"
          >
            {context?.label ? context.label.toLowerCase() : 'unsure'}
          </button>
        </div>

        {showWhy && (
          <div className="surface__why">
            {context?.summary && <p className="surface__whyline surface__whyline--lead">{context.summary}</p>}
            {(context?.reasons || []).map((r, i) => <p key={i} className="surface__whyline">{r}</p>)}
            {(context?.contradictions || []).map((c, i) => (
              <p key={`c${i}`} className="surface__whyline surface__whyline--warn">{c}</p>
            ))}
            {rationale && <p className="surface__whyline">{rationale}</p>}
            {gaps.length > 0 && (
              <p className="surface__whyline">Couldn't read: {gaps.map((g) => g.input).join(', ')}.</p>
            )}
            <p className="surface__whyline">
              Confidence {context?.confidence?.level} — {context?.confidence?.rationale}
            </p>
          </div>
        )}

        {/* The one thing, given the room. */}
        <div className="surface__say">
          {primary ? (
            <>
              <p className="surface__saylead">{primary.title}</p>
              {primary.say && <p className="surface__saysub">{primary.say}</p>}
              {primary.kind === 'item' && (
                <div className="surface__acts">
                  <button type="button" className="surface__btn surface__btn--go" onClick={() => open(primary)}>
                    {primary.actionHint || 'Open it'}
                  </button>
                  <button type="button" className="surface__btn" disabled={busy} onClick={() => dismiss(primary)}>
                    Not now
                  </button>
                </div>
              )}
            </>
          ) : (
            // Three genuinely different facts. Conflating them is how a broken
            // feed comes to look like a good day.
            <>
              {!poolAvailable ? (
                <>
                  <p className="surface__saylead">I can't see your work right now.</p>
                  <p className="surface__saysub">So don't read this as an all-clear.</p>
                </>
              ) : quiet ? (
                <>
                  <p className="surface__saylead">{context?.summary || 'Staying out of the way.'}</p>
                  <p className="surface__saysub">Nothing here needs you.</p>
                </>
              ) : (
                <>
                  <p className="surface__saylead">Nothing pressing.</p>
                  <p className="surface__saysub">Everything's where it should be.</p>
                </>
              )}
            </>
          )}
        </div>

        {/* Everything else, deliberately quieter. */}
        {secondary.length > 0 && (
          <ul className="surface__rest">
            {secondary.map((card) => (
              <li key={card.id}>
                <button type="button" className="surface__row" onClick={() => open(card)}>
                  <span className="surface__rowtitle">{card.title}</span>
                  {card.say && <span className="surface__rowsay">{card.say}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="surface__foot">
          {/* Held, not lost. Naming it is what keeps this from feeling like
              things go missing behind her back. */}
          {dropped.length > 0 && (
            <p className="surface__aside">{dropped.length} held — {dropped[0].why}.</p>
          )}
          {/* The honesty, in her words rather than as a badge. */}
          {context?.cannotSee && <p className="surface__aside surface__aside--her">{context.cannotSee}</p>}
          {error && <p className="surface__aside surface__aside--warn">That last read failed — this is what I had.</p>}
          <button type="button" className="surface__all" onClick={() => onShowAll?.()}>Show me everything</button>
        </div>
      </div>
    </div>
  );
}
