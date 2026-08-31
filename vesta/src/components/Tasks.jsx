import { useState } from 'react';
import Section from './Section.jsx';

const STATE_CLASS = {
  'done': 'task--done',
  'not doing': 'task--dropped',
  'in progress': 'task--doing',
  'to do': 'task--todo',
};

/**
 * What she has asked for, and what became of it.
 *
 * The four states come from the server already collapsed into words a
 * non-user of NEURO understands. ⚠ "not doing" is shown plainly rather than
 * hidden or dressed up as done: she asked for something and deserves to know it
 * was declined.
 */
export default function Tasks({ tasks, gap, onAdd }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(clean);
      // Cleared only AFTER it landed. If the add failed, the words in the box
      // are the only copy of the thought.
      setText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Tasks"
      gap={gap}
      empty={tasks && tasks.length === 0 ? 'Nothing on the list.' : null}
    >
      <ul className="tasks">
        {(tasks || []).map((t, i) => (
          <li key={`${t.text}-${i}`} className={`task ${STATE_CLASS[t.status] || ''}`}>
            <span className="task__text">{t.text}</span>
            <span className="task__meta">
              <span className="task__status">{t.status}</span>
              {t.dueDate && <span className="task__due">by {t.dueDate}</span>}
            </span>
          </li>
        ))}
      </ul>

      <form className="composer" onSubmit={submit}>
        <input
          className="composer__input"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Add something…"
          enterKeyHint="done"
        />
        <button className="btn" disabled={busy || !text.trim()}>
          {busy ? '…' : 'Add'}
        </button>
      </form>
      {error && <p className="composer__error" role="alert">{error}</p>}
    </Section>
  );
}
