import React, { useState, useEffect, useCallback } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
import './FocusPanel.css';

const TYPE_ICONS = {
  escalation: '!!',
  jira_ticket: '#',
  meeting: '@',
  todo: '[ ]',
  nudge: '~',
  imports: '>',
  email: '\u2709',
  nova_flag: '!!',
};

const DEFER_MESSAGES = [
  "Moved to tomorrow morning.",
  "That\u2019s twice. When are you actually doing this?",
  "You\u2019re avoiding this. What\u2019s blocking you?",
];
const { resolveNueroNavigation } = actionSurfaces;

function getDeferCount(itemId) {
  try {
    const stored = JSON.parse(localStorage.getItem('sara-defers') || '{}');
    return stored[itemId] || 0;
  } catch { return 0; }
}

function incrementDefer(itemId) {
  try {
    const stored = JSON.parse(localStorage.getItem('sara-defers') || '{}');
    stored[itemId] = (stored[itemId] || 0) + 1;
    localStorage.setItem('sara-defers', JSON.stringify(stored));
    return stored[itemId];
  } catch { return 1; }
}

function clearDefer(itemId) {
  try {
    const stored = JSON.parse(localStorage.getItem('sara-defers') || '{}');
    delete stored[itemId];
    localStorage.setItem('sara-defers', JSON.stringify(stored));
  } catch {}
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function FocusPanel({ onNavigate }) {
  const { data, status, refresh } = useCachedFetch('/api/focus', { interval: 30000 });

  const items = (data?.items || []).slice(0, 5);
  const sara = data?.sara || null;
  const tone = data?.tone || 'focused';

  const [currentIndex, setCurrentIndex] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [deferFeedback, setDeferFeedback] = useState(null);
  const [doneAnimation, setDoneAnimation] = useState(false);

  useEffect(() => {
    if (currentIndex >= items.length && items.length > 0) {
      setCurrentIndex(items.length - 1);
    }
  }, [items.length, currentIndex]);

  const current = items[currentIndex] || null;
  const guidance = current && sara?.items
    ? sara.items.find(ai => ai.id === current.id) || null
    : null;

  const handleDone = useCallback(async () => {
    if (!current || actionLoading) return;
    setActionLoading(true);
    setDoneAnimation(true);

    try {
      await fetch(apiUrl('/api/focus/action-done'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: current.type,
          detail: current.title,
          itemId: current.id,
          itemType: current.type,
        }),
      });
      clearDefer(current.id);
    } catch {}

    setTimeout(() => {
      setDoneAnimation(false);
      setActionLoading(false);
      refresh();
    }, 400);
  }, [current, actionLoading, refresh]);

  const handleDefer = useCallback(async () => {
    if (!current || actionLoading) return;
    setActionLoading(true);

    const count = incrementDefer(current.id);
    const msgIndex = Math.min(count - 1, DEFER_MESSAGES.length - 1);
    setDeferFeedback(DEFER_MESSAGES[msgIndex]);

    try {
      await fetch(apiUrl('/api/focus/dismiss'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: current.id, itemType: current.type }),
      });
    } catch {}

    setTimeout(() => {
      setDeferFeedback(null);
      setActionLoading(false);
      refresh();
    }, count >= 3 ? 3000 : 1800);
  }, [current, actionLoading, refresh]);

  const handleSnooze = useCallback(async () => {
    if (!current || actionLoading) return;
    setActionLoading(true);
    setDeferFeedback('Snoozed for 1 hour.');

    try {
      await fetch(apiUrl('/api/focus/snooze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: current.id, itemType: current.type, durationMinutes: 60 }),
      });
    } catch {}

    setTimeout(() => {
      setDeferFeedback(null);
      setActionLoading(false);
      refresh();
    }, 1400);
  }, [current, actionLoading, refresh]);

  const handleHideToday = useCallback(async () => {
    if (!current || actionLoading) return;
    setActionLoading(true);
    setDeferFeedback('Hidden until tomorrow.');

    try {
      await fetch(apiUrl('/api/focus/hide-today'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: current.id, itemType: current.type }),
      });
    } catch {}

    setTimeout(() => {
      setDeferFeedback(null);
      setActionLoading(false);
      refresh();
    }, 1400);
  }, [current, actionLoading, refresh]);

  const handleNavigate = (item) => {
    if (!item) return;
    const ctx = { fromFocus: true, focusItem: item };
    const destination = resolveNueroNavigation(item);
    if (!destination) return;
    onNavigate?.(destination.view, { ...ctx, ...(destination.context || {}) });
  };

  const deferCount = current ? getDeferCount(current.id) : 0;
  const isNovaFlag = current?.type === 'nova_flag';

  return (
    <div className="focus-panel">
      {/* SARA line */}
      {sara?.primary && (
        <div className={`focus-sara focus-sara-${tone}`}>
          <span className="focus-sara-label">SARA</span>
          <p className="focus-sara-line">{sara.primary.message}</p>
          {sara.primary.action && (
            <span className="focus-sara-action">{sara.primary.action}</span>
          )}
        </div>
      )}

      {/* Defer feedback overlay */}
      {deferFeedback && (
        <div className={`focus-defer-feedback ${deferCount >= 3 ? 'focus-defer-hard' : deferCount >= 2 ? 'focus-defer-medium' : ''}`}>
          <span className="focus-defer-feedback-text">{deferFeedback}</span>
        </div>
      )}

      {/* Main card area */}
      {items.length === 0 ? (
        <div className="focus-clear">
          <div className="focus-clear-check">\u2713</div>
          <div className="focus-clear-text">Nothing needs you right now.</div>
          <div className="focus-clear-sub">Queue, calendar, and todos are clear.</div>
        </div>
      ) : current ? (
        <div className={`focus-card focus-card-${current.urgency || 'low'} ${doneAnimation ? 'focus-card-done' : ''}`}>
          <div className="focus-card-type">
            <span className="focus-card-icon">{TYPE_ICONS[current.type] || '\u00b7'}</span>
            <span className="focus-card-type-label">{current.type?.replace('_', ' ')}</span>
            {current.urgency && (
              <span className={`focus-card-urgency focus-card-urgency-${current.urgency}`}>
                {current.urgency === 'critical' ? 'NOW' : current.urgency === 'high' ? 'SOON' : current.urgency === 'medium' ? 'TODAY' : 'LATER'}
              </span>
            )}
          </div>

          <h2 className="focus-card-title">{current.title}</h2>

          <p className="focus-card-reason">
            {guidance?.why || current.reason}
          </p>

          {/* Escalations name themselves — a count alone isn't actionable */}
          {current.meta?.escalations?.length > 1 && (
            <ul className="focus-card-list">
              {current.meta.escalations.map(e => (
                <li key={e.key} className="focus-card-list-item">
                  <span className="focus-card-list-key">{e.key}</span>
                  <span className="focus-card-list-text">{e.summary}</span>
                  {e.ageDays != null && (
                    <span className="focus-card-list-age">{e.ageDays === 0 ? 'today' : `${e.ageDays}d`}</span>
                  )}
                </li>
              ))}
              {current.meta.overflow > 0 && (
                <li className="focus-card-list-more">+{current.meta.overflow} more</li>
              )}
            </ul>
          )}

          {guidance?.action && (
            <div className="focus-card-action">{guidance.action}</div>
          )}

          {current.meta?.time && (
            <div className="focus-card-time">{current.meta.time}</div>
          )}

          {deferCount > 0 && !deferFeedback && (
            <div className={`focus-card-defer-count ${deferCount >= 2 ? 'focus-card-defer-warn' : ''}`}>
              Deferred {deferCount}x
            </div>
          )}

          {/* Action buttons */}
          <div className="focus-card-actions">
            <button
              className="focus-btn-done"
              onClick={handleDone}
              disabled={actionLoading}
            >
              Done
            </button>
            {isNovaFlag ? (
              <>
                <button
                  className="focus-btn-defer"
                  onClick={handleSnooze}
                  disabled={actionLoading}
                >
                  Snooze
                </button>
                <button
                  className="focus-btn-hide"
                  onClick={handleHideToday}
                  disabled={actionLoading}
                >
                  Hide today
                </button>
              </>
            ) : (
              <button
                className={`focus-btn-defer ${deferCount >= 2 ? 'focus-btn-defer-warn' : ''}`}
                onClick={handleDefer}
                disabled={actionLoading}
              >
                Defer
              </button>
            )}
            <button
              className="focus-btn-open"
              onClick={() => handleNavigate(current)}
            >
              Open \u2192
            </button>
          </div>
        </div>
      ) : null}

      {/* Navigation dots */}
      {items.length > 1 && (
        <div className="focus-nav">
          {items.map((item, i) => (
            <button
              key={item.id || i}
              className={`focus-nav-dot ${i === currentIndex ? 'focus-nav-active' : ''} ${item.urgency === 'critical' ? 'focus-nav-critical' : ''}`}
              onClick={() => { setCurrentIndex(i); setDeferFeedback(null); }}
              title={item.title}
            />
          ))}
          <span className="focus-nav-count">{currentIndex + 1}/{items.length}</span>
        </div>
      )}

      {/* Footer */}
      <div className="focus-footer">
        {data?.generatedAt && (
          <span className="focus-footer-time">
            Updated {timeAgo(data.generatedAt)}
            {status === 'cached' && ' \u00b7 cached'}
          </span>
        )}
        <button className="focus-footer-refresh" onClick={refresh}>↻</button>
      </div>
    </div>
  );
}
