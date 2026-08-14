import { useState } from 'react';
import { apiFetch } from '../api';
import dueDates from '../../../../shared/due-dates.cjs';
import './DueControl.css';

const { duePresets, describeDue } = dueDates;

// Give a task a date without opening a calendar.
//
// Only NEURO-owned tasks (task_id) can be dated — the task store is the only
// writer with a due_date field. Microsoft-owned tasks are dated in Microsoft,
// and a vault checkbox has nowhere to put one. So the control renders only when
// it can actually act: a button that silently does nothing is worse than no
// button, because you stop trusting the ones that do work.
export default function DueControl({ task, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!task?.task_id) return null;

  const current = describeDue(task.due_date);

  async function setDue(date) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/tasks/${task.task_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ due_date: date }),
      });
      setOpen(false);
      onChanged?.(date);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="due">
      <button
        type="button"
        className={`due__btn${current?.overdue ? ' due__btn--over' : ''}${current?.due ? ' due__btn--today' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={current ? `Due ${current.label}. Change date.` : 'Set a due date'}
      >
        {current ? current.label : '+ date'}
      </button>

      {open && (
        <span className="due__menu" role="menu">
          {duePresets().map(p => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className="due__opt"
              disabled={busy}
              onClick={() => setDue(p.date)}
            >{p.label}</button>
          ))}
          {task.due_date && (
            <button
              type="button"
              role="menuitem"
              className="due__opt due__opt--clear"
              disabled={busy}
              onClick={() => setDue(null)}
            >Clear</button>
          )}
          {error && <span className="due__err">{error}</span>}
        </span>
      )}
    </span>
  );
}
