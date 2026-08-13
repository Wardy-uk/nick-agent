import React, { useState, useRef, useEffect } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
import { speakIfEnabled } from '../voiceUtils';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
import './BriefingPanel.css';

const SOURCE_ICONS = {
  escalation: '!!',
  jira_ticket: 'JIRA',
  meeting: 'CAL',
  todo: 'TODO',
  nudge: 'SARA',
  imports: 'IMP',
  email: 'MAIL',
};
const { resolveNueroNavigation } = actionSurfaces;

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

function formatSlaMinutes(mins) {
  if (!mins && mins !== 0) return '';
  if (mins < 0) return 'BREACHED';
  if (mins < 60) return `${Math.round(mins)}m`;
  return `${Math.round(mins / 60)}h`;
}

export default function BriefingPanel({ onNavigate }) {
  const focusFetch = useCachedFetch('/api/focus', { interval: 30000 });
  const todoFetch = useCachedFetch('/api/todos', { interval: 60000 });
  const qaFetch = useCachedFetch('/api/qa/summary', { interval: 300000 });

  const items = focusFetch.data?.items || [];
  const sara = focusFetch.data?.sara || null;
  const tone = focusFetch.data?.tone || 'focused';
  const nextAction = focusFetch.data?.nextAction || null;
  const context = focusFetch.data?.context || {};

  const todos = todoFetch.data?.todos || [];
  const overdueTodos = todos.filter(t => !t.done && t.due_date && t.due_date < new Date().toISOString().split('T')[0]).length;

  const qaAvg = qaFetch.data?.average != null ? `${Math.round(qaFetch.data.average)}%` : (qaFetch.data?.teamAverage != null ? `${Math.round(qaFetch.data.teamAverage)}%` : '-');

  const [actionLoading, setActionLoading] = useState(null);

  // Speak SARA's opening line once per briefing visit
  const spokenRef = useRef(null);
  useEffect(() => {
    const msg = sara?.primary?.message;
    if (!msg || msg === spokenRef.current) return;
    spokenRef.current = msg;
    speakIfEnabled(msg);
  }, [sara?.primary?.message]);

  const handleCardClick = (item) => {
    const ctx = { fromBriefing: true, focusItem: item };
    const destination = resolveNueroNavigation(item);
    if (!destination) return;
    onNavigate?.(destination.view, { ...ctx, ...(destination.context || {}) });
  };

  const handleAction = async (action) => {
    setActionLoading(action.focusItemId);
    try {
      if (action.url) window.open(action.url, '_blank');
      if (action.target && onNavigate) {
        onNavigate(action.target, action.targetContext || { fromBriefing: true });
      }
      await fetch(apiUrl('/api/focus/action-done'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: action.type, detail: action.label }),
      }).catch(() => {});
      setTimeout(() => focusFetch.refresh(), 500);
    } catch {}
    setActionLoading(null);
  };

  const handleDismiss = async (e, item) => {
    e.stopPropagation();
    try {
      await fetch(apiUrl('/api/focus/dismiss'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, itemType: item.type }),
      });
      focusFetch.refresh();
    } catch {}
  };

  const getItemGuidance = (item) => {
    if (!sara?.items) return null;
    return sara.items.find(ai => ai.id === item.id) || null;
  };

  const topItems = items.slice(0, 6);

  return (
    <div className="briefing">
      {/* SARA opening line */}
      <div className={`briefing-sara briefing-tone-${tone}`}>
        <span className="briefing-sara-label">SARA</span>
        {sara?.primary?.message ? (
          <p className="briefing-sara-line">{sara.primary.message}</p>
        ) : (
          <p className="briefing-sara-line briefing-sara-loading">Assembling your briefing...</p>
        )}
        {sara?.primary?.action && (
          <p className="briefing-sara-action">{sara.primary.action}</p>
        )}
      </div>

      {/* Primary action — the one thing to do right now */}
      {nextAction && (
        <div
          className={`briefing-next briefing-next-${nextAction.urgency || 'medium'}`}
          onClick={() => handleAction(nextAction)}
        >
          <div className="briefing-next-body">
            <span className="briefing-next-badge">
              {nextAction.urgency === 'critical' ? 'NOW' : nextAction.urgency === 'high' ? 'SOON' : 'NEXT'}
            </span>
            <span className="briefing-next-label">{nextAction.label}</span>
            <span className="briefing-next-reason">{nextAction.reason}</span>
          </div>
          <button
            className="briefing-next-btn"
            disabled={actionLoading === nextAction.focusItemId}
            onClick={(e) => { e.stopPropagation(); handleAction(nextAction); }}
          >
            {actionLoading === nextAction.focusItemId ? '...' : 'Do it'}
          </button>
        </div>
      )}

      {/* Action cards */}
      {topItems.length > 0 ? (
        <div className="briefing-cards">
          {topItems.map((item, i) => {
            const guidance = getItemGuidance(item);
            return (
              <div
                key={item.id || i}
                className={`briefing-card briefing-card-${item.urgency || 'low'}`}
                onClick={() => handleCardClick(item)}
              >
                <div className="briefing-card-head">
                  <span className="briefing-card-source">{SOURCE_ICONS[item.type] || '·'}</span>
                  {item.meta?.ticket_key && (
                    <span className="briefing-card-key">{item.meta.ticket_key}</span>
                  )}
                  {item.meta?.sla_remaining_minutes != null && (
                    <span className={`briefing-card-sla ${item.meta.sla_remaining_minutes < 0 ? 'sla-breached' : item.meta.sla_remaining_minutes < 120 ? 'sla-danger' : ''}`}>
                      {formatSlaMinutes(item.meta.sla_remaining_minutes)}
                    </span>
                  )}
                  <button
                    className="briefing-card-dismiss"
                    onClick={(e) => handleDismiss(e, item)}
                    title="Dismiss"
                  >&times;</button>
                </div>
                <div className="briefing-card-title">{item.title}</div>
                <div className="briefing-card-take">
                  {guidance?.why || item.reason}
                </div>
                {item.meta?.escalations?.length > 1 && (
                  <ul className="briefing-card-list">
                    {item.meta.escalations.map(e => (
                      <li key={e.key}>
                        {e.url ? (
                          /* the card itself navigates in-app — don't let that swallow the link */
                          <a
                            className="briefing-card-list-link"
                            href={e.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            <span className="briefing-card-list-key">{e.key}</span>
                            <span className="briefing-card-list-text">{e.summary}</span>
                          </a>
                        ) : (
                          <>
                            <span className="briefing-card-list-key">{e.key}</span>
                            <span className="briefing-card-list-text">{e.summary}</span>
                          </>
                        )}
                        {e.ageDays != null && (
                          <span className="briefing-card-list-age">{e.ageDays === 0 ? 'today' : `${e.ageDays}d`}</span>
                        )}
                      </li>
                    ))}
                    {item.meta.overflow > 0 && (
                      <li className="briefing-card-list-more">+{item.meta.overflow} more</li>
                    )}
                  </ul>
                )}
                {guidance?.action && (
                  <div className="briefing-card-cta">{guidance.action}</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="briefing-empty">
          <div className="briefing-empty-line">Nothing on fire. Rare. Use it well.</div>
        </div>
      )}

      {/* Quick stats bar */}
      <div className="briefing-stats">
        <div className="briefing-stat" onClick={() => onNavigate?.('people')}>
          <span className="briefing-stat-val">{qaAvg}</span>
          <span className="briefing-stat-lbl">QA Avg</span>
        </div>
        <div className={`briefing-stat ${overdueTodos > 0 ? 'stat-warn' : ''}`} onClick={() => onNavigate?.('todos', { filter: 'overdue' })}>
          <span className="briefing-stat-val">{overdueTodos || 0}</span>
          <span className="briefing-stat-lbl">Overdue</span>
        </div>
      </div>

      {/* Standup nudge if not done */}
      {context.standupDone === false && (
        <button className="briefing-standup-nudge" onClick={() => onNavigate?.('standup')}>
          Standup not done yet &rarr;
        </button>
      )}

      {/* Footer */}
      <div className="briefing-footer">
        {focusFetch.data?.generatedAt && (
          <span>Updated {timeAgo(focusFetch.data.generatedAt)}</span>
        )}
        <button className="briefing-refresh" onClick={focusFetch.refresh}>Refresh</button>
      </div>
    </div>
  );
}
