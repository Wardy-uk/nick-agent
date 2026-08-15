import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './ActionsPanel.css';

/**
 * Pending actions — the approval surface for everything SARA has queued.
 *
 * A lot of machinery was built, works, and could not be reached: nothing in
 * either frontend read `GET /api/actions`. `TodoPanel` handled only the todo
 * suggestions arriving in its own payload, and `WaitingOn` only
 * `chase_commitment`. Everything else — `draft_reply`, `reply_email`,
 * `chase_agenda`, `respond_meeting`, `schedule_focus_block`, `escalate_ticket`
 * — reached the queue and had no screen anywhere.
 *
 * The one that matters is outbound email. It is deliberately TWO-gated:
 * `draft_reply` writes the words and queues a separate `reply_email` carrying
 * them, so nothing sends until Nick has read the draft and approved again. That
 * second gate was reachable only through a push notification's action card,
 * which needed the notification to have fired and still be on screen. This is
 * the gate.
 *
 * Three rules it is built to, all learned by getting them wrong on the chase card:
 *
 *  1. Show enough to approve SAFELY. For anything outbound that means the full
 *     text and the actual recipient. Everything on a card comes from
 *     `action.presentation`, built on the SERVER from the stored payload the
 *     executor will read — never reconstructed here, or the screen is free to
 *     drift from what sends.
 *  2. Report the outcome. A failed action is marked `failed` and drops straight
 *     out of pending, so the card would simply vanish — indistinguishable from
 *     success. Outcomes stay on screen until dismissed.
 *  3. If it cannot be executed, disable approve and say why, rather than an
 *     approve that quietly fails. `presentation.blockers` carries the reasons.
 */

// Outbound first: it leaves the building and is the reason this screen exists.
// Navigation last: approving it changes nothing at all.
const KIND_ORDER = ['outbound', 'write', 'navigate'];

const KIND_META = {
  outbound: {
    title: 'Leaves the building',
    blurb: 'Real email, real Teams DMs, real invites to real people. Read the words before approving.',
  },
  write: {
    title: 'Changes NEURO',
    blurb: 'Internal and reversible — tasks, drafts, the vault.',
  },
  navigate: {
    title: 'Just navigates',
    blurb: 'Approving these writes nothing; they only move the screen.',
  },
};

function when(iso) {
  if (!iso) return '';
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, which
  // Safari parses as NaN and Chrome as local. Normalise both ends explicitly.
  const d = new Date(String(iso).replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The outcome of an approve or a reject, kept on screen after the card has gone.
 * This is the whole of rule 2 — without it a failed send looks exactly like a
 * successful one, because both make the card disappear.
 */
function Outcome({ result, onDismiss, onNavigate }) {
  return (
    <div className={`ap-outcome${result.ok ? '' : ' bad'}`}>
      <span className="ap-outcome-mark">{result.ok ? '✓' : '✗'}</span>
      <span className="ap-outcome-text">
        <strong>{result.label}</strong>
        {' — '}
        {result.text}
      </span>
      {result.ok && result.navigate && onNavigate && (
        <button className="ap-btn ap-btn-ghost" onClick={() => onNavigate(result.navigate)}>
          Go to {result.navigate}
        </button>
      )}
      {result.url && (
        <a className="ap-btn ap-btn-ghost" href={result.url} target="_blank" rel="noreferrer">Open</a>
      )}
      <button className="ap-btn ap-btn-ghost" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function ActionCard({ action, busy, onResolve }) {
  const p = action.presentation || {};
  const blocked = p.canApprove === false;
  const outbound = p.kind === 'outbound';

  return (
    <div className={`ap-card ap-kind-${p.kind || 'write'}${blocked ? ' is-blocked' : ''}`}>
      <div className="ap-card-head">
        <span className="ap-label">{p.label || action.type}</span>
        <span className="ap-id">#{action.id}</span>
        <span className="ap-when">{when(action.created_at)}</span>
      </div>

      <div className="ap-summary">{p.summary}</div>

      {/* The action's own reason for existing — why SARA raised it, as opposed
          to what approving it does. */}
      {action.reason && <div className="ap-reason">{action.reason}</div>}

      {p.note && <div className="ap-note">{p.note}</div>}

      {p.fields?.length > 0 && (
        <dl className="ap-fields">
          {p.fields.map((f, i) => (
            <div className="ap-field" key={i}>
              <dt>{f.label}</dt>
              <dd className={f.mono ? 'mono' : undefined}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Verbatim, wrapped, never truncated. An email to a colleague is not
          something to approve from a one-line gist. */}
      {p.body && (
        <>
          {p.bodyLabel && <div className="ap-body-label">{p.bodyLabel}</div>}
          <pre className="ap-body">{p.body}</pre>
        </>
      )}

      {p.warnings?.map((w, i) => <div className="ap-warn" key={i}>{w}</div>)}
      {p.blockers?.map((b, i) => <div className="ap-blocker" key={i}>{b}</div>)}

      <div className="ap-actions">
        <button
          className={`ap-btn${outbound ? ' ap-btn-send' : ' ap-btn-ok'}`}
          disabled={busy || blocked}
          title={blocked ? p.blockers.join(' ') : undefined}
          onClick={() => onResolve('approve')}
        >
          {busy ? 'Working…' : outbound ? 'Approve & send' : 'Approve'}
        </button>
        <button className="ap-btn ap-btn-ghost" disabled={busy} onClick={() => onResolve('reject')}>
          Reject
        </button>
        {blocked && p.link && (
          <span className="ap-blocker-link">{p.link.text}</span>
        )}
      </div>
    </div>
  );
}

export default function ActionsPanel({ onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [outcomes, setOutcomes] = useState([]);   // newest first, survives the reload
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    fetch(apiUrl('/api/actions'))
      .then(r => r.json())
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const resolve = async (action, verb) => {
    setBusyId(action.id);
    const label = action.presentation?.label || action.type;
    try {
      const res = await fetch(apiUrl(`/api/actions/${action.id}/${verb}`), { method: 'POST' });
      const body = await res.json();
      if (verb === 'reject') {
        setOutcomes(o => [{ id: action.id, ok: true, label, text: 'Rejected' }, ...o]);
      } else {
        setOutcomes(o => [{
          id: action.id,
          ok: Boolean(body.ok),
          label,
          // `detail` is the executor's own words. It is the only place that
          // knows a Teams DM fell back to email, or which of three things a
          // complete_task actually managed.
          text: body.detail || body.error || (body.ok ? 'Done' : 'Failed'),
          navigate: body.navigate || null,
          url: body.url || null,
        }, ...o]);
      }
    } catch (e) {
      setOutcomes(o => [{ id: action.id, ok: false, label, text: e.message }, ...o]);
    }
    setBusyId(null);
    load();
  };

  if (error) {
    return (
      <div className="actions-panel">
        <div className="ap-error">Actions unavailable: {error}</div>
      </div>
    );
  }
  if (!data) return <div className="actions-panel"><div className="ap-loading">Loading…</div></div>;

  const pending = data.pending || [];
  const recent = data.recent || [];
  const grouped = KIND_ORDER
    .map(kind => ({ kind, items: pending.filter(a => (a.presentation?.kind || 'write') === kind) }))
    .filter(g => g.items.length > 0);

  const outboundCount = pending.filter(a => a.presentation?.kind === 'outbound').length;

  return (
    <div className="actions-panel">
      <div className="ap-header">
        <h2>Pending actions</h2>
        <p className="ap-sub">
          {pending.length === 0
            ? 'Nothing waiting on you.'
            : `${pending.length} waiting on you`
              + (outboundCount ? ` · ${outboundCount} would leave the building` : '')
              + '. Nothing here has happened yet.'}
        </p>
      </div>

      {outcomes.length > 0 && (
        <div className="ap-outcomes">
          {outcomes.map((o, i) => (
            <Outcome
              key={`${o.id}-${i}`}
              result={o}
              onNavigate={onNavigate}
              onDismiss={() => setOutcomes(prev => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      {grouped.map(g => (
        <section className="ap-group" key={g.kind}>
          <h3 className={`ap-group-title ap-group-${g.kind}`}>
            {KIND_META[g.kind].title}
            <span className="ap-count">{g.items.length}</span>
          </h3>
          <p className="ap-group-blurb">{KIND_META[g.kind].blurb}</p>
          {g.items.map(a => (
            <ActionCard
              key={a.id}
              action={a}
              busy={busyId === a.id}
              onResolve={verb => resolve(a, verb)}
            />
          ))}
        </section>
      ))}

      {pending.length === 0 && outcomes.length === 0 && (
        <p className="ap-empty">
          Queued actions land here — drafted replies, chases, bookings, escalations.
          They wait until you approve them.
        </p>
      )}

      {recent.length > 0 && (
        <section className="ap-history">
          <button className="ap-history-toggle" onClick={() => setShowHistory(s => !s)}>
            {showHistory ? '▾' : '▸'} Recently resolved ({recent.length})
          </button>
          {showHistory && (
            <div className="ap-history-list">
              {recent.map(a => (
                <div className={`ap-hist-row ap-hist-${a.status}`} key={a.id}>
                  <span className="ap-hist-status">{a.status}</span>
                  <span className="ap-hist-label">{a.presentation?.label || a.type}</span>
                  <span className="ap-hist-summary">{a.presentation?.summary}</span>
                  <span className="ap-hist-when">{when(a.resolved_at || a.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
