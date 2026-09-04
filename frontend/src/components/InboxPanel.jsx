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

// When the email landed. The window is 14 days now, so "how long has this been
// sitting" is most of what the date is for — a relative age is what scans, with
// the exact moment on hover for the rare case the wording matters.
//
// NOTE this DOES parse into a Date, deliberately, and is not the calendar's
// slice-the-string rule: `receivedDateTime` is a real UTC instant, and both an
// elapsed duration and a local rendering of an instant are correct to compute.
// The calendar rule exists because Graph is asked there for Europe/London
// wall-clock, which re-parsing would shift by an offset a second time.
const OLD_MAIL_DAYS = 7;

function receivedAge(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  // Unreadable is nothing, never a guess — a card with no date says less than
  // a card with the wrong one.
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((now - t) / 60000);
  if (mins < 0) return { label: 'just now', days: 0 };
  if (mins < 60) return { label: `${Math.max(mins, 1)}m`, days: 0 };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { label: `${hrs}h`, days: 0 };
  const days = Math.floor(hrs / 24);
  return { label: `${days}d`, days };
}

function receivedExact(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function EmailCard({ email, borderClass, onDismiss, dismissing, onReplied, onPromote }) {
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
  // false = the thread could not be read, which is NOT the same as a one-to-one
  const [threadKnown, setThreadKnown] = useState(true);
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
      setThreadKnown(d.replyDefaults.threadKnown !== false);
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
  const age = receivedAge(email.received);

  return (
    <div className={`inbox-item ${borderClass}`}>
      <div className="inbox-item-header">
        <span className="inbox-item-from">{email.from}</span>
        {age && (
          <span
            className={`inbox-item-age${age.days >= OLD_MAIL_DAYS ? ' inbox-item-age-old' : ''}`}
            title={receivedExact(email.received)}
          >
            {age.label}
          </span>
        )}
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
              {/* An unreachable thread used to render as nothing at all, which
                  reads exactly like a one-to-one email — and the difference is
                  who gets left off the reply. */}
              {!threadKnown && (
                <span className="inbox-recip-unknown" title="Only the cached copy of this email was available, and it does not record the other participants.">
                  thread unavailable — add anyone else by hand
                </span>
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
        <button
          className="inbox-action-btn inbox-action-done"
          onClick={() => onDismiss(email.id, { reason: 'done' })}
          disabled={busy}
          title="Handled — triage was right to surface it"
        >
          {busy ? '...' : 'Done'}
        </button>
        <button
          className="inbox-action-btn inbox-action-done"
          onClick={() => onDismiss(email.id, { markRead: true, reason: 'done' })}
          disabled={busy}
          title="Marks it read in Outlook as well as clearing it from triage"
        >
          {busy ? '...' : 'Read & dismiss'}
        </button>
        <button
          className="inbox-action-btn inbox-action-ignore"
          onClick={() => onDismiss(email.id, { reason: 'not-relevant' })}
          disabled={busy}
          title="Files this and mutes the sender — nothing from this address will reach the panel again"
        >
          {busy ? '...' : 'Not relevant'}
        </button>
        {/* The other direction. Only offered where there is somewhere to go:
            on an ACTION card it would be a no-op button. */}
        {email.category !== 'ACTION' && onPromote && (
          <button
            className="inbox-action-btn inbox-action-promote"
            onClick={() => onPromote(email.id)}
            disabled={busy}
            title="Triage under-ranked this — move it to Action and record the miss"
          >
            {busy ? '...' : 'Needs action'}
          </button>
        )}
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
  // #69 — a sent reply dismisses the email, so it leaves this list entirely and
  // the only record used to be Outlook's Sent Items. There is no "dismissed"
  // view to hang a "Replied" badge on, so replies get their own section.
  const [replies, setReplies] = useState(null);
  const [repliesOpen, setRepliesOpen] = useState(false);
  // 4 Sep 2026 - "Not relevant" now mutes the SENDER on the first press, and a
  // rule the panel cannot show is a rule Nick cannot revoke. A one-click mute
  // with no way back is the only genuinely dangerous shape this could take.
  const [muted, setMuted] = useState(null);
  const [mutedOpen, setMutedOpen] = useState(false);

  const fetchTriage = () => {
    fetch(apiUrl('/api/email/triage'))
      .then(r => r.json())
      .then(data => setTriage(data))
      .catch(() => {});
  };

  const fetchReplies = () => {
    fetch(apiUrl('/api/email/replies?limit=20'))
      .then(r => r.json())
      .then(data => setReplies(data))
      .catch(() => {});
  };

  const fetchMuted = () => {
    fetch(apiUrl('/api/email/triage/muted'))
      .then(r => r.json())
      // null stays null on a failure: "I could not read the rules" and "there
      // are none" are different facts and only one of them is reassuring.
      .then(data => setMuted(data?.ok ? (data.senders || []) : null))
      .catch(() => setMuted(null));
  };

  const unmute = (address) => {
    fetch(apiUrl(`/api/email/triage/muted/${encodeURIComponent(address)}`), { method: 'DELETE' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setDismissNote(d?.error ? `Could not un-mute: ${d.error}` : 'Could not un-mute.');
        else setDismissNote(`${address} will show up again from now on. Mail already filed stays filed.`);
        fetchMuted();
      })
      .catch(() => setDismissNote('Could not un-mute.'));
  };

  useEffect(() => { fetchTriage(); fetchReplies(); fetchMuted(); }, []);

  const runTriage = () => {
    setRunning(true);
    fetch(apiUrl('/api/email/triage/run'), { method: 'POST' })
      .then(r => r.json())
      .then(() => { fetchTriage(); setRunning(false); })
      .catch(() => setRunning(false));
  };

  // #70 — `reason` is what makes Done and Not relevant different buttons rather
  // than two labels on the same one. "Not relevant" is a misclassification
  // report and it is the only free feedback this classifier will ever get.
  const dismiss = (emailId, { markRead = false, reason = 'done' } = {}) => {
    setDismissing(emailId);
    setDismissNote('');
    fetch(apiUrl(`/api/email/triage/dismiss/${encodeURIComponent(emailId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markRead, reason }),
    })
      .then(r => r.json())
      .then(d => {
        // The dismiss still happened — this only reports the Outlook half failing.
        if (d?.readError) setDismissNote(d.readError);
        // A mute is a bigger statement than a dismissal, so it is said out loud
        // — and a REFUSED one especially, since a silent refusal is
        // indistinguishable from a mute that worked until the next edition
        // turns up, which is the bug this whole change exists to fix.
        else if (d?.muted && d.muted.ok) {
          setDismissNote(d.muted.alreadyMuted
            ? `${d.muted.muted} was already muted — nothing from them will reach the panel.`
            : `Muted ${d.muted.muted}. Future mail from this sender is filed automatically.`);
        } else if (d?.muted && !d.muted.ok) {
          setDismissNote(`Dismissed, but the sender was NOT muted — ${d.muted.reason}.`);
        }
        fetchTriage();
        fetchMuted();
        setDismissing(null);
      })
      .catch(() => setDismissing(null));
  };

  // The mirror of "Not relevant". Deliberately NOT a dismissal — the email
  // moves up into ACTION and stays on screen, because the complaint being
  // answered is "this should be in front of me", not "take it away".
  const promote = (emailId) => {
    setDismissing(emailId);
    setDismissNote('');
    fetch(apiUrl(`/api/email/triage/promote/${encodeURIComponent(emailId)}`), { method: 'POST' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        // A promotion that moved nothing must say so rather than leaving the
        // card sitting where it was with no explanation.
        if (!ok) setDismissNote(d?.error ? `Could not move it: ${d.error}` : 'Could not move it.');
        fetchTriage();
        setDismissing(null);
      })
      .catch(() => { setDismissNote('Could not move it.'); setDismissing(null); });
  };

  // The backend dismisses on send, so a reply just needs a refresh — and the
  // reply now leaves a record, so refresh that too or the section it just
  // joined would stay a send behind.
  const handleReplied = () => { fetchTriage(); fetchReplies(); };

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

      {/* Only rendered when there is something to say. An always-on panel of
          rules is one nobody reads by week two; a hidden one is a rule Nick
          cannot take back. null means the read FAILED, which is said plainly
          rather than rendered as "no rules". */}
      {muted === null && (
        <div className="inbox-dismiss-note">
          <span>Couldn't read your muted senders — this isn't confirmation there are none.</span>
        </div>
      )}
      {Array.isArray(muted) && muted.length > 0 && (
        <div className="inbox-muted">
          <button className="inbox-muted-toggle" onClick={() => setMutedOpen(o => !o)}>
            {mutedOpen ? '▾' : '▸'} {muted.length} muted sender{muted.length === 1 ? '' : 's'}
          </button>
          {mutedOpen && (
            <ul className="inbox-muted-list">
              {muted.map(m => (
                <li key={m.address}>
                  <span className="inbox-muted-addr">{m.name ? `${m.name} <${m.address}>` : m.address}</span>
                  {m.sampleSubject && (
                    <span className="inbox-muted-sample">muted on "{m.sampleSubject}"</span>
                  )}
                  <button className="inbox-muted-undo" onClick={() => unmute(m.address)}>Un-mute</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
            <EmailCard key={e.id} email={e} borderClass="urgency-high" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
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
                <EmailCard key={e.id} email={e} borderClass="urgency-medium" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
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
            <EmailCard key={e.id} email={e} borderClass="urgency-low" onDismiss={dismiss} dismissing={dismissing} onReplied={handleReplied} onPromote={promote} />
          ))}
        </div>
      )}

      {replies?.total > 0 && (
        <div className="inbox-section">
          <button className="inbox-section-toggle" onClick={() => setRepliesOpen(o => !o)}>
            {repliesOpen ? '▾' : '▸'} REPLIED ({replies.total})
          </button>
          {repliesOpen && replies.replies.map(r => (
            <div className="inbox-reply" key={r.id}>
              <div className="inbox-reply-head">
                <span className="inbox-reply-subject">{r.subject || '(no subject)'}</span>
                <span className="inbox-reply-when">{timeAgo(r.sentAt)}</span>
              </div>
              <div className="inbox-reply-to">
                {r.recipients.length
                  ? `To ${r.recipients.map(p => p.name || p.email).join(', ')}`
                  : 'Recipients not recorded'}
                {/* NEURO only knows the addressees for certain when the composer
                    passed them; on a plain reply Graph chooses. Saying which is
                    the difference between a record and a guess (#65). */}
                {r.recipientsSource === 'inferred' && (
                  <span className="inbox-reply-hint"> · from the thread, not confirmed</span>
                )}
              </div>
              <div className="inbox-reply-body">{r.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
