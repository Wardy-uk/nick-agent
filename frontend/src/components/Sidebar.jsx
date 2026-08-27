import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './Sidebar.css';

const PRIMARY_ITEMS = [
  // Above Briefing on purpose. Briefing answers "what about today"; this answers
  // "what shape is everything in" — including the things no other screen looks
  // at, like a Jira cache that had been stale for six weeks while every panel
  // reading it rendered happily.
  { id: 'state',      label: 'State of Play', icon: '◈' },
  { id: 'briefing',   label: 'Briefing',  icon: '◉' },
  { id: 'chat',       label: 'Ask',       icon: '›' },
  { id: 'capture',    label: 'Capture',   icon: '+' },
  // Primary, not under MORE: MORE is collapsed by default, so a badge there is
  // invisible until you already know to look — and this is the queue holding
  // outbound email waiting on a second approval. An approval surface nobody can
  // find is the hole it was built to close.
  { id: 'actions',    label: 'Actions',   icon: '✓' },
];

const SECONDARY_ITEMS = [
  // "Today" is the ADHD dashboard — one thing, momentum, avoidance, quick wins.
  // Sits above Focus because it's the one to open when you don't know where to start.
  { id: 'today',      label: 'Today',     icon: '◐' },
  { id: 'focus',      label: 'Focus',     icon: '◎' },
  // TodoPanel has always been routable via App.jsx but had no menu entry, so the
  // one consolidated task view was only reachable if a nudge banner sent you there.
  { id: 'todos',      label: 'Tasks',     icon: '☑' },
  { id: 'dashboard',  label: 'Review',    icon: '⬡' },
  { id: 'people',     label: 'People',    icon: '>' },
  { id: 'calendar',   label: 'Calendar',  icon: '>' },
  { id: 'meeting-prep', label: 'Meeting Prep', icon: '>' },
  { id: 'vault',      label: 'Vault',     icon: '>' },
  { id: 'inbox',      label: 'Inbox',     icon: '>' },
  { id: 'escalations', label: 'Escalations', icon: '▲' },
  // 'standup' is the editor (start the guided standup / EOD); 'standups' is the
  // read-only streak history. Only the history had a menu entry, so the ritual
  // itself was reachable only from a nudge banner or a push notification.
  { id: 'standup',    label: 'Standup',   icon: '✎' },
  // Same reasoning one ritual later: EOD was reachable only from an "EOD"
  // button inside the standup screen, so "how do I start end of day?" had no
  // answer you could find by looking.
  { id: 'eod',        label: 'End of day', icon: '✓' },
  { id: 'standups',   label: 'Standup history', icon: '>' },
  { id: 'journal',    label: 'Journal',   icon: '>' },
  // #28 — the route and the table both existed and nothing read them. A panel
  // with no menu entry is the same hole one step later (see 'todos'), so it
  // gets one here rather than being routable-but-unreachable.
  { id: 'decisions',  label: 'Decisions', icon: '>' },
  // The Monday report to Chris. It has a deadline and a named recipient, so it
  // gets a menu entry rather than being reachable only from the 07:30 push —
  // which is the failure this list already documents twice above.
  { id: 'weekly-risk', label: 'Weekly Risk', icon: '▲' },
  { id: 'imports',    label: 'Imports',   icon: '>' },
  { id: 'recent',     label: 'Recent',    icon: '>' },
  { id: 'insights',   label: 'Insights',  icon: '◈' },
  { id: 'pi-health',  label: 'Pi Health', icon: '▚' },
  { id: 'admin',      label: 'Settings',  icon: '>' },
];

const SECONDARY_IDS = new Set(SECONDARY_ITEMS.map(i => i.id));

function useTimeHighlight() {
  const [highlight, setHighlight] = React.useState(null);
  React.useEffect(() => {
    function check() {
      const now = new Date();
      const h = now.getHours();
      const day = now.getDay();
      const isWeekday = day >= 1 && day <= 5;
      if (!isWeekday) { setHighlight(null); return; }
      if (h >= 8 && h < 10) { setHighlight('briefing'); return; }
      if (h >= 21 && h < 23) { setHighlight('briefing'); return; }
      setHighlight(null);
    }
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);
  return highlight;
}

export default function Sidebar({ activeView, onNavigate, open }) {
  const [importsCount, setImportsCount] = useState(0);
  const [actionsCount, setActionsCount] = useState(0);

  const [moreOpen, setMoreOpen] = useState(() => {
    try { return localStorage.getItem('sidebar_more_open') === 'true'; }
    catch { return false; }
  });

  const toggleMore = () => {
    setMoreOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('sidebar_more_open', String(next)); } catch {}
      return next;
    });
  };

  // Auto-expand secondary if active view is inside it
  useEffect(() => {
    if (SECONDARY_IDS.has(activeView)) setMoreOpen(true);
  }, [activeView]);

  useEffect(() => {
    function fetchCounts() {
      fetch(apiUrl('/api/imports/pending'))
        .then(res => res.json())
        .then(data => setImportsCount(data.count || 0))
        .catch(() => {});

      // The badge is the discovery mechanism: a queued draft reply is invisible
      // otherwise, and it was for a day. pendingTotal, not pending.length —
      // the list itself is capped and the badge must not inherit that cap.
      fetch(apiUrl('/api/actions'))
        .then(res => res.json())
        .then(data => setActionsCount(data.pendingTotal ?? (data.pending || []).length))
        .catch(() => {});
    }

    fetchCounts();
    const interval = setInterval(fetchCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  const timeHighlight = useTimeHighlight();

  const renderItem = (item) => (
    <button
      key={item.id}
      className={[
        'sidebar-item',
        item.primary ? 'sidebar-item-primary' : '',
        activeView === item.id ? 'active' : '',
        timeHighlight === item.id ? 'time-highlight' : ''
      ].filter(Boolean).join(' ')}
      onClick={() => onNavigate(item.id)}
    >
      <span className="sidebar-icon">{item.icon}</span>
      <span className="sidebar-label">
        {item.label}
        {item.id === 'imports' && importsCount > 0 && (
          <span className="sidebar-badge">{importsCount}</span>
        )}
        {item.id === 'actions' && actionsCount > 0 && (
          /* 930 does not fit a badge and 930 is the real number, so say "lots"
             rather than either lying or breaking the row. */
          <span className="sidebar-badge">{actionsCount > 99 ? '99+' : actionsCount}</span>
        )}

      </span>
    </button>
  );

  return (
    <nav className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-nav">
        {/* Primary: Review / Ask / Capture */}
        <div className="sidebar-group sidebar-group-primary">
          {PRIMARY_ITEMS.map(item => renderItem({ ...item, primary: true }))}
        </div>

        {/* Secondary: collapsible */}
        <div className="sidebar-group">
          <button
            className="sidebar-group-header sidebar-group-toggle"
            onClick={toggleMore}
          >
            <span className="sidebar-group-label">MORE</span>
            <span className="sidebar-group-chevron">{moreOpen ? '▾' : '▸'}</span>
          </button>

          {moreOpen && SECONDARY_ITEMS.map(item => renderItem(item))}
        </div>
      </div>
    </nav>
  );
}
