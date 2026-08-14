import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './InboxPanel.css';

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - Number(timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function EmailCard({ email, borderClass, onDismiss, dismissing, onReplied }) {
  // mode: null | 'summary' | 'full' | 'reply'
  const [mode, setMode] = useState(null);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [replyText, setReplyText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [replyAllCc, setReplyAllCc] = useState([]);
  const [newTo, setNewTo] = useState('');
  const [newCc, setNewCc] = useState('');

  const base = `/api/email/triage/${encodeURIComponent(email.id)}`;

  const toggle = (next) => {
    setError('');
    setMode(m => (m === next ? null : next));
  };

  // Both Full email and Reply need the Graph detail — fetch once, share it.
  const loadDetail = () => {
    if (detail) return Promise.resolve(detail);
    setLoading(true);
    return fetch(apiUrl(base))
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error || 'Could not load email'); return null; }
        setDetail(d.email);
        return d.email;
      })
      .catch(() => { setError('Could not load email'); return null; })
      .finally(() => setLoading(false));
  };

  const openReply = () => {
    toggle('reply');
    if (mode === 'reply') return;
    loadDetail().then(d => {
      if (!d?.replyDefaults) return;
      // Only prefill once — don't stamp on edits made before the fetch landed.
      setTo(prev => (prev.length ? prev : d.replyDefaults.to || []));
      setReplyAllCc(d.replyDefaults.replyAllCc || []);
    });
  };

  const addRecipient = (value, list, setList, clear) => {
    const email = value.trim().replace(/^.*<|>$/g, '').trim();
    if (!email || !email.includes('@')) { setError('That does not look like an email address'); return; }
    if (list.some(r => r.email.toLowerCase() === email.toLowerCase())) { clear(''); return; }
    setError('');
    setList([...list, { name: email, email }]);
    clear('');
  };

  const addAllCc = () => {
    const merged = [...cc];
    replyAllCc.forEach(r => {
      if (!merged.some(x => x.email.toLowerCase() === r.email.toLowerCase())) merged.push(r);
    });
    setCc(merged);
  };

  const showSummary = () => {
    toggle('summary');
    if (summary || mode === 'summary') return;
    setLoading(true);
    fetch(apiUrl(`${base}/summary`), { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setSummary(d.summary);
        else setError(d.error || 'Could not summarise');
      })
      .catch(() => setError('Could not summarise'))
      .finally(() => setLoading(false));
  };

  const showFull = () => {
    toggle('full');
    if (mode === 'full') return;
    loadDetail();
  };

  const draftWithAI = () => {
    setDrafting(true);
    setError('');
    fetch(apiUrl(`${base}/draft`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: replyText.trim() || undefined }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) setReplyText(d.draft);
        else setError(d.error || 'Could not draft a reply');
      })
      .catch(() => setError('Could not draft a reply'))
      .finally(() => setDrafting(false));
  };

  const sendReply = () => {
    if (!replyText.trim()) return;
    setSending(true);
    setError('');
    fetch(apiUrl(`${base}/reply`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: replyText, to, cc }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) onReplied(email.id);
        else setError(d.error || 'Send failed');
      })
      .catch(() => setError('Send failed'))
      .finally(() => setSending(false));
  };

  const busy = dismissing === email.id;

  return (
    <div className={`inbox-item ${borderClass}`}>
      <div className="inbox-item-header">
        <span className="inbox-item-from">{email.from}</span>
        {email.reason && <span className="inbox-item-cat">{email.reason}</span>}
      </div>
      <div className="inbox-item-subject">{email.subject}</div>
      {email.preview && mode !== 'full' && (
        <div className="inbox-item-summary">{email.preview.substring(0, 150)}</div>
      )}

      {mode === 'summary' && (
        <div className="inbox-detail">
          {loading ? <div className="inbox-detail-loading">Summarising...</div>
            : <div className="inbox-detail-body">{summary}</div>}
        </div>
      )}

      {mode === 'full' && (
        <div className="inbox-detail">
          {loading ? <div className="inbox-detail-loading">Loading email...</div> : detail && (
            <>
              <div className="inbox-detail-meta">
                {detail.fromEmail && <span>{detail.fromEmail}</span>}
                {detail.received && <span>{new Date(detail.received).toLocaleString('en-GB')}</span>}
              </div>
              <div className="inbox-detail-body inbox-detail-full">{detail.body}</div>
              {detail.webLink && (
                <a className="inbox-detail-link" href={detail.webLink} target="_blank" rel="noreferrer">
                  Open in Outlook
                </a>
              )}
            </>
          )}
        </div>
      )}

      {mode === 'reply' && (
        <div className="inbox-detail">
          {loading && <div className="inbox-detail-loading">Loading recipients...</div>}

          <div className="inbox-recip-row">
            <span className="inbox-recip-label">To</span>
            <div className="inbox-recip-chips">
              {to.map(r => (
                <span className="inbox-chip" key={r.email} title={r.email}>
                  {r.name || r.email}
                  <button
                    className="inbox-chip-x"
                    onClick={() => setTo(to.filter(x => x.email !== r.email))}
                    aria-label={`Remove ${r.email}`}
                  >×</button>
                </span>
              ))}
              <input
                className="inbox-recip-input"
                value={newTo}
                onChange={e => setNewTo(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addRecipient(newTo, to, setTo, setNewTo);
                  }
                }}
                onBlur={() => newTo.trim() && addRecipient(newTo, to, setTo, setNewTo)}
                placeholder={to.length ? 'Add...' : 'name@company.com'}
              />
            </div>
          </div>

          <div className="inbox-recip-row">
            <span className="inbox-recip-label">Cc</span>
            <div className="inbox-recip-chips">
              {cc.map(r => (
                <span className="inbox-chip" key={r.email} title={r.email}>
                  {r.name || r.email}
                  <button
                    className="inbox-chip-x"
                    onClick={() => setCc(cc.filter(x => x.email !== r.email))}
                    aria-label={`Remove ${r.email}`}
                  >×</button>
                </span>
              ))}
              <input
                className="inbox-recip-input"
                value={newCc}
                onChange={e => setNewCc(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addRecipient(newCc, cc, setCc, setNewCc);
                  }
                }}
                onBlur={() => newCc.trim() && addRecipient(newCc, cc, setCc, setNewCc)}
                placeholder={cc.length ? 'Add...' : 'none'}
              />
              {replyAllCc.length > 0 && replyAllCc.some(r => !cc.some(c => c.email === r.email)) && (
                <button className="inbox-recip-all" onClick={addAllCc}>
                  + everyone on thread ({replyAllCc.length})
                </button>
              )}
            </div>
          </div>

          <div className="inbox-reply-modes">
            <button className="inbox-action-btn" onClick={draftWithAI} disabled={drafting || sending}>
              {drafting ? 'Drafting...' : 'Draft with AI'}
            </button>
            <span className="inbox-reply-hint">
              or just type below — anything you write is used as a steer if you then draft with AI
            </span>
          </div>
          <textarea
            className="inbox-reply-text"
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="Write your reply..."
            rows={8}
          />
          <div className="inbox-item-actions">
            <button
              className="inbox-action-btn inbox-action-done"
              onClick={sendReply}
              disabled={sending || drafting || !replyText.trim() || to.length === 0}
            >
              {sending ? 'Sending...' : `Send to ${to.length || 'nobody'}`}
            </button>
            <button className="inbox-action-btn inbox-action-ignore" onClick={() => setMode(null)} disabled={sending}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="inbox-detail-error">{error}</div>}

      <div className="inbox-item-actions">
        <button className="inbox-action-btn inbox-action-done" onClick={() => onDismiss(email.id)} disabled={busy}>
          {busy ? '...' : 'Done'}
        </button>
        <button
          className="inbox-action-btn inbox-action-done"
          onClick={() => onDismiss(email.id, { markRead: true })}
          disabled={busy}
          title="Marks it read in Outlook as well as clearing it from triage"
        >
          {busy ? '...' : 'Read & dismiss'}
        </button>
        <button className="inbox-action-btn inbox-action-ignore" onClick={() => onDismiss(email.id)} disabled={busy}>
          {busy ? '...' : 'Not relevant'}
        </button>
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'summary' ? ' is-open' : ''}`}
          onClick={showSummary}
        >
          Summary
        </button>
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'full' ? ' is-open' : ''}`}
          onClick={showFull}
        >
          Full email
        </button>
        <button
          className={`inbox-action-btn inbox-action-view${mode === 'reply' ? ' is-open' : ''}`}
          onClick={openReply}
        >
          Reply
        </button>
      </div>
    </div>
  );
}

export default function InboxPanel({ focusContext }) {
  const fromFocus = focusContext?.fromFocus;
  const [showAllAction, setShowAllAction] = useState(!fromFocus);
  const [showDelegate, setShowDelegate] = useState(!fromFocus);
  const [triage, setTriage] = useState(null);
  const [running, setRunning] = useState(false);
  const [dismissing, setDismissing] = useState(null);
  const [dismissNote, setDismissNote] = useState('');
  const [fyiOpen, setFyiOpen] = useState(false);

  const fetchTriage = () => {
    fetch(apiUrl('/api/email/triage'))
      .then(r => r.json())
      .then(data => setTriage(data))
      .catch(() => {});
  };

  useEffect(() => { fetchTriage(); }, []);

  const runTriage = () => {
    setRunning(true);
    fetch(apiUrl('/api/email/triage/run'), { method: 'POST' })
      .then(r => r.json())
      .then(() => { fetchTriage(); setRunning(false); })
      .catch(() => setRunning(false));
  };

  const dismiss = (emailId, { markRead = false } = {}) => {
    setDismissing(emailId);
    setDismissNote('');
    fetch(apiUrl(`/api/email/triage/dismiss/${encodeURIComponent(emailId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markRead }),
    })
      .then(r => r.json())
      .then(d => {
        // The dismiss still happened — this only reports the Outlook half failing.
        if (d?.readError) setDismissNote(d.readError);
        fetchTriage();
        setDismissing(null);
      })
      .catch(() => setDismissing(null));
  };

  // The backend dismisses on send, so a reply just needs a refresh.
  const handleReplied = () => fetchTriage();

  const action = triage?.action || [];
  const delegate = triage?.delegate || [];
  const fyi = triage?.fyi || [];
  const ignore = triage?.ignore || [];
  const fyiTotal = fyi.length + ignore.length;

  return (
    <div className="inbox-container">
      {fromFocus && action.length > 0 && (
        <div className="todo-focus-summary" style={{ marginBottom: 16 }}>
          <span className="todo-focus-summary-text">
            {action.length} email{action.length !== 1 ? 's' : ''} need action — start here
          </span>
          {(delegate.length + fyiTotal) > 0 && (
            <span className="todo-focus-summary-stale">
              {delegate.length + fyiTotal} lower-priority below
            </span>
          )}
        </div>
      )}
      <div className="inbox-header">
        <h2 className="inbox-title">{fromFocus ? 'Urgent Emails — Start Here' : 'Inbox Triage'}</h2>
        <div className="inbox-actions">
          {triage?.lastRun && (
            <span className="inbox-last-scan">
              Last triage: {timeAgo(triage.lastRun)}
            </span>
          )}
          <button
            className="inbox-scan-btn"
            onClick={runTriage}
            disabled={running}
          >
            {running ? 'Running...' : 'Run Triage'}
          </button>
        </div>
      </div>

      {dismissNote && (
        <div className="inbox-dismiss-note">
          <span>{dismissNote}</span>
          <button className="inbox-dismiss-note-x" onClick={() => setDismissNote('')}>×</button>
        </div>
      )}

      {!triage && <div className="inbox-empty">Loading...</div>}

      {triage && action.length === 0 && delegate.length === 0 && fyiTotal === 0 && (
        <div className="inbox-empty">
          {triage.lastRun
            ? 'Inbox clear — nothing needs your attention.'
            : 'No triage yet. Click Run Triage to classify your inbox.'}
        </div>
      )}

      {action.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-action">ACTION ({action.length})</div>
          {(showAllAction ? action : action.slice(0, 5)).map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-high" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} />
          ))}
          {!showAllAction && action.length > 5 && (
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAllAction(true)}>
              +{action.length - 5} more action emails
            </button>
          )}
        </div>
      )}

      {delegate.length > 0 && (
        <div className="inbox-section">
          {fromFocus && !showDelegate ? (
            <button className="inbox-section-toggle" onClick={() => setShowDelegate(true)}>
              ▸ DELEGATE ({delegate.length})
            </button>
          ) : (
            <>
              <div className="inbox-section-label inbox-section-delegate">DELEGATE ({delegate.length})</div>
              {delegate.map(e => (
                <EmailCard key={e.id} email={e} borderClass="urgency-medium" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} />
              ))}
            </>
          )}
        </div>
      )}

      {fyiTotal > 0 && (
        <div className="inbox-section">
          <button
            className="inbox-section-toggle"
            onClick={() => setFyiOpen(o => !o)}
          >
            {fyiOpen ? '▾' : '▸'} FYI ({fyiTotal})
          </button>
          {fyiOpen && [...fyi, ...ignore].map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-low" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} />
          ))}
        </div>
      )}
    </div>
  );
}
