import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../api';
import './EscalationPanel.css';

/**
 * Escalations — what is escalated right now, and the form to escalate something.
 *
 * The list comes first because that is the question this screen is usually
 * opened with. The form's lookup step exists because escalating the wrong
 * ticket is a real risk when someone reads a number to you over Teams. Nothing
 * is written until the confirm step, and the confirm names exactly what will
 * change on the ticket.
 */

const PRIORITY_TARGET = 'Critical';

function ageDays(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso)) / 86400000);
}

function EscalationRow({ t, onPick }) {
  const age = ageDays(t.created);
  return (
    <div className="esc-row">
      <div className="esc-row-main">
        <a href={t.url || '#'} target="_blank" rel="noreferrer" className="esc-row-key">{t.key}</a>
        <span className="esc-row-summary">{t.summary}</span>
      </div>
      <div className="esc-row-meta">
        {/* Kept even though the groups now say most of this: a ticket can be
            more than one at once, and only the badges show the overlap. */}
        {t.viaRequestType && <span className="esc-tag esc-tag-req">customer-raised</span>}
        {t.viaTier && <span className="esc-tag esc-tag-tier">tier</span>}
        {t.viaUrgency && (
          <span className="esc-tag esc-tag-urgency" title={
            [t.urgencyReason, t.escalatedBy && `by ${t.escalatedBy}`].filter(Boolean).join(' — ')
          }>urgency</span>
        )}
        <span>{t.status || '—'}</span>
        <span>{t.priority || 'No priority'}</span>
        <span>{t.assignee || 'Unassigned'}</span>
        {age != null && <span>{age}d old</span>}
        <button type="button" className="esc-row-action" onClick={() => onPick(t.key)}>
          Escalate again
        </button>
      </div>
    </div>
  );
}

/** One collapsible group. Open by default — a closed section hides a count. */
function EscalationGroup({ title, blurb, items, onPick }) {
  return (
    <details className="esc-group" open>
      <summary>
        <span className="esc-group-title">{title}</span>
        <span className="esc-count">{items.length}</span>
      </summary>
      <p className="esc-group-blurb">{blurb}</p>
      {items.length === 0
        ? <p className="esc-empty">None.</p>
        : items.map(t => <EscalationRow key={t.key} t={t} onPick={onPick} />)}
    </details>
  );
}

/**
 * The escalated queue, split by how a ticket got here.
 *
 * Three groups rather than two, because the two named ones do not cover the
 * queue: most escalated tickets were moved into the Escalations tier by the
 * team without a portal escalation or a pass through this tool. Folding those
 * into either named group would be a lie, and dropping them would put the tab
 * back to under-reporting, which is what it was built to stop.
 *
 * Membership is exclusive and most-specific-first, so the counts sum to the
 * total and nothing appears twice. The per-row badges still show overlap.
 */
function ActiveEscalations({ items, loading, error, warning, onPick, onRefresh }) {
  const functional = items.filter(t => t.viaUrgency);
  const customer = items.filter(t => !t.viaUrgency && t.viaRequestType);
  const tier = items.filter(t => !t.viaUrgency && !t.viaRequestType);

  return (
    <section className="esc-active">
      <div className="esc-active-head">
        <h3>
          Currently escalated
          {!loading && !error && <span className="esc-count">{items.length}</span>}
        </h3>
        <button type="button" className="esc-btn esc-btn-ghost esc-btn-sm" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="esc-error">{error}</div>}

      {/* A short list is indistinguishable from a quiet day, so say so. */}
      {warning && <div className="esc-warn">{warning}</div>}

      {!error && !loading && items.length === 0 && (
        <p className="esc-empty">Nothing is escalated. That is the good outcome, not a broken query.</p>
      )}

      {items.length > 0 && (
        <>
          <EscalationGroup
            title="Functional escalations"
            blurb="Escalated with this tool — priority raised and an internal comment posted. Recorded in NOVA's escalation log, not on the ticket."
            items={functional}
            onPick={onPick}
          />
          <EscalationGroup
            title="Customer escalations"
            blurb="Raised as an escalation through the portal — the customer asked for this one."
            items={customer}
            onPick={onPick}
          />
          <EscalationGroup
            title="In the escalations tier"
            blurb="Moved into the Escalations tier by the team. Neither raised as an escalation by the customer nor put through this tool."
            items={tier}
            onPick={onPick}
          />
        </>
      )}
    </section>
  );
}

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
  const [active, setActive] = useState([]);
  const [activeLoading, setActiveLoading] = useState(true);
  const [activeError, setActiveError] = useState(null);
  const [activeWarning, setActiveWarning] = useState(null);
  const keyInput = useRef(null);

  useEffect(() => { keyInput.current?.focus(); }, []);

  useEffect(() => {
    fetch(apiUrl('/api/escalation/reasons'))
      .then(r => r.json())
      .then(d => setReasons(d.reasons || []))
      .catch(() => setReasons([]));
  }, []);

  const loadActive = async () => {
    setActiveLoading(true); setActiveError(null);
    try {
      const res = await fetch(apiUrl('/api/escalation/active'));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load escalations');
      setActive(data.escalations || []);
      setActiveWarning(data.warning || null);
    } catch (err) {
      setActiveError(err.message);
    } finally {
      setActiveLoading(false);
    }
  };

  useEffect(() => { loadActive(); }, []);

  const lookup = async (e, presetKey) => {
    e?.preventDefault();
    const k = String(presetKey ?? key).trim().toUpperCase();
    if (!k) return;
    if (presetKey) setKey(k);
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
      // Priority and due date have just moved on that ticket — if it's in the
      // list, the list is now wrong.
      loadActive();
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

      <ActiveEscalations
        items={active}
        loading={activeLoading}
        error={activeError}
        warning={activeWarning}
        onRefresh={loadActive}
        onPick={(k) => lookup(null, k)}
      />

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
