import React, { useState, useEffect, useCallback } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
import DoNextPanel from './DoNextPanel';
import './Dashboard.css';

const START_DATE = new Date('2026-03-16');

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatEventTime(isoStr) {
  return isoStr.split('T')[1]?.substring(0, 5) || '';
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// ── Inline Standup (morning section) ──────────────────────────────────────

function InlineMustDos() {
  const [mustDos, setMustDos] = useState([]);

  useEffect(() => {
    fetch(apiUrl('/api/standup/must-dos'))
      .then(r => r.json())
      .then(d => setMustDos(d.items || []))
      .catch(() => {});
  }, []);

  if (mustDos.length === 0) return null;

  return (
    <div className="review-section" style={{ border: '1px solid rgba(239, 68, 68, 0.35)', borderLeft: '3px solid #ef4444', background: 'rgba(239, 68, 68, 0.04)' }}>
      <div className="review-section-header">
        <span className="review-section-title" style={{ color: '#ef4444' }}>
          Must Do — Non-Negotiable ({mustDos.length})
        </span>
      </div>
      {mustDos.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', fontFamily: 'var(--font-mono)' }}>
          <span style={{ width: 6, height: 6, background: '#ef4444', borderRadius: '50%', flexShrink: 0 }} />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function InlineMustMove({ onNavigate }) {
  const todoFetch = useCachedFetch('/api/todos', { interval: 30000 });
  const items = todoFetch.data?.todayLane || [];

  if (items.length === 0) return null;

  return (
    <div className="review-section" style={{ border: '1px solid rgba(79, 156, 249, 0.24)', borderLeft: '3px solid var(--accent)' }}>
      <div className="review-section-header">
        <span className="review-section-title">
          Must Move Today <span className="review-badge-warn">{items.length}</span>
        </span>
        <button className="review-link" onClick={() => onNavigate?.('todos')}>Open todos</button>
      </div>
      {items.map((item) => (
        <div key={item.id} className={`review-todo ${item.priority === 'high' ? 'review-todo-high' : ''}`}>
          <span className="review-todo-text">{item.text}</span>
          <span className="review-todo-due">{item.moscow}{item.context ? ` · ${item.context}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function InlineStandup() {
  const [ritualData, setRitualData] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle, running, done
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    fetch(apiUrl('/api/standup/ritual-state'))
      .then(r => r.json())
      .then(d => {
        setRitualData(d);
        if (d.standupDoneToday) setPhase('done');
      })
      .catch(() => {});
  }, []);

  const startGuided = async () => {
    setPhase('running');
    setMessages([]);
    try {
      const res = await fetch(apiUrl('/api/standup/interactive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'start', messages: [] })
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantMsg = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text') assistantMsg += data.content;
            if (data.type === 'done') {
              setMessages([{ role: 'assistant', content: assistantMsg }]);
              if (data.noteSaved) setPhase('done');
            }
          } catch {}
        }
      }
    } catch {
      setMessages([{ role: 'assistant', content: 'Guided standup unavailable — try manual mode in the Standup panel.' }]);
    }
  };

  const respond = async () => {
    if (!input.trim()) return;
    const newMsgs = [...messages, { role: 'user', content: input.trim() }];
    setMessages(newMsgs);
    setInput('');
    let assistantMsg = '';

    try {
      const res = await fetch(apiUrl('/api/standup/interactive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'answering', messages: newMsgs })
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text') {
              assistantMsg += data.content;
              setMessages([...newMsgs, { role: 'assistant', content: assistantMsg }]);
            }
            if (data.type === 'done') {
              if (data.noteSaved) setPhase('done');
            }
          } catch {}
        }
      }
    } catch {}
  };

  if (phase === 'done') {
    return (
      <div className="review-section review-done">
        <span className="review-done-check">&#10003;</span> Standup done
      </div>
    );
  }

  if (phase === 'idle') {
    return (
      <div className="review-section">
        <div className="review-section-header">
          <span className="review-section-title">Standup</span>
        </div>
        <button className="review-action-btn" onClick={startGuided}>Start guided standup</button>
      </div>
    );
  }

  // Running
  return (
    <div className="review-section">
      <div className="review-section-header">
        <span className="review-section-title">Standup</span>
      </div>
      <div className="review-standup-msgs">
        {messages.map((m, i) => (
          <div key={i} className={`review-standup-msg ${m.role}`}>{m.content}</div>
        ))}
      </div>
      <div className="review-standup-input">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && respond()}
          placeholder="Reply..."
          autoFocus
        />
        <button onClick={respond}>Send</button>
      </div>
    </div>
  );
}

// ── Inline Todos (completeable) ───────────────────────────────────────────

function InlineTodos({ onNavigate }) {
  const todoFetch = useCachedFetch('/api/todos', { interval: 30000 });
  const todos = (todoFetch.data?.todos || []).filter(t => !t.done);
  const overdue = todos.filter(t => t.due_date && t.due_date < todayStr());
  const highPri = todos.filter(t => t.priority === 'high');
  const shown = highPri.length > 0 ? highPri.slice(0, 5) : todos.slice(0, 5);

  const toggle = async (id) => {
    await fetch(apiUrl('/api/todos/toggle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).catch(() => {});
    todoFetch.refresh();
  };

  return (
    <div className="review-section">
      <div className="review-section-header">
        <span className="review-section-title">
          Tasks {overdue.length > 0 && <span className="review-badge-warn">{overdue.length} overdue</span>}
        </span>
        <button className="review-link" onClick={() => onNavigate?.('todos')}>All tasks</button>
      </div>
      {shown.length === 0 && <div className="review-empty">No active tasks</div>}
      {shown.map(t => (
        <div key={t.id} className={`review-todo ${t.priority === 'high' ? 'review-todo-high' : ''}`}>
          <button className="review-todo-check" onClick={() => toggle(t.id)}>&#9744;</button>
          <span className="review-todo-text">{t.text}</span>
          {t.due_date && <span className="review-todo-due">{t.due_date}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Inline EOD / Journal (evening section) ────────────────────────────────

function InlineEod() {
  const [win, setWin] = useState('');
  const [didntGo, setDidntGo] = useState('');
  const [feeling, setFeeling] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch(apiUrl('/api/standup/daily-stats'))
      .then(r => r.json())
      .then(d => setStats(d))
      .catch(() => {});
  }, []);

  const submit = async () => {
    if (!win.trim() && !didntGo.trim() && !feeling.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/eod'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ win: win.trim(), didntGo: didntGo.trim(), feeling: feeling.trim() })
      });
      if (res.ok) setSaved(true);
    } catch {}
    setSaving(false);
  };

  if (saved) {
    return (
      <div className="review-section review-done">
        <span className="review-done-check">&#10003;</span> EOD saved
      </div>
    );
  }

  return (
    <div className="review-section">
      <div className="review-section-header">
        <span className="review-section-title">End of Day</span>
        <span className="review-hint">2 minutes. Then close the laptop.</span>
      </div>

      {/* Daily stats summary */}
      {stats && (
        <div className="eod-stats">
          {(stats.todosCompleted + stats.doNextCompleted) > 0 && (
            <span className="eod-stat eod-stat-ok">{stats.todosCompleted + stats.doNextCompleted} tasks done</span>
          )}
          {stats.meetingsAttended > 0 && (
            <span className="eod-stat">{stats.meetingsAttended} meetings</span>
          )}
          {stats.meetingNotesWritten > 0 && (
            <span className="eod-stat eod-stat-ok">{stats.meetingNotesWritten} meeting notes</span>
          )}
          {stats.captures > 0 && (
            <span className="eod-stat">{stats.captures} captures</span>
          )}
          {stats.vaultWrites > 0 && (
            <span className="eod-stat">{stats.vaultWrites} notes written</span>
          )}
          {stats.escalationsRaised > 0 && (
            <span className="eod-stat eod-stat-warn">{stats.escalationsRaised} escalations</span>
          )}
          {stats.chatMessages > 0 && (
            <span className="eod-stat">{stats.chatMessages} chats</span>
          )}
        </div>
      )}

      <input className="review-eod-input" placeholder="Win today" value={win} onChange={e => setWin(e.target.value)} />
      <input className="review-eod-input" placeholder="Didn't go to plan" value={didntGo} onChange={e => setDidntGo(e.target.value)} />
      <input className="review-eod-input" placeholder="Feeling" value={feeling} onChange={e => setFeeling(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()} />
      <button className="review-action-btn" onClick={submit} disabled={saving}>
        {saving ? 'Saving...' : 'Save EOD'}
      </button>
    </div>
  );
}

// ── Orphan Alert ──────────────────────────────────────────────────────────

function OrphanAlert({ onNavigate }) {
  const orphanFetch = useCachedFetch('/api/vault/orphans?days=7', { interval: 300000 });
  const orphans = orphanFetch.data?.orphans || [];

  if (orphans.length === 0) return null;

  return (
    <div className="review-section">
      <div className="review-section-header">
        <span className="review-section-title">
          Unreviewed <span className="review-badge-warn">{orphans.length}</span>
        </span>
        <button className="review-link" onClick={() => onNavigate?.('imports')}>Review all</button>
      </div>
      {orphans.slice(0, 3).map((o, i) => (
        <div key={i} className="review-orphan">
          <span className="review-orphan-name">{o.name}</span>
          <span className="review-orphan-preview">{o.preview}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Review Surface ───────────────────────────────────────────────────

export default function Dashboard({ onNavigate }) {
  const today = new Date();
  const dayCount = Math.max(0, Math.floor((today - START_DATE) / (1000 * 60 * 60 * 24)));
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeOfDay = getTimeOfDay();

  const planFetch = useCachedFetch('/api/obsidian/ninety-day-plan', { interval: 60000 });
  const td = todayStr();
  const calFetch = useCachedFetch(`/api/obsidian/calendar?start=${td}&end=${td}`, { interval: 120000 });
  const calEvents = (calFetch.data?.events || [])
    .filter(e => e.showAs !== 'cancelled')
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const plan = planFetch.data;
  const planPct = plan ? Math.round((plan.totalDone / Math.max(plan.totalTasks, 1)) * 100) : 0;

  return (
    <div className="dash">
      {/* Greeting */}
      <div className="dash-greeting">
        <h1 className="dash-hello">{getGreeting()}, Nick.</h1>
        <span className="dash-date">{dateStr} — Day {dayCount}</span>
      </div>

      {/* Stat cards */}
      <div className="dash-stats">
        <div className="dash-stat" onClick={() => onNavigate?.('plan')}>
          <span className="stat-val">{plan ? `${planPct}%` : '-'}</span>
          <span className="stat-lbl">90-Day</span>
          {plan && <span className="stat-sub">Day {plan.currentDay}</span>}
        </div>
      </div>

      {/* Must Do items — always visible */}
      <InlineMustDos />
      <InlineMustMove onNavigate={onNavigate} />

      {/* Morning: Standup */}
      {timeOfDay === 'morning' && <InlineStandup />}

      {/* Today's calendar */}
      {calEvents.length > 0 && (
        <div className="review-section" onClick={() => onNavigate?.('calendar')}>
          <div className="review-section-header">
            <span className="review-section-title">Today</span>
            <button className="review-link" onClick={e => { e.stopPropagation(); onNavigate?.('calendar'); }}>Full calendar</button>
          </div>
          {calEvents.slice(0, 5).map((ev, i) => {
            const now = new Date();
            const isCurrent = !ev.isAllDay && now >= new Date(ev.start) && now < new Date(ev.end);
            const isPast = !ev.isAllDay && now > new Date(ev.end);
            return (
              <div key={i} className={`dash-cal-event ${isCurrent ? 'cal-now' : ''} ${isPast ? 'cal-past' : ''}`}>
                <span className="cal-ev-time">{ev.isAllDay ? 'All day' : formatEventTime(ev.start)}</span>
                <span className="cal-ev-subject">{ev.subject}</span>
                {isCurrent && <span className="cal-ev-now">NOW</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Do Next — replaces InlineTodos */}
      <DoNextPanel compact={true} onNavigate={onNavigate} />

      {/* 90-Day progress */}
      {plan && (
        <div className="review-section">
          <div className="progress-header">
            <span className="progress-title">90-Day Plan</span>
            <span className="progress-meta">{plan.totalDone}/{plan.totalTasks} — {plan.nextCheckpoint.label} in {plan.daysToCheckpoint}d</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${planPct}%` }} />
            <div className="progress-marker" style={{ left: `${Math.round((plan.currentDay / 90) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* 90-Day alerts — overdue + today's plan tasks */}
      {plan && ((plan.overdueTasks?.length > 0) || (plan.todayTasks?.length > 0)) && (
        <div className="review-section">
          <div className="review-section-header">
            <span className="review-section-title">
              90-Day Plan
              {plan.overdueTasks?.length > 0 && <span className="review-badge-warn">{plan.overdueTasks.length} overdue</span>}
            </span>
            <button className="review-link" onClick={() => onNavigate?.('plan')}>Full plan</button>
          </div>
          {plan.overdueTasks?.slice(0, 3).map((t, i) => (
            <div key={`o${i}`} className="dash-task task-high">
              <span className="task-key">Day {t.day}</span>
              <span className="task-text">{t.text}</span>
            </div>
          ))}
          {plan.todayTasks?.filter(t => t.status !== 'x').map((t, i) => (
            <div key={`t${i}`} className="dash-task">
              <span className="task-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Orphan captures — unreviewed notes */}
      <OrphanAlert onNavigate={onNavigate} />

      {/* Evening: EOD */}
      {timeOfDay === 'evening' && <InlineEod />}

      {/* Quick actions — mobile */}
      <div className="dash-actions dash-mobile-only">
        <button className="dash-action" onClick={() => onNavigate?.('capture')}>+ Capture</button>
        <button className="dash-action" onClick={() => onNavigate?.('chat')}>Ask</button>
        {/* ⚠ This said "Queue" and navigated to `queue`, a view DELETED with the
            Jira queue feature in July 2026. `App.jsx`'s default case sends an
            unknown view to Now, so the button silently landed somewhere
            unrelated and looked like it had worked. Replaced with the thing a
            quick action on this row is actually for. */}
        <button className="dash-action" onClick={() => onNavigate?.('todos')}>Tasks</button>
      </div>
    </div>
  );
}
