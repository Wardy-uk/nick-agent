import { useState } from 'react';
import Field from './Field';
import Dashboard from './Dashboard';
import { isPressing } from './useFieldDrive';
import './AttentionSurface.css';

// AttentionSurface — the attention feed, rendered.
//
// ⚠ ONE source, shared by the phone (`sara/app` Surface) and the Pi kiosk
// (`sara/frontend` Presence). Nick's steer on 30 Aug was that the two "should
// essentially be the same app", and this is the half of that which matters: the
// RULES live here, once, so the two surfaces cannot come to disagree about what
// a payload means.
//
// The CHROME does not live here. Each shell passes its own — the phone brings a
// mic, a speech toggle and a notification-arrival card; the kiosk brings none of
// them and is not made to pretend otherwise. That split is deliberate: sharing
// the rules is what stops drift, sharing the furniture would only make both
// surfaces worse.
//
// It fetches nothing and decides nothing. `title`, `say`, `tab` and the
// transition wording are all composed server-side and rendered VERBATIM — this
// is the third renderer of one decision, not a third opinion.
//
// ── The rules it exists to hold in one place ────────────────────────────────
//
//   * THREE SILENCES, kept apart. "I can't see your work", "staying out of the
//     way" and "nothing pressing" are different facts and only the last is good
//     news. Conflating them is how a broken feed comes to look like a calm day.
//   * NOTHING IS HIDDEN SILENTLY. What the gate held back is counted and named.
//   * A TRANSITION LEADS when there is one — "leave now" is worthless five
//     minutes late — and it PROPOSES: every option opens a screen, none starts
//     a timer, writes a calendar or completes anything.
//   * "NOT NOW" ASKS HOW LONG rather than snoozing on a guess, and each answer
//     carries a REASON: a thing pushed back three times as "too big" is a
//     different problem from one pushed back as "not now".
//   * DISMISS IS OFFERED ONLY WHEN THE RECORD ALLOWS IT. An escalation is
//     deliberately not dismissable, and a button NEURO will refuse is worse
//     than no button at all.

// How long "not now" means, in Nick's words rather than in minutes.
export const DEFERRALS = [
  { label: 'An hour', minutes: 60, reason: 'not-now' },
  { label: 'This afternoon', minutes: 240, reason: 'not-now' },
  { label: 'Tomorrow', minutes: 60 * 20, reason: 'no-context' },
  { label: 'Too big', minutes: 60 * 20, reason: 'too-big' },
];

export default function AttentionSurface({
  data,
  error = null,
  busy = false,
  rootClassName = 'surface',
  onOpen,
  onAct,
  onNavigate,
  // What Nick could SAY next. Each utterance carries a structured intent, so no
  // shell ever parses language — see `backend/services/sara-surface.js`.
  // Omitting it falls back to the original buttons, which is what keeps a
  // failed composition from emptying the screen.
  onSay,
  // Slots. Each shell brings its own chrome; none of them is required.
  crownExtra = null,
  beforeSay = null,
  sayOverride = null,
  footAside = null,
  footExtra = null,
  hideSecondary = false,
}) {
  const [showWhy, setShowWhy] = useState(false);
  const [deferring, setDeferring] = useState(false);
  // ⚠ Keyed on the PROMPT, not a boolean. "Not now" dismisses THIS transition;
  // the next one must appear on its own. A boolean would silence every later
  // transition too, which is how a useful prompt becomes one nobody sees again.
  const [dismissedTransition, setDismissedTransition] = useState(null);

  if (!data) {
    return (
      <div className={`${rootClassName} surface--bare`}>
        <Field confidenceLevel="low" degraded />
        <p className="surface__saylead">I can&rsquo;t reach the brain.</p>
        {error && <p className="surface__whyline">{error}</p>}
      </div>
    );
  }

  const {
    context, primary, secondary = [], dropped = [], quiet,
    rationale, poolAvailable, gaps = [], transition = null, ambient = null,
    dashboard = null, utterances = [],
  } = data;

  const act = (card, action, opts) => onAct && onAct(card, action, opts);

  // ⚠ The sentences REPLACE the button row only when the brain composed them
  // AND the shell knows how to act on one. Either missing falls through to the
  // original buttons: a framing layer must never be able to leave the screen
  // with no way to answer it.
  const speaks = Boolean(onSay) && Array.isArray(utterances) && utterances.length > 0;

  // ── What counts as PRESSING ────────────────────────────────────────────────
  //
  // Nick, 31 Aug 2026: "change anything pressing to a slow pulse."
  //
  // ⚠ The rule itself lives in `useFieldDrive` and is IMPORTED, not restated,
  // because the shell's background field applies it too — two definitions of
  // "pressing" would be two answers free to drift, on the same screen.
  //
  // Critical or high only, and it must be an ITEM. On a normal working day
  // there is nearly always a primary, so pulsing on any of them would mean
  // pulsing all day, and a signal that is always on is one nobody sees.
  const pressing = isPressing(primary);

  return (
    <div className={rootClassName}>
      {/* The coherence on screen is the coherence of the READ — informative
          before a word is read, which is what keeps this from being a
          screensaver. */}
      <Field
        activity={context?.activity}
        confidenceLevel={context?.confidence?.level}
        quiet={quiet}
        degraded={!poolAvailable}
        pressing={pressing}
      />

      <div className="surface__content">
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
          {crownExtra}
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
              <p className="surface__whyline">Couldn&rsquo;t read: {gaps.map((g) => g.input).join(', ')}.</p>
            )}
            <p className="surface__whyline">
              Confidence {context?.confidence?.level} — {context?.confidence?.rationale}
            </p>
          </div>
        )}

        {beforeSay}

        <div className="surface__say">
          {/* A transition is time-critical and leads when there is one. */}
          {!sayOverride && transition && dismissedTransition !== transition.prompt && (
            <div className="surface__transition">
              <p className="surface__saylead">{transition.prompt}</p>
              <p className="surface__saysub">{transition.question}</p>
              <div className="surface__acts">
                {transition.tab && onNavigate && (
                  <button
                    type="button"
                    className="surface__btn surface__btn--go"
                    onClick={() => onNavigate(transition.tab)}
                  >
                    {transition.kind === 'leave-now' ? 'Open prep'
                      : transition.kind === 'post-meeting' ? 'Capture it'
                        : 'Pick it up'}
                  </button>
                )}
                <button
                  type="button"
                  className="surface__btn"
                  onClick={() => setDismissedTransition(transition.prompt)}
                >
                  Not now
                </button>
              </div>
            </div>
          )}

          {sayOverride || (primary ? (
            <>
              <p className="surface__saylead">{primary.title}</p>
              {primary.say && <p className="surface__saysub">{primary.say}</p>}
              {primary.kind === 'item' && onAct && !speaks && (
                <>
                  <div className="surface__acts">
                    <button
                      type="button"
                      className="surface__btn surface__btn--go"
                      onClick={() => onOpen && onOpen(primary)}
                    >
                      {primary.actionHint || 'Open it'}
                    </button>
                    {/* ⚠ "Not now" opens the durations rather than deferring on
                        a guess. A snooze whose length SARA picked is one Nick
                        has no reason to trust, and the length is most of what
                        the gesture means. */}
                    <button
                      type="button"
                      className="surface__btn"
                      disabled={busy}
                      onClick={() => setDeferring((v) => !v)}
                    >
                      Not now
                    </button>
                  </div>

                  {deferring && (
                    <div className="surface__acts surface__acts--defer">
                      {DEFERRALS.map((d) => (
                        <button
                          key={d.label}
                          type="button"
                          className="surface__btn surface__btn--small"
                          disabled={busy}
                          onClick={() => { act(primary, 'defer', { minutes: d.minutes, reason: d.reason }); setDeferring(false); }}
                        >
                          {d.label}
                        </button>
                      ))}
                      {/* Seen is NOT a snooze. It stops SARA asking again while
                          leaving the card exactly where it is — the one state
                          the old suppression timer could not express. */}
                      <button
                        type="button"
                        className="surface__btn surface__btn--small"
                        disabled={busy}
                        onClick={() => { act(primary, 'acknowledge'); setDeferring(false); }}
                      >
                        Seen it
                      </button>
                      {(primary.actions || []).includes('dismiss') && (
                        <button
                          type="button"
                          className="surface__btn surface__btn--small"
                          disabled={busy}
                          onClick={() => { act(primary, 'dismiss'); setDeferring(false); }}
                        >
                          Not mine
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            // ⚠ THREE genuinely different facts, and only the last is good news.
            <>
              {!poolAvailable ? (
                <>
                  <p className="surface__saylead">I can&rsquo;t see your work right now.</p>
                  <p className="surface__saysub">So don&rsquo;t read this as an all-clear.</p>
                </>
              ) : quiet ? (
                <>
                  <p className="surface__saylead">{context?.summary || 'Staying out of the way.'}</p>
                  <p className="surface__saysub">Nothing here needs you.</p>
                </>
              ) : (
                <>
                  <p className="surface__saylead">Nothing pressing.</p>
                  <p className="surface__saysub">Everything&rsquo;s where it should be.</p>
                </>
              )}
            </>
          ))}
        </div>

        {/* ── What she's showing ────────────────────────────────────────────
            Nick, 31 Aug 2026: SARA is "a series of dashboards", and the
            dashboard is an ANSWER, not a destination — it changed because the
            situation changed or because he asked, never because he went
            looking. Which one to show is composed server-side beside `say`,
            `speech` and `tab`, so three surfaces cannot disagree about which
            moment this is.

            ⚠ BELOW her words, always. The sentence is the product; this is what
            the sentence is about. */}
        {!hideSecondary && dashboard && <Dashboard dashboard={dashboard} />}

        {/* ── What he could say ─────────────────────────────────────────────
            ⚠ EVERY ONE OF THESE IS A SENTENCE HE COULD HAVE SAID OUT LOUD, and
            that is the whole design: the buttons exist for when he can't speak,
            so they must be the same words rather than a second vocabulary of UI
            verbs competing with the first. The intent travels with each one, so
            nothing here parses language.

            The escape hatch is always the last of them and is never dropped —
            an ambient surface that is sometimes wrong must always have a way
            round it. */}
        {speaks && (
          <div className="surface__says">
            {utterances.map((u, i) => (
              <button
                key={`${u.say}-${i}`}
                type="button"
                className={`surface__say-btn${u.intent && u.intent.kind === 'reveal' ? ' surface__say-btn--quiet' : ''}`}
                disabled={busy}
                onClick={() => onSay(u, primary)}
              >
                {u.say}
              </button>
            ))}
          </div>
        )}

        {!hideSecondary && secondary.length > 0 && (
          <ul className="surface__rest">
            {secondary.map((card) => (
              <li key={card.id}>
                <button type="button" className="surface__row" onClick={() => onOpen && onOpen(card)}>
                  <span className="surface__rowtitle">{card.title}</span>
                  {card.say && <span className="surface__rowsay">{card.say}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* ── What she has noticed ──────────────────────────────────────────
            Ambient observations: sat still a long time, no exercise for three
            days, a health trend against his own baseline, no food logged when
            he normally logs it.

            ⚠ BELOW the pool, never above it, and never in the primary slot.
            These are facts about right now, not things to decide about — a
            sitting-down prompt must never outrank a breaching escalation. They
            are here because he is already looking, and NOTHING here notifies.

            ⚠ A caveat is rendered whenever the observation carries one. Apple
            Health cannot separate exercise, illness, alcohol and a hard week,
            and dropping the caveat is how a reading becomes a diagnosis. */}
        {!hideSecondary && ambient?.observations?.length > 0 && (
          <ul className="surface__ambient">
            {ambient.observations.map((o, i) => (
              <li key={`${o.kind}-${i}`} className={`surface__amb surface__amb--${o.level || 'info'}`}>
                <span className="surface__ambtext">{o.text}</span>
                {o.detail && <span className="surface__ambdetail">{o.detail}</span>}
                {o.suggestion && <span className="surface__ambsuggest">{o.suggestion}</span>}
                {o.caveat && <span className="surface__ambcaveat">{o.caveat}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className="surface__foot">
          {footAside}
          {/* Held is not lost, and "couldn't look" is not "nothing there". */}
          {!hideSecondary && dropped.length > 0 && (
            <p className="surface__aside">{dropped.length} held — {dropped[0].why}.</p>
          )}
          {!hideSecondary && context?.cannotSee && (
            <p className="surface__aside surface__aside--her">{context.cannotSee}</p>
          )}
          {error && <p className="surface__aside surface__aside--warn">That last read failed — this is what I had.</p>}
          {footExtra}
        </div>
      </div>
    </div>
  );
}
