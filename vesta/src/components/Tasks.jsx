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
export default function Tasks({ tasks, gap, people = [], onAdd, onUpdate }) {
  const [text, setText] = useState('');
  const [assignees, setAssignees] = useState([]);
  const [due, setDue] = useState('');
  const [editing, setEditing] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);
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
      await onAdd(clean, assignees, due || null);
      // Cleared only AFTER it landed. If the add failed, the words in the box
      // are the only copy of the thought.
      setText('');
      setAssignees([]);
      setDue('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id, fields) {
    setRowBusy(id);
    setError(null);
    try {
      await onUpdate(id, fields);
      // Deliberately NOT closing the editor: assigning is often two taps (both
      // of us), and snapping shut after the first makes the second a hunt.
      if (!('assignees' in fields)) setEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setRowBusy(null);
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
              <span className={`task__who${(t.assigneeLabels || []).length ? '' : ' task__who--none'}`}>
                {(t.assigneeLabels || []).join(' & ') || 'anyone'}
              </span>
              <span className="task__status">{t.status}</span>
              {t.dueDate && <span className="task__due">by {t.dueDate}</span>}
            </span>
            {/* Only shown on a shared list, where it can actually differ. */}
            {t.from && <span className="task__from">added by {t.from}</span>}

            {editing === t.id ? (
              <div className="task__edit">
                <input
                  type="date"
                  className="task__date"
                  defaultValue={t.dueDate || ''}
                  disabled={rowBusy === t.id}
                  onChange={e => patch(t.id, { dueDate: e.target.value || null })}
                />
                <div className="who who--row">
                  {people.map(p => {
                    const on = (t.assignees || []).includes(p.id);
                    return (
                      <button
                        type="button"
                        key={p.id}
                        className={`who__chip${on ? ' who__chip--on' : ''}`}
                        disabled={rowBusy === t.id}
                        // Sent as the WHOLE new list, never as an add/remove —
                        // the server stores a set, and two taps in flight against
                        // a delta would race into the wrong answer.
                        onClick={() => patch(t.id, {
                          assignees: on
                            ? (t.assignees || []).filter(x => x !== p.id)
                            : [...(t.assignees || []), p.id],
                        })}
                      >{p.label}</button>
                    );
                  })}
                </div>
                {/* Clearing a date is a real instruction, distinct from leaving
                    it alone — so it gets its own control rather than hoping an
                    emptied date input fires. */}
                {t.dueDate && (
                  <button className="btn btn--quiet" disabled={rowBusy === t.id}
                          onClick={() => patch(t.id, { dueDate: null })}>No date</button>
                )}
                <button className="btn btn--quiet" onClick={() => setEditing(null)}>Close</button>
              </div>
            ) : (
              t.id && (
                <button className="task__editbtn" onClick={() => setEditing(t.id)}>
                  {t.dueDate ? 'Change' : 'Add a date'}
                </button>
              )
            )}
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
          <input
            type="date"
            className="composer__date"
            value={due}
            onChange={e => setDue(e.target.value)}
            aria-label="Due date"
          />
          <button className="btn" disabled={busy || !text.trim()}>
            {busy ? '…' : 'Add'}
          </button>
        </div>
        {/* Chips rather than a dropdown, because it is a MULTI-choice now and a
            multi-select on a phone is a fight. Nobody selected is the default:
            most things on a household list are not yet anybody's, and forcing a
            choice invents one. */}
        <div className="who">
          <span className="who__label">
            {assignees.length ? 'For' : 'For anyone'}
          </span>
          {people.map(p => (
            <button
              type="button"
              key={p.id}
              className={`who__chip${assignees.includes(p.id) ? ' who__chip--on' : ''}`}
              onClick={() => setAssignees(a =>
                a.includes(p.id) ? a.filter(x => x !== p.id) : [...a, p.id])}
            >{p.label}</button>
          ))}
        </div>
      </form>
      {error && <p className="composer__error" role="alert">{error}</p>}
    </Section>
  );
}
