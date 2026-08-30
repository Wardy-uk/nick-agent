import React, { useRef, useEffect } from 'react';
import useCachedFetch from '../useCachedFetch';
import useAttention from '../useAttention';
import AttentionCard from './AttentionCard';
import { speakIfEnabled } from '../voiceUtils';
import './BriefingPanel.css';

/**
 * Briefing — the morning read.
 *
 * A SUPPORTING view now, not a second "what should I do?" surface: `Now` is
 * where work gets started, and this is where the day gets framed. It still owns
 * SARA's opening line, the tone and the day's context, because none of those
 * are in the attention contract.
 *
 * ⚠ THE BUG THIS FILE CARRIED. Clicking "Do it" POSTed
 * `/api/focus/action-done`, which calls `nextActionEngine.logOutcome()` AND
 * dismisses the item — so pressing the button that merely OPENS a thing
 * recorded it as a completed outcome and hid it, before any work had been done.
 * Both halves were wrong and both were invisible: the card vanished, which
 * looks exactly like the button having worked. There is no state of the world
 * in which "I am starting this" should log a completion.
 *
 * The cards are canonical attention now, rendered by the shared `AttentionCard`,
 * so Open context navigates and calls nothing, Start this starts a session and
 * moves no state, and only an explicit Done resolves anything. Nothing on this
 * screen writes to `/api/focus` any more.
 */

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function BriefingPanel({ onNavigate }) {
  // Read-only, and only for what the attention contract does not carry: SARA's
  // briefing prose, the tone, and whether the rituals are done.
  const focusFetch = useCachedFetch('/api/focus', { interval: 30000 });
  const todoFetch = useCachedFetch('/api/todos', { interval: 60000 });
  const qaFetch = useCachedFetch('/api/qa/summary', { interval: 300000 });
  const attention = useAttention({ interval: 30000 });

  const sara = focusFetch.data?.sara || null;
  const tone = focusFetch.data?.tone || 'focused';
  const context = focusFetch.data?.context || {};

  const todos = todoFetch.data?.todos || [];
  const overdueTodos = todos.filter(
    t => !t.done && t.due_date && t.due_date < new Date().toISOString().split('T')[0]
  ).length;

  const qaAvg = qaFetch.data?.average != null
    ? `${Math.round(qaFetch.data.average)}%`
    : (qaFetch.data?.teamAverage != null ? `${Math.round(qaFetch.data.teamAverage)}%` : '-');

  // Speak SARA's opening line once per briefing visit
  const spokenRef = useRef(null);
  useEffect(() => {
    const msg = sara?.primary?.message;
    if (!msg || msg === spokenRef.current) return;
    spokenRef.current = msg;
    speakIfEnabled(msg);
  }, [sara?.primary?.message]);

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

      {/* Canonical attention. The wording, the destination and the permitted
          actions all come off the record — nothing is composed here. */}
      {attention.poolAvailable === false ? (
        <div className="briefing-empty briefing-empty-warn">
          <div className="briefing-empty-line">
            I can&rsquo;t see your work right now &mdash; this is not an all-clear.
          </div>
        </div>
      ) : attention.cards.length > 0 ? (
        <div className="briefing-cards">
          {attention.cards.slice(0, 6).map((card) => (
            <AttentionCard
              key={card.recordId || card.id}
              card={card}
              onNavigate={onNavigate}
              onAct={attention.act}
            />
          ))}
        </div>
      ) : attention.contextCard ? (
        <div className="briefing-empty">
          <div className="briefing-empty-line">{attention.contextCard.title}</div>
          <div className="briefing-empty-sub">{attention.contextCard.reason}</div>
        </div>
      ) : attention.loading ? (
        <div className="briefing-empty">
          <div className="briefing-empty-line">Looking&hellip;</div>
        </div>
      ) : (
        <div className="briefing-empty">
          <div className="briefing-empty-line">Nothing on fire. Rare. Use it well.</div>
        </div>
      )}

      {/* Held back, and inputs that could not be read. Never swallowed. */}
      {(attention.dropped.length > 0 || attention.gaps.length > 0) && (
        <p className="briefing-held">
          {attention.dropped.length > 0 && `${attention.dropped.length} held back`}
          {attention.dropped.length > 0 && attention.gaps.length > 0 && ' · '}
          {attention.gaps.length > 0 && `${attention.gaps.length} couldn't be read`}
        </p>
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
        {attention.data?.generatedAt && (
          <span>Updated {timeAgo(attention.data.generatedAt)}</span>
        )}
        <button className="briefing-refresh" onClick={() => { attention.refresh(); focusFetch.refresh(); }}>Refresh</button>
      </div>
    </div>
  );
}
