import React, { useState, useEffect } from 'react';
import useCachedFetch from '../useCachedFetch';
import useAttention from '../useAttention';
import AttentionCard from './AttentionCard';
import './FocusPanel.css';

/**
 * Focus — the one-at-a-time deck.
 *
 * A SUPPORTING view now: `Now` is the execution surface and the default screen,
 * and this is the place to page through the pool one card at a time when the
 * top of it is not the thing you want.
 *
 * ── What changed, and why each was wrong ────────────────────────────────────
 *
 * **"Done" POSTed `/api/focus/action-done`.** That logs an outcome through
 * `nextActionEngine.logOutcome()` and dismisses the item — but it never
 * completed the underlying task, so ticking a card here left the task open and
 * hid the reminder about it. It now goes through the canonical `complete`
 * action, which resolves the record AND closes the task where one can be found,
 * and says which of the two actually happened.
 *
 * **"Defer" POSTed `/api/focus/dismiss`.** So "not now" and "not mine"
 * collapsed into one gesture, and the difference — the thing the friction read
 * is built on — was thrown away at the moment Nick expressed it. The escalating
 * DEFER_MESSAGES that went with it ("You're avoiding this") are gone: they were
 * counted in `localStorage`, so the number was per-browser rather than a fact
 * about the work, and the wording was a claim about Nick that no evidence
 * supported. Deferrals are recorded server-side with a reason now, and
 * `FrictionSection` says what they add up to, neutrally.
 *
 * The card itself is `AttentionCard`, shared with Now and Briefing, so the
 * actions cannot come to mean three different things on three screens.
 */

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function FocusPanel({ onNavigate }) {
  // Read-only: SARA's line and the tone are not in the attention contract.
  const { data: focusData, status } = useCachedFetch('/api/focus', { interval: 30000 });
  const attention = useAttention({ interval: 30000 });

  const sara = focusData?.sara || null;
  const tone = focusData?.tone || 'focused';

  const cards = attention.cards;
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (currentIndex >= cards.length && cards.length > 0) setCurrentIndex(cards.length - 1);
  }, [cards.length, currentIndex]);

  const current = cards[currentIndex] || null;

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

      {/* ⚠ Four states, kept apart. An unreadable pool must never render as the
          clear one — that is the false all-clear the attention contract exists
          to prevent, and a big green tick over it is the worst possible way to
          get it wrong. */}
      {attention.poolAvailable === false ? (
        <div className="focus-clear focus-clear-warn">
          <div className="focus-clear-text">I can&rsquo;t see your work right now.</div>
          <div className="focus-clear-sub">This is not an all-clear &mdash; the pool could not be read.</div>
        </div>
      ) : attention.contextCard && cards.length === 0 ? (
        <div className="focus-clear">
          <div className="focus-clear-text">{attention.contextCard.title}</div>
          <div className="focus-clear-sub">{attention.contextCard.reason}</div>
        </div>
      ) : cards.length === 0 ? (
        attention.loading ? (
          <div className="focus-clear"><div className="focus-clear-text">Looking&hellip;</div></div>
        ) : (
          <div className="focus-clear">
            <div className="focus-clear-check">&#x2713;</div>
            <div className="focus-clear-text">Nothing needs you right now.</div>
            <div className="focus-clear-sub">Calendar and tasks are clear.</div>
          </div>
        )
      ) : current ? (
        <AttentionCard
          card={current}
          onNavigate={onNavigate}
          onAct={attention.act}
        />
      ) : null}

      {/* Navigation dots */}
      {cards.length > 1 && (
        <div className="focus-nav">
          {cards.map((card, i) => (
            <button
              key={card.recordId || card.id || i}
              className={`focus-nav-dot ${i === currentIndex ? 'focus-nav-active' : ''} ${card.urgency === 'critical' ? 'focus-nav-critical' : ''}`}
              onClick={() => setCurrentIndex(i)}
              title={card.title}
            />
          ))}
          <span className="focus-nav-count">{currentIndex + 1}/{cards.length}</span>
        </div>
      )}

      {/* Held back, and inputs that could not be read. Never swallowed. */}
      {(attention.dropped.length > 0 || attention.gaps.length > 0) && (
        <p className="focus-held">
          {attention.dropped.length > 0 && `${attention.dropped.length} held back`}
          {attention.dropped.length > 0 && attention.gaps.length > 0 && ' · '}
          {attention.gaps.length > 0 && `${attention.gaps.length} couldn't be read`}
        </p>
      )}

      {/* Footer */}
      <div className="focus-footer">
        {attention.data?.generatedAt && (
          <span className="focus-footer-time">
            Updated {timeAgo(attention.data.generatedAt)}
            {status === 'cached' && ' · cached'}
          </span>
        )}
        <button className="focus-footer-refresh" onClick={attention.refresh}>↻</button>
      </div>
    </div>
  );
}
