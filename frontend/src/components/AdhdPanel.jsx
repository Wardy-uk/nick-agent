import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './AdhdPanel.css';

// apiFetch hands back a raw Response and sets no Content-Type, so every JSON
// call needs this wrapper. Throwing on non-2xx keeps a failed load from
// rendering as a page full of zeroes, which would read as "you did nothing".
async function api(path, options = {}) {
  const res = await apiFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// The "help me actually function today" view.
//
// The layout is the argument. One thing at the top, big, with a button. Evidence
// of progress immediately under it — ADHD memory drops finished work, so the day
// feels empty even when it wasn't. Avoidance is stated as fact and kept small.
// Quick wins sit at the bottom as the way back in when the top thing is too big.
//
// All the judgement is in services/adhd-dashboard.js. This file only renders.

export default function AdhdPanel({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState({});
  const [win, setWin] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api('/api/adhd');
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function completeQuickWin(item, index) {
    if (busy[index]) return;
    setBusy((b) => ({ ...b, [index]: true }));
    try {
      if (item.task_id) {
        await api(`/api/tasks/${item.task_id}/complete`, { method: 'POST' });
      } else if (item.ms_id) {
        await api('/api/todos/complete-ms', {
          method: 'POST',
          body: JSON.stringify({ msId: item.ms_id, source: item.source, filePath: item.filePath, lineNumber: item.lineNumber }),
        });
      } else if (item.filePath && item.lineNumber != null) {
        await api('/api/todos/toggle', {
          method: 'POST',
          body: JSON.stringify({ filePath: item.filePath, lineNumber: item.lineNumber }),
        });
      }
      load();
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
      setBusy((b) => ({ ...b, [index]: false }));
    }
  }

  async function logWin(e) {
    e.preventDefault();
    const text = win.trim();
    if (!text) return;
    try {
      await api('/api/adhd/win', { method: 'POST', body: JSON.stringify({ text }) });
      setWin('');
      load();
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    }
  }

  const { loading, error, data } = state;

  if (loading) return <div className="adhd"><div className="adhd__card">Working out where you are…</div></div>;
  if (error) return <div className="adhd"><div className="adhd__card adhd__card--err">{error}</div></div>;
  if (!data) return null;

  const { shape, rightNow, momentum, winsToday, avoidance, quickWins } = data;

  return (
    <div className="adhd">
      <div className="adhd__shape">
        <span className={`adhd__mode adhd__mode--${shape.mode}`}>{shape.mode}</span>
        <span className="adhd__shape-line">{shape.line}</span>
        <button className="adhd__refresh" type="button" onClick={load} title="Refresh">↻</button>
      </div>

      {/* ── The one thing ── */}
      <section className={`adhd__now adhd__now--${rightNow.item?.urgency || 'none'}`}>
        <div className="adhd__now-label">Right now</div>
        {rightNow.item ? (
          <>
            <h2 className="adhd__now-title">{rightNow.item.title}</h2>
            {rightNow.item.reason && <p className="adhd__now-reason">{rightNow.item.reason}</p>}
            <div className="adhd__now-actions">
              {rightNow.action && (
                <button
                  className="adhd__do"
                  type="button"
                  onClick={() => onNavigate?.(rightNow.action.target, rightNow.action.targetContext)}
                >{rightNow.action.label || 'Do it'}</button>
              )}
              <button className="adhd__later" type="button" onClick={() => onNavigate?.('focus')}>
                Something else
              </button>
            </div>
            {rightNow.waiting > 0 && (
              // Named, not listed. Knowing the rest is tracked is reassuring;
              // seeing it is the overwhelm this page exists to avoid.
              <p className="adhd__waiting">{rightNow.waiting} other thing{rightNow.waiting === 1 ? '' : 's'} tracked. They can wait.</p>
            )}
          </>
        ) : (
          <h2 className="adhd__now-title adhd__now-title--clear">Nothing pressing. You're clear.</h2>
        )}
      </section>

      <div className="adhd__grid">
        {/* ── Momentum ── */}
        <section className="adhd__card">
          <h3 className="adhd__h">Momentum</h3>
          <div className="adhd__momentum">
            <div className="adhd__big">{momentum.doneToday}</div>
            <div className="adhd__big-label">
              finished today
              {momentum.streakDays > 0 && <span className="adhd__streak">{momentum.streakDays}-day streak</span>}
            </div>
          </div>

          <div className="adhd__spark" role="img" aria-label={`Last 7 days: ${momentum.last7.map(d => d.done).join(', ')} finished`}>
            {momentum.last7.map((d) => (
              <div className="adhd__spark-col" key={d.date} title={`${d.date}: ${d.done}`}>
                <div
                  className={`adhd__spark-bar${d.date === data.dateKey ? ' adhd__spark-bar--today' : ''}`}
                  style={{ height: `${momentum.best7 ? Math.max(6, (d.done / momentum.best7) * 100) : 6}%` }}
                />
                <span className="adhd__spark-day">{new Date(d.date).toLocaleDateString('en-GB', { weekday: 'narrow' })}</span>
              </div>
            ))}
          </div>

          <div className="adhd__rituals">
            <span className={momentum.rituals.standup ? 'adhd__ritual adhd__ritual--on' : 'adhd__ritual'}>
              {momentum.rituals.standup ? '✓' : '○'} Standup
            </span>
            <span className={momentum.rituals.eod ? 'adhd__ritual adhd__ritual--on' : 'adhd__ritual'}>
              {momentum.rituals.eod ? '✓' : '○'} EOD
            </span>
          </div>
        </section>

        {/* ── Avoidance radar ── */}
        <section className="adhd__card">
          <h3 className="adhd__h">What you're pushing away</h3>
          {avoidance.signals.length === 0 ? (
            <p className="adhd__empty">Nothing's been sitting. Good week.</p>
          ) : (
            <ul className="adhd__avoid">
              {avoidance.signals.map((s, i) => (
                <li className="adhd__avoid-item" key={i}>
                  <span className="adhd__avoid-label">{s.label}</span>
                  <span className="adhd__avoid-detail">{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="adhd__note">Stated so you can decide, not so you feel bad. Dropping one is a valid answer.</p>
        </section>
      </div>

      {/* ── Quick wins ── */}
      <section className="adhd__card">
        <h3 className="adhd__h">If the big thing is too big</h3>
        {quickWins.length === 0 ? (
          <p className="adhd__empty">No small ones going spare — everything on the list needs a proper run at it.</p>
        ) : (
          <ul className="adhd__quick">
            {quickWins.map((q, i) => (
              <li className="adhd__quick-item" key={i}>
                <button
                  className="adhd__tick"
                  type="button"
                  onClick={() => completeQuickWin(q, i)}
                  disabled={busy[i]}
                  aria-label={`Complete: ${q.text}`}
                >{busy[i] ? '…' : ''}</button>
                <span className="adhd__quick-text">{q.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Wins today ── */}
      <section className="adhd__card">
        <h3 className="adhd__h">Done today</h3>
        {winsToday.length === 0 ? (
          <p className="adhd__empty">Nothing logged yet. The day isn't over.</p>
        ) : (
          <ul className="adhd__wins">
            {winsToday.map((w, i) => (
              <li className="adhd__win" key={i}>
                <span className="adhd__win-time">{w.time}</span>
                <span className="adhd__win-text">{w.text}</span>
              </li>
            ))}
          </ul>
        )}
        <form className="adhd__logwin" onSubmit={logWin}>
          <input
            className="adhd__logwin-input"
            value={win}
            onChange={(e) => setWin(e.target.value)}
            placeholder="Did something that isn't on a list? Log it."
            aria-label="Log a win"
          />
          <button className="adhd__logwin-btn" type="submit" disabled={!win.trim()}>Log</button>
        </form>
      </section>
    </div>
  );
}
