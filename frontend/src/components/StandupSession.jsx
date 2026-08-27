import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import './StandupSession.css';

// The ritual as a conversation.
//
// Design constraints came straight from how the old one failed:
//   - Nothing typed is ever lost. The server holds the transcript and persists
//     it before and after every turn, so a failure is a Retry button, never a
//     dead end that discards what you wrote.
//   - Every error state offers a way forward: retry, finish with what we have,
//     or switch to manual. "Connection error" with no path out is what made the
//     ritual skippable.
//   - You can leave and come back. On mount it resumes today's session rather
//     than starting a new one.

const LABELS = {
  standup: { title: 'Standup', opener: 'Starting your standup…', finish: 'Write the daily note' },
  eod: { title: 'End of day', opener: 'Winding down…', finish: 'Write the EOD' },
};

// Must go through apiFetch, not raw fetch(apiUrl(...)): NEURO_PIN is set on the
// Pi and apiFetch is what attaches the X-Neuro-Pin header. Plenty of older
// components still call fetch(apiUrl(...)) directly and 401 silently.
async function call(path, options = {}) {
  const res = await apiFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.retryable = Boolean(body.retryable);
    err.session = body.session || null;
    throw err;
  }
  return body;
}

export default function StandupSession({ kind = 'standup', onDone, onSwitchToManual }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [input, setInput] = useState('');
  const [finishing, setFinishing] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  const labels = LABELS[kind] || LABELS.standup;

  const begin = useCallback(async (restart = false) => {
    setLoading(true);
    setError(null);
    try {
      const { session: s } = await call(`/api/standup-session/${kind}/start`, {
        method: 'POST',
        body: JSON.stringify({ restart }),
      });
      setSession(s);
    } catch (e) {
      setError({ message: e.message, retryable: e.retryable !== false });
    } finally {
      setLoading(false);
    }
  }, [kind]);

  // Resume first, start second. Coming back to a half-finished standup should
  // pick up where it stopped, not throw the conversation away.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { session: existing } = await call(`/api/standup-session/${kind}`);
        if (cancelled) return;
        if (existing && existing.state !== 'finished') {
          setSession(existing);
          setLoading(false);
          return;
        }
      } catch { /* fall through to a fresh start */ }
      if (!cancelled) begin(false);
    })();
    return () => { cancelled = true; };
  }, [kind, begin]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [session?.messages, sending]);
  useEffect(() => { if (!loading && !sending) inputRef.current?.focus(); }, [loading, sending]);

  async function send(text) {
    const message = (text ?? input).trim();
    if (!message || sending) return;

    // Optimistic — but the server has already been told, so this is display
    // only. If the turn fails the message is still there on reload.
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
      // The server kept the message. Offer a retry that re-runs the turn rather
      // than making him type it again.
      if (e.session) setSession(e.session);
      setError({ message: e.message, retryable: true, retryText: message });
    } finally {
      setSending(false);
    }
  }

  async function retryTurn() {
    const last = session?.messages?.at(-1);
    setError(null);
    // The user's message is already on the server; an empty reply just re-runs
    // the assistant turn against the stored transcript.
    if (last?.role === 'user') {
      setSending(true);
      try {
        const { session: s } = await call(`/api/standup-session/${kind}/reply`, {
          method: 'POST',
          body: JSON.stringify({ message: '(continue)' }),
        });
        setSession(s);
      } catch (e) {
        setError({ message: e.message, retryable: true });
      } finally {
        setSending(false);
      }
    } else {
      begin(false);
    }
  }

  async function finish() {
    setFinishing(true);
    setError(null);
    try {
      await call(`/api/standup-session/${kind}/finish`, { method: 'POST' });
      onDone?.();
    } catch (e) {
      setError({ message: e.message, retryable: true });
    } finally {
      setFinishing(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (loading) return <div className="ss__loading">{labels.opener}</div>;

  const ready = session?.state === 'ready';
  const outcome = session?.outcome || {};

  return (
    <div className="ss">
      {/* Whose conversation this is. The prompt has composed from sara-voice's
          VOICE_FULL since 17 Aug, so the words were always hers — but nothing
          on this screen or the EOD one ever SAID so, and an unattributed
          message bubble reads as a form, not as talking to someone. Matches
          ChatPanel's presentation deliberately: two surfaces where SARA speaks
          should not look like two different assistants. */}
      <div className="ss__who">
        <span className="ss__who-name">SARA</span>
        <span className="ss__who-what">
          {kind === 'eod' ? 'End of day' : 'Morning standup'}
        </span>
      </div>

      {session?.degraded && (
        <div className="ss__banner ss__banner--warn">
          Running without tools — I can talk this through but can't record decisions myself.
        </div>
      )}

      <div className="ss__thread">
        {(session?.messages || [])
          .filter((m) => m.content && m.content !== '(continue)')
          // The opening "Let's do my standup." is a trigger, not something he said.
          .slice(1)
          .map((m, i) => (
            <div key={i} className={`ss__msg ss__msg--${m.role}`}>
              <span className={`ss__msg-label ss__msg-label--${m.role}`}>
                {m.role === 'assistant' ? 'SARA' : 'You'}
              </span>
              <div className="ss__msg-body">{m.content}</div>
            </div>
          ))}
        {sending && (
          <div className="ss__msg ss__msg--assistant ss__typing">
            <span className="ss__msg-label ss__msg-label--assistant">SARA</span>
            <div className="ss__msg-body">…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="ss__error">
          <div className="ss__error-msg">{error.message}</div>
          <div className="ss__error-actions">
            {error.retryable && (
              <button className="btn btn-primary" onClick={retryTurn} disabled={sending}>Retry</button>
            )}
            {/* Always a way out that keeps the work. */}
            <button className="btn btn-secondary" onClick={finish} disabled={finishing}>
              Finish with what we have
            </button>
            {onSwitchToManual && (
              <button className="btn btn-secondary" onClick={onSwitchToManual}>Switch to Manual</button>
            )}
          </div>
          <div className="ss__error-note">Nothing you've typed is lost — it's saved on the Pi.</div>
        </div>
      )}

      {ready && (
        <div className="ss__ready">
          <div className="ss__ready-title">
            {kind === 'eod' ? 'Reflection captured' : 'Focus agreed'}
          </div>
          {(outcome.focus || []).length > 0 && (
            <ul className="ss__ready-list">
              {outcome.focus.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          {(outcome.done || []).length > 0 && (
            <ul className="ss__ready-list">
              {outcome.done.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
          <button className="btn btn-primary" onClick={finish} disabled={finishing}>
            {finishing ? 'Writing…' : labels.finish}
          </button>
        </div>
      )}

      <div className="ss__composer">
        <textarea
          ref={inputRef}
          className="ss__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={sending ? 'Thinking…' : 'Type your answer…'}
          rows={2}
          disabled={sending}
        />
        <button className="ss__send" onClick={() => send()} disabled={sending || !input.trim()}>↑</button>
      </div>

      <div className="ss__foot">
        <button className="ss__link" onClick={() => begin(true)} disabled={sending}>Start over</button>
        {!ready && <button className="ss__link" onClick={finish} disabled={finishing}>End here</button>}
        {onSwitchToManual && <button className="ss__link" onClick={onSwitchToManual}>Manual</button>}
      </div>
    </div>
  );
}
