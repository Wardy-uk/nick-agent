import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../api';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
import { speakIfEnabled, isAudioUnlocked, unlockAudio, isVoiceOutEnabled, setVoiceOutEnabled } from '../voiceUtils';
// ⚠ ONE source, shared with the Pi kiosk (`sara/shared-ui`). SARA's presence
// must look the same wherever she is; two copies would drift, which is exactly
// what happened to `voiceUtils.js` when the phone and the desktop each kept
// their own. Field itself is size-agnostic — its density is per AREA, not a
// node count — so the same file reads correctly on a 390px phone and a 1280px
// desk panel without re-tuning.
import Field from '../../../shared-ui/Field';
import AttentionSurface from '../../../shared-ui/AttentionSurface';
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
// visible only as order arriving in it. No orb, no avatar, no face. The field
// is driven by the brain's OWN state, so the coherence on screen is the
// coherence of the read — informative before a word is read, which is what
// keeps it from being a screensaver.
//
// ── Ears ────────────────────────────────────────────────────────────────────
// SARA is the voice/ears/eyes layer, and until now her own screen had neither a
// mic nor a speech toggle: talking to her meant "Show me everything" → Chat,
// i.e. going through a menu to reach the thing that exists so you don't need
// one. The mic is here, and the exchange is deliberately EPHEMERAL — one
// question, one answer, then back to the ambient state. The Chat tab owns
// conversation and history; this owns the passing question. Two surfaces
// keeping two versions of the same thread is the drift this avoids.
//
// The mic tap is also the iOS audio-unlock gesture, which is why `unlockAudio`
// is called there explicitly rather than left to whichever touch wins the race.
//
// Three things it must still get right, all of them about honesty:
//   * SILENCE IS A CORRECT ANSWER. Most of a calm day has no primary.
//   * NOTHING IS HIDDEN SILENTLY. What was gated out is named.
//   * "COULDN'T LOOK" IS NOT "NOTHING THERE" — hence `context.cannotSee`, which
//     the brain now filters to gaps that could actually have changed the answer.
const POLL_MS = 60_000;

// How long "not now" means, said in Nick's words rather than in minutes.
//
// The REASON travels with each one because a thing pushed back three times for
// `too-big` is a different problem from one pushed back for `not-now`, and that
// distinction is what Work Package C is built on. It costs nothing to record it
// at the moment the gesture is made and cannot be recovered afterwards.
const { resolveSaraLiteTab } = actionSurfaces;

// Straight from Chat.jsx — iOS fails dictation in specific, explicable ways and
// saying which one beats a spinner that stops.
const VOICE_ERRORS = {
  'not-allowed': 'Microphone permission is off for SARA.',
  'service-not-allowed': 'iOS refused speech recognition here. Try Safari rather than the installed app.',
  'audio-capture': 'No microphone available.',
  network: 'Speech recognition needs the network and couldn’t reach it.',
  aborted: 'Cut off before it caught anything. Tap the mic and try again.',
};

// Where a card goes when tapped. Reuses the notification router, so a card and
// the notification for the same thing can never land on different tabs.
function tabFor(card) {
  if (!card || card.kind !== 'item') return null;
  return resolveSaraLiteTab({ type: card.type, meta: card.meta });
}

export default function Surface({ onNavigate, onShowAll, arrivedFrom, onClearArrival }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(false);
  const [voiceOut, setVoiceOut] = useState(() => isVoiceOutEnabled());

  // The passing question. Null most of the time — this is an ambient screen
  // that can be spoken to, not a chat window.
  const [exchange, setExchange] = useState(null); // { question, answer, thinking, error }
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState('');
  const recognitionRef = useRef(null);
  const dictatedRef = useRef('');

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
  // while the screen was off. Paused while an exchange is open so an answer
  // never gets swept away mid-read.
  useEffect(() => {
    const timer = setInterval(() => { if (!exchange) load({ quiet: true }); }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !exchange) load({ quiet: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load, exchange]);

  // Speak the brain's line, once per distinct line. `speech` is already null
  // whenever it decided to stay quiet, so there is no second opinion here.
  // The gesture retry is what makes it work on iOS at all (#111): a cold start
  // lands here before any touch, so it is left UNSPOKEN and retried rather than
  // dropped — a dropped utterance is indistinguishable from a broken toggle.
  const spokenRef = useRef(null);
  const speech = exchange ? null : (state.data?.speech || null);
  useEffect(() => {
    if (!speech || speech === spokenRef.current) return;
    const say = () => { spokenRef.current = speech; speakIfEnabled(speech); };
    if (isAudioUnlocked()) { say(); return; }
    const onGesture = () => say();
    document.addEventListener('pointerdown', onGesture, { once: true });
    return () => document.removeEventListener('pointerdown', onGesture);
  }, [speech]);

  async function ask(question) {
    setExchange({ question, answer: '', thinking: true, error: null });
    let acc = '';
    try {
      await chatStream(
        { message: question },
        {
          onChunk: (c) => { acc += c; setExchange((e) => (e ? { ...e, answer: acc } : e)); },
          onError: (msg) => setExchange((e) => (e ? { ...e, error: msg } : e)),
        },
      );
    } catch {
      // Streaming failed outright — the sync endpoint is the documented fallback.
      try {
        const res = await apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify({ message: question }) });
        acc = res?.reply || res?.content || '';
      } catch (e2) {
        setExchange((x) => (x ? { ...x, thinking: false, error: e2.message } : x));
        return;
      }
    }
    setExchange((e) => (e ? { ...e, answer: acc, thinking: false } : e));
    if (acc) speakIfEnabled(acc);
  }

  function toggleMic() {
    // The tap that starts dictation is also the gesture iOS needs before it will
    // ever speak. Doing it here explicitly beats relying on a {once:true} race.
    unlockAudio();
    setVoiceErr('');

    if (listening) { recognitionRef.current?.stop(); return; }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setVoiceErr('This browser has no speech recognition.'); return; }

    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;          // the STOP tap is what sends
    dictatedRef.current = '';
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      dictatedRef.current = (dictatedRef.current ? `${dictatedRef.current} ${chunk}` : chunk).trim();
    };
    // onend fires from a stale closure, hence dictatedRef rather than state.
    rec.onend = () => {
      setListening(false);
      const said = dictatedRef.current.trim();
      if (said) ask(said);
      else setVoiceErr((e) => e || 'Heard nothing. If that keeps happening, try Safari rather than the installed app.');
    };
    rec.onerror = (evt) => {
      setListening(false);
      const code = evt?.error || 'unknown';
      if (dictatedRef.current.trim()) return;   // a finished turn is not a failure
      const known = Object.prototype.hasOwnProperty.call(VOICE_ERRORS, code);
      setVoiceErr(known ? VOICE_ERRORS[code] : `Mic error: ${code}`);
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function endExchange() {
    setExchange(null);
    setVoiceErr('');
    load({ quiet: true });
  }

  /**
   * Act on the card's RECORD.
   *
   * ⚠ This used to POST `/api/focus/dismiss` — the engine's per-item
   * suppression, which is a TIMER. It could not tell "I have seen this" from
   * "hide it for 30 minutes" from "this is finished", so every gesture here
   * collapsed into the same one and nothing Nick did was recoverable later.
   *
   * The record is the one place that distinction lives, so this submits an
   * ACTION and lets NEURO decide the state — the contract's rule that clients
   * never write state directly.
   *
   * It FALLS BACK to the old route when a card has no `recordId`, which is the
   * case against a backend that has not been deployed yet. A phone in Nick's
   * pocket running an older bundle must not lose the ability to clear a card.
   */
  async function act(card, action, opts = {}) {
    if (!card || card.kind !== 'item') return;
    setBusy(true);
    try {
      if (card.recordId) {
        await apiFetch(`/api/attention/records/${card.recordId}/act`, {
          method: 'POST',
          body: JSON.stringify({ action, ...opts }),
        });
      } else {
        await apiFetch('/api/focus/dismiss', {
          method: 'POST',
          body: JSON.stringify({ itemId: card.id, itemType: card.type }),
        });
      }
      await load({ quiet: true });
    } catch { /* leave it on screen if it failed — a card that vanishes on an
                 error is a card Nick believes he has dealt with */ }
    finally { setBusy(false); }
  }

  function open(card) {
    const tab = tabFor(card);
    if (tab) onNavigate?.(tab);
  }

  /**
   * A sentence Nick said — or tapped, which is the same sentence.
   *
   * ⚠ THE INTENT IS STRUCTURED AND IS NEVER PARSED HERE. The brain composed
   * both the words and what they mean (`backend/services/sara-surface.js`), for
   * the same reason it composes `say`, `speech` and `tab`: the moment a client
   * works out what a sentence means, there are two answers to that question and
   * they are free to drift.
   *
   * ⚠ The kinds are a CLOSED set and an unrecognised one does nothing rather
   * than guessing. A surface that falls through to a default action on a verb
   * it does not understand is how a tap comes to do something nobody asked for.
   */
  async function onSay(utterance, card) {
    const intent = utterance && utterance.intent;
    if (!intent) return;

    switch (intent.kind) {
      case 'act':
        // The record is the identity, and the brain named it. `card` is only a
        // fallback for the legacy route inside `act`.
        return act(
          intent.recordId ? { ...card, kind: 'item', recordId: intent.recordId } : card,
          intent.action,
          { minutes: intent.minutes, reason: intent.reason },
        );

      case 'session':
        // ⚠ A DIFFERENT API from `act`. Shrink, step-away and finish live on
        // `/api/session/*`; the attention lifecycle refuses all three, so
        // sending them there would be a sentence NEURO cannot honour.
        setBusy(true);
        try {
          await apiFetch(`/api/session/${intent.action}`, { method: 'POST', body: JSON.stringify({}) });
          await load({ quiet: true });
        } catch { /* left on screen — a card that vanishes on an error is one
                     Nick believes he has dealt with */ }
        finally { setBusy(false); }
        return undefined;

      case 'navigate':
        if (intent.tab) onNavigate?.(intent.tab);
        return undefined;

      case 'ask':
        // Straight into the passing question — the same ephemeral exchange the
        // mic uses. Chat owns conversation and history; this owns the one
        // question, and two surfaces keeping two versions of one thread is the
        // drift that split avoids.
        return ask(intent.text || utterance.say);

      case 'refresh':
        return load();

      case 'reveal':
        onShowAll?.();
        return undefined;

      default:
        return undefined;
    }
  }

  const { loading, error, data } = state;
  // The bare states keep their own words — a cold start and an unreachable
  // brain are not the same fact, and neither is the shared component's job.
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

  // ⚠ Everything the feed MEANS now lives in `sara/shared-ui/AttentionSurface`,
  // shared file-for-file with the Pi kiosk: the three distinct silences, the
  // transition, the defer row with its reasons, what is held back. This file
  // keeps only what is genuinely the PHONE's — fetching, speech, the mic, the
  // passing question and the notification arrival — and passes them in as slots.
  //
  // The rules are shared so the two surfaces cannot drift; the chrome is not,
  // because a kiosk carrying a mic it cannot use is worse than one without.
  return (
    <AttentionSurface
      data={data}
      error={error}
      busy={busy}
      rootClassName="surface"
      onOpen={open}
      onAct={act}
      onSay={onSay}
      onNavigate={(tab) => onNavigate?.(tab)}
      hideSecondary={Boolean(exchange)}
      crownExtra={(
        <button
          type="button"
          className={`surface__ear${voiceOut ? ' surface__ear--on' : ''}`}
          onClick={() => { unlockAudio(); const next = !voiceOut; setVoiceOutEnabled(next); setVoiceOut(next); }}
          aria-pressed={voiceOut}
          aria-label={voiceOut ? 'Stop SARA speaking' : 'Let SARA speak'}
        >{voiceOut ? '🔊' : '🔇'}</button>
      )}
      beforeSay={arrivedFrom?.body && !exchange ? (
        // Why he is here, when he arrived by tapping a notification. Without it
        // the push and the screen are two unconnected events.
        <button type="button" className="surface__arrival" onClick={() => onClearArrival?.()}>
          <span className="surface__arrivallabel">you tapped</span>
          <span className="surface__arrivalbody">{arrivedFrom.body}</span>
        </button>
      ) : null}
      sayOverride={exchange ? (
        <>
          <p className="surface__asked">“{exchange.question}”</p>
          {exchange.error ? (
            <p className="surface__saysub surface__saysub--warn">{exchange.error}</p>
          ) : (
            <p className="surface__saylead">{exchange.answer || (exchange.thinking ? '…' : '')}</p>
          )}
          <div className="surface__acts">
            <button type="button" className="surface__btn" onClick={endExchange}>Done</button>
          </div>
        </>
      ) : null}
      footAside={voiceErr ? <p className="surface__aside surface__aside--warn">{voiceErr}</p> : null}
      footExtra={(
        <div className="surface__footrow">
          <button
            type="button"
            className={`surface__mic${listening ? ' surface__mic--live' : ''}`}
            onClick={toggleMic}
            aria-pressed={listening}
            aria-label={listening ? 'Stop and send' : 'Talk to SARA'}
          >
            {listening ? 'Listening — tap to send' : '🎤 Talk to me'}
          </button>
          <button type="button" className="surface__all" onClick={() => onShowAll?.()}>Show me everything</button>
        </div>
      )}
    />
  );
}
