import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import useAttention from '../useAttention';
import AttentionCard from './AttentionCard';
import FrictionSection from './FrictionSection';
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

// `Now` — the execution surface, and the desktop's default view.
//
// This was the ADHD "Today" dashboard, sitting four clicks deep under MORE. It
// is promoted rather than rebuilt because it already owns every control that
// lowers the barrier to STARTING — the session container, the return prompt,
// "make it smaller", quick wins — and a thin new screen composing them would
// have been a second "what should I do?" surface, which is the one thing this
// phase exists to remove.
//
// ⚠ One thing changed rather than being added: "Right now" no longer renders
// `decision-engine` output straight out of `/api/adhd`. It renders the
// CANONICAL attention card, so acknowledging something here means what it means
// on the phone, and the five actions mean exactly what they say.
//
// The order on the page is the argument. Session and return prompt come FIRST,
// above any general suggestion: the cost of an interruption is not the
// interruption, it is the failure to return, and a page that opens with fresh
// work stacked on top of an unfinished thing is how the thread gets lost.
//
// The layout is the argument. One thing at the top, big, with a button. Evidence
// of progress immediately under it — ADHD memory drops finished work, so the day
// feels empty even when it wasn't. Avoidance is stated as fact and kept small.
// Quick wins sit at the bottom as the way back in when the top thing is too big.
//
// All the judgement is in services/adhd-dashboard.js. This file only renders.

export default function AdhdPanel({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  // The canonical feed. Everything on this page that proposes WORK comes from
  // here. `/api/adhd` keeps the session, momentum, quick wins and the wins
  // ledger — none of which the attention contract covers, and none of which is
  // a second opinion about what matters.
  const attention = useAttention({ interval: 30000 });
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

  // The "make it smaller" box. Null when closed; a string while being typed.
  const [smaller, setSmaller] = useState(null);

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

  // `startOnThing` lived here and started a session from the old "Right now"
  // block. That block now renders a canonical `AttentionCard`, which owns the
  // start (text only, for the same reason: a decision-engine item's `id` is a
  // slug like `todo-overdue-top`, never a task row, so the link back to the
  // task is made server-side on the normalised text and left unmade when the
  // card genuinely is not a task).

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

  /**
   * Can this row be acted on, or only read?
   *
   * A task signal without any of the three handles cannot be completed and
   * cannot be pointed at with confidence — the only thing left would be its
   * text, and a loose text match that lands on the WRONG task would tick
   * somebody else's work off. So: handles, or no buttons.
   */
  function avoidActionable(s) {
    return s.kind === 'task' && (s.task_id != null || s.ms_id != null || (s.filePath && s.lineNumber != null));
  }

  /**
   * Close an avoided task from the card it is named on.
   *
   * Owner order is `task_id` → `ms_id` → file+line, the same order and the same
   * three routes `completeQuickWin` and the phone's `completeTask.js` use — one
   * more copy of that order is one more chance for them to disagree, so it is
   * kept identical rather than improved.
   */
  async function completeAvoided(s, i) {
    const key = `av-${i}`;
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      if (s.task_id != null) {
        await api(`/api/tasks/${s.task_id}/complete`, { method: 'POST' });
      } else if (s.ms_id != null) {
        await api('/api/todos/complete-ms', {
          method: 'POST',
          body: JSON.stringify({ msId: s.ms_id, source: s.source, filePath: s.filePath, lineNumber: s.lineNumber }),
        });
      } else if (s.filePath && s.lineNumber != null) {
        await api('/api/todos/toggle', {
          method: 'POST',
          body: JSON.stringify({ filePath: s.filePath, lineNumber: s.lineNumber }),
        });
      }
      load();
    } catch (e) {
      setState((st) => ({ ...st, error: e.message }));
    }
    setBusy((b) => ({ ...b, [key]: false }));
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

  const { shape, momentum, winsToday, avoidance, quickWins, session, recovery } = data;

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
            {recovery.kind === 'resume' ? 'Where you were'
              : recovery.kind === 'shrink' ? 'Too big to start'
                : 'Left open'}
          </div>
          <p className="adhd__recovery-prompt">{recovery.prompt}</p>
          <p className="adhd__recovery-question">{recovery.question}</p>
          {/* The next step he left himself, if any. The whole reason the return
              prompt works: "the task" is a wall, a named action is a decision. */}
          {recovery.nextStep && <p className="adhd__session-next">Next: {recovery.nextStep}</p>}

          {/* ⚠ The shrink box has to live HERE as well as on the session card.
              Recovery renders INSTEAD of the card, so a "make it smaller"
              button that only opened the card's input would do nothing at all
              at the exact moment the option is offered. */}
          {smaller !== null ? (
            <div className="adhd__session-shrink">
              <label className="adhd__session-shrinkl" htmlFor="adhd-smaller-rec">
                What is the smallest next bit of it?
              </label>
              <input
                id="adhd-smaller-rec"
                className="adhd__session-input"
                value={smaller}
                onChange={(e) => setSmaller(e.target.value)}
                placeholder="e.g. open the doc and write the first heading"
                autoFocus
              />
              <div className="adhd__recovery-actions">
                <button
                  className="adhd__do"
                  type="button"
                  disabled={!smaller.trim()}
                  onClick={() => { sessionPost('shrink', { step: smaller.trim() }); setSmaller(null); }}
                >That is the step</button>
                <button className="adhd__later" type="button" onClick={() => setSmaller(null)}>Cancel</button>
              </div>
            </div>
          ) : (
          <div className="adhd__recovery-actions">
            {recovery.options.includes('resume') && (
              <button className="adhd__do" type="button" onClick={() => sessionPost('resume')}>Back to it</button>
            )}
            {recovery.options.includes('shrink') && (
              <button className="adhd__do" type="button" onClick={() => setSmaller('')}>Make it smaller</button>
            )}
            {recovery.options.includes('restart') && (
              <button className="adhd__do" type="button" onClick={() => sessionPost('start', { text: recovery.session.text, force: true })}>Start it again</button>
            )}
            <button className="adhd__later" type="button" onClick={() => sessionPost('finish', { completeTask: true })}>It's done</button>
            {/* Dropping it is a legitimate answer, and saying so out loud is
                the difference between a prompt and a nag. */}
            <button className="adhd__later" type="button" onClick={() => sessionPost('abandon')}>Let it go</button>
          </div>
          )}
        </section>
      )}

      {/* ── The session container (#88) ──
          The other answer to activation energy. Quick wins offer a SMALLER
          thing; this holds the thing you actually picked. */}
      {session && !recovery && (
        <section className={`adhd__session${session.overrun ? ' adhd__session--over' : ''}`}>
          {/* Four states, named. The old label collapsed every non-active one
              into "Paused" — but "I was pulled off this" and "I'm stuck on how
              big it is" are different problems needing different next moves. */}
          <div className="adhd__session-label">
            {session.status === 'active' ? 'In progress'
              : session.status === 'needs-smaller' ? 'Too big to start'
                : session.status === 'interrupted' ? 'You were pulled off this'
                  : 'Paused'} · started {session.startedTime}
          </div>
          <h2 className="adhd__session-title">{session.text}</h2>
          {/* The concrete physical step. Coming back to "the task" is a wall. */}
          {session.nextStep && <p className="adhd__session-next">Next: {session.nextStep}</p>}
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
          {/* Stated, never scored. A task made smaller three times is a finding
              about the work, not a mark against you. */}
          {session.shrinks > 0 && (
            <p className="adhd__session-int">Made smaller {session.shrinks}× so far</p>
          )}
          {/* The private body-double. Only when it is actually due, and only on
              a running session — and it is a PULL: nothing pushed this. */}
          {session.dueCheckIn && smaller === null && (
            <p className="adhd__session-int">
              Still on this one?{' '}
              <button className="adhd__do" type="button" onClick={() => sessionPost('check-in')}>Still here</button>
            </p>
          )}
          {smaller !== null ? (
            <div className="adhd__session-shrink">
              <label className="adhd__session-shrinkl" htmlFor="adhd-smaller">
                {session.status === 'needs-smaller'
                  ? 'What is the smallest next bit of it?'
                  : 'What is the smaller version?'}
              </label>
              <input
                id="adhd-smaller"
                className="adhd__session-input"
                value={smaller}
                onChange={(e) => setSmaller(e.target.value)}
                placeholder="e.g. open the doc and write the first heading"
                autoFocus
              />
              <div className="adhd__session-actions">
                <button
                  className="adhd__do"
                  type="button"
                  disabled={!smaller.trim()}
                  onClick={() => { sessionPost('shrink', { step: smaller.trim() }); setSmaller(null); }}
                >That is the step</button>
                <button className="adhd__later" type="button" onClick={() => setSmaller(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="adhd__session-actions">
              {/* First, and first on purpose: every other control here answers
                  WHEN, and only this one lowers the barrier to starting. */}
              <button className="adhd__do" type="button" onClick={() => setSmaller('')}>Make it smaller</button>
              {session.status === 'active'
                ? <button className="adhd__later" type="button" onClick={() => sessionPost('pause')}>Pause</button>
                : <button className="adhd__do" type="button" onClick={() => sessionPost('resume')}>Resume</button>}
              <button className="adhd__do" type="button" onClick={() => sessionPost('finish', { completeTask: true })}>Done</button>
              <button className="adhd__later" type="button" onClick={() => sessionPost('abandon')}>Stop</button>
            </div>
          )}
        </section>
      )}

      {/* ── The one thing ──
          Canonical attention, rendered by the shared card so the five actions
          mean exactly what they mean on every other surface. Nothing here
          reranks, rewords or decides urgency. */}
      <section className="adhd__now adhd__now--canonical">
        <div className="adhd__now-label">
          Right now
          {attention.error && <span className="adhd__now-warn"> · couldn&rsquo;t refresh</span>}
        </div>

        {/* ⚠ Three silences, and they must stay apart. A blank card is
            otherwise three different facts wearing one face, and only the last
            of them is good news. */}
        {attention.poolAvailable === false ? (
          <h2 className="adhd__now-title adhd__now-title--warn">
            I can&rsquo;t see your work right now. This is not an all-clear.
          </h2>
        ) : attention.contextCard ? (
          <>
            <h2 className="adhd__now-title">{attention.contextCard.title}</h2>
            <p className="adhd__now-reason">{attention.contextCard.reason}</p>
          </>
        ) : attention.primary ? (
          <AttentionCard
            card={attention.primary}
            onNavigate={onNavigate}
            onAct={attention.act}
            onStarted={load}
          />
        ) : attention.loading ? (
          <h2 className="adhd__now-title">Looking&hellip;</h2>
        ) : (
          <h2 className="adhd__now-title adhd__now-title--clear">Nothing pressing. You&rsquo;re clear.</h2>
        )}

        {attention.secondary.length > 0 && (
          // Named, not listed in full. Knowing the rest is tracked is
          // reassuring; seeing all of it is the overwhelm this page avoids.
          <details className="adhd__now-more">
            <summary>
              {attention.secondary.length} other thing{attention.secondary.length === 1 ? '' : 's'} tracked. They can wait.
            </summary>
            {attention.secondary.map((card) => (
              <AttentionCard
                key={card.recordId || card.id}
                card={card}
                compact
                showEvidence={false}
                onNavigate={onNavigate}
                onAct={attention.act}
                onStarted={load}
              />
            ))}
          </details>
        )}

        {/* Held back by the gate, and inputs that could not be read. Neither is
            swallowed: held is not gone, and "couldn't look" is not "nothing
            there". */}
        {(attention.dropped.length > 0 || attention.gaps.length > 0) && (
          <p className="adhd__waiting">
            {attention.dropped.length > 0 && `${attention.dropped.length} held back`}
            {attention.dropped.length > 0 && attention.gaps.length > 0 && ' · '}
            {attention.gaps.length > 0 && `${attention.gaps.length} couldn't be read`}
          </p>
        )}
      </section>

      {/* ── Friction noticed ──
          Evidence only, and BELOW the work rather than above it. */}
      <FrictionSection onNavigate={onNavigate} />

      {/*
        Momentum is full width and alone. It used to share a two-column grid
        row with "What you're pushing away", so half the reward surface was a
        list of what Nick had failed to do — same eyeline, same weight. You
        cannot feed dopamine and administer guilt on one line. The avoidance
        card still exists and still matters; it now sits BELOW the wins, after
        the day has been credited.
      */}
      <div className="adhd__solo">
        {/* ── Momentum ── */}
        <section className="adhd__card">
          <h3 className="adhd__h">Momentum</h3>
          <div className="adhd__momentum">
            <div className="adhd__big">{momentum.doneToday}</div>
            <div className="adhd__big-label">
              finished today
              {/*
                Compared with his own median working day, not with zero and not
                with a streak. The streak counted consecutive days with any win
                and was unbreakable the moment meetings were counted honestly
                (4 to 35 in one backfill) — a number that cannot go down is
                wallpaper. Shown only when real: typical is null until there are
                five working days of ledger to take a median of.
              */}
              {momentum.typical > 0 && momentum.doneToday > momentum.typical && (
                <span className="adhd__streak">above your usual {momentum.typical}</span>
              )}
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
                {/* The tick closes it; this picks it up. A quick win is the way
                    back in when the big thing is too big, so being able to
                    START one is the whole point of the section. */}
                <button
                  className="adhd__quick-start"
                  type="button"
                  onClick={() => sessionPost('start', { taskId: q.task_id ?? null, text: q.text })}
                >Start</button>
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

      {/*
        Below the wins, deliberately. This card is honest and it matters, but
        it was sharing a grid row with Momentum — reward and reproach at equal
        weight in one eyeline. It reads completely differently once the day has
        already been credited above it.
      */}
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
                {/* ⚠ The card said "stated so you can decide" and then offered
                    no way to decide anything. A row naming a task you have been
                    pushing away, with nothing on it, is the single most
                    demoralising shape this page can take: it can only be read,
                    and it says the same thing again tomorrow.

                    What is offered depends on what the row actually knows.
                    Nothing is invented — a signal with no handle gets no
                    buttons rather than a button that guesses. */}
                <span className="adhd__avoid-actions">
                  {avoidActionable(s) && (
                    <>
                      <button
                        className="adhd__do adhd__avoid-btn"
                        type="button"
                        onClick={() => sessionPost('start', { taskId: s.task_id ?? null, text: s.label })}
                      >Start it</button>
                      <button
                        className="adhd__later adhd__avoid-btn"
                        type="button"
                        disabled={busy[`av-${i}`]}
                        onClick={() => completeAvoided(s, i)}
                      >{busy[`av-${i}`] ? '…' : 'Done'}</button>
                      <button
                        className="adhd__later adhd__avoid-btn"
                        type="button"
                        onClick={() => onNavigate?.('todos', {
                          taskId: s.task_id, msId: s.ms_id,
                          filePath: s.filePath, lineNumber: s.lineNumber,
                          taskText: s.label,
                        })}
                      >Open it</button>
                    </>
                  )}
                  {/* A snoozed reminder is not a task, so it gets the one honest
                      action it has: take me to the thing it is about. */}
                  {s.kind === 'nudge' && s.navigate && (
                    <button
                      className="adhd__later adhd__avoid-btn"
                      type="button"
                      onClick={() => onNavigate?.(s.navigate)}
                    >Go there</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="adhd__note">Stated so you can decide, not so you feel bad. Dropping one is a valid answer.</p>
      </section>
    </div>
  );
}
