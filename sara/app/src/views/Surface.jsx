import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
import { speakIfEnabled, isAudioUnlocked } from '../voiceUtils';
import './Surface.css';

// Surface — SARA without a menu.
//
// The rest of this app is a tab strip: Nick chooses, SARA renders. This is the
// other way round. It renders GET /api/attention — ONE thing the brain decided
// is worth his attention right now, in the context it decided it in — and the
// nine views become places the brain routes TO rather than things to go and find.
//
// Three things it must get right, all of them about honesty:
//
//   1. SILENCE IS A CORRECT ANSWER. Most of a calm day has no primary, and the
//      brain deliberately returns `primary: null`. Rendering a filler card here
//      would turn an ambient surface into a nudge machine, which is the one
//      thing allowed to argue against building more of this.
//   2. NOTHING IS HIDDEN SILENTLY. The brain reports what it gated out and why;
//      so does this. A card that vanished for a reason Nick cannot see is
//      indistinguishable from one that was lost.
//   3. "COULDN'T LOOK" IS NOT "NOTHING THERE". `context.unknowns` and `gaps`
//      are rendered, not swallowed — a confident-looking calm day inferred
//      without the calendar is exactly the false all-clear the brain refuses to
//      give, and the UI must not put it back.
//
// Speech follows the brain's `quiet` and its pre-composed `speech` line. The
// phrasing is NOT rebuilt here: three surfaces saying the same thing differently
// is how they drift.
const POLL_MS = 60_000;
const { resolveSaraLiteTab } = actionSurfaces;

// Where a card goes when it is tapped. Reuses the notification router, so a card
// and the notification for the same thing can never land on different tabs.
function tabFor(card) {
  if (!card || card.kind !== 'item') return null;
  return resolveSaraLiteTab({ type: card.type, meta: card.meta });
}

export default function Surface({ onNavigate, onShowAll }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch('/api/attention');
      setState({ loading: false, error: null, data });
    } catch (error) {
      // An error is NOT an empty feed. Keeping the last good payload on screen
      // beside the error beats blanking to something that looks like a calm day.
      setState((s) => ({ loading: false, error: error.message, data: s.data }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll, and re-read the moment the phone comes back to the foreground — the
  // context this is built on (in a meeting, mid-session, before a 1-2-1) is
  // exactly the thing that has changed while the screen was off.
  useEffect(() => {
    const timer = setInterval(() => load({ quiet: true }), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load({ quiet: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  // Speak the brain's line, once per distinct line. `speech` is already null
  // whenever the brain decided to stay quiet, so there is no second opinion
  // about silence here.
  //
  // The gesture retry is what makes this work on iOS at all: speechSynthesis
  // needs a touch first, and a cold start lands straight here. Left UNSPOKEN and
  // retried rather than dropped — a dropped utterance is indistinguishable from
  // a broken toggle (#111).
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
    return <div className="surface surface--waiting"><p className="surface__waiting">Reading the room…</p></div>;
  }

  if (!data) {
    return (
      <div className="surface surface--waiting">
        <p className="surface__error">Can't reach the brain.</p>
        {error && <p className="surface__errordetail">{error}</p>}
        <button type="button" className="surface__btn" onClick={() => load()}>Try again</button>
      </div>
    );
  }

  const { context, primary, secondary = [], dropped = [], quiet, rationale, poolAvailable, gaps = [] } = data;
  const unknowns = context?.unknowns || [];
  const blind = unknowns.length > 0;

  return (
    <div className="surface">
      {/* The frame: where SARA thinks Nick is, and how sure she is. Confidence is
          shown always, not only when it is low — a read that never admits doubt
          is one Nick stops interrogating. */}
      <button
        type="button"
        className="surface__context"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
      >
        <span className="surface__ctxlabel">{context?.label || 'Unknown'}</span>
        <span className={`surface__ctxconf surface__ctxconf--${context?.confidence?.level || 'low'}`}>
          {context?.confidence?.level || 'low'} confidence
        </span>
        {context?.place?.known && context.place.name !== 'unknown' && (
          <span className="surface__ctxplace">{context.place.name}</span>
        )}
        {blind && <span className="surface__ctxblind">can't see {unknowns.length}</span>}
      </button>

      {showDetail && (
        <div className="surface__detail">
          <p className="surface__summary">{context?.summary}</p>
          {(context?.reasons || []).map((r, i) => <p key={i} className="surface__reason">{r}</p>)}
          {(context?.contradictions || []).map((c, i) => (
            <p key={`c${i}`} className="surface__contradiction">⚠ {c}</p>
          ))}
          {rationale && <p className="surface__rationale">{rationale}</p>}
          {gaps.length > 0 && (
            <p className="surface__gaps">
              Couldn't read: {gaps.map((g) => g.input).join(', ')}.
            </p>
          )}
        </div>
      )}

      {/* The one thing. */}
      {primary ? (
        <div className={`surface__primary surface__primary--${primary.kind}`}>
          <h1 className="surface__title">{primary.title}</h1>
          {primary.reason && <p className="surface__reasonline">{primary.reason}</p>}
          {primary.kind === 'item' && (
            <div className="surface__actions">
              <button type="button" className="surface__btn surface__btn--go" onClick={() => open(primary)}>
                {primary.actionHint || 'Open'}
              </button>
              <button type="button" className="surface__btn" disabled={busy} onClick={() => dismiss(primary)}>
                Not now
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="surface__primary surface__primary--empty">
          {/* Three genuinely different facts, and conflating them is how a broken
              feed comes to look like a good day. */}
          {!poolAvailable ? (
            <>
              <h1 className="surface__title">I can't see your work right now.</h1>
              <p className="surface__reasonline">The queue didn't answer, so this isn't an all-clear.</p>
            </>
          ) : quiet ? (
            <>
              <h1 className="surface__title">{context?.summary || 'Staying out of the way.'}</h1>
              <p className="surface__reasonline">Nothing needs you here.</p>
            </>
          ) : (
            <>
              <h1 className="surface__title">Nothing pressing.</h1>
              <p className="surface__reasonline">
                {blind ? "Though I can't see everything — tap above." : 'Everything is where it should be.'}
              </p>
            </>
          )}
        </div>
      )}

      {secondary.length > 0 && (
        <ul className="surface__secondary">
          {secondary.map((card) => (
            <li key={card.id}>
              <button type="button" className="surface__row" onClick={() => open(card)}>
                <span className="surface__rowtitle">{card.title}</span>
                {card.reason && <span className="surface__rowreason">{card.reason}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Held, not lost. The brain names everything it gated out; saying so is
          what keeps this from feeling like things go missing. */}
      {dropped.length > 0 && (
        <p className="surface__held">
          {dropped.length} held — {dropped[0].why}.
        </p>
      )}

      <div className="surface__foot">
        <button type="button" className="surface__all" onClick={() => onShowAll?.()}>
          Show me everything
        </button>
        {error && <span className="surface__stale">Last read failed — showing what I had.</span>}
      </div>
    </div>
  );
}
