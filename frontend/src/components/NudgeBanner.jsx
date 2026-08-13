import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiUrl, API_BASE } from '../api';
import useCachedFetch from '../useCachedFetch';
import { speakIfEnabled } from '../voiceUtils';
import './NudgeBanner.css';

// Snooze durations offered per nudge. `minutes` is a function so "rest of day"
// is measured from when the button is actually pressed.
const SNOOZE_OPTIONS = [
  { label: '30 min', minutes: () => 30 },
  { label: '1 hour', minutes: () => 60 },
  { label: '3 hours', minutes: () => 180 },
  {
    label: 'Rest of day',
    minutes: () => {
      const end = new Date();
      end.setHours(23, 59, 0, 0);
      return Math.max(5, Math.round((end.getTime() - Date.now()) / 60000));
    }
  }
];

export default function NudgeBanner({ onGoToStandup, onGoToTodos, onGoToJournal, onGoToPeople, onGoToBriefing, onGoToInbox }) {
  const transform = useMemo(() => (json) => ({
    nudges: json.nudges || [],
    snoozeState: json.snoozeState || {}
  }), []);
  const { data: nudgeData } = useCachedFetch('/api/nudges', { interval: 30000, transform });
  const [nudges, setNudges] = useState([]);
  const [snoozed, setSnoozed] = useState({}); // { todo: 1755102000000 } — snoozed-until epoch ms
  const [menuOpen, setMenuOpen] = useState(null); // nudge type whose snooze menu is open
  const [now, setNow] = useState(() => Date.now());

  // Close the snooze menu when clicking anywhere outside it
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e) => {
      if (!e.target.closest('.nudge-snooze-wrap')) setMenuOpen(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [menuOpen]);

  // Cheap ticker so a snooze expires on its own without a page refresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const applySnooze = (type, until) => {
    setSnoozed(prev => ({ ...prev, [type]: until }));
    setNow(Date.now());
  };

  // Sync fetched nudges + snooze state into local state
  useEffect(() => {
    if (!nudgeData) return;
    setNudges(nudgeData.nudges);
    // Seed snooze state from server — makes all devices consistent
    const serverSnooze = nudgeData.snoozeState || {};
    const current = Date.now();
    const newSnoozed = {};
    for (const [type, until] of Object.entries(serverSnooze)) {
      if (until && current < until) newSnoozed[type] = until;
    }
    setSnoozed(newSnoozed);
    setNow(current);
  }, [nudgeData]);

  const handleSnooze = (type, minutes) => {
    setMenuOpen(null);
    // Optimistic — the server response confirms the exact expiry
    applySnooze(type, Date.now() + minutes * 60 * 1000);
    fetch(apiUrl(`/api/nudges/${type}/snooze`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes })
    })
      .then(r => r.json())
      .then(res => { if (res && res.until) applySnooze(type, res.until); })
      .catch(console.error);
  };

  // SSE stream for real-time nudge updates
  useEffect(() => {
    let es;
    try {
      es = new EventSource(apiUrl('/api/nudges/stream'));
      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'nudge') {
          setNudges(prev => {
            // Update or add nudge
            const existing = prev.find(n => n.type === data.nudge_type && n.active);
            if (existing) {
              return prev.map(n =>
                n.type === data.nudge_type && n.active
                  ? { ...n, message: data.message, nag_count: data.nag_count }
                  : n
              );
            }
            return [...prev, { type: data.nudge_type, message: data.message, nag_count: data.nag_count, active: 1 }];
          });
        } else if (data.type === 'nudge_cleared') {
          setNudges(prev => prev.filter(n => n.type !== data.nudge_type));
        } else if (data.type === 'nudge_snoozed') {
          const until = data.until || (Date.now() + 30 * 60 * 1000);
          setSnoozed(prev => ({ ...prev, [data.nudge_type]: until }));
          setNow(Date.now());
        }
      };
    } catch (e) { /* SSE not supported or connection failed */ }

    return () => { if (es) es.close(); };
  }, []);

  const handleDismiss = (nudge) => {
    if (nudge.id) {
      fetch(apiUrl(`/api/nudges/${nudge.id}/complete`), { method: 'POST' }).catch(console.error);
    }
    setNudges(prev => prev.filter(n => n !== nudge));
  };

  // Speak new nudges aloud (once per nudge type per session)
  const spokenNudgesRef = useRef(new Set());
  useEffect(() => {
    const visible = nudges.filter(n => !(snoozed[n.type] > Date.now()));
    for (const n of visible) {
      const key = `${n.type}_${n.nag_count || 0}`;
      if (!spokenNudgesRef.current.has(key) && n.message) {
        spokenNudgesRef.current.add(key);
        speakIfEnabled(n.message);
        break; // one at a time — don't stack utterances
      }
    }
  }, [nudges, snoozed]);

  const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

  const visibleNudges = nudges.filter(n => !(snoozed[n.type] > now));

  if (visibleNudges.length === 0) return null;

  return (
    <div className="nudge-container">
      {visibleNudges.map((nudge, i) => {
        const isEscalated = (nudge.nag_count || 0) >= 2;
        return (
          <div key={i} className={`nudge-banner ${isEscalated ? 'escalated' : ''} ${nudge.type}`}>
            <div className="nudge-content">
              <span className="nudge-sara-label">SARA</span>
              <span className="nudge-type">
                {nudge.type === 'standup' ? 'STANDUP'
                  : nudge.type === 'todo' ? 'TODOS'
                  : nudge.type === 'eod' ? 'EOD'
                  : nudge.type === '121' ? '1-2-1'
                  : nudge.type === 'plan_milestone' ? 'PLAN'
                  : nudge.type === 'journal' ? 'JOURNAL'
                  : nudge.type === 'escalation' ? 'ESCALATION'
                  : nudge.type === 'email' ? 'EMAIL'
                  : nudge.type.toUpperCase()}
              </span>
              <span className="nudge-message">{nudge.message}</span>
            </div>
            <div className="nudge-actions">
              {isWeekend && (
                <button
                  className="nudge-dismiss"
                  onClick={() => handleDismiss(nudge)}
                  title="Dismiss this nudge"
                >
                  Dismiss
                </button>
              )}
              <div className="nudge-snooze-wrap">
                <button
                  className="nudge-snooze"
                  onClick={() => setMenuOpen(menuOpen === nudge.type ? null : nudge.type)}
                  title="Snooze for…"
                  aria-expanded={menuOpen === nudge.type}
                >
                  Snooze ▾
                </button>
                {menuOpen === nudge.type && (
                  <div className="nudge-snooze-menu">
                    {SNOOZE_OPTIONS.map(opt => (
                      <button
                        key={opt.label}
                        className="nudge-snooze-option"
                        onClick={() => handleSnooze(nudge.type, opt.minutes())}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="nudge-action"
                onClick={() => {
                  if (nudge.type === 'standup' || nudge.type === 'eod') onGoToStandup();
                  else if (nudge.type === 'todo') onGoToTodos();
                  else if (nudge.type === 'journal') { if (onGoToJournal) onGoToJournal(); }
                  else if (nudge.type === '121') { if (onGoToPeople) onGoToPeople(); }
                  else if (nudge.type === 'escalation') { if (onGoToBriefing) onGoToBriefing(); }
                  else if (nudge.type === 'email') { if (onGoToInbox) onGoToInbox(); }
                  handleDismiss(nudge);
                }}
              >
                {nudge.type === 'standup' ? 'Do it'
                  : nudge.type === 'todo' ? 'Open'
                  : nudge.type === 'eod' ? 'Do it'
                  : nudge.type === 'journal' ? 'Open'
                  : nudge.type === '121' ? 'Open'
                  : nudge.type === 'escalation' ? 'Open'
                  : nudge.type === 'email' ? 'Reply'
                  : 'Go'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
