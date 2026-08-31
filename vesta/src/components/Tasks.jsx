import { useState } from 'react';
import Section from './Section.jsx';

const STATE_CLASS = {
  'done': 'task--done',
  'not doing': 'task--dropped',
  'in progress': 'task--doing',
  'to do': 'task--todo',
};

/**
 * The household list — what has been asked for, who it is for, and what became
 * of it.
 *
 * The four states come from the server already collapsed into words a non-user
 * of NEURO understands. ⚠ "not doing" is shown plainly rather than hidden or
 * dressed up as done: somebody asked for something and deserves to know it was
 * declined.
 *
 * ⚠ The composer renders even when the list is empty. `Section` used to swap its
 * children out for the empty message, which hid this form on exactly the screen
 * that had nothing on it yet — so the app was unusable from a standing start.
 */
export default function Tasks({ tasks, gap, people = [], onAdd }) {
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      // '' means unassigned — the absence of a choice, which the server stores
      // as null rather than attributing it to whoever typed it.
      await onAdd(clean, assignee || null);
      // Cleared only AFTER it landed. If the add failed, the words in the box
      // are the only copy of the thought.
      setText('');
      setAssignee('');
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
              {/* Unassigned says so, rather than showing nothing — a blank is
                  indistinguishable from a field that failed to render. */}
              <span className={`task__who${t.assignee ? '' : ' task__who--none'}`}>
                {t.assigneeLabel || 'anyone'}
              </span>
              <span className="task__status">{t.status}</span>
              {t.dueDate && <span className="task__due">by {t.dueDate}</span>}
            </span>
            {/* Only shown on a shared list, where it can actually differ. */}
            {t.from && <span className="task__from">added by {t.from}</span>}
          </li>
        ))}
      </ul>

      <form className="composer composer--stacked" onSubmit={submit}>
        <input
          className="composer__input"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Add something…"
          enterKeyHint="done"
        />
        <div className="composer__row">
          <select
            className="composer__who"
            value={assignee}
            onChange={e => setAssignee(e.target.value)}
          >
            {/* First and default: most things put on a household list are not
                yet anybody's, and forcing a choice invents one. */}
            <option value="">For anyone</option>
            {people.map(p => (
              <option key={p.id} value={p.id}>For {p.label}</option>
            ))}
          </select>
          <button className="btn" disabled={busy || !text.trim()}>
            {busy ? '…' : 'Add'}
          </button>
        </div>
      </form>
      {error && <p className="composer__error" role="alert">{error}</p>}
    </Section>
  );
}
