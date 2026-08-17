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

  // A running session has a clock on it, so the card has to move. One minute is
  // the right granularity: a second-by-second timer on a page for low executive
  // function is a distraction wearing the clothes of feedback.
  useEffect(() => {
    if (!state.data?.session || state.data.session.status !== 'active') return undefined;
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [state.data?.session?.id, state.data?.session?.status, load]);

  async function sessionPost(path, body) {
    try {
      const res = await apiFetch(`/api/session/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => ({}));
      // 409 is "you're already on something" — not an error, a question. The
      // running session comes back with it so it can be named rather than
      // silently replaced.
      if (res.status === 409 && json.session) {
        const ok = window.confirm(
          `You're ${json.session.elapsedMinutes} minutes into "${json.session.text}".\n\nPark it and start this instead?`
        );
        if (!ok) return;
        return sessionPost(path, { ...(body || {}), force: true });
      }
      if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
      load();
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
    }
    return undefined;
  }

  function startOnThing(title) {
    // Text only. A decision-engine item's `id` is a slug (`todo-overdue-top`),
    // never a task row, so the link back to the task is made server-side on the
    // normalised text — and left unmade when it genuinely isn't a task.
    return sessionPost('start', { text: title });
  }

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

  const { shape, rightNow, momentum, winsToday, avoidance, quickWins, session, recovery } = data;

  return (
    <div className="adhd">
      <div className="adhd__shape">
        <span className={`adhd__mode adhd__mode--${shape.mode}`}>{shape.mode}</span>
        <span className="adhd__shape-line">{shape.line}</span>
        <button className="adhd__refresh" type="button" onClick={load} title="Refresh">↻</button>
      </div>

      {/* ── The way back in (#89) ──
          Above everything, because it is the only thing on this page that is
          time-critical: the cost of an interruption is not the interruption,
          it's the failure to return. Pull-only — nothing pushed this. */}
      {recovery && (
        <section className={`adhd__recovery adhd__recovery--${recovery.kind}`}>
          <div className="adhd__recovery-label">
            {recovery.kind === 'resume' ? 'Where you were' : 'Left open'}
          </div>
          <p className="adhd__recovery-prompt">{recovery.prompt}</p>
          <p className="adhd__recovery-question">{recovery.question}</p>
          <div className="adhd__recovery-actions">
            {recovery.options.includes('resume') && (
              <button className="adhd__do" type="button" onClick={() => sessionPost('resume')}>Back to it</button>
            )}
            {recovery.options.includes('restart') && (
              <button className="adhd__do" type="button" onClick={() => sessionPost('start', { text: recovery.session.text, force: true })}>Start it again</button>
            )}
            <button className="adhd__later" type="button" onClick={() => sessionPost('finish', { completeTask: true })}>It's done</button>
            {/* Dropping it is a legitimate answer, and saying so out loud is
                the difference between a prompt and a nag. */}
            <button className="adhd__later" type="button" onClick={() => sessionPost('abandon')}>Let it go</button>
          </div>
        </section>
      )}

      {/* ── The session container (#88) ──
          The other answer to activation energy. Quick wins offer a SMALLER
          thing; this holds the thing you actually picked. */}
      {session && !recovery && (
        <section className={`adhd__session${session.overrun ? ' adhd__session--over' : ''}`}>
          <div className="adhd__session-label">
            {session.status === 'active' ? 'In progress' : 'Paused'} · started {session.startedTime}
          </div>
          <h2 className="adhd__session-title">{session.text}</h2>
          <div className="adhd__session-bar" role="img" aria-label={`${session.elapsedMinutes} of about ${session.plannedMinutes} minutes`}>
            <div
              className="adhd__session-fill"
              style={{ width: `${Math.min(100, (session.elapsedMinutes / session.plannedMinutes) * 100)}%` }}
            />
          </div>
          <p className="adhd__session-time">
            {session.elapsedMinutes} min in
            {session.overrun
              ? ` · ${session.overrunMinutes} over the ${session.plannedMinutes} you gave it`
              : ` · about ${session.remainingMinutes} left`}
            {/* The #87 rule, carried all the way to the screen: a number resting
                on an assumption has to say so, every single time. */}
            {session.plannedAssumed && <span className="adhd__assumed"> · assuming 30 min, nobody estimated it</span>}
          </p>
          {session.interruptions > 0 && (
            <p className="adhd__session-int">
              {session.interruptions} interruption{session.interruptions === 1 ? '' : 's'} since you started
              {session.lastInterruption?.detail ? ` — last: ${session.lastInterruption.detail}` : ''}
            </p>
          )}
          <div className="adhd__session-actions">
            {session.status === 'active'
              ? <button className="adhd__later" type="button" onClick={() => sessionPost('pause')}>Pause</button>
              : <button className="adhd__do" type="button" onClick={() => sessionPost('resume')}>Resume</button>}
            <button className="adhd__do" type="button" onClick={() => sessionPost('finish', { completeTask: true })}>Done</button>
            <button className="adhd__later" type="button" onClick={() => sessionPost('abandon')}>Stop</button>
          </div>
        </section>
      )}

      {/* ── The one thing ── */}
      <section className={`adhd__now adhd__now--${rightNow.item?.urgency || 'none'}`}>
        <div className="adhd__now-label">Right now</div>
        {rightNow.item ? (
          <>
            <h2 className="adhd__now-title">{rightNow.item.title}</h2>
            {rightNow.item.reason && <p className="adhd__now-reason">{rightNow.item.reason}</p>}
            <div className="adhd__now-actions">
              {/* The scaffolded start (#88), next to the navigate-there button.
                  Hidden while a session is live — offering to start a second
                  "one thing" is how you end up with none. */}
              {!session && !recovery && (
                <button className="adhd__do" type="button" onClick={() => startOnThing(rightNow.item.title)}>
                  Start on this
                </button>
              )}
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

          {/*
            The two counters that only go up. Every other growing number in
            NEURO is a debt — open tasks, waiting-on, the pending queue — and
            this is the first place growth is good news, so it is on the card
            rather than a click away.
          */}
          <div className="adhd__totals">
            <span><strong>{momentum.doneThisWeek ?? 0}</strong> this week</span>
            <span><strong>{momentum.total ?? 0}</strong> all time</span>
          </div>

          {momentum.bySource?.length > 0 && (
            <p className="adhd__sources">
              {momentum.bySource.map(s => `${s.count} ${s.source}`).join(' · ')}
            </p>
          )}

          {/*
            A source that could not be read is NAMED. Silently reporting a
            smaller number is the exact bug this card had for months: it showed
            0 finished on days full of finished work, and looked correct doing it.
          */}
          {data.gaps?.length > 0 && (
            <p className="adhd__gap">Couldn't read: {data.gaps.join('; ')}</p>
          )}
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
              /*
                The source is shown, and `evidence` is the tooltip. A win that
                cannot say what proves it is an assertion — which is exactly what
                the tickbox this replaced already was.
              */
              <li className="adhd__win" key={i} title={w.evidence || 'logged by hand'}>
                <span className="adhd__win-time">{w.time}</span>
                <span className="adhd__win-text">{w.text}</span>
                {w.source && <span className="adhd__win-src">{w.source}</span>}
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
