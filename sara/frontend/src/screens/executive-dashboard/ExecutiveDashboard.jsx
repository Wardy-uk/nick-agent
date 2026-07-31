import { useEffect, useMemo, useState } from 'react';
import { useSaraState } from '../../state/saraState';
import './ExecutiveDashboard.css';

// Executive Dashboard v0 — the operational SARA view (WS2A-WP1).
//
// Same shared state as Mission Control, presented with more depth. This screen is a
// pure representation of `useSaraState()` and owns NO data of its own: the WS1 State
// Engine model supplies the queue, people, focus and vault domains plus the derived
// confidence/briefing; the shared placeholder presentation supplies What Matters Now;
// the shared clock supplies current time. Where Mission Control distils, this view
// expands — KPI tiles, the full queue broken down by section, and the people roster —
// but it never re-derives or duplicates state (charter principle 7).
//
// It deliberately does NOT depend on Home Assistant / WS3 telemetry: every value here
// comes from the existing WS1 contract. Inputs are still seeded; that is surfaced with
// the same seed pill the other views use.

const SECTIONS = [
  { key: 'act_now', label: 'Act now', tone: 'urgent' },
  { key: 'today', label: 'Today', tone: 'attention' },
  { key: 'watch', label: 'Watch', tone: 'watch' },
];

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// SLA minutes -> compact human label, so the queue reads at a glance.
function formatSla(mins) {
  if (typeof mins !== 'number') return '—';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function ExecutiveDashboard() {
  const {
    status,
    error,
    model,
    now,
    presentation,
    interruptionNotice,
    dismissInterruptionNotice,
    openInterruptionNotice,
    currentViewContext,
    navigateToView,
  } = useSaraState();
  const [escalations, setEscalations] = useState({ status: 'idle', tickets: [], total: 0, error: null });
  const [emailTriage, setEmailTriage] = useState({ status: 'idle', urgent: [], reply: [], delegate: [], error: null, lastRun: null });

  if (status === 'connecting') {
    return (
      <section className="ed ed--message">
        <p className="ed__waking">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="ed ed--message">
        <p className="ed__offline">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const queue = model.domains?.queue;
  const people = model.domains?.people;
  const focus = model.domains?.focus;
  const vault = model.domains?.vault;
  const attention = people?.members?.filter((m) => m.status !== 'solid').length ?? 0;
  const escalationMode = currentViewContext?.filter === 'escalations';
  const emailMode = currentViewContext?.filter === 'urgent' || currentViewContext?.filter === 'reply';
  const replyMode = currentViewContext?.filter === 'reply';
  const emailSummaryModel = presentation?.email || { urgentCount: 0, replyCount: 0 };

  useEffect(() => {
    let cancelled = false;
    if (!escalationMode) {
      setEscalations({ status: 'idle', tickets: [], total: 0, error: null });
      return undefined;
    }

    async function loadEscalations() {
      setEscalations((current) => ({ ...current, status: 'loading', error: null }));
      try {
        const [listRes, seenRes] = await Promise.all([
          fetch('/api/jira/escalations'),
          fetch('/api/jira/escalations/seen', { method: 'POST' }),
        ]);
        if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
        if (!seenRes.ok) throw new Error(`Seen HTTP ${seenRes.status}`);
        const data = await listRes.json();
        if (cancelled) return;
        setEscalations({
          status: 'ready',
          tickets: Array.isArray(data?.tickets) ? data.tickets : [],
          total: data?.total || 0,
          error: null,
        });
      } catch (loadError) {
        if (cancelled) return;
        setEscalations({ status: 'error', tickets: [], total: 0, error: loadError.message });
      }
    }

    loadEscalations();
    return () => {
      cancelled = true;
    };
  }, [escalationMode]);

  useEffect(() => {
    let cancelled = false;
    async function loadEmailTriage() {
      setEmailTriage((current) => ({ ...current, status: 'loading', error: null }));
      try {
        const res = await fetch('/api/email/triage');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setEmailTriage({
          status: 'ready',
          urgent: Array.isArray(data?.urgent) ? data.urgent : [],
          reply: Array.isArray(data?.reply) ? data.reply : [],
          delegate: Array.isArray(data?.delegate) ? data.delegate : [],
          error: null,
          lastRun: data?.lastRun || null,
        });
      } catch (loadError) {
        if (cancelled) return;
        setEmailTriage({ status: 'error', urgent: [], reply: [], delegate: [], error: loadError.message, lastRun: null });
      }
    }

    loadEmailTriage();
    const id = setInterval(loadEmailTriage, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const escalationSummary = useMemo(() => {
    if (!escalationMode) return null;
    if (escalations.status === 'loading') return 'Loading live escalations…';
    if (escalations.status === 'error') return `Could not load escalations — ${escalations.error}`;
    if (!escalations.total) return 'No live escalations are currently queued.';
    return `${escalations.total} live escalation${escalations.total === 1 ? '' : 's'} from NUERO.`;
  }, [escalationMode, escalations]);

  const emailSummary = useMemo(() => {
    if (!emailMode) return null;
    if (emailTriage.status === 'loading') return replyMode ? 'Loading reply triage…' : 'Loading urgent email triage…';
    if (emailTriage.status === 'error') return `Could not load email triage — ${emailTriage.error}`;
    if (emailSummaryModel.available === false) return `Email triage unavailable — ${emailSummaryModel.detail || 'mail access needs reconnecting'}`;
    if (replyMode && emailTriage.reply.length > 0) {
      return `${emailTriage.reply.length} email${emailTriage.reply.length === 1 ? '' : 's'} need a reply.`;
    }
    if (!replyMode && emailTriage.urgent.length > 0) {
      return `${emailTriage.urgent.length} urgent email${emailTriage.urgent.length === 1 ? '' : 's'} need action.`;
    }
    if (emailTriage.delegate.length > 0) {
      return `${emailTriage.delegate.length} email${emailTriage.delegate.length === 1 ? '' : 's'} could be delegated.`;
    }
    return replyMode ? 'No reply-needed emails are currently queued.' : 'No urgent emails are currently triaged.';
  }, [emailMode, emailTriage, replyMode, emailSummaryModel.available, emailSummaryModel.detail]);

  const queueSections = SECTIONS.map(({ key, label, tone }) => ({
    key,
    label,
    tone,
    tickets: queue?.sections?.[key] ?? [],
  })).filter((section) => section.tickets.length > 0);

  // KPI tiles — all counts read straight from the engine domains, never computed
  // into screen-owned state.
  const kpis = [
    { id: 'kpi-open', label: 'Open tickets', value: queue?.open ?? '—' },
    { id: 'kpi-breaching', label: 'Breaching SLA', value: queue?.breaching ?? '—', tone: 'urgent' },
    { id: 'kpi-people', label: 'People to watch', value: attention, tone: attention ? 'attention' : undefined },
    { id: 'kpi-notes', label: 'Notes to surface', value: vault?.picks?.length ?? '—' },
  ];

  return (
    <section className="ed" aria-label="Queue">
      <header className="ed__header">
        <div className="ed__brand">
          <span className="ed__mark">SARA</span>
          <span className="ed__view-tag">Queue</span>
          <span className="ed__state" data-state={model.sara?.status}>
            {model.sara?.status}
          </span>
          {model.dataSource === 'seed' && <span className="ed__seed">seed data</span>}
        </div>
        <div className="ed__clock">
          <span className="ed__time">{formatTime(now)}</span>
          <span className={`ed__confidence ed__confidence--${model.confidence?.level}`}>
            Confidence {model.confidence?.level}
            {typeof model.confidence?.score === 'number' && ` · ${model.confidence.score}`}
          </span>
        </div>
      </header>

      {/* Engine briefing line — derived by the State Engine, read verbatim */}
      {model.briefing?.line && <p className="ed__briefing">{model.briefing.line}</p>}

      <section className="ed__filters" aria-label="Queue filters">
        <button type="button" className={`ed__filter${!currentViewContext?.filter ? ' ed__filter--active' : ''}`} onClick={() => navigateToView('executive-dashboard')}>
          Queue
        </button>
        <button type="button" className={`ed__filter${escalationMode ? ' ed__filter--active' : ''}`} onClick={() => navigateToView('executive-dashboard', { fromFocus: true, filter: 'escalations' })}>
          Escalations
        </button>
        <button type="button" className={`ed__filter${currentViewContext?.filter === 'urgent' ? ' ed__filter--active' : ''}`} onClick={() => navigateToView('executive-dashboard', { fromFocus: true, filter: 'urgent' })}>
          Urgent email
          {emailSummaryModel.urgentCount > 0 && <span className="ed__filter-count">{emailSummaryModel.urgentCount}</span>}
        </button>
        <button type="button" className={`ed__filter${replyMode ? ' ed__filter--active' : ''}`} onClick={() => navigateToView('executive-dashboard', { fromFocus: true, filter: 'reply' })}>
          Needs reply
          {emailSummaryModel.replyCount > 0 && <span className="ed__filter-count">{emailSummaryModel.replyCount}</span>}
        </button>
      </section>

      {interruptionNotice?.viewId === 'executive-dashboard' && (
        <section className="ed__notice" aria-live="assertive">
          <div>
            <p className="ed__notice-kicker">SARA brought this forward</p>
            <p className="ed__notice-title">{interruptionNotice.title}</p>
            <p className="ed__notice-detail">{interruptionNotice.detail}</p>
          </div>
          <div className="product__actions">
            {interruptionNotice.viewId && (
              <button type="button" className="ed__notice-dismiss" onClick={openInterruptionNotice}>
                Review now
              </button>
            )}
            <button type="button" className="ed__notice-dismiss" onClick={dismissInterruptionNotice}>
              Dismiss
            </button>
          </div>
        </section>
      )}

      {/* KPI tiles — operational counts straight from shared domains */}
      <section className="ed__kpis" aria-label="Key metrics">
        {kpis.map((kpi) => (
          <div key={kpi.id} className={`ed__kpi${kpi.tone ? ` ed__kpi--${kpi.tone}` : ''}`}>
            <span className="ed__kpi-value">{kpi.value}</span>
            <span className="ed__kpi-label">{kpi.label}</span>
          </div>
        ))}
      </section>

      <div className="ed__columns">
        {/* Queue at depth — every section and ticket from the queue domain */}
        <section className="ed__panel ed__panel--wide" aria-label="Queue">
          <div className="ed__panel-head">
            <p className="ed__section-label">Queue</p>
            <p className="ed__panel-summary">{escalationMode ? escalationSummary : emailMode ? emailSummary : queue?.summary}</p>
          </div>
          {escalationMode ? (
            escalations.status === 'ready' && escalations.tickets.length > 0 ? (
              <div className="ed__queue-section">
                <p className="ed__queue-heading ed__queue-heading--urgent">
                  Escalations
                  <span className="ed__queue-count">{escalations.total}</span>
                </p>
                <ul className="ed__list">
                  {escalations.tickets.map((ticket) => (
                    <li key={ticket.key} className="ed__ticket ed__ticket--urgent">
                      <div className="ed__ticket-top">
                        <span className="ed__ticket-key">{ticket.key}</span>
                        <span className="ed__ticket-summary">{ticket.summary || 'Escalation ticket'}</span>
                        <span className="ed__ticket-sla">{ticket.seen ? 'seen' : 'new'}</span>
                      </div>
                      <div className="ed__ticket-meta">
                        <span className="ed__ticket-assignee">
                          {ticket.hasComment ? 'You have commented' : 'No Nick comment yet'}
                        </span>
                        {ticket.created && <span className="ed__ticket-take">Raised {ticket.created}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="ed__queue-empty">{escalationSummary}</div>
            )
          ) : emailMode ? (
            emailTriage.status === 'ready' && (((replyMode ? emailTriage.reply : emailTriage.urgent).length > 0) || emailTriage.delegate.length > 0) ? (
              <>
                {(replyMode ? emailTriage.reply : emailTriage.urgent).length > 0 && (
                  <div className="ed__queue-section">
                    <p className={`ed__queue-heading ed__queue-heading--${replyMode ? 'attention' : 'urgent'}`}>
                      {replyMode ? 'Needs reply' : 'Act now'}
                      <span className="ed__queue-count">{(replyMode ? emailTriage.reply : emailTriage.urgent).length}</span>
                    </p>
                    <ul className="ed__list">
                      {(replyMode ? emailTriage.reply : emailTriage.urgent).map((email) => (
                        <li key={email.id || email.emailId || email.subject} className={`ed__ticket ed__ticket--${replyMode ? 'attention' : 'urgent'}`}>
                          <div className="ed__ticket-top">
                            <span className="ed__ticket-key">EMAIL</span>
                            <span className="ed__ticket-summary">{email.subject || (replyMode ? 'Needs reply' : 'Urgent email')}</span>
                            <span className="ed__ticket-sla">{email.isRead ? 'read' : 'unread'}</span>
                          </div>
                          <div className="ed__ticket-meta">
                            <span className="ed__ticket-assignee">{email.from || 'Unknown sender'}</span>
                            <span className="ed__ticket-take">{email.reason || email.summary || (replyMode ? 'Needs your reply' : 'Needs your attention')}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {emailTriage.delegate.length > 0 && (
                  <div className="ed__queue-section">
                    <p className="ed__queue-heading ed__queue-heading--attention">
                      Delegate
                      <span className="ed__queue-count">{emailTriage.delegate.length}</span>
                    </p>
                    <ul className="ed__list">
                      {emailTriage.delegate.map((email) => (
                        <li key={email.id || email.emailId || email.subject} className="ed__ticket ed__ticket--attention">
                          <div className="ed__ticket-top">
                            <span className="ed__ticket-key">EMAIL</span>
                            <span className="ed__ticket-summary">{email.subject || 'Delegate email'}</span>
                            <span className="ed__ticket-sla">{email.isRead ? 'read' : 'unread'}</span>
                          </div>
                          <div className="ed__ticket-meta">
                            <span className="ed__ticket-assignee">{email.from || 'Unknown sender'}</span>
                            <span className="ed__ticket-take">{email.reason || email.summary || 'Could be delegated'}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="ed__queue-empty">{emailSummary}</div>
            )
          ) : queueSections.length > 0 ? (
            queueSections.map(({ key, label, tone, tickets }) => (
              <div key={key} className="ed__queue-section">
                <p className={`ed__queue-heading ed__queue-heading--${tone}`}>
                  {label}
                  <span className="ed__queue-count">{tickets.length}</span>
                </p>
                <ul className="ed__list">
                  {tickets.map((t) => (
                    <li key={t.key} className={`ed__ticket ed__ticket--${tone}`}>
                      <div className="ed__ticket-top">
                        <span className="ed__ticket-key">{t.key}</span>
                        <span className="ed__ticket-summary">{t.summary}</span>
                        <span className="ed__ticket-sla">{formatSla(t.slaMins)}</span>
                      </div>
                      <div className="ed__ticket-meta">
                        <span className="ed__ticket-assignee">{t.assignee}</span>
                        {t.take && <span className="ed__ticket-take">{t.take}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div className="ed__queue-empty">{queue?.summary || 'Queue is calm right now.'}</div>
          )}
        </section>

        <div className="ed__side">
          {/* People roster — full member list from the people domain */}
          <section className="ed__panel" aria-label="People">
            <div className="ed__panel-head">
              <p className="ed__section-label">People</p>
              {people?.summary && <p className="ed__panel-summary">{people.summary}</p>}
            </div>
            <ul className="ed__list">
              {people?.members?.map((m) => (
                <li key={m.name} className="ed__person">
                  <div className="ed__person-top">
                    <span className="ed__person-name">{m.name}</span>
                    <span className={`ed__person-status ed__person-status--${m.status}`}>{m.status}</span>
                  </div>
                  <div className="ed__person-meta">
                    <span className="ed__person-role">{m.role}</span>
                    <span className="ed__person-metric">{m.metric}</span>
                  </div>
                  {m.flag && <p className="ed__person-flag">{m.flag}</p>}
                </li>
              ))}
            </ul>
          </section>

          {/* What Matters Now — from the SHARED placeholder presentation layer, the
              same source Mission Control reads. Not owned here. */}
          <section className="ed__panel" aria-label="What matters now">
            <p className="ed__section-label">What Matters Now</p>
            <ul className="ed__list">
              {presentation.whatMattersNow.map((item) => (
                <li key={item.id} className={`ed__matter ed__matter--${item.tone}`}>
                  <span className="ed__matter-title">{item.title}</span>
                  <span className="ed__matter-detail">{item.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {/* Current focus — the engine's focus domain, shown as the operational footer */}
      {focus?.current && (
        <section className="ed__focus" aria-label="Current focus">
          <span className="ed__focus-label">Focus</span>
          <span className="ed__focus-title">{focus.current.title}</span>
          {typeof focus.current.timeboxMins === 'number' && (
            <span className="ed__focus-timebox">{focus.current.timeboxMins} min</span>
          )}
        </section>
      )}
    </section>
  );
}
