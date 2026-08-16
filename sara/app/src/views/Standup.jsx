import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import './Standup.css';

// The ritual, on the phone. #26.
//
// Before this the standup was reachable from ONE place — tapping a standup
// notification — and what it opened was the retired fixed three-question
// stepper (/api/standup/questions + /submit-guided), which keeps every answer in
// browser state until one final POST and loses all of it when that POST fails.
// That is the precise failure standup-session.js was built to end, and the
// phone was the only surface still exposed to it.
//
// This drives /api/standup-session/* instead, so:
//   - the server holds the transcript and persists it before AND after every
//     turn. Nothing typed is ever lost, and a failure is a Retry, not a dead end.
//   - a failed turn comes back 503 with `retryable` and the SAVED SESSION, so
//     the retry re-runs the turn rather than making Nick retype.
//   - leaving and coming back resumes; it does not start again.
//
// It cannot use apiFetch: that flattens a non-2xx body into an Error message,
// which throws away `retryable` and `session` — the two fields the whole
// recovery story rests on. Hence the local `call` over shared authHeaders.

const LABELS = {
  standup: { title: 'Standup', opener: 'Starting your standup…', finish: 'Write the daily note', done: 'Standup written.' },
  eod: { title: 'End of day', opener: 'Winding down…', finish: 'Write the EOD', done: 'EOD written.' },
};

const KINDS = ['standup', 'eod'];

async function call(path, options = {}) {
  const res = await fetch(apiUrl(path), { ...options, headers: authHeaders(path, options.headers) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.retryable = Boolean(body.retryable);
    err.inFlight = Boolean(body.inFlight);
    err.session = body.session || null;
    throw err;
  }
  return body;
}

function isFinished(session) {
  return Boolean(session && session.state === 'finished');
}

// Which ritual to open on.
//
// Deliberately derived from what is actually outstanding rather than from a
// clock threshold — there is no such threshold anywhere in NEURO to reuse (the
// scheduler nudges standup at 9am and EOD at 5pm, which says when to prompt,
// not what is owed at 11:40). An unfinished session always wins, so walking back
// into a half-done conversation resumes it. The toggle is always visible, so
// being wrong costs one tap.
function pickKind(sessions) {
  const unfinished = KINDS.find((k) => sessions[k] && !isFinished(sessions[k]));
  if (unfinished) return unfinished;
  const outstanding = KINDS.find((k) => !isFinished(sessions[k]));
  return outstanding || 'standup';
}

export default function Standup({ intentKind = null }) {
  const [kind, setKind] = useState(intentKind === 'eod' ? 'eod' : null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState(null);
  const [input, setInput] = useState('');
  const endRef = useRef(null);

  const labels = LABELS[kind] || LABELS.standup;

  // No intent kind — ask the server what is outstanding before opening anything.
  // Both GETs are cheap (agent_state reads) and neither creates a session.
  useEffect(() => {
    if (kind) return undefined;
    let cancelled = false;
    (async () => {
      const sessions = {};
      await Promise.all(KINDS.map(async (k) => {
        try {
          const { session: s } = await call(`/api/standup-session/${k}`);
          sessions[k] = s;
        } catch {
          sessions[k] = null;
        }
      }));
      if (!cancelled) setKind(pickKind(sessions));
    })();
    return () => { cancelled = true; };
  }, [kind]);

  const begin = useCallback(async (restart = false) => {
    setLoading(true);
    setError(null);
    try {
      const { session: s } = await call(`/api/standup-session/${kind}/start`, {
        method: 'POST',
        body: JSON.stringify({ restart }),
      });
      setSession(s);
      setFinished(false);
    } catch (e) {
      setError({ message: e.message, retryable: e.retryable !== false });
    } finally {
      setLoading(false);
    }
  }, [kind]);

  // Resume first, start second — same order as the desktop. Coming back to a
  // half-finished standup must pick up where it stopped.
  useEffect(() => {
    if (!kind) return undefined;
    let cancelled = false;
    setSession(null);
    setFinished(false);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const { session: existing } = await call(`/api/standup-session/${kind}`);
        if (cancelled) return;
        if (existing && existing.state !== 'finished') {
          setSession(existing);
          setLoading(false);
          return;
        }
        // Already written today. Say so instead of silently reopening it —
        // a second standup would overwrite the note he already has.
        if (isFinished(existing)) {
          setSession(existing);
          setFinished(true);
          setLoading(false);
          return;
        }
      } catch { /* fall through to a fresh start */ }
      if (!cancelled) begin(false);
    })();
    return () => { cancelled = true; };
  }, [kind, begin]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [session?.messages, sending]);

  async function send(text) {
    const message = (text ?? input).trim();
    if (!message || sending) return;

    // Display-only optimism: the server is told in the same breath and is the
    // one holding the transcript, so a failure here still has the message.
    setSession((s) => (s ? { ...s, messages: [...s.messages, { role: 'user', content: message }] } : s));
    setInput('');
    setSending(true);
    setError(null);

    try {
      const { session: s } = await call(`/api/standup-session/${kind}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      setSession(s);
    } catch (e) {
      // 409 is a double-tap, not a fault — likelier on a touch screen than on a
      // desktop, and the route says so itself. Take the server's copy and stay
      // quiet rather than showing a scary banner for a second press.
      if (e.inFlight) {
        if (e.session) setSession(e.session);
        return;
      }
      if (e.session) setSession(e.session);
      setError({ message: e.message, retryable: true });
    } finally {
      setSending(false);
    }
  }

  async function retryTurn() {
    const last = session?.messages?.at(-1);
    setError(null);
    if (last?.role !== 'user') { begin(false); return; }
    // His message is already on the server; an empty-ish reply just re-runs the
    // assistant turn against the stored transcript.
    setSending(true);
    try {
      const { session: s } = await call(`/api/standup-session/${kind}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: '(continue)' }),
      });
      setSession(s);
    } catch (e) {
      if (e.session) setSession(e.session);
      setError({ message: e.message, retryable: true });
    } finally {
      setSending(false);
    }
  }

  async function finish() {
    setFinishing(true);
    setError(null);
    try {
      await call(`/api/standup-session/${kind}/finish`, { method: 'POST' });
      setFinished(true);
    } catch (e) {
      setError({ message: e.message, retryable: true });
    } finally {
      setFinishing(false);
    }
  }

  if (!kind || loading) {
    return (
      <section className="su">
        <div className="su__status">{kind ? labels.opener : 'Checking what’s outstanding…'}</div>
      </section>
    );
  }

  const ready = session?.state === 'ready';
  const outcome = session?.outcome || {};

  const toggle = (
    <div className="su__toggle" role="group" aria-label="Which ritual">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          className={`su__toggle-btn${kind === k ? ' su__toggle-btn--on' : ''}`}
          aria-pressed={kind === k}
          onClick={() => { if (k !== kind) setKind(k); }}
          disabled={sending || finishing}
        >{LABELS[k].title}</button>
      ))}
    </div>
  );

  if (finished) {
    const other = kind === 'standup' ? 'eod' : 'standup';
    return (
      <section className="su">
        {toggle}
        <div className="su__done">
          <div className="su__done-tick" aria-hidden="true">✓</div>
          <div className="su__done-title">{labels.done}</div>
          <div className="su__done-sub">Written to the vault.</div>
          <div className="su__done-actions">
            <button type="button" className="su__btn" onClick={() => setKind(other)}>
              {LABELS[other].title}
            </button>
            <button type="button" className="su__btn" onClick={() => begin(true)}>Redo</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="su">
      {toggle}

      {session?.degraded && (
        <div className="su__banner">
          Running without tools — I can talk this through but can’t record decisions myself.
        </div>
      )}

      <div className="su__thread">
        {(session?.messages || [])
          .filter((m) => m.content && m.content !== '(continue)')
          // messages[0] is the seeded "Let's do my standup." trigger, not
          // something Nick said.
          .slice(1)
          .map((m, i) => (
            <div key={i} className={`su__msg su__msg--${m.role}`}>{m.content}</div>
          ))}
        {sending && <div className="su__msg su__msg--assistant su__typing">…</div>}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="su__error">
          <div className="su__error-msg">{error.message}</div>
          <div className="su__error-actions">
            {error.retryable && (
              <button type="button" className="su__btn su__btn--primary" onClick={retryTurn} disabled={sending}>
                Retry
              </button>
            )}
            {/* Always a way out that keeps the work. */}
            <button type="button" className="su__btn" onClick={finish} disabled={finishing}>
              Finish with what we have
            </button>
          </div>
          <div className="su__error-note">Nothing you’ve typed is lost — it’s saved on the Pi.</div>
        </div>
      )}

      {ready && (
        <div className="su__ready">
          <div className="su__ready-title">{kind === 'eod' ? 'Reflection captured' : 'Focus agreed'}</div>
          {(outcome.focus || []).length > 0 && (
            <ul className="su__ready-list">{outcome.focus.map((f, i) => <li key={i}>{f}</li>)}</ul>
          )}
          {(outcome.done || []).length > 0 && (
            <ul className="su__ready-list">{outcome.done.map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
          <button type="button" className="su__btn su__btn--primary" onClick={finish} disabled={finishing}>
            {finishing ? 'Writing…' : labels.finish}
          </button>
        </div>
      )}

      {/* No Enter-to-send, unlike the desktop: on a phone keyboard Enter is how
          you get a new line, and the arrow is the deliberate action. */}
      <div className="su__composer">
        <textarea
          className="su__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={sending ? 'Thinking…' : 'Type your answer…'}
          rows={2}
          disabled={sending}
        />
        <button
          type="button"
          className="su__send"
          onClick={() => send()}
          disabled={sending || !input.trim()}
          aria-label="Send"
        >↑</button>
      </div>

      <div className="su__foot">
        <button type="button" className="su__link" onClick={() => begin(true)} disabled={sending}>Start over</button>
        {!ready && (
          <button type="button" className="su__link" onClick={finish} disabled={finishing}>End here</button>
        )}
      </div>
    </section>
  );
}
