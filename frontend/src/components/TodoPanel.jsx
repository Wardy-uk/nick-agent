import React, { useState, useMemo, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './TodoPanel.css';

function sourceClass(source) {
  if (!source) return '';
  if (source.startsWith('Master')) return 'todo-source-master';
  if (source.startsWith('MS Planner')) return 'todo-source-planner';
  if (source.startsWith('MS ToDo')) return 'todo-source-todo';
  if (source.startsWith('Daily')) return 'todo-source-daily';
  if (source.startsWith('90-Day')) return 'todo-source-plan';
  return '';
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function formatDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  const today = new Date(new Date().toDateString());
  const diff = Math.floor((d - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function getSubCategory(source) {
  if (!source) return null;
  const parenMatch = source.match(/\(([^)]+)\)/);
  if (parenMatch) return parenMatch[1];
  if (source.startsWith('Daily ')) return source.replace('Daily ', '');
  return null;
}

function getTopGroup(source) {
  if (!source) return 'other';
  if (source.startsWith('90-Day')) return 'plan';
  if (source.startsWith('Master') || source.startsWith('Daily')) return 'vault';
  if (source.startsWith('MS')) return 'ms';
  return 'other';
}

// ── MoSCoW Review ──
const MOSCOW_OPTIONS = [
  { key: 'must', label: 'Must', color: '#ef4444', desc: 'Non-negotiable' },
  { key: 'should', label: 'Should', color: '#f59e0b', desc: 'Important but not critical' },
  { key: 'could', label: 'Could', color: '#3b82f6', desc: 'Nice to have' },
  { key: 'wont', label: "Won't", color: '#6b7280', desc: 'Not now' },
];

function MoscowReview({ onClose }) {
  const [tasks, setTasks] = useState([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, triaged: 0, untriaged: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(apiUrl('/api/todos/moscow/review'))
      .then(r => r.json())
      .then(d => {
        setTasks(d.tasks || []);
        setStats({ total: d.total, triaged: d.triaged, untriaged: d.untriaged });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const current = tasks[index];
  const progress = tasks.length > 0 ? Math.round(((index) / tasks.length) * 100) : 0;

  const handleRate = async (moscow) => {
    if (!current || saving) return;
    setSaving(true);
    try {
      await fetch(apiUrl('/api/todos/moscow'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: current.filePath,
          lineNumber: current.lineNumber,
          text: current.text,
          moscow,
        })
      });
    } catch {}
    setSaving(false);
    if (index < tasks.length - 1) {
      setIndex(i => i + 1);
    } else {
      // Done
      setIndex(tasks.length);
    }
  };

  const handleSkip = () => {
    if (index < tasks.length - 1) setIndex(i => i + 1);
    else setIndex(tasks.length);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '1' || e.key === 'm' || e.key === 'M') handleRate('must');
      else if (e.key === '2' || e.key === 's' || e.key === 'S') handleRate('should');
      else if (e.key === '3' || e.key === 'c' || e.key === 'C') handleRate('could');
      else if (e.key === '4' || e.key === 'w' || e.key === 'W') handleRate('wont');
      else if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); handleSkip(); }
      else if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (loading) return <div className="moscow-review"><div className="moscow-loading">Loading tasks...</div></div>;

  if (tasks.length === 0 || index >= tasks.length) {
    return (
      <div className="moscow-review">
        <div className="moscow-done">
          <div className="moscow-done-icon">✓</div>
          <div className="moscow-done-title">All tasks triaged</div>
          <div className="moscow-done-stats">{stats.triaged + (index)} of {stats.total} rated</div>
          <button className="btn btn-primary" onClick={onClose} style={{ marginTop: '16px' }}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="moscow-review">
      <div className="moscow-header">
        <h2 className="moscow-title">MoSCoW Triage</h2>
        <div className="moscow-progress-info">
          <span>{index + 1} of {tasks.length} remaining</span>
          <button className="moscow-close" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="moscow-progress-track">
        <div className="moscow-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="moscow-card">
        <div className="moscow-task-text">{current.text}</div>
        <div className="moscow-task-meta">
          {current.source && <span className={`todo-source ${sourceClass(current.source)}`}>{current.source}</span>}
          {current.due_date && <span className={`todo-due ${isOverdue(current.due_date) ? 'due-overdue' : ''}`}>{formatDue(current.due_date)}</span>}
        </div>
      </div>

      <div className="moscow-buttons">
        {MOSCOW_OPTIONS.map(opt => (
          <button
            key={opt.key}
            className="moscow-btn"
            style={{ '--moscow-color': opt.color }}
            onClick={() => handleRate(opt.key)}
            disabled={saving}
          >
            <span className="moscow-btn-label">{opt.label}</span>
            <span className="moscow-btn-desc">{opt.desc}</span>
          </button>
        ))}
      </div>

      <div className="moscow-skip">
        <button className="moscow-skip-btn" onClick={handleSkip}>Skip →</button>
        <span className="moscow-hint">Keys: 1-4 to rate, Space to skip, Esc to close</span>
      </div>
    </div>
  );
}

// ── Shared todo item renderer ──
function TodoItem({ todo, toggling, onToggle, expanded, onExpand }) {
  const overdue = isOverdue(todo.due_date);
  const dueLabel = formatDue(todo.due_date);
  const toggleKey = `${todo.filePath}:${todo.lineNumber}`;
  const isToggling = toggling[toggleKey];
  const isExpanded = expanded === `${todo.source}-${todo.id}`;

  return (
    <div className={`todo-item priority-${todo.priority} ${overdue ? 'overdue' : ''} ${isExpanded ? 'expanded' : ''}`}>
      <button
        className={`todo-checkbox ${isToggling ? 'toggling' : ''}`}
        onClick={() => onToggle(todo)}
        disabled={isToggling || !todo.filePath}
        title="Mark done"
      />
      <div className="todo-text-col" onClick={() => onExpand(isExpanded ? null : `${todo.source}-${todo.id}`)} style={{ cursor: 'pointer' }}>
        <span className={`todo-text ${isExpanded ? '' : 'todo-text-truncated'}`}>{todo.text}</span>
        <div className="todo-meta-row">
          {todo.source && <span className={`todo-source ${sourceClass(todo.source)}`}>{todo.source}</span>}
          {dueLabel && <span className={`todo-due ${overdue ? 'due-overdue' : ''}`}>{dueLabel}</span>}
          {todo.planDay != null && <span className="todo-due">Day {todo.planDay}</span>}
          {todo._scoreReason && <span className="todo-score-reason">{todo._scoreReason}</span>}
        </div>
      </div>
      <span className={`todo-priority-badge ${todo.priority}`}>{todo.priority}</span>
    </div>
  );
}

function buildTodoSaraLine(active, overdue) {
  if (active.length === 0) return "No open tasks. Rare. Use it well.";
  if (overdue.length === 0) return `${active.length} open. Nothing overdue.`;
  if (overdue.length === 1) return `${active.length} open. 1 overdue — deal with it.`;
  if (overdue.length >= 5) return `${overdue.length} overdue. That's not a backlog, that's avoidance.`;
  return `${active.length} open. ${overdue.length} overdue.`;
}

function SuggestedTodoQueue({ items, actingId, onApprove, onReject }) {
  if (!items.length) return null;

  return (
    <section className="todo-suggestions">
      <div className="todo-suggestions-header">
        <div>
          <div className="todo-suggestions-label">Extracted from notes</div>
          <div className="todo-suggestions-copy">SARA spotted these in the vault. Approve the uncertain ones; the obvious ones are auto-added.</div>
        </div>
        <span className="todo-suggestions-count">{items.length} waiting</span>
      </div>
      <div className="todo-suggestions-list">
        {items.map((item) => (
          <div key={item.id} className="todo-suggestion-card">
            <div className="todo-suggestion-main">
              <div className="todo-suggestion-text">{item.text}</div>
              <div className="todo-suggestion-meta">
                {item.sourcePath && <span className="todo-source">{item.sourcePath}</span>}
                <span className="todo-due">Confidence {Math.round((item.confidence || 0) * 100)}%</span>
              </div>
            </div>
            <div className="todo-suggestion-actions">
              <button className="btn btn-secondary btn-sm" disabled={actingId === item.id} onClick={() => onReject(item)}>
                Dismiss
              </button>
              <button className="btn btn-primary btn-sm" disabled={actingId === item.id} onClick={() => onApprove(item)}>
                Add todo
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MustMoveLane({ items }) {
  if (!items.length) return null;

  return (
    <section className="todo-suggestions todo-suggestions-mustmove">
      <div className="todo-suggestions-header">
        <div>
          <div className="todo-suggestions-label">Must move today</div>
          <div className="todo-suggestions-copy">These are the tasks SARA thinks most directly protect your day, your commitments, or your reputation.</div>
        </div>
        <span className="todo-suggestions-count">{items.length} in lane</span>
      </div>
      <div className="todo-suggestions-list">
        {items.map((item) => (
          <div key={item.id} className="todo-suggestion-card">
            <div className="todo-suggestion-main">
              <div className="todo-suggestion-text">{item.text}</div>
              <div className="todo-suggestion-meta">
                <span className="todo-source">{item.moscow}</span>
                {item.context && <span className="todo-source">{item.context}</span>}
                {item.due_date && <span className="todo-due">{formatDue(item.due_date)}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function TodoPanel({ focusContext, onClearContext }) {
  // Determine initial mode: if arriving from Focus, start in focused shortlist mode
  const fromFocus = focusContext?.fromFocus;
  const initialFilter = focusContext?.filter || 'overdue';

  const [mode, setMode] = useState(fromFocus ? 'focused' : 'full');
  const [focusFilter, setFocusFilter] = useState(initialFilter);
  const [focusExpansion, setFocusExpansion] = useState('compact'); // compact (5) | expanded (10) | all

  // Full mode state (original)
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState('all');
  const [subFilters, setSubFilters] = useState([]);
  const [toggling, setToggling] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [showMoscow, setShowMoscow] = useState(false);
  const [moscowRatings, setMoscowRatings] = useState({});
  const [actingSuggestionId, setActingSuggestionId] = useState(null);

  // Load MoSCoW ratings
  useEffect(() => {
    fetch(apiUrl('/api/todos/moscow')).then(r => r.json()).then(d => setMoscowRatings(d.ratings || {})).catch(() => {});
  }, [showMoscow]); // Refresh when moscow review closes

  // Clear nav context after consuming it
  useEffect(() => {
    if (fromFocus && onClearContext) {
      // Clear after a tick so we've already read the context
      const t = setTimeout(() => onClearContext(), 100);
      return () => clearTimeout(t);
    }
  }, []);

  // ── Focused mode data ──
  const focusLimit = focusExpansion === 'all' ? '&showAll=true' : focusExpansion === 'expanded' ? '&limit=10' : '&limit=5';
  const focusPath = `/api/todos/focus?filter=${focusFilter}${focusLimit}`;
  const { data: focusData, refresh: refreshFocus } = useCachedFetch(
    mode === 'focused' ? focusPath : null,
    { interval: 30000 }
  );

  // ── Full mode data ──
  const fullPath = `/api/todos${showDone ? '?all=true' : ''}`;
  const { data: fullData, refresh: fetchTodos } = useCachedFetch(mode === 'full' ? fullPath : null);

  // Ids resolved locally (approved/dismissed/ticked) — hidden straight away so the
  // UI answers the click instead of waiting on a slow /api/todos refetch.
  const [resolvedSuggestions, setResolvedSuggestions] = useState([]);
  const [localDone, setLocalDone] = useState({}); // "filePath:lineNumber" -> 1

  const todos = (fullData?.todos || []).map(t => (
    localDone[`${t.filePath}:${t.lineNumber}`] ? { ...t, done: 1 } : t
  ));
  const suggestedTodos = (fullData?.suggested || []).filter(s => !resolvedSuggestions.includes(s.id));
  const todayLane = fullData?.todayLane || [];

  const handleSuggestionAction = async (item, verb) => {
    setActingSuggestionId(item.id);
    // Same task extracted from more than one note (a Plaud summary and the meeting
    // note it came from, say) — resolve the twins too, or dismissing one just
    // uncovers an identical card and looks like nothing happened.
    const ids = [item.id, ...(item.duplicateIds || [])];
    try {
      const results = await Promise.all(
        ids.map((id, i) => fetch(apiUrl(`/api/actions/${id}/${i === 0 ? verb : 'reject'}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }))
      );
      if (results.every(r => r.ok)) {
        setResolvedSuggestions(prev => [...prev, ...ids]);
      } else {
        console.error(`[TodoPanel] Suggestion ${verb} failed:`, results.map(r => r.status));
      }
      await fetchTodos();
    } catch (e) {
      console.error(`[TodoPanel] Suggestion ${verb} error:`, e);
    }
    setActingSuggestionId(null);
  };

  const toggleTodo = async (todo) => {
    if (!todo.filePath || todo.lineNumber == null) return;
    const key = `${todo.filePath}:${todo.lineNumber}`;
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      let res;
      if (todo.ms_id && (todo.source === 'MS Planner' || todo.source === 'MS ToDo')) {
        res = await fetch(apiUrl('/api/todos/complete-ms'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msId: todo.ms_id,
            source: todo.source,
            filePath: todo.filePath,
            lineNumber: todo.lineNumber
          })
        });
      } else {
        res = await fetch(apiUrl('/api/todos/toggle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: todo.filePath, lineNumber: todo.lineNumber })
        });
      }
      if (res.ok) setLocalDone(prev => ({ ...prev, [key]: todo.done ? 0 : 1 }));
      else console.error('[TodoPanel] Toggle failed:', res.status);
      // Small delay to let vault cache invalidate before refetch
      await new Promise(r => setTimeout(r, 300));
      if (mode === 'focused') refreshFocus();
      else await fetchTodos();
    } catch (e) { console.error('[TodoPanel] Toggle error:', e); }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  // ── Focused Mode Render ──
  if (mode === 'focused') {
    const items = focusData?.items || [];
    const totalCount = focusData?.totalCount || 0;
    const hidden = focusData?.hidden || 0;
    const breakdown = focusData?.breakdown || {};
    const loading = focusData === null;

    if (showMoscow) {
      return <MoscowReview onClose={() => setShowMoscow(false)} />;
    }

    return (
      <div className="todo-container">
        <div className="todo-header">
          <h2 className="todo-title">
            {focusFilter === 'overdue' ? 'Overdue Tasks' :
             focusFilter === 'today' ? 'Due Today' : 'Tasks'} — Start Here
          </h2>
          <div className="todo-header-right">
            <button className="btn btn-secondary btn-sm" onClick={() => setShowMoscow(true)}>
              MoSCoW
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setMode('full'); }}>
              Full view
            </button>
            <button className="btn btn-secondary btn-sm" onClick={refreshFocus}>Refresh</button>
          </div>
        </div>

        {/* Focus filter pills */}
        <div className="todo-filters">
          {[
            { key: 'overdue', label: 'Overdue' },
            { key: 'today', label: 'Due today' },
            { key: 'all', label: 'All open' },
          ].map(f => (
            <button
              key={f.key}
              className={`todo-filter-btn ${focusFilter === f.key ? 'active' : ''}`}
              onClick={() => { setFocusFilter(f.key); setFocusExpansion('compact'); }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* AI framing + summary header */}
        {totalCount > 0 && focusExpansion !== 'all' && (
          <div className="todo-focus-summary">
            {focusData?.framing ? (
              <span className="todo-focus-framing">{focusData.framing}</span>
            ) : (
              <span className="todo-focus-summary-text">
                {items.length === 1 ? 'Your top priority' : `Top ${items.length} of ${totalCount}`}
              </span>
            )}
            {breakdown.stale > 0 && (
              <span className="todo-focus-summary-stale">
                {breakdown.stale} stale items hidden
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div className="todo-empty">Loading prioritised tasks...</div>
        ) : items.length === 0 ? (
          <div className="todo-empty">
            {focusFilter === 'overdue' ? 'Nothing overdue. That\'s clean.' : 'Nothing due. Clear.'}
          </div>
        ) : (
          <>
            <SuggestedTodoQueue
              items={suggestedTodos}
              actingId={actingSuggestionId}
              onApprove={(item) => handleSuggestionAction(item, 'approve')}
              onReject={(item) => handleSuggestionAction(item, 'reject')}
            />
            <div className="todo-list">
              {items.map(todo => (
                <TodoItem
                  key={`${todo.source}-${todo.id}`}
                  todo={todo}
                  toggling={toggling}
                  onToggle={toggleTodo}
                  expanded={expanded}
                  onExpand={setExpanded}
                />
              ))}
            </div>
          </>
        )}

        {/* Progressive expansion: compact(5) → expanded(10) → all */}
        {hidden > 0 && focusExpansion === 'compact' && (
          <div className="todo-focus-footer">
            <button className="btn btn-secondary btn-sm" onClick={() => setFocusExpansion('expanded')}>
              Show more ({Math.min(10, totalCount)} items)
            </button>
          </div>
        )}
        {hidden > 0 && focusExpansion === 'expanded' && (
          <div className="todo-focus-footer">
            <button className="btn btn-secondary btn-sm" onClick={() => setFocusExpansion('compact')}>
              Fewer
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setFocusExpansion('all')}>
              Show all {totalCount}
            </button>
          </div>
        )}
        {focusExpansion === 'all' && totalCount > 10 && (
          <div className="todo-focus-footer">
            <button className="btn btn-secondary btn-sm" onClick={() => setFocusExpansion('compact')}>
              Top items only
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Full Mode Render (original behaviour, preserved) ──
  const loading = todos === null;
  const activeTodos = (todos || []).filter(t => !t.done);
  const doneTodos = (todos || []).filter(t => t.done);
  const overdueTodos = activeTodos.filter(t => isOverdue(t.due_date));
  const mustDoTodos = activeTodos.filter(t => t.mustdo);

  const subCategoryOptions = useMemo(() => {
    if (!['plan', 'vault', 'ms'].includes(filter)) return [];
    const counts = {};
    for (const t of activeTodos) {
      if (getTopGroup(t.source) !== filter) continue;
      const sub = getSubCategory(t.source) || (
        filter === 'vault'
          ? (t.source?.startsWith('Master') ? 'Master Todo' : t.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
          : (t.source?.startsWith('MS Planner') ? 'Planner' : t.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
      );
      counts[sub] = (counts[sub] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filter, activeTodos]);

  const topCounts = useMemo(() => {
    const c = { plan: 0, vault: 0, ms: 0 };
    for (const t of activeTodos) {
      const g = getTopGroup(t.source);
      if (c[g] !== undefined) c[g]++;
    }
    return c;
  }, [activeTodos]);

  let filtered = activeTodos;
  if (filter === 'mustdo') {
    filtered = mustDoTodos;
  } else if (filter === 'overdue') {
    filtered = activeTodos.filter(t => isOverdue(t.due_date));
  } else if (filter === 'today') {
    filtered = activeTodos.filter(t => {
      if (!t.due_date) return false;
      const d = new Date(t.due_date);
      const today = new Date(new Date().toDateString());
      return d.getTime() === today.getTime() || d < today;
    });
  } else if (filter === 'high') {
    filtered = activeTodos.filter(t => t.priority === 'high');
  } else if (['plan', 'vault', 'ms'].includes(filter)) {
    filtered = activeTodos.filter(t => getTopGroup(t.source) === filter);
    if (subFilters.length > 0) {
      filtered = filtered.filter(t => {
        const sub = getSubCategory(t.source) || (
          filter === 'vault'
            ? (t.source?.startsWith('Master') ? 'Master Todo' : t.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
            : (t.source?.startsWith('MS Planner') ? 'Planner' : t.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
        );
        return subFilters.includes(sub);
      });
    }
  }

  const toggleSubFilter = (sub) => {
    setSubFilters(prev =>
      prev.includes(sub) ? prev.filter(s => s !== sub) : [...prev, sub]
    );
  };

  const setTopFilter = (key) => {
    setFilter(key);
    setSubFilters([]);
  };

  if (showMoscow) {
    return <MoscowReview onClose={() => setShowMoscow(false)} />;
  }

  const todoSaraLine = buildTodoSaraLine(activeTodos, overdueTodos);

  return (
    <div className="todo-container">
      <div className="todo-sara">
        <span className="todo-sara-label">SARA</span>
        <span className="todo-sara-line">{todoSaraLine}</span>
      </div>
      <div className="todo-header">
        <h2 className="todo-title">Todos</h2>
        <div className="todo-header-right">
          <span className="todo-count">
            {activeTodos.length} open
            {overdueTodos.length > 0 && <span className="overdue-count"> / {overdueTodos.length} overdue</span>}
          </span>
          <button className="btn btn-secondary" onClick={() => setShowMoscow(true)}>
            MoSCoW
          </button>
          <button className="btn btn-secondary" onClick={() => setMode('focused')}>
            Smart view
          </button>
          <button className="btn btn-secondary" disabled={syncing} onClick={async () => {
            setSyncing(true);
            try {
              await fetch(apiUrl('/api/microsoft/tasks/sync'), { method: 'POST' });
              await fetchTodos();
            } catch {}
            setSyncing(false);
          }}>{syncing ? 'Syncing...' : 'Sync MS'}</button>
          <button className="btn btn-secondary" onClick={fetchTodos}>Refresh</button>
        </div>
      </div>

      <SuggestedTodoQueue
        items={suggestedTodos}
        actingId={actingSuggestionId}
        onApprove={(item) => handleSuggestionAction(item, 'approve')}
        onReject={(item) => handleSuggestionAction(item, 'reject')}
      />
      <MustMoveLane items={todayLane} />

      <div className="todo-filters">
        {[
          { key: 'all', label: 'All' },
          ...(mustDoTodos.length > 0 ? [{ key: 'mustdo', label: `Must Do (${mustDoTodos.length})` }] : []),
          { key: 'overdue', label: `Overdue (${overdueTodos.length})` },
          { key: 'today', label: 'Due today' },
          { key: 'high', label: 'High priority' },
          { key: 'plan', label: `90-Day Plan (${topCounts.plan})` },
          { key: 'vault', label: `Vault Todos (${topCounts.vault})` },
          { key: 'ms', label: `MS Tasks (${topCounts.ms})` },
        ].map(f => (
          <button
            key={f.key}
            className={`todo-filter-btn ${filter === f.key ? 'active' : ''}${f.key === 'mustdo' ? ' mustdo-filter' : ''}`}
            onClick={() => setTopFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {subCategoryOptions.length > 0 && (
        <div className="todo-sub-filters">
          <button
            className={`todo-sub-btn ${subFilters.length === 0 ? 'active' : ''}`}
            onClick={() => setSubFilters([])}
          >
            All
          </button>
          {subCategoryOptions.map(([sub, count]) => (
            <button
              key={sub}
              className={`todo-sub-btn ${subFilters.includes(sub) ? 'active' : ''}`}
              onClick={() => toggleSubFilter(sub)}
            >
              {sub} ({count})
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="todo-empty">Loading vault tasks...</div>
      ) : (
        <div className="todo-list">
          {filtered.length === 0 && (
            <div className="todo-empty">
              {filter === 'all' ? 'No open todos. Rare.' : 'No matching todos.'}
            </div>
          )}
          {filtered.map(todo => (
            <TodoItem
              key={`${todo.source}-${todo.id}`}
              todo={todo}
              toggling={toggling}
              onToggle={toggleTodo}
              expanded={expanded}
              onExpand={setExpanded}
            />
          ))}
        </div>
      )}

      <div className="todo-footer">
        <button className="btn btn-secondary" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide completed' : 'Show completed'}
        </button>
      </div>

      {showDone && doneTodos.length > 0 && (
        <div className="todo-done-list">
          {doneTodos.map(todo => {
            const toggleKey = `${todo.filePath}:${todo.lineNumber}`;
            const isToggling = toggling[toggleKey];
            return (
              <div key={`done-${todo.id}`} className="todo-item done">
                <button
                  className={`todo-checkbox checked ${isToggling ? 'toggling' : ''}`}
                  onClick={() => toggleTodo(todo)}
                  disabled={isToggling || !todo.filePath}
                  title="Mark not done"
                />
                <div className="todo-text-col">
                  <span className="todo-text">{todo.text}</span>
                  <div className="todo-meta-row">
                    {todo.source && <span className={`todo-source ${sourceClass(todo.source)}`}>{todo.source}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
