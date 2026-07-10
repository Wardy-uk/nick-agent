import { useSaraState } from '../../state/saraState';
import './AtWorkView.css';

// At Work — the "needs Nick's eyes on" view (NOVA-backed).
//
// Pure representation of useSaraState(): reads model.nova (an integration block, like
// model.neuro — NOT a contract domain) and owns no data. The slant is an exception/
// decision queue, not a metrics wall: pending AI approvals (escalations + low-confidence
// first), overdue customers, and queue-health warnings. Green/healthy signals are
// suppressed to an "all clear" line rather than shown as tiles. When NOVA is not
// connected the view says so honestly and renders nothing fabricated.

const KIND_LABEL = { approval: 'Approval', overdue: 'SLA', health: 'Queue' };

function fmtAge(mins) {
  if (typeof mins !== 'number') return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Stat({ label, value, tone }) {
  return (
    <div className={`aw__stat${tone ? ` aw__stat--${tone}` : ''}`}>
      <span className="aw__stat-value">{value ?? '—'}</span>
      <span className="aw__stat-label">{label}</span>
    </div>
  );
}

export default function AtWorkView() {
  const { status, error, model, now, interruptionNotice, dismissInterruptionNotice } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="aw aw--message">
        <p className="aw__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="aw aw--message">
        <p className="aw__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const nova = model.nova;
  const eyesOn = nova?.eyesOn;

  return (
    <section className="aw" aria-label="At Work">
      <header className="aw__header">
        <div className="aw__brand">
          <span className="aw__mark">SARA</span>
          <span className="aw__view-tag">At Work</span>
        </div>
        <span className="aw__clock">{fmtTime(now)}</span>
      </header>

      {!nova?.available && (
        <p className="aw__unavailable">
          NOVA not connected{nova?.reason ? ` — ${nova.reason}` : ''}. Set <code>NOVA_BASE_URL</code> to
          surface approvals, overdue customers, and exceptions here.
        </p>
      )}

      {interruptionNotice?.viewId === 'at-work' && (
        <section className="aw__notice" aria-live="assertive">
          <div>
            <p className="aw__notice-kicker">SARA brought this forward</p>
            <p className="aw__notice-title">{interruptionNotice.title}</p>
            <p className="aw__notice-detail">{interruptionNotice.detail}</p>
          </div>
          <button type="button" className="aw__notice-dismiss" onClick={dismissInterruptionNotice}>
            Dismiss
          </button>
        </section>
      )}

      {nova?.available && eyesOn && (
        <>
          <p className="aw__headline">{eyesOn.headline}</p>

          {eyesOn.stats && (
            <section className="aw__stats" aria-label="NOVA at a glance">
              <Stat
                label="Approvals waiting"
                value={eyesOn.stats.approvalsPending}
                tone={eyesOn.stats.approvalsPending ? 'attention' : undefined}
              />
              <Stat
                label="Customers overdue"
                value={eyesOn.stats.customersOverdue}
                tone={eyesOn.stats.customersOverdue ? 'urgent' : undefined}
              />
              <Stat label="Timed out (all-time)" value={eyesOn.stats.approvalsTimedOut} />
              <Stat
                label="Commitments met"
                value={eyesOn.stats.commitmentsMet != null ? `${eyesOn.stats.commitmentsMet}%` : '—'}
              />
            </section>
          )}

          {eyesOn.allClear ? (
            <p className="aw__clear">✓ Nothing needs your eyes right now. Hygiene and commitments are green.</p>
          ) : (
            <ul className="aw__list">
              {eyesOn.items.map((it) => (
                <li key={it.id} className={`aw__item aw__item--p${it.priority} aw__item--${it.kind}`}>
                  <div className="aw__item-top">
                    <span className="aw__item-kind">{KIND_LABEL[it.kind] || it.kind}</span>
                    <span className="aw__item-title">{it.title}</span>
                    {it.ticketId && <span className="aw__item-ticket">{it.ticketId}</span>}
                  </div>
                  <div className="aw__item-meta">
                    {it.detail && <span className="aw__item-detail">{it.detail}</span>}
                    {typeof it.confidence === 'number' && (
                      <span className="aw__item-conf">{Math.round(it.confidence * 100)}% conf</span>
                    )}
                    {it.assignee && <span className="aw__item-assignee">{it.assignee}</span>}
                    {it.ageMins != null && <span className="aw__item-age">{fmtAge(it.ageMins)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {nova.polledAt && <p className="aw__foot">NOVA · updated {fmtTime(new Date(nova.polledAt))}</p>}
        </>
      )}
    </section>
  );
}
