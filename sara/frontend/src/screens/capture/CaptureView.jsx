import { useState } from 'react';
import { useSaraState } from '../../state/saraState';

export default function CaptureView() {
  const { status, error, model, presentation, captureNote, captureTodo } = useSaraState();
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState(null);

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  return (
    <section className="product" aria-label="Capture">
      <header className="product__hero">
        <p className="product__eyebrow">Capture</p>
        <h2 className="product__title">Catch it before it disappears</h2>
        <p className="product__summary">Captures are forwarded to NEURO, which owns them. Nothing is stored in SARA — if NEURO does not take it, SARA says so and leaves your words in the box.</p>
        <div className="product__meta">
          <span className="product__pill">{presentation.capture.source}</span>
          {feedback && (
            <span className={`product__pill${feedback.ok ? '' : ' product__pill--danger'}`}>{feedback.text}</span>
          )}
        </div>
      </header>

      <div className="product__grid">
        <section className="product__section product__section--span-7">
          <p className="product__section-title">Quick capture</p>
          <textarea
            className="product__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Drop a note, follow-up, or task here…"
          />
          <div className="product__actions">
            <button
              type="button"
              className="product__button"
              onClick={async () => {
                const result = await captureNote(draft);
                setFeedback(
                  result.saved
                    ? { ok: true, text: 'Saved to NEURO' }
                    : { ok: false, text: `NOT saved — ${result.error}` }
                );
                // ⚠ The box is cleared ONLY on an acknowledged save. Clearing it on a
                // failure destroys the one copy of the thought that still exists,
                // which is the whole thing capture is for.
                if (result.saved) setDraft('');
              }}
            >
              Save to inbox
            </button>
            <button
              type="button"
              className="product__button"
              onClick={async () => {
                const result = await captureTodo(draft);
                setFeedback(
                  result.saved
                    ? { ok: true, text: 'Task created in NEURO' }
                    : { ok: false, text: `NOT saved — ${result.error}` }
                );
                if (result.saved) setDraft('');
              }}
            >
              Turn into todo
            </button>
          </div>
        </section>
        <section className="product__section product__section--span-5">
          <p className="product__section-title">Capture shortcuts</p>
          <ul className="product__list">
            {presentation.capture.shortcuts.map((item) => (
              <li key={item.id} className="product__card">
                <p className="product__card-title">{item.label}</p>
                <p className="product__card-detail">{item.detail}</p>
              </li>
            ))}
          </ul>
          {presentation.capture.recent?.length > 0 && (
            <>
              <p className="product__section-title">Recent captures</p>
              <ul className="product__list">
                {presentation.capture.recent.map((item) => (
                  <li key={item.id} className="product__card">
                    <p className="product__card-title">{item.title}</p>
                    <p className="product__card-detail">{item.detail}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
