import React, { useState } from 'react';
import { apiFetch } from '../api';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
import './AttentionCard.css';

const { resolveNueroNavigation } = actionSurfaces;

/**
 * One canonical attention card, with the exact action semantics.
 *
 * Every surface that renders work — Now, Focus, Briefing — renders THIS, so the
 * five buttons cannot come to mean five different things in three places. The
 * wording, the destination and the permitted action set all come off the
 * record; nothing here reranks, rephrases or decides urgency.
 *
 * ── The semantics, each one a bug that has actually happened ────────────────
 *
 * **Open context** navigates, and calls NOTHING. This is the one that was
 * wrong: Briefing's "Do it" POSTed `/api/focus/action-done`, which logs an
 * outcome and dismisses the item — so opening a thing recorded it as finished
 * before any work had been done.
 *
 * **Start this** starts a focus session and leaves the record exactly where it
 * was. Picking something up is not finishing it. The record is told (`start`)
 * only so the friction read has the evidence; no state moves.
 *
 * **Done** is Nick saying so, and is the ONLY path that resolves. It closes the
 * underlying task where one can be found, and SAYS which of the two happened —
 * a tick held by the outcome-note rule must not read as a completion.
 *
 * **Not now** / **Waiting on someone** defer with the reason recorded, because
 * a thing put off three times because it needs context is a different problem
 * from one put off three times as not-now, and the friction read is built on
 * knowing which.
 *
 * **Not relevant** dismisses: it teaches suppression and touches no work.
 *
 * **Seen it** acknowledges: the card STAYS on screen and stops notifying, which
 * is the one distinction the old suppression timer could not express. It is on
 * the record's action set and the phone has always rendered it; the desktop
 * silently dropped it, so on a card that cannot be dismissed (an imminent
 * meeting, an escalation) there was no way to say "yes, I know" at all.
 *
 * Nothing here auto-completes, auto-defers, auto-dismisses, auto-starts or
 * sends anything on Nick's behalf. Every one of these is a click.
 */

const LABELS = {
  open: 'Open context',
  acknowledge: 'Seen it',
  start: 'Start this',
  complete: 'Done',
  dismiss: 'Not relevant',
};

// How long each deferral lasts. Both are ordinary working spans rather than
// "until you look again" — a deferral with no end is a dismissal in disguise.
const NOT_NOW_MINUTES = 120;
const WAITING_MINUTES = 24 * 60;

export default function AttentionCard({
  card,
  onNavigate,
  onAct,
  onStarted,
  compact = false,
  showEvidence = true,
}) {
  const [busy, setBusy] = useState(null);
  const [outcome, setOutcome] = useState(null);

  if (!card) return null;

  const actions = Array.isArray(card.actions) ? card.actions : [];
  // A card with no record has no canonical action set. Rather than guessing one
  // (which is how a Done button appears over a thing that cannot be completed),
  // it gets the two the legacy path can genuinely honour.
  const permitted = card.recordId ? actions : ['open', 'dismiss', 'defer'];

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    try {
      const result = await fn();
      if (result && result.ok === false) {
        setOutcome({ kind: 'error', text: result.why || 'That did not go through.' });
      } else if (result && result.text) {
        setOutcome({ kind: 'ok', text: result.text });
      } else {
        setOutcome(null);
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: e.message });
    }
    setBusy(null);
  };

  // Navigation only. No request, by design — see the header.
  const open = () => {
    const destination = resolveNueroNavigation({ type: card.type, meta: card.meta, id: card.id })
      || (card.tab ? { view: card.tab } : null);
    if (!destination) {
      setOutcome({ kind: 'error', text: 'Nothing to open for this one.' });
      return;
    }
    onNavigate?.(destination.view, { fromAttention: true, attentionCard: card, ...(destination.context || {}) });
  };

  const start = () => run('start', async () => {
    const res = await apiFetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: card.title, source: 'attention' }),
    });
    const json = await res.json().catch(() => ({}));
    // 409 is "you're already on something" — a question, not a failure. Nothing
    // is switched without Nick saying so.
    if (res.status === 409 && json.session) {
      const ok = window.confirm(
        `You're ${json.session.elapsedMinutes} minutes into "${json.session.text}".\n\nPark it and start this instead?`
      );
      if (!ok) return { ok: true, text: null };
      const forced = await apiFetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: card.title, source: 'attention', force: true }),
      });
      if (!forced.ok) return { ok: false, why: 'Could not start that session.' };
    } else if (!res.ok) {
      return { ok: false, why: json.error || 'Could not start that session.' };
    }
    // Told, not moved: the record stays where it was.
    if (card.recordId) await onAct?.(card, 'start');
    onStarted?.(card);
    return { ok: true, text: 'Session started. The record is untouched.' };
  });

  const done = () => run('complete', async () => {
    const result = await onAct?.(card, 'complete');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    // Both outcomes are stated. "Done" that quietly left a task open, or quietly
    // closed one Nick did not mean, are both worse than a sentence.
    const text = result.taskCompleted === true
      ? `Done. ${result.taskWhy || 'Task closed too.'}`
      : `Done — card cleared. ${result.taskWhy || 'No task was closed.'}`;
    return { ok: true, text };
  });

  const defer = (reason, minutes, label) => run(reason, async () => {
    const result = await onAct?.(card, 'defer', { reason, minutes });
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    return { ok: true, text: `${label}${result.canonical === false ? ' (legacy snooze — no record for this card)' : ''}` };
  });

  const acknowledge = () => run('acknowledge', async () => {
    const result = await onAct?.(card, 'acknowledge');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    // Said out loud, because the card deliberately does not disappear and a
    // button that looks like it did nothing is a button nobody presses twice.
    return { ok: true, text: 'Noted. It stays here, but it will not interrupt again.' };
  });

  const dismiss = () => run('dismiss', async () => {
    const result = await onAct?.(card, 'dismiss');
    if (!result || result.ok === false) return result || { ok: false, why: 'Nothing handled that.' };
    return { ok: true, text: 'Marked not relevant. The work itself is untouched.' };
  });

  return (
    <article className={`att-card att-card--${card.urgency || 'none'}${compact ? ' att-card--compact' : ''}`}>
      <header className="att-card__head">
        <span className="att-card__type">{String(card.type || 'item').replace(/_/g, ' ')}</span>
        {card.state && card.state !== 'active' && (
          /* The lifecycle state is rendered, never re-derived. An acknowledged
             card STAYS visible — that is the whole distinction the old
             suppression timer could not express. */
          <span className={`att-card__state att-card__state--${card.state}`}>{card.state}</span>
        )}
        {!card.recordId && (
          <span className="att-card__state att-card__state--nolifecycle" title="No canonical attention record — actions fall back to the legacy suppression timer">
            no record
          </span>
        )}
      </header>

      <h3 className="att-card__title">{card.title}</h3>
      {/* `say` is SARA's sentence, composed server-side. `reason` is the raw
          field dump behind it and is the fallback, never the preference. */}
      <p className="att-card__say">{card.say || card.reason}</p>

      {showEvidence && Array.isArray(card.evidence) && card.evidence.length > 0 && (
        <ul className="att-card__evidence">
          {card.evidence.slice(0, 3).map((e, i) => (
            <li key={i}>
              <span className="att-card__evsrc">{e.source}</span>
              <span className="att-card__evref">{e.ref}</span>
              {e.detail && <span className="att-card__evdetail">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {outcome && (
        <p className={`att-card__outcome att-card__outcome--${outcome.kind}`}>{outcome.text}</p>
      )}

      {/*
        Already being worked on. The server drops `start` from the permitted set
        when a session is running on this very card, so the button cannot be
        offered — but a card that merely loses a button says nothing, and the
        thing Nick needs to know is that he is ALREADY on it.

        ⚠ Says how long and what it was cut down to, because after a shrink the
        card's title and the thing actually being done are different, and the
        step is the half that lets him pick the thread back up.
      */}
      {card.session && (
        <p className="att-card__session">
          In progress — {card.session.elapsedMinutes} min
          {card.session.nextStep ? <> · on “{card.session.nextStep}”</> : null}
          {card.session.status !== 'active' ? ` · ${card.session.status}` : ''}
        </p>
      )}

      <div className="att-card__actions">
        {permitted.includes('open') && (
          <button className="att-card__btn" type="button" onClick={open}>{LABELS.open}</button>
        )}
        {permitted.includes('acknowledge') && card.state !== 'acknowledged' && (
          <button className="att-card__btn" type="button" disabled={busy === 'acknowledge'} onClick={acknowledge}>
            {busy === 'acknowledge' ? '…' : LABELS.acknowledge}
          </button>
        )}
        {permitted.includes('start') && (
          <button className="att-card__btn att-card__btn--do" type="button" disabled={busy === 'start'} onClick={start}>
            {busy === 'start' ? '…' : LABELS.start}
          </button>
        )}
        {permitted.includes('complete') && (
          <button className="att-card__btn att-card__btn--do" type="button" disabled={busy === 'complete'} onClick={done}>
            {busy === 'complete' ? '…' : LABELS.complete}
          </button>
        )}
        {permitted.includes('defer') && (
          <>
            <button className="att-card__btn" type="button" disabled={busy === 'not-now'} onClick={() => defer('not-now', NOT_NOW_MINUTES, 'Put off for now.')}>
              Not now
            </button>
            <button className="att-card__btn" type="button" disabled={busy === 'waiting-on-someone'} onClick={() => defer('waiting-on-someone', WAITING_MINUTES, 'Noted as waiting on someone else.')}>
              Waiting on someone
            </button>
          </>
        )}
        {permitted.includes('dismiss') && (
          <button className="att-card__btn att-card__btn--quiet" type="button" disabled={busy === 'dismiss'} onClick={dismiss}>
            {LABELS.dismiss}
          </button>
        )}
      </div>
    </article>
  );
}
