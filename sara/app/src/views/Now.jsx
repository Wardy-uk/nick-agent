import { useCallback, useEffect, useState } from 'react';
import { useNickNow, stampFor } from '../mobile/useNickNow';
import { apiFetch } from '../api';
import { enqueue, flush, outcomeFor, pending as pendingOps, subscribe } from '../mobile/outbox';
import Freshness from '../components/Freshness';
import './Now.css';

// NOW — one current action and the next transition.
//
// Everything on this screen is sourced and timestamped, because the whole screen
// may be a cached copy of a morning that has since moved on. The rules it holds
// to, all of them borrowed rather than reinvented:
//
//  • A section NEURO could not read says so. It is never rendered as empty.
//  • "The pool was unavailable" is NOT an all-clear, and gets those words.
//  • A quiet day is a correct answer, and reads as calm rather than broken.
//  • Nothing here re-derives what the brain already decided — `say`, the tab a
//    card routes to, the agenda's `scope` — because three surfaces phrasing one
//    fact three ways is how they drift.

/**
 * The live focus session, with the controls that matter on a phone.
 *
 * ⚠ "Make it smaller" is the point of this card. Every other control answers
 * WHEN — pause, done, let it go — and Nick's difficulty is INITIATION, not
 * timing: anything that raises awareness without lowering the barrier is the
 * wrong shape. Shrinking is the only one here that lowers it, so it is the
 * first button and it is never phrased as giving up.
 *
 * Nothing on this card is scored. A session shrunk three times shows what it
 * shows; it is a finding about the work, not a mark against him.
 *
 * ⚠ Online-only, deliberately. These are not captures — they are edits to a
 * live session, and queueing them would mean replaying "shrink to X" against a
 * session that has since ended. The outbox is for things whose identity
 * survives sitting in a queue; this is not one of them.
 */
function SessionCard({ session, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState(null);

  async function post(path, body) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/session/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
      setAsking(false);
      setStep('');
      await onChanged?.();
    } catch (e) {
      // Say what failed and leave the card exactly as it was. A control that
      // silently does nothing is worse than one that refuses out loud.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const stuck = session.status === 'needs-smaller';
  const banked = session.status === 'paused' || session.status === 'interrupted' || stuck;

  return (
    <div className="card now__focus">
      <div className="now__focus-label">
        {stuck
          ? 'Stuck on how big this is'
          : session.status === 'interrupted'
            ? 'You were pulled off this'
            : session.status === 'paused'
              ? 'Paused'
              : 'In a focus session'}
        {session.stale ? ' — this one ran away, worth settling' : ''}
      </div>

      <div className="now__focus-text">{session.text || 'Untitled session'}</div>

      {/* The concrete physical step. This is what makes coming back thinkable:
          "the task" is a wall, a named action is a decision. */}
      {session.nextStep && <div className="now__next">Next: {session.nextStep}</div>}

      <div className="now__meta">
        {session.elapsedMinutes != null && `${session.elapsedMinutes}m in`}
        {session.plannedMinutes != null && ` of ${session.plannedMinutes}m`}
        {/* #87's rule: an assumed length must say it is assumed, every time. */}
        {session.plannedAssumed && ' (assumed)'}
        {/* Stated plainly, with no verdict attached. */}
        {session.shrinks > 0 && ` · made smaller ${session.shrinks}x`}
      </div>

      {error && <div className="now__sess-err">{error}</div>}

      {asking ? (
        <div className="now__sess-shrink">
          <label className="now__sess-label" htmlFor="now-step">
            {stuck ? 'What is the smallest next bit of it?' : 'What is the smaller version?'}
          </label>
          <input
            id="now-step"
            className="now__sess-input"
            value={step}
            onChange={(e) => setStep(e.target.value)}
            placeholder="e.g. open the doc and write the first heading"
            autoFocus
          />
          <div className="now__sess-acts">
            <button
              type="button"
              className="now__sess-btn now__sess-btn--go"
              disabled={busy || !step.trim()}
              onClick={() => post('shrink', { step: step.trim() })}
            >
              That is the step
            </button>
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="now__sess-acts">
          {/* First, and first on purpose. */}
          <button type="button" className="now__sess-btn now__sess-btn--go" disabled={busy} onClick={() => setAsking(true)}>
            Make it smaller
          </button>
          {banked ? (
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('resume')}>
              Back to it
            </button>
          ) : (
            <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('step-away')}>
              Stepping away
            </button>
          )}
          <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('finish', {})}>
            Done
          </button>
          {/* Offered without ceremony. Letting something go is a legitimate
              outcome, and dressing it up as failure is how it stops being used. */}
          <button type="button" className="now__sess-btn" disabled={busy} onClick={() => post('abandon')}>
            Let it go
          </button>
        </div>
      )}
      {/* Only offered where it is the honest answer: he has said it is too big
          and has not yet named the smaller thing. */}
      {stuck && !asking && (
        <div className="now__meta">No smaller step named yet — that is fine, it is the next thing to work out.</div>
      )}
    </div>
  );
}

function Section({ title, state, children }) {
  return (
    <section className="now__sec">
      <h2 className="now__sech">{title}</h2>
      {state && state.known === false ? (
        <div className="card now__unread">
          I couldn&rsquo;t read this{state.why ? ` — ${state.why}` : ''}.
          <span className="now__unread-note"> That isn&rsquo;t the same as nothing being there.</span>
        </div>
      ) : children}
    </section>
  );
}

function Countdown({ minutesAway, running, allDay }) {
  // ⚠ Null-check BEFORE coercing. `Number(null)` is 0 and `isFinite(0)` is true,
  // so a deliberate "no answer" prints a confident "0m" (28 Aug).
  if (allDay) return <span className="now__when">all day</span>;
  if (minutesAway === null || minutesAway === undefined) return null;
  const mins = Number(minutesAway);
  if (!Number.isFinite(mins)) return null;
  if (running) return <span className="now__when now__when--live">on now</span>;
  if (mins < 60) return <span className="now__when">in {mins}m</span>;
  return <span className="now__when">in {Math.round(mins / 60)}h</span>;
}

export default function Now({ onNavigate }) {
  const { snapshot, freshness, fetchedAt, error, busy, refresh } = useNickNow();
  const [queue, setQueue] = useState([]);
  const [ticking, setTicking] = useState(null);
  const [flash, setFlash] = useState(null);

  const reloadQueue = useCallback(async () => {
    try { setQueue(await pendingOps()); } catch { /* the queue view is a nicety */ }
  }, []);

  useEffect(() => {
    reloadQueue();
    return subscribe(() => reloadQueue());
  }, [reloadQueue]);

  // Ticking a task offline is the one WRITE on this screen, and it goes through
  // the outbox like everything else — never straight to the API. Two code paths
  // for one act is what Phase 2 exists to remove.
  //
  // ⚠ The outcome is read from THIS operation's receipt, never from flush()'s
  // aggregate counts. `flush()` drains the whole queue, so `confirmed >= 1` is
  // true whenever any older capture happens to land in the same round trip —
  // which would print "Done" over a completion NEURO rejected, or over one it
  // HELD pending a write-up. That is the silent half-failure shape, on the one
  // screen Nick uses to find what he owes.
  async function tick(task) {
    if (ticking) return;
    setTicking(task.id);
    setFlash(null);
    try {
      const op = await enqueue('todo.complete', { taskId: task.taskId });
      const result = await flush();
      const outcome = outcomeFor(result.receipts[op.operationId]);
      setFlash({
        ok: outcome.state === 'confirmed',
        msg: outcome.state === 'confirmed'
          ? `Done — ${task.text.slice(0, 40)}`
          : outcome.message,
      });
    } catch (e) {
      setFlash({ ok: false, msg: `Couldn't queue that: ${e.message}` });
    } finally {
      setTicking(null);
      reloadQueue();
    }
  }

  const s = snapshot;
  const queuedCount = queue.filter((o) => o.status === 'queued' || o.status === 'sending' || o.status === 'failed').length;
  const attentionCount = queue.filter((o) => o.status === 'needs-attention').length;

  return (
    <section className="now">
      <h1 className="view__title">Now</h1>
      <p className="view__lede">
        {s ? `As of ${stampFor(s.generatedAt) || '—'}` : 'Loading your working set…'}
      </p>

      <Freshness
        freshness={freshness}
        fetchedAt={fetchedAt}
        error={error}
        busy={busy}
        onRetry={() => refresh()}
      />

      {(queuedCount > 0 || attentionCount > 0) && (
        <div className="now__outbox">
          {queuedCount > 0 && <span>{queuedCount} waiting to reach NEURO</span>}
          {queuedCount > 0 && attentionCount > 0 && <span> · </span>}
          {attentionCount > 0 && <span className="err">{attentionCount} need{attentionCount === 1 ? 's' : ''} attention</span>}
          <button type="button" className="now__outbox-btn" onClick={() => flush({ force: true })}>Send now</button>
        </div>
      )}

      {flash && <div className={`now__flash${flash.ok ? '' : ' err'}`}>{flash.msg}</div>}

      {!s && freshness !== 'loading' && (
        <div className="card now__unread">Nothing to show yet.</div>
      )}

      {s && (
        <>
          {/* ── The one current action ─────────────────────────────────── */}
          <Section title="Right now" state={s.focus}>
            {s.focus.session ? (
              <SessionCard session={s.focus.session} onChanged={refresh} />
            ) : s.focus.item ? (
              <div className="card now__focus">
                <div className="now__focus-text">{s.focus.item.title}</div>
                {s.focus.nextStep && <div className="now__next">{s.focus.nextStep}</div>}
                {s.focus.item.tab && onNavigate && (
                  <button type="button" className="now__go" onClick={() => onNavigate(s.focus.item.tab)}>
                    Open →
                  </button>
                )}
              </div>
            ) : (
              <div className="card now__calm">
                {s.poolAvailable
                  ? 'Nothing pending. That is the real answer, not a blank screen.'
                  : "I couldn't read what needs doing — this is NOT an all-clear."}
              </div>
            )}
          </Section>

          {/* ── The next transition ─────────────────────────────────────── */}
          <Section title={s.agenda.known && s.agenda.scope !== 'today' ? `Next — ${s.agenda.scope}` : 'Next'} state={s.agenda}>
            {s.agenda.items.length === 0 ? (
              <div className="card now__calm">Nothing left in the diary.</div>
            ) : (
              s.agenda.items.map((e) => (
                <div className="card now__event" key={e.id}>
                  <div className="now__event-top">
                    <span className="now__event-title">{e.title}</span>
                    <Countdown minutesAway={e.minutesAway} running={e.running} allDay={e.allDay} />
                  </div>
                  {e.withOthers === true && <div className="now__meta">with other people</div>}
                </div>
              ))
            )}
          </Section>

          {/* ── Follow-ups ──────────────────────────────────────────────── */}
          <Section title="Needs a decision" state={s.followUps}>
            {s.followUps.items.length === 0 ? (
              <div className="card now__calm">
                {s.followUps.quiet ? 'Quiet — nothing worth interrupting you for.' : 'Nothing pending.'}
              </div>
            ) : (
              s.followUps.items.map((f) => (
                <div className="card now__item" key={f.id}>
                  <div className="now__item-title">{f.title}</div>
                  {f.say && <div className="now__item-say">{f.say}</div>}
                  {f.tab && onNavigate && (
                    <button type="button" className="now__go" onClick={() => onNavigate(f.tab)}>Open →</button>
                  )}
                </div>
              ))
            )}
            {s.followUps.known && s.followUps.dropped > 0 && (
              <div className="now__meta">{s.followUps.dropped} held back for now — held is not lost.</div>
            )}
          </Section>

          {/* ── The bounded task set ────────────────────────────────────── */}
          <Section title="Tasks" state={s.tasks}>
            {s.tasks.items.length === 0 ? (
              <div className="card now__calm">Nothing open.</div>
            ) : (
              <>
                {s.tasks.items.map((t) => (
                  <div className="card now__task" key={t.id}>
                    <button
                      type="button"
                      className="now__tick"
                      onClick={() => tick(t)}
                      disabled={!t.completableOffline || ticking === t.id}
                      aria-label={`Complete ${t.text}`}
                      title={t.completableOffline ? 'Complete' : 'Owned elsewhere — open it online to tick it'}
                    >{ticking === t.id ? '…' : '○'}</button>
                    <div className="now__task-body">
                      <div className="now__task-text">{t.text}</div>
                      <div className="now__meta">
                        {t.dueDate ? `due ${String(t.dueDate).slice(0, 10)}` : 'no due date'}
                        {t.moscow ? ` · ${t.moscow}` : ''}
                        {t.estimateMinutes ? ` · ${t.estimateMinutes}m` : ''}
                      </div>
                    </div>
                  </div>
                ))}
                {s.tasks.total > s.tasks.items.length && (
                  <div className="now__meta">
                    Showing {s.tasks.items.length} of {s.tasks.total} — the rest live in NEURO.
                  </div>
                )}
              </>
            )}
          </Section>

          {/* Everything NEURO could not see, named rather than swallowed. */}
          {s.gaps && s.gaps.length > 0 && (
            <details className="now__gaps">
              <summary>{s.gaps.length} thing{s.gaps.length === 1 ? '' : 's'} I couldn&rsquo;t read</summary>
              <ul>
                {s.gaps.map((g, i) => (
                  <li key={`${g.input}-${i}`}><strong>{g.input}</strong> — {g.why}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
