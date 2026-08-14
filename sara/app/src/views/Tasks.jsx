import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { completeTask } from '../completeTask';
import './Tasks.css';

// Tasks = the list you can actually work from on the phone.
//
// Capture was one-way before this existed: four routes fired tasks INTO the
// system and the only way to tick one off on mobile was to happen to arrive via
// a notification. A capture tool you can't close the loop on stops being trusted.
//
// Scored and ordered by the brain (/api/todos/focus) — same ranking as Focus, so
// the top of this list is the same top the rest of NEURO agrees on.
const FILTERS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'all', label: 'All' },
];

export default function Tasks() {
  const [filter, setFilter] = useState('overdue');
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState({});
  const [done, setDone] = useState({});
  const [adding, setAdding] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch(`/api/todos/focus?filter=${filter}&limit=30`);
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function tick(item) {
    if (busy[item.id]) return;
    setBusy((b) => ({ ...b, [item.id]: true }));
    try {
      await completeTask(item);
      // Strike it through rather than yanking it out — on a phone, a row that
      // vanishes under your thumb reads as "did that work?".
      setDone((d) => ({ ...d, [item.id]: true }));
      setTimeout(() => {
        setState((s) => (s.data
          ? { ...s, data: { ...s.data, items: s.data.items.filter((i) => i.id !== item.id) } }
          : s));
      }, 900);
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }

  async function add(e) {
    e.preventDefault();
    const text = adding.trim();
    if (!text || addBusy) return;
    setAddBusy(true);
    try {
      await apiFetch('/api/capture/todo', {
        method: 'POST',
        body: JSON.stringify({ text, source: 'sara-tasks' }),
      });
      setAdding('');
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setAddBusy(false);
    }
  }

  const { loading, error, data } = state;
  const items = data?.items || [];

  return (
    <section>
      <div className="tasks__head">
        <div>
          <h1 className="view__title">Tasks</h1>
          <p className="view__lede">What's outstanding. Tick it off here.</p>
        </div>
        <button className="tasks__refresh" type="button" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      <div className="tasks__filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`tasks__filter${filter === f.id ? ' tasks__filter--on' : ''}`}
            onClick={() => setFilter(f.id)}
          >{f.label}</button>
        ))}
      </div>

      <form className="tasks__add" onSubmit={add}>
        <input
          className="tasks__add-input"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add a task…"
          aria-label="Add a task"
        />
        <button className="tasks__add-btn" type="submit" disabled={addBusy || !adding.trim()}>
          {addBusy ? '…' : '+'}
        </button>
      </form>

      {loading && <div className="card">Asking the brain…</div>}

      {error && (
        <div className="card err">
          {error}
          <div className="tasks__hint">Check you're on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </div>
      )}

      {data && items.length === 0 && (
        <div className="card tasks__clear">
          {filter === 'overdue' ? 'Nothing overdue. 🎉' : filter === 'today' ? 'Nothing due today.' : 'No open tasks.'}
        </div>
      )}

      {items.map((item) => (
        <div className={`card tasks__item${done[item.id] ? ' tasks__item--done' : ''}`} key={item.id}>
          <button
            className="tasks__tick"
            type="button"
            onClick={() => tick(item)}
            disabled={busy[item.id] || done[item.id]}
            aria-label={`Complete: ${item.text}`}
          >{done[item.id] ? '✓' : busy[item.id] ? '…' : ''}</button>
          <div className="tasks__body">
            <div className="tasks__text">{item.text}</div>
            <div className="tasks__meta">
              {item.moscow && <span className={`tasks__moscow tasks__moscow--${item.moscow}`}>{item.moscow}</span>}
              {item.due_date && (
                <span className={`tasks__due${item.due_date.split('T')[0] < new Date().toISOString().split('T')[0] ? ' tasks__due--over' : ''}`}>
                  {item.due_date.split('T')[0]}
                </span>
              )}
              {item.source && <span className="tasks__source">{item.source}</span>}
            </div>
          </div>
        </div>
      ))}

      {data && data.hidden > 0 && (
        <div className="tasks__hidden">{data.hidden} more not shown — the brain ranked these first.</div>
      )}
    </section>
  );
}
