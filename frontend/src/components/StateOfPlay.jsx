import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './StateOfPlay.css';

const REFRESH_MS = 60000;

function fmtDate(value) {
  if (!value) return 'never';
  const t = Date.parse(String(value).replace(' ', 'T'));
  if (Number.isNaN(t)) return String(value);
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtTime(value) {
  if (!value) return '';
  const t = Date.parse(String(value).replace(' ', 'T'));
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** A headline number. `tone` colours it only when it means something. */
function Stat({ label, value, sub, tone = 'neutral', onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`sop-stat sop-tone-${tone}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      <span className="sop-stat-value">{value}</span>
      <span className="sop-stat-label">{label}</span>
      {sub && <span className="sop-stat-sub">{sub}</span>}
    </Tag>
  );
}

/**
 * A proportional bar. Segments carry their own colour so MoSCoW reads the same
 * here as it does on Tasks — a must that is amber in one place and blue in
 * another is a bar you have to decode twice.
 */
function SplitBar({ segments }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  if (!total) return <div className="sop-bar sop-bar-empty" />;
  return (
    <>
      <div className="sop-bar">
        {segments.filter(s => s.value > 0).map(s => (
          <span
            key={s.key}
            className={`sop-bar-seg sop-seg-${s.key}`}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <div className="sop-bar-key">
        {segments.filter(s => s.value > 0).map(s => (
          <span key={s.key} className="sop-bar-key-item">
            <i className={`sop-dot sop-seg-${s.key}`} />
            {s.label} <b>{s.value}</b>
          </span>
        ))}
      </div>
    </>
  );
}

/** Sparkline over a short series. Bars, not a line — the counts are discrete. */
function Spark({ points, tone = 'accent' }) {
  const max = Math.max(1, ...points.map(p => p.value));
  return (
    <div className={`sop-spark sop-spark-${tone}`}>
      {points.map((p, i) => (
        <span key={i} className="sop-spark-bar" style={{ height: `${Math.max(6, (p.value / max) * 100)}%` }}
              title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  );
}

function Card({ title, action, children, wide }) {
  return (
    <section className={`sop-card${wide ? ' sop-card-wide' : ''}`}>
      <header className="sop-card-head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

export default function StateOfPlay({ onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch(apiUrl('/api/state-of-play'))
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error || r.status))))
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) return <div className="sop-panel"><div className="sop-loading">Reading the state of play…</div></div>;
  if (error && !data) return <div className="sop-panel"><div className="sop-error">Couldn’t load<span>{error}</span></div></div>;
  if (!data) return null;

  // ⚠ `queue` is deliberately NOT destructured. The service stopped sending it
  // when the Jira queue was removed on 27 Aug 2026; reading it here is what
  // crashed the panel. If it ever comes back it needs a card that tolerates the
  // field being absent, because a missing block must render as "not known",
  // never as a throw.
  const { tasks, commitments, approvals, inbox, rituals, vault, jobs, calendar, issues, overall } = data;
  const go = (view) => onNavigate && onNavigate(view);

  const moscowSegments = [
    { key: 'must', label: 'Must', value: tasks.moscow.must || 0 },
    { key: 'should', label: 'Should', value: tasks.moscow.should || 0 },
    { key: 'could', label: 'Could', value: tasks.moscow.could || 0 },
    { key: 'unset', label: 'Unset', value: tasks.moscow.unset || 0 },
  ];

  const okJobs = jobs.filter(j => j.state === 'ok').length;

  return (
    <div className="sop-panel">
      {/* ── Focus band: what is actually wrong, worst first ─────────────── */}
      <section className={`sop-focus sop-overall-${overall}`}>
        <div className="sop-focus-head">
          <div>
            <h2>State of play</h2>
            <p className="sop-focus-sub">
              {issues.length === 0
                ? 'Nothing needs attention.'
                : `${issues.length} thing${issues.length === 1 ? '' : 's'} worth knowing about.`}
            </p>
          </div>
          <button className="sop-refresh" onClick={load} title="Refresh">↻</button>
        </div>

        {issues.length > 0 && (
          <ul className="sop-issues">
            {issues.map((issue, i) => (
              <li key={i} className={`sop-issue sop-sev-${issue.severity}`}>
                <button type="button" onClick={() => go(issue.view)}>
                  <span className="sop-issue-title">{issue.title}</span>
                  <span className="sop-issue-detail">{issue.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Headline numbers ─────────────────────────────────────────────── */}
      <div className="sop-stats">
        <Stat label="Open tasks" value={tasks.open} sub={`${tasks.done} done`} onClick={() => go('todos')} />
        <Stat label="Overdue" value={tasks.overdue} tone={tasks.overdue > 0 ? 'danger' : 'good'} onClick={() => go('todos')} />
        <Stat label="Awaiting approval" value={approvals.pending}
              tone={approvals.pending > 0 ? 'warn' : 'good'} onClick={() => go('actions')} />
        <Stat label="Owed to you" value={commitments.open} sub={`${commitments.people} people`}
              tone={commitments.open > 100 ? 'warn' : 'neutral'} onClick={() => go('people')} />
        <Stat label="Inbox" value={inbox.open} sub={`${inbox.byUrgency.high || 0} high`}
              tone={(inbox.byUrgency.high || 0) > 0 ? 'warn' : 'neutral'} onClick={() => go('inbox')} />
        <Stat label="Jobs healthy" value={`${okJobs}/${jobs.length}`}
              tone={okJobs === jobs.length ? 'good' : 'danger'} />
      </div>

      <div className="sop-grid">
        {/* ── Tasks ──────────────────────────────────────────────────────── */}
        <Card title="Tasks" action={<button className="sop-link" onClick={() => go('todos')}>Open →</button>}>
          <SplitBar segments={moscowSegments} />
          <dl className="sop-facts">
            <div><dt>Overdue</dt><dd className={tasks.overdue ? 'sop-bad' : ''}>{tasks.overdue}</dd></div>
            <div><dt>Due today</dt><dd>{tasks.dueToday}</dd></div>
            <div><dt>No due date</dt><dd>{tasks.noDueDate}</dd></div>
            <div><dt>Estimated</dt><dd className={tasks.estimated === 0 ? 'sop-bad' : ''}>{tasks.estimated}/{tasks.open}</dd></div>
          </dl>
          <div className="sop-context">
            {tasks.byContext.slice(0, 6).map(c => (
              <span key={c.k} className="sop-chip">{c.k} <b>{c.c}</b></span>
            ))}
          </div>
        </Card>

        {/* ── Commitments ────────────────────────────────────────────────── */}
        <Card title="Waiting on others" action={<button className="sop-link" onClick={() => go('people')}>Open →</button>}>
          <ul className="sop-people">
            {commitments.top.map(p => (
              <li key={p.person}>
                <span className="sop-person">{p.person}</span>
                <span className="sop-person-bar">
                  <i style={{ width: `${(p.count / (commitments.top[0]?.count || 1)) * 100}%` }} />
                </span>
                <span className="sop-person-n">{p.count}</span>
                <span className={`sop-person-age${p.ageDays > 90 ? ' sop-bad' : ''}`}>
                  {p.ageDays != null ? `${p.ageDays}d` : '—'}
                </span>
              </li>
            ))}
            {commitments.top.length === 0 && <li className="sop-empty">Nothing outstanding.</li>}
          </ul>
        </Card>

        {/* ⚠ The "Support queue" card was REMOVED here on 30 Aug 2026, and it had
            been crashing this whole panel since 27 Aug.

            The Jira queue was ripped out that day — `getQueueSummary` and the
            cache it read are gone, and the service correctly stopped emitting a
            `queue` block. This component was missed, so `queue` destructured to
            `undefined` and `queue.staleDays` threw on every render. With no
            error boundary above it that took the entire app down, not just this
            screen, which is why several unrelated menus looked broken at once.

            Escalations are untouched and are still reachable from the issue list
            above; they never came from the queue cache. */}

        {/* ── Rituals ────────────────────────────────────────────────────── */}
        <Card title="Rituals" action={<button className="sop-link" onClick={() => go('standup')}>Standup →</button>}>
          <div className="sop-ritual-row">
            <span className="sop-ritual-label">Standup</span>
            <div className="sop-cells">
              {rituals.days.map(d => (
                <i key={d.date_key} className={d.standup_done ? 'sop-cell on' : 'sop-cell'} title={d.date_key} />
              ))}
            </div>
            <span className="sop-ritual-n">{rituals.standupDays}/{rituals.window}</span>
          </div>
          <div className="sop-ritual-row">
            <span className="sop-ritual-label">EOD</span>
            <div className="sop-cells">
              {rituals.days.map(d => (
                <i key={d.date_key} className={d.eod_done ? 'sop-cell on' : 'sop-cell'} title={d.date_key} />
              ))}
            </div>
            <span className="sop-ritual-n">{rituals.eodDays}/{rituals.window}</span>
          </div>
          <p className="sop-note">Last {rituals.window} logged days.</p>
        </Card>

        {/* ── Approvals ──────────────────────────────────────────────────── */}
        <Card title="Approval queue" action={<button className="sop-link" onClick={() => go('actions')}>Open →</button>}>
          <Spark points={approvals.recent.map(r => ({ label: r.d, value: r.c }))} />
          <p className="sop-note">Actions raised, last 14 days.</p>
          {/* Outbound stated separately and first. "4 pending" and "1 of them
              sends an email to a real person" are different facts, and only the
              second one decides whether this needs looking at today. */}
          {approvals.pending > 0 && (
            <div className={`sop-freshness${approvals.outbound > 0 ? ' sop-stale' : ''}`}>
              {approvals.outbound > 0
                ? `${approvals.outbound} would send to a real person · ${approvals.pending - approvals.outbound} internal`
                : `All ${approvals.pending} internal — nothing here sends anything`}
            </div>
          )}
          <ul className="sop-statuses">
            {Object.entries(approvals.pendingByType).map(([k, v]) => (
              <li key={k}><span>{k.replace(/_/g, ' ')}</span><b>{v}</b></li>
            ))}
            {approvals.pending === 0 && <li className="sop-empty">Queue is clear.</li>}
          </ul>
        </Card>

        {/* ── System ─────────────────────────────────────────────────────── */}
        <Card title="Scheduled jobs">
          <ul className="sop-jobs">
            {jobs.map(j => (
              <li key={j.name} className={`sop-job sop-job-${j.state}`}>
                <span className="sop-job-dot" />
                <span className="sop-job-name">{j.name}</span>
                <span className="sop-job-when">
                  {j.state === 'never' ? 'never run' : `${fmtDate(j.lastRun)}${j.ageDays > 0 ? ` · ${j.ageDays}d` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* ── Vault ──────────────────────────────────────────────────────── */}
        <Card title="Vault index" action={<button className="sop-link" onClick={() => go('vault')}>Open →</button>}>
          <dl className="sop-facts">
            <div><dt>Files indexed</dt><dd>{vault.files.toLocaleString()}</dd></div>
            <div><dt>Chunks</dt><dd>{vault.chunks.toLocaleString()}</dd></div>
            <div><dt>Entities</dt><dd>{vault.entities.toLocaleString()}</dd></div>
            <div><dt>Links</dt><dd>{vault.links.toLocaleString()}</dd></div>
          </dl>
          <p className="sop-note">
            Last embedded {fmtDate(vault.lastEmbedAt)} {fmtTime(vault.lastEmbedAt)}
          </p>
        </Card>

        {/* ── Next up ────────────────────────────────────────────────────── */}
        <Card title="Next up" action={<button className="sop-link" onClick={() => go('calendar')}>Calendar →</button>}>
          <ul className="sop-events">
            {calendar.upcoming.map((e, i) => (
              <li key={i} className={e.show_as === 'free' ? 'sop-event-free' : ''}>
                <span className="sop-event-when">{fmtDate(e.start_time)} {fmtTime(e.start_time)}</span>
                <span className="sop-event-subject">{e.subject}</span>
              </li>
            ))}
            {calendar.upcoming.length === 0 && <li className="sop-empty">Nothing in the diary.</li>}
          </ul>
        </Card>
      </div>

      <p className="sop-stamp">Generated {fmtTime(data.generatedAt)} · refreshes every minute</p>
    </div>
  );
}
