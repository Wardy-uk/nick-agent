import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { completeTask } from '../completeTask';
import './Today.css';

// The phone cut of the ADHD dashboard. Same /api/adhd payload as desktop, but
// ruthless about what earns a place on a small screen at a bad moment:
//
//   in  — the one thing, momentum, quick wins, one avoidance line
//   out — the 7-day trend, the full wins list, the log-a-win box
//
// Those all reward sitting and reading. This surface catches you mid-drift, so
// everything on it is either "what do I do" or "you have already done things".
export default function Today({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState({});
  const [headline, setHeadline] = useState(null);
  const [showWins, setShowWins] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/adhd');
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function tick(item, index) {
    if (busy[index]) return;
    setBusy((b) => ({ ...b, [index]: true }));
    try {
      // The running total, stated the moment the task closes. Null on an empty
      // day or an unreachable ledger — never a fabricated number.
      const line = await completeTask(item);
      if (line) setHeadline(line);
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
      setBusy((b) => ({ ...b, [index]: false }));
    }
  }

  const { loading, error, data } = state;

  if (loading) return <section><div className="card">Working out where you are…</div></section>;
  if (error) {
    return (
      <section>
        <div className="card err">
          {error}
          <div className="today__hint">Check you're on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </div>
      </section>
    );
  }
  if (!data) return null;

  const { shape, rightNow, momentum, winsToday, avoidance, quickWins } = data;
  const topAvoidance = avoidance.signals[0] || null;

  return (
    <section className="today">
      {/* What the day comes to, the moment a task closes. Statement of fact,
          not a celebration — and nothing at all on an empty day. */}
      {headline && <div className="card today__headline">{headline}</div>}
      <div className="today__head">
        <p className="today__shape">{shape.line}</p>
        <button className="today__refresh" type="button" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      {/* ── The one thing ── */}
      <div className={`card today__now today__now--${rightNow.item?.urgency || 'none'}`}>
        <div className="today__now-label">Right now</div>
        {rightNow.item ? (
          <>
            <div className="today__now-title">{rightNow.item.title}</div>
            {rightNow.item.reason && <div className="today__now-reason">{rightNow.item.reason}</div>}
            <div className="today__now-actions">
              <button className="today__do" type="button" onClick={() => onNavigate?.('focus')}>
                {rightNow.action?.label || 'Open it'}
              </button>
              <button className="today__later" type="button" onClick={() => onNavigate?.('tasks')}>
                Something else
              </button>
            </div>
            {rightNow.waiting > 0 && (
              <div className="today__waiting">{rightNow.waiting} other thing{rightNow.waiting === 1 ? '' : 's'} tracked. They can wait.</div>
            )}
          </>
        ) : (
          <div className="today__now-title today__now-title--clear">Nothing pressing. You're clear.</div>
        )}
      </div>

      {/* ── Momentum: tappable, because the wins list is the payoff ── */}
      <button
        className="card today__momentum"
        type="button"
        onClick={() => setShowWins((v) => !v)}
        aria-expanded={showWins}
        disabled={winsToday.length === 0}
      >
        <span className="today__count">{momentum.doneToday}</span>
        <span className="today__count-label">
          finished today
          {momentum.streakDays > 0 && <span className="today__streak">{momentum.streakDays}-day streak</span>}
        </span>
        <span className="today__rituals">
          <span className={momentum.rituals.standup ? 'on' : ''}>{momentum.rituals.standup ? '✓' : '○'}</span>
          <span className={momentum.rituals.eod ? 'on' : ''}>{momentum.rituals.eod ? '✓' : '○'}</span>
        </span>
      </button>

      {showWins && winsToday.length > 0 && (
        <div className="card today__wins">
          {winsToday.map((w, i) => (
            <div className="today__win" key={i}>
              <span className="today__win-time">{w.time}</span>
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Quick wins ── */}
      {quickWins.length > 0 && (
        <div className="card today__quick">
          <div className="today__h">If that's too big</div>
          {quickWins.map((q, i) => (
            <div className="today__quick-item" key={i}>
              <button
                className="today__tick"
                type="button"
                onClick={() => tick(q, i)}
                disabled={busy[i]}
                aria-label={`Complete: ${q.text}`}
              >{busy[i] ? '…' : ''}</button>
              <span>{q.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── One avoidance line, stated flat ── */}
      {topAvoidance && (
        <div className="card today__avoid">
          <span className="today__avoid-label">{topAvoidance.label}</span>
          <span className="today__avoid-detail">{topAvoidance.detail}</span>
        </div>
      )}
    </section>
  );
}
