import { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from '../api';
import './ProfilePanel.css';

/**
 * About Me — what SARA knows about Nick as a person, and the conversation that
 * fills it in.
 *
 * The engine shipped without a door, which is the routable-but-unreachable hole
 * this codebase has fallen into twice before (DecisionsPanel, TodoPanel). The
 * profile and the interview were both live on `/api/profile` with no way to
 * reach either.
 *
 * Two halves on one screen deliberately: the facts and the conversation that
 * produces them. Seeing the list grow as you talk is the whole reassurance that
 * this is going somewhere, and it is the answer to "what have I actually told
 * it?" without opening Obsidian.
 *
 * ⚠ Provenance is rendered, not hidden. `(mentioned)` came from a memory export
 * of a previous assistant and is weaker than `(told me)`, which he said himself.
 * A screen that flattened the two would be quietly claiming he confirmed things
 * he never did — and it is the file he is most likely to want to correct.
 */

const SOURCE_LABEL = {
  seed: 'mentioned',
  interview: 'told me',
  conversation: 'told me',
  observed: 'observed',
  nick: 'you wrote',
};

export default function ProfilePanel() {
  const [profile, setProfile] = useState(null);
  const [session, setSession] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/profile'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProfile(await res.json());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const loadInterview = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/profile/interview'));
      if (res.ok) setSession(await res.json());
    } catch { /* no interview yet is a normal state, not an error */ }
  }, []);

  useEffect(() => { loadProfile(); loadInterview(); }, [loadProfile, loadInterview]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [session?.messages?.length]);

  async function post(path, body) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        // ⚠ A retryable failure keeps the transcript. Losing what he has already
        // typed because a provider hiccuped is the thing the session machinery
        // exists to prevent.
        if (json.messages) setSession(s => ({ ...(s || {}), messages: json.messages }));
        throw new Error(json.retryable ? `${json.error} — try again, nothing was lost` : (json.error || `HTTP ${res.status}`));
      }
      setSession(json);
      loadProfile();
      return json;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    // Cleared only once it is on its way; a failed send keeps the words in the
    // box rather than destroying them.
    const previous = draft;
    setDraft('');
    const result = await post('/api/profile/interview/reply', { message: text });
    if (!result) setDraft(previous);
  };

  if (error && !profile) {
    return (
      <div className="prof-panel">
        <p className="prof-err">Couldn&rsquo;t read this — {error}. That is not the same as her knowing nothing about you.</p>
      </div>
    );
  }
  if (!profile) return null;

  const messages = session?.messages || [];
  const talking = session?.inProgress;
  const finished = session?.finished;

  return (
    <div className="prof-panel">
      <header className="prof-head">
        <div>
          <h1 className="prof-title">About me</h1>
          <p className="prof-sub">
            What SARA knows about you as a person, rather than as Head of Technical Support.
            She reads this; she doesn&rsquo;t own it — it&rsquo;s <code>Me/About Nick.md</code> in the vault, edit it freely.
          </p>
        </div>
        <div className="prof-count">
          <strong>{profile.count}</strong>
          <span>{profile.count === 1 ? 'thing' : 'things'} known</span>
        </div>
      </header>

      {profile.gaps?.length > 0 && (
        <p className="prof-gaps">
          Still empty: {profile.gaps.join(', ')}.
        </p>
      )}

      <div className="prof-body">
        {/* ── What she knows ────────────────────────────────────────────── */}
        <section className="prof-facts">
          {profile.sections?.map(section => {
            const list = profile.facts?.[section.toLowerCase()] || [];
            if (!list.length) return null;
            return (
              <div className="prof-section" key={section}>
                <h2>{section}</h2>
                <ul>
                  {list.map((f, i) => (
                    <li key={`${section}-${i}`}>
                      <span className="prof-fact">{f.text}</span>
                      {/* Weaker evidence looks weaker. */}
                      <span className={`prof-src prof-src--${f.source}`}>{SOURCE_LABEL[f.source] || f.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {profile.count === 0 && (
            <p className="prof-empty">
              Nothing yet. Start the conversation and it fills in as you talk.
            </p>
          )}
        </section>

        {/* ── The conversation ──────────────────────────────────────────── */}
        <section className="prof-chat">
          {!talking && !finished && (
            <div className="prof-start">
              <p>
                A one-off conversation so she stops having to ask. One question at a time,
                and you can stop whenever — nothing is lost, and it picks up where you left off.
              </p>
              <button className="prof-btn" disabled={busy} onClick={() => post('/api/profile/interview/start')}>
                {busy ? 'Starting…' : 'Start the conversation'}
              </button>
            </div>
          )}

          {messages.length > 0 && (
            <div className="prof-thread">
              {messages.map((m, i) => (
                // The seeded opener is scaffolding, not something he said.
                (i === 0 && m.role === 'user') ? null : (
                  <div key={i} className={`prof-msg prof-msg--${m.role}`}>
                    {m.content}
                  </div>
                )
              ))}
              <div ref={endRef} />
            </div>
          )}

          {finished && (
            <div className="prof-done">
              <p>That&rsquo;s done — {session.recorded} {session.recorded === 1 ? 'thing' : 'things'} recorded.</p>
              <button className="prof-btn prof-btn--quiet" disabled={busy}
                onClick={() => post('/api/profile/interview/start', { restart: true })}>
                Go again
              </button>
            </div>
          )}

          {talking && (
            <div className="prof-composer">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
                placeholder="Answer her…"
                rows={3}
                disabled={busy}
              />
              <button className="prof-btn" onClick={send} disabled={busy || !draft.trim()}>
                {busy ? 'Thinking…' : 'Send'}
              </button>
            </div>
          )}

          {session?.degraded && (
            <p className="prof-warn">
              She&rsquo;s talking without tools right now, so she can&rsquo;t write anything down herself — the conversation is still saved.
            </p>
          )}
          {error && <p className="prof-err">{error}</p>}
        </section>
      </div>
    </div>
  );
}
