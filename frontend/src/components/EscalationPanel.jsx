import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import './EscalationPanel.css';

/**
 * Escalations — type a ticket key, check it's the right ticket, say why, escalate.
 *
 * The lookup step exists because escalating the wrong ticket is a real risk when
 * someone reads a number to you over Teams. Nothing is written until the confirm
 * step, and the confirm names exactly what will change on the ticket.
 */

const PRIORITY_TARGET = 'Critical';

export default function EscalationPanel() {
  const [key, setKey] = useState('');
  const [ticket, setTicket] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [reasonCode, setReasonCode] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const keyInput = useRef(null);

  useEffect(() => { keyInput.current?.focus(); }, []);

  useEffect(() => {
    fetch(apiUrl('/api/escalation/reasons'))
      .then(r => r.json())
      .then(d => setReasons(d.reasons || []))
      .catch(() => setReasons([]));
  }, []);

  const lookup = async (e) => {
    e?.preventDefault();
    const k = key.trim().toUpperCase();
    if (!k) return;
    setLoading(true); setError(null); setTicket(null); setResult(null); setConfirming(false);
    try {
      const res = await fetch(apiUrl(`/api/escalation/ticket/${encodeURIComponent(k)}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lookup failed');
      setTicket(data.ticket);
      setKey(data.ticket.key);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiUrl('/api/escalation'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_key: ticket.key,
          reason_code: reasonCode,
          needed_by: neededBy || undefined,
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Escalation failed');
      setResult(data.result);
      setConfirming(false);
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setKey(''); setTicket(null); setReasonCode(''); setNeededBy('');
    setNotes(''); setResult(null); setError(null); setConfirming(false);
    keyInput.current?.focus();
  };

  // What the confirm step promises. Mirrors NOVA's rules so the promise is honest:
  // priority only rises, the due date only tightens.
  const willRaisePriority = ticket && !['Blocker', PRIORITY_TARGET].includes(ticket.priority);
  const willTightenDue = ticket && neededBy && (!ticket.duedate || neededBy < ticket.duedate);

  return (
    <div className="escalation-panel">
      <header className="esc-header">
        <h2>Escalations</h2>
        <p className="esc-sub">Make a ticket jump the queue, and record why.</p>
      </header>

      <form className="esc-lookup" onSubmit={lookup}>
        <input
          ref={keyInput}
          className="esc-key-input"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="NT-28061"
          spellCheck={false}
          autoCapitalize="characters"
        />
        <button type="submit" className="esc-btn" disabled={loading || !key.trim()}>
          {loading && !ticket ? 'Looking…' : 'Find ticket'}
        </button>
        {(ticket || result) && (
          <button type="button" className="esc-btn esc-btn-ghost" onClick={reset}>Clear</button>
        )}
      </form>

      {error && <div className="esc-error">{error}</div>}

      {ticket && !result && (
        <div className="esc-ticket">
          <div className="esc-ticket-head">
            <span className="esc-ticket-key">{ticket.key}</span>
            <span className="esc-ticket-summary">{ticket.summary}</span>
          </div>
          <dl className="esc-meta">
            <div><dt>Status</dt><dd>{ticket.status || '—'}</dd></div>
            <div><dt>Priority</dt><dd>{ticket.priority || 'Unset'}</dd></div>
            <div><dt>Tier</dt><dd>{ticket.tier || '—'}</dd></div>
            <div><dt>Assignee</dt><dd>{ticket.assignee || 'Unassigned'}</dd></div>
            <div><dt>Due</dt><dd>{ticket.duedate || '—'}</dd></div>
            <div><dt>Updated</dt><dd>{ticket.updated ? new Date(ticket.updated).toLocaleDateString('en-GB') : '—'}</dd></div>
          </dl>

          {ticket.statusCategory === 'done' && (
            <div className="esc-warn">This ticket is already closed — escalating it is probably not what you want.</div>
          )}

          {ticket.description && <p className="esc-desc">{ticket.description.slice(0, 400)}</p>}

          {ticket.comments?.length > 0 && (
            <details className="esc-comments">
              <summary>Last {ticket.comments.length} comment{ticket.comments.length === 1 ? '' : 's'}</summary>
              {ticket.comments.map((c, i) => (
                <div key={i} className={`esc-comment ${c.internal ? 'is-internal' : ''}`}>
                  <span className="esc-comment-author">
                    {c.author}
                    {c.internal && <span className="esc-tag">internal</span>}
                  </span>
                  <span className="esc-comment-text">{c.text}</span>
                </div>
              ))}
            </details>
          )}

          <div className="esc-form">
            <label>
              <span>Why does it need to jump the queue?</span>
              <select value={reasonCode} onChange={e => setReasonCode(e.target.value)}>
                <option value="">Choose a reason…</option>
                {reasons.map(r => (
                  <option key={r.reason_code} value={r.reason_code}>{r.label}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Needed by <em>(optional — only ever brings a date forward)</em></span>
              <input type="date" value={neededBy} onChange={e => setNeededBy(e.target.value)} />
            </label>

            <label>
              <span>Context <em>(the assignee reads this)</em></span>
              <textarea
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Who asked, and why it matters."
              />
            </label>

            {!confirming ? (
              <button
                className="esc-btn esc-btn-primary"
                disabled={!reasonCode}
                onClick={() => setConfirming(true)}
              >
                Escalate {ticket.key}
              </button>
            ) : (
              <div className="esc-confirm">
                <p className="esc-confirm-title">This will change {ticket.key}:</p>
                <ul>
                  <li>
                    {willRaisePriority
                      ? <>Priority <strong>{ticket.priority || 'Unset'} → {PRIORITY_TARGET}</strong></>
                      : <>Priority stays <strong>{ticket.priority}</strong> — already at or above {PRIORITY_TARGET}</>}
                  </li>
                  {neededBy && (
                    <li>
                      {willTightenDue
                        ? <>Due date <strong>{ticket.duedate || 'none'} → {neededBy}</strong></>
                        : <>Due date stays <strong>{ticket.duedate}</strong> — already tighter than {neededBy}</>}
                    </li>
                  )}
                  <li>An <strong>internal</strong> comment, visible to the team but never to the customer</li>
                </ul>
                <div className="esc-confirm-actions">
                  <button className="esc-btn esc-btn-primary" onClick={submit} disabled={loading}>
                    {loading ? 'Escalating…' : 'Yes, escalate'}
                  </button>
                  <button className="esc-btn esc-btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="esc-result">
          <p className="esc-result-title">Escalated {result.ticket_key} — {result.reason_label}</p>
          <ul>
            <li>Priority: {result.priority.changed
              ? `${result.priority.from || 'unset'} → ${result.priority.to}`
              : `unchanged (${result.priority.from || 'unset'})`}</li>
            <li>Due date: {result.duedate.changed
              ? result.duedate.to
              : `unchanged (${result.duedate.from || 'none'})`}</li>
            <li>Internal comment: {result.comment_posted ? 'posted' : 'FAILED'}</li>
          </ul>
          {result.warnings?.length > 0 && (
            <div className="esc-warn">{result.warnings.join(' ')}</div>
          )}
          <button className="esc-btn" onClick={reset}>Escalate another</button>
        </div>
      )}
    </div>
  );
}
