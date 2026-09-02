import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './FrictionSection.css';

/**
 * "Friction noticed" — what has actually got in the way, with its evidence.
 *
 * All the judgement is in `backend/services/friction.js`; this file only
 * renders. That is deliberate: the rules about what may and may not be said are
 * the product here, and a second copy of them in React is a second opinion
 * about someone's week.
 *
 * Three things this component must never do, and each is enforced by what the
 * server sends rather than by discipline here:
 *   * invent a line when there is no evidence — an empty list renders as
 *     nothing at all, not as a reassurance;
 *   * present "I could not look" as "nothing in your way" — `gaps` are named;
 *   * grow into a dashboard. It is one small section under the thing Nick is
 *     trying to start, because a page about how hard the week has been is a
 *     page that gets opened once.
 */
export default function FrictionSection({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/friction');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${res.status}`);
      setState({ loading: false, error: null, data: json });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * "Noted" — the one action this section has, and the one it was missing.
   *
   * Every card in NEURO that Nick cannot answer in some way is a card that
   * repeats at him until he stops reading the surface it is on. This does NOT
   * touch the work and does NOT un-record the evidence: it says he has taken
   * the line on board, and the server holds it only while the evidence is
   * unchanged — a third shrink on the same task raises it again.
   */
  const note = useCallback(async (ins) => {
    if (!ins?.id || busy) return;
    setBusy(ins.id);
    setFailed(null);
    try {
      const res = await apiFetch('/api/friction/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ins.id, signature: ins.signature }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
      await load();
    } catch (e) {
      // Said out loud. A button that silently did nothing is worse than none.
      setFailed(e.message);
    }
    setBusy(null);
  }, [busy, load]);

  const { loading, error, data } = state;
  if (loading) return null;

  // A failed read says so. It is not "nothing has got in your way".
  if (error) {
    return (
      <section className="friction">
        <h3 className="friction__h">Friction noticed</h3>
        <p className="friction__gap">Couldn&rsquo;t read this &mdash; {error}. That is not the same as nothing being in your way.</p>
      </section>
    );
  }

  const insights = data?.insights || [];
  const gaps = data?.gaps || [];

  // Nothing recorded and nothing unreadable: render nothing. The whole surface
  // is about lowering the barrier to starting, and an empty card headed
  // "Friction" is a paragraph about difficulty in front of someone about to work.
  if (insights.length === 0 && gaps.length === 0) return null;

  return (
    <section className="friction">
      <h3 className="friction__h">Friction noticed</h3>

      {insights.length === 0 ? (
        <p className="friction__gap">Nothing recorded to go on yet.</p>
      ) : (
        <ul className="friction__list">
          {insights.map((ins, i) => (
            <li className="friction__item" key={i}>
              <p className="friction__text">{ins.text}</p>
              {/* Why this is being said. Every line here rests on something Nick
                  did and NEURO wrote down, and showing the working is what keeps
                  it a statement of fact rather than a judgement about him. */}
              <p className="friction__because">Based on {ins.because}.</p>
              <span className="friction__acts">
                {/* ⚠ "Noted" answers the CARD; this answers the WORK. They are
                    different acts and a section that only offered the first one
                    could tell Nick a task had been put off four times and leave
                    him to go and find it. `subject` is null wherever the insight
                    is not about one nameable task, and then there is no button —
                    never a link that guesses which task was meant. */}
                {ins.subject && onNavigate && (
                  <button
                    className="friction__note-btn"
                    type="button"
                    onClick={() => onNavigate('todos', { taskText: ins.subject })}
                  >Open it</button>
                )}
                {ins.id && (
                  <button
                    className="friction__note-btn"
                    type="button"
                    disabled={busy === ins.id}
                    onClick={() => note(ins)}
                  >
                    {busy === ins.id ? '…' : 'Noted'}
                  </button>
                )}
              </span>
              {Array.isArray(ins.evidence) && ins.evidence.length > 0 && (
                <ul className="friction__ev">
                  {ins.evidence.slice(0, 3).map((e, j) => (
                    <li key={j}>
                      <span className="friction__evsrc">{e.source}</span>
                      {e.detail}
                      {e.observedAt && <span className="friction__evat">{String(e.observedAt).slice(0, 10)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {failed && <p className="friction__gap">Couldn&rsquo;t note that &mdash; {failed}.</p>}

      {/* Held back, not gone. A section that quietly shrank would look like one
          that had stopped working. */}
      {data?.noted > 0 && (
        <p className="friction__noted">
          {data.noted} noted already &mdash; back if the evidence grows.
        </p>
      )}

      {gaps.length > 0 && (
        <p className="friction__gap">
          Couldn&rsquo;t read: {gaps.map((g) => `${g.source} (${g.why})`).join('; ')}.
        </p>
      )}

      <p className="friction__note">
        Recorded from things you did &mdash; deferrals with a reason, asking for something smaller,
        saying you were pulled away. Nothing here is inferred from silence.
      </p>
    </section>
  );
}
