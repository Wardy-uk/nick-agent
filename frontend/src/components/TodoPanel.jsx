import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import { duePresets } from '../../../shared/due-dates.cjs';
import { msPlanBadge, recurrenceLabel } from '../../../shared/ms-task.cjs';
import { domainBadge } from '../../../shared/task-domain.cjs';
import { originBadge, ORIGINS, SHORT_LABELS, DESCRIPTIONS, LABELS, UNCLASSIFIED_LABEL } from '../../../shared/task-origin.cjs';
import TimeFitCard from './TimeFitCard';
import { pinFromContext, findPinned } from '../taskPin';
import TaskDedupe from './TaskDedupe';
import TaskBlocks, { BlockTimeControl } from './TaskBlocks';
import './TodoPanel.css';

// Beside a source badge. A file-backed mirror's badge already reads "MS Planner"
// / "MS ToDo", so the plan badge drops the system there; a LINKED NEURO row's
// badge reads "NEURO", so it keeps it — that row has no other Microsoft marker.
function planBadge(todo) {
  return msPlanBadge(todo, { withSystem: !String((todo && todo.source) || '').startsWith('MS ') });
}

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

// Overdue FOR NICK, which is the only question the count, the filter tab and
// SARA's line are actually asking. A shared card he has finished his half of is
// still late on the board — it is just not late because of him, and counting it
// as his makes the number he reads every morning wrong in the one direction
// that reads as failure. The row itself never disappears.
function isMineOverdue(todo) {
  return isOverdue(todo.due_date) && todo.msLocalState !== 'mine-done';
}

/**
 * Which dimension each filter chip belongs to.
 *
 * One selection per dimension, ANDed across dimensions. The grouping is not
 * cosmetic — within a dimension the options are mutually exclusive by
 * construction (nothing is both overdue and undated, nothing is both a
 * commitment and continual improvement), so letting them stack would offer
 * combinations that are always empty.
 */
const FILTER_GROUPS = {
  mustdo: 'lane',
  overdue: 'date',
  today: 'date',
  nodue: 'date',
  high: 'priority',
  commitment: 'origin',
  improvement: 'origin',
  unclassified: 'origin',
  plan: 'source',
  vault: 'source',
  ms: 'source',
};

/**
 * One predicate per chip, so the chain composes instead of branching.
 *
 * Each is lifted VERBATIM from the if/else chain it replaced — the stacking
 * change must not quietly redefine what any single filter means.
 */
const FILTER_PREDICATES = {
  mustdo: t => Boolean(t.mustdo),
  overdue: isMineOverdue,
  today: t => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    const today = new Date(new Date().toDateString());
    return d.getTime() === today.getTime() || d < today;
  },
  // ⚠ Positively "has no date", never "is not overdue". An undated task is
  // invisible to every date-driven surface NEURO has — the Must Move lane,
  // time-fit, the day planner — so no other filter can find it. It is also PIP
  // competency 3, which counts open items missing a date.
  nodue: t => !t.due_date,
  high: t => t.priority === 'high',
  commitment: t => t.origin === 'commitment',
  improvement: t => t.origin === 'improvement',
  // Positively unset, and NOT "everything that is not a commitment" — which
  // would sweep in the improvement pile the moment someone edits this line.
  //
  // ⚠ `task_id` is load-bearing: only rows NEURO OWNS can carry an origin. A
  // Microsoft mirror or a vault checkbox has no origin column and no Origin
  // control on its expanded row, so including them would build a list whose
  // whole purpose is "what do I still have to decide" out of rows that cannot
  // be decided — and give a count that disagrees with the weekly risk report
  // for a reason nothing on screen explains.
  unclassified: t => Boolean(t.task_id) && !t.origin,
  plan: t => getTopGroup(t.source) === 'plan',
  vault: t => getTopGroup(t.source) === 'vault',
  ms: t => getTopGroup(t.source) === 'ms',
};

/** The sub-category a row falls under, within a selected source group. */
function subCategoryOf(todo, sourceFilter) {
  return getSubCategory(todo.source) || (
    sourceFilter === 'vault'
      ? (todo.source?.startsWith('Master') ? 'Master Todo' : todo.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
      : (todo.source?.startsWith('MS Planner') ? 'Planner' : todo.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
  );
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

// Which part of Nick's life a task belongs to. The vocabulary itself lives in
// shared/task-domain.cjs so the backend, this panel, sara/app and the capture
// page cannot disagree about what the values are; only the wording of the
// buttons is local.
const DOMAIN_OPTIONS = [
  { key: 'work', label: 'Work', desc: 'Can be blocked into the work diary and can appear in a briefing' },
  { key: 'personal', label: 'Personal', desc: 'Never blocked into the work diary, never sent to a work system' },
];

// Commitment or continual improvement. The vocabulary comes from
// shared/task-origin.cjs, never a copy — a second list is how a screen offers a
// value the backend refuses. Only the button wording is local.
const ORIGIN_OPTIONS = ORIGINS.map(key => ({ key, label: SHORT_LABELS[key], desc: DESCRIPTIONS[key] }));

// The two things NEURO can say about a Microsoft task that Microsoft cannot
// hold. Mutually exclusive on purpose — "I am doing this" and "I cannot do
// this" cannot both be true, and a pair that allowed both would be a third
// state nothing knows how to render. The vocabulary is pinned server-side in
// services/ms-task-local.js; only the wording is local.
// What an unsaved change is CALLED, so the Save row can name it. A card can sit
// open for a while and "unsaved changes" on its own is a prompt to go hunting.
const FIELD_LABELS = {
  moscow: 'MoSCoW', domain: 'domain', origin: 'origin',
  priority: 'priority', due_date: 'due date', state: 'state',
};

const MS_LOCAL_STATES = [
  { key: 'working', label: 'Working on', color: '#22c55e', desc: 'You are mid-way through this — kept in NEURO, not pushed to the board' },
  { key: 'blocked', label: 'Blocked', color: '#ef4444', desc: 'Stuck waiting on something — Planner has no way to say this, so it stays here' },
  // Shared ownership: his sub-tasks are done and somebody else's are not. The
  // card stays open and keeps its date — it stops counting as HIS overdue work.
  { key: 'mine-done', label: 'My part done', color: '#38bdf8', desc: 'Your half of a shared card is finished. It stays open on the board and stops counting as your overdue work — nothing is completed, here or in Planner' },
];

// One place decides what a locally-annotated state says on a row, so the chip,
// its tooltip and the due date cannot end up telling three different stories.
const MS_LOCAL_STATE_CHIP = {
  working: { label: '● Working on', title: 'Working on it — kept in NEURO, not pushed to the board.' },
  blocked: { label: '⛔ Blocked', title: 'Blocked — your note to NEURO. Microsoft has not been told.' },
  'mine-done': {
    label: '✓ My part done',
    title: 'Your half is finished. The card is still open on the board and nothing has been completed — it just no longer counts as your overdue work.',
  },
};

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
        // Only the id — the review is scoped to NEURO-owned tasks, so every row
        // here has one, and the path fields it used to send were always null
        // anyway (#50).
        body: JSON.stringify({ taskId: current.task_id, moscow })
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
          {current.proposedMoscow && (
            <span className={`todo-moscow-badge ${current.proposedMoscow}`}>
              {current.proposedMoscow}? — proposed, confirm or change
            </span>
          )}
          {current.source && <span className={`todo-source ${sourceClass(current.source)}`}>{current.source}</span>}
          {planBadge(current) && <span className="todo-ms-plan" title="Microsoft board / list">{planBadge(current)}</span>}
          {current.due_date &&<span className={`todo-due ${isOverdue(current.due_date) ? 'due-overdue' : ''}`}>{formatDue(current.due_date)}</span>}
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

// ── Editing controls ──
// Only shown for tasks NEURO owns (task_id present). Before the 13 Aug migration none
// of MoSCoW / priority / due date could be edited anywhere: the metadata lived in a
// worksheet file. Now it is a plain DB write and the vault export follows.
/**
 * A card's edits are a DRAFT until Save.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * Every control here used to PATCH on click. Each patch refetched and re-ranked
 * the list, so setting a MoSCoW moved the card out from under the cursor before
 * the priority beside it had been touched — triaging one task meant chasing it
 * up the screen through four separate re-sorts. Worse, none of these buttons
 * stopped their click bubbling to the row's expand handler, so every one of
 * them ALSO collapsed the card it lived on.
 *
 * Triage is one thought, not five. It writes once now, on a deliberate Save.
 *
 * ⚠ The draft resets on the row's IDENTITY, never on its values. The panel
 * refetches on a timer and after every write elsewhere on the screen, so an
 * effect keyed on `todo.moscow` and friends would wipe half-finished edits
 * whenever a background poll landed — silently, and indistinguishably from a
 * button that never registered.
 *
 * BlockTimeControl and HouseholdToggle are deliberately NOT drafted. They are
 * not fields, they are actions with consequences of their own (a real calendar
 * event; a task published to VESTA, which Nick's partner reads on a public
 * URL), each already gated by its own confirmation. Parking those behind a
 * shared Save would make one button whose blast radius ranges from "changed a
 * letter" to "put this on the internet".
 */
function TaskControls({ todo, onPatch, busy, onRefresh }) {
  // Drafted under the PATCH field names, not the row's — `taskPriority` on the
  // row is `priority` on the wire, and drafting under the display name is how
  // the wrong key gets sent and then silently dropped by the whitelist.
  const snapshot = (t) => ({
    moscow: t.moscow || null,
    // Read with its default applied, because that is what the buttons render as
    // selected. Comparing a drafted 'work' against a stored null would make an
    // untouched task read as dirty the moment it was opened.
    domain: t.domain || 'work',
    origin: t.origin || null,
    priority: t.taskPriority || null,
    due_date: t.due_date ? t.due_date.split('T')[0] : null,
  });

  const identity = rowKey(todo);
  const [draft, setDraft] = useState(() => snapshot(todo));
  const [baseline, setBaseline] = useState(() => snapshot(todo));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const next = snapshot(todo);
    setDraft(next);
    setBaseline(next);
    // Identity only — see the note above about background refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const changed = {};
  for (const key of Object.keys(baseline)) {
    if (draft[key] !== baseline[key]) changed[key] = draft[key];
  }
  const dirty = Object.keys(changed).length > 0;
  const locked = busy || saving;

  const edit = (fields) => setDraft(prev => ({ ...prev, ...fields }));

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await onPatch(changed);
      // Optimistic, matching the parent's own localPatches: the row already
      // shows these values, so re-deriving from props that have not landed yet
      // would flash the card back to what it was.
      setBaseline(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    // ⚠ Load-bearing. Without it every click in here bubbles to
    // `.todo-text-col`'s onClick and collapses the row being edited.
    <div className="todo-edit" onClick={(e) => e.stopPropagation()}>
      <div className="todo-edit-group">
        <span className="todo-edit-label">{todo.moscowProposed ? 'MoSCoW?' : 'MoSCoW'}</span>
        {MOSCOW_OPTIONS.map(opt => (
          <button
            key={opt.key}
            className={`todo-edit-btn ${draft.moscow === opt.key ? 'active' : ''}`}
            style={{ '--moscow-color': opt.color }}
            disabled={locked}
            title={opt.desc}
            onClick={() => edit({ moscow: draft.moscow === opt.key ? null : opt.key })}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Work or personal. NEURO was built entirely around work, so this is the
          only place a task can be told otherwise — and it has to be one tap,
          because reclassifying is the kind of tidying that never happens if it
          costs more than that.

          Deliberately a TOGGLE PAIR rather than a single "Personal" checkbox:
          a checkbox makes work the unmarked absence of a choice, and the whole
          point is that the domain is a decision with consequences — it decides
          whether the day planner may book Nurtur calendar time for this and
          whether it may appear in a briefing that leaves the building. */}
      <div className="todo-edit-group">
        <span className="todo-edit-label">Domain</span>
        {DOMAIN_OPTIONS.map(opt => (
          <button
            key={opt.key}
            className={`todo-edit-btn ${draft.domain === opt.key ? 'active' : ''}`}
            disabled={locked}
            title={opt.desc}
            onClick={() => edit({ domain: opt.key })}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Did somebody ask for this, or did you decide to do it?

          This is the only place the question can be answered, and it has to be
          one tap, because the weekly risk report to Chris counts overdue
          COMMITMENTS only — an unclassified task sits in neither bucket and
          holds the headline figure back from being complete.

          ⚠ A THIRD state is offered on purpose. `origin` is genuinely
          three-valued: unset is not "improvement", and Clear is how you
          disagree with a proposal without yet knowing the right answer. A pair
          of buttons with no way back would make a wrong tap permanent. */}
      <div className="todo-edit-group">
        <span className="todo-edit-label">{todo.originProposed ? 'Asked of me?' : 'Origin'}</span>
        {ORIGIN_OPTIONS.map(opt => (
          <button
            key={opt.key}
            className={`todo-edit-btn ${draft.origin === opt.key ? 'active' : ''}`}
            disabled={locked}
            title={opt.desc}
            onClick={() => edit({ origin: opt.key })}
          >
            {opt.label}
          </button>
        ))}
        {draft.origin && (
          <button
            className="todo-edit-btn"
            disabled={locked}
            title="Back to unclassified — the weekly report counts it separately until you decide"
            onClick={() => edit({ origin: null })}
          >
            Clear
          </button>
        )}
        {todo.originProposed && (
          <span className="todo-origin-hint">NEURO&rsquo;s guess &mdash; tap to confirm</span>
        )}
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">Priority</span>
        {[3, 2, 1].map(p => (
          <button
            key={p}
            className={`todo-edit-btn ${draft.priority === p ? 'active' : ''}`}
            disabled={locked}
            title={p === 3 ? 'Most pressing' : p === 1 ? 'Least pressing' : 'Middle'}
            onClick={() => edit({ priority: draft.priority === p ? null : p })}
          >
            P{p}
          </button>
        ))}
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">Due</span>
        {/* Presets first: "how far away?" is answerable at a glance, "which
            day?" needs a calendar held in your head. The picker stays for when
            a specific date is genuinely the point. Weekends are never offered.

            The half-typed-date problem the old code guarded against is gone by
            construction: nothing is written until Save, so an incomplete value
            in the box is just an incomplete draft. Clearing is still its own
            button rather than inferred from an empty picker — an empty box
            mid-typing is not a request to wipe the date. */}
        {duePresets().map(p => (
          <button
            key={p.id}
            className={`todo-edit-btn${draft.due_date === p.date ? ' active' : ''}`}
            disabled={locked}
            onClick={() => edit({ due_date: p.date })}
          >{p.label}</button>
        ))}
        <input
          type="date"
          className="todo-edit-date"
          value={draft.due_date || ''}
          disabled={locked}
          onChange={(e) => edit({ due_date: e.target.value || null })}
        />
        {draft.due_date && (
          <button className="todo-edit-btn" disabled={locked} onClick={() => edit({ due_date: null })}>
            Clear
          </button>
        )}
      </div>

      {/* "Block an hour for this" is a thought you have while looking AT the
          task, so it lives on the row that is already open rather than behind a
          screen you have to go and find. Only NEURO-owned tasks reach here,
          which is also the only kind that can be blocked — a Microsoft mirror
          has no row to hang the block on. */}
      <BlockTimeControl todo={todo} busy={busy} />

      {/* Share with the house — the same instinct as blocking time: it is a
          thought you have while LOOKING at the task, so it lives on the open
          row rather than behind a screen you have to remember exists. */}
      <HouseholdToggle todo={todo} busy={busy} onSaved={onRefresh} />

      {todo.jiraKey && (
        <div className="todo-edit-group todo-edit-jira">
          <span className="todo-edit-label">Closes</span>
          <span className="todo-edit-note">
            {todo.jiraKey} closes this one. Resolve the ticket in Jira and NEURO
            closes the task &mdash; there is no manual tick, so there is never two
            places to close one thing. Everything else on this card is still yours
            to set, and Drop is still open to you if it is not work you will do.
          </span>
        </div>
      )}

      {todo.originPath && (
        <div className="todo-edit-group">
          <span className="todo-edit-label">From</span>
          <span className="todo-source">{todo.originPath}</span>
        </div>
      )}

      {/* Names WHAT is unsaved, not merely that something is. A card can sit
          open for a while, and "unsaved changes" on its own is a prompt to go
          hunting for them. */}
      <div className="todo-edit-group todo-edit-save">
        <button className="btn btn-primary btn-sm" disabled={!dirty || locked} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="todo-edit-btn" disabled={locked} onClick={() => setDraft(baseline)}>
            Discard
          </button>
        )}
        <span className="todo-edit-note">
          {dirty
            ? `Not saved yet — ${Object.keys(changed).map(k => FIELD_LABELS[k] || k).join(', ')}.`
            : 'Nothing to save.'}
        </span>
      </div>
    </div>
  );
}

/**
 * Editing a task Microsoft owns.
 *
 * Microsoft stays the source of truth — this reads live from Graph and PATCHes
 * back; nothing is stored locally. Three fields only (title, due, notes),
 * because assignments, buckets and checklists are board structure other people
 * maintain and there is no undo for them from here.
 *
 * ⚠ The fields are READ on expand rather than taken from the row. The row comes
 * from `Tasks/Microsoft Tasks.md`, which carries no description at all — so a
 * notes box filled from it would render empty over a Planner description that
 * has content, and the first save would erase it. When the description could not
 * be read the box is disabled and says so, rather than offering an empty one.
 */
/**
 * Put a task on the household list, or take it off.
 *
 * ⚠ The one control here with a consequence outside this screen: it publishes a
 * task to VESTA, which his partner reads on a public URL. So it says where the
 * task is GOING in words, rather than being a bare switch labelled "shared".
 *
 * Only NEURO-owned tasks reach this row; a Microsoft mirror has no `task_id` to
 * hang the flag on, which is also why it is not offered there.
 */
function HouseholdToggle({ todo, busy, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const on = todo.household === 1 || todo.household === true;

  // ⚠ `task_id`, not `taskId` — the legacy todo shape uses snake_case here, and
  // the wrong key is undefined rather than an error, so the control would simply
  // never render.
  if (!todo.task_id) return null;

  const flip = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/tasks/${todo.task_id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ household: !on }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  return (
    <div className="todo-edit-group">
      <span className="todo-edit-label">Household</span>
      <label className="todo-household">
        <input type="checkbox" checked={on} disabled={busy || saving} onChange={flip} />
        <span>
          {on
            ? 'On the shared list — visible in VESTA'
            : 'Share with the house'}
        </span>
      </label>
      {error && <span className="todo-household-error">{error}</span>}
    </div>
  );
}

/**
 * What NEURO thinks about a task Microsoft owns.
 *
 * ⚠ NOTHING HERE REACHES MICROSOFT, and the panel says so in words rather than
 * leaving it to be inferred — every other control on an expanded Microsoft row
 * writes to Graph, so a group that does not is the exception and has to be
 * marked as one. "Blocked" in particular has no Planner equivalent: it is Nick
 * telling NEURO he is stuck, not a status his team should be reading off a
 * shared board.
 *
 * ⚠ Deliberately rendered OUTSIDE MicrosoftTaskControls rather than inside it.
 * That component refuses to show anything when Graph could not be read — right,
 * because it would be editing over values it never fetched — but NEURO's own
 * triage depends on Microsoft not at all, and losing the ability to say "MUST"
 * because sign-in expired would make the feature disappear on exactly the days
 * the list is hardest to work with.
 */
function MsLocalControls({ todo, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const snapshot = (t) => ({
    state: t.msLocalState || null,
    moscow: t.moscow || null,
    priority: t.taskPriority || null,
  });

  // Drafted until Save, exactly like the NEURO-owned card above — MoSCoW and
  // priority feed the ranking, so writing on click re-sorted the list and moved
  // the card mid-triage. Reset on IDENTITY, never on values, or a background
  // refetch wipes a half-finished edit.
  const identity = rowKey(todo);
  const [draft, setDraft] = useState(() => snapshot(todo));
  const [baseline, setBaseline] = useState(() => snapshot(todo));
  useEffect(() => {
    const next = snapshot(todo);
    setDraft(next);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const changed = {};
  for (const key of Object.keys(baseline)) {
    if (draft[key] !== baseline[key]) changed[key] = draft[key];
  }
  const dirty = Object.keys(changed).length > 0;
  const edit = (fields) => setDraft(prev => ({ ...prev, ...fields }));

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/todos/ms/${encodeURIComponent(todo.ms_id)}/local`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || 'NEURO would not store that.');
      setBaseline(draft);
      if (onSaved) onSaved();
    } catch (e) {
      // The draft stays exactly as Nick left it. Resetting it on a failure
      // would throw away the decision as well as the write.
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="todo-edit todo-edit-local" onClick={(e) => e.stopPropagation()}>
      <div className="todo-edit-banner">
        NEURO only &mdash; none of this is sent to {/planner/i.test(todo.source || '') ? 'Planner' : 'Microsoft'}.
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">State</span>
        {MS_LOCAL_STATES.map(opt => (
          <button
            key={opt.key}
            className={`todo-edit-btn${draft.state === opt.key ? ' active' : ''}`}
            style={{ '--moscow-color': opt.color }}
            disabled={saving}
            title={opt.desc}
            onClick={() => edit({ state: draft.state === opt.key ? null : opt.key })}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">MoSCoW</span>
        {MOSCOW_OPTIONS.map(opt => (
          <button
            key={opt.key}
            className={`todo-edit-btn${draft.moscow === opt.key ? ' active' : ''}`}
            style={{ '--moscow-color': opt.color }}
            disabled={saving}
            title={opt.desc}
            onClick={() => edit({ moscow: draft.moscow === opt.key ? null : opt.key })}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">Priority</span>
        {[3, 2, 1].map(pr => (
          <button
            key={pr}
            className={`todo-edit-btn${draft.priority === pr ? ' active' : ''}`}
            disabled={saving}
            title={pr === 3 ? 'Most pressing' : pr === 1 ? 'Least pressing' : 'Middle'}
            onClick={() => edit({ priority: draft.priority === pr ? null : pr })}
          >
            P{pr}
          </button>
        ))}
      </div>

      <div className="todo-edit-group todo-edit-save">
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="todo-edit-btn" disabled={saving} onClick={() => setDraft(baseline)}>
            Discard
          </button>
        )}
        <span className="todo-edit-note">
          {dirty
            ? `Not saved yet — ${Object.keys(changed).map(k => FIELD_LABELS[k] || k).join(', ')}.`
            : 'Nothing to save.'}
        </span>
      </div>

      {error && <div className="todo-edit-error">{error}</div>}
    </div>
  );
}

function MicrosoftTaskControls({ todo, onSaved }) {
  const [state, setState] = useState({ status: 'loading' });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const isPlanner = /planner/i.test(todo.source || todo.msSource || '');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setError(null);
    setResult(null);
    const qs = new URLSearchParams({ source: todo.source || '' }).toString();
    fetch(apiUrl(`/api/todos/ms/${encodeURIComponent(todo.ms_id)}?${qs}`))
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setState({ status: 'error', error: json.error || 'Could not read this task from Microsoft.' });
          return;
        }
        setTitle(json.title || '');
        setDue(json.dueDate || '');
        setNotes(json.notes || '');
        setState({ status: 'ready', loaded: json });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', error: 'Could not reach Microsoft.' });
      });
    return () => { cancelled = true; };
  }, [todo.ms_id, todo.source]);

  if (state.status === 'loading') {
    return <div className="todo-edit todo-edit-readonly">Reading it from Microsoft…</div>;
  }
  if (state.status === 'error') {
    // Distinct from "there is nothing here": the task exists, NEURO could not
    // look. Editing is refused rather than offered over values it never read.
    return <div className="todo-edit todo-edit-readonly">{state.error} Editing is off until it can be read.</div>;
  }

  const loaded = state.loaded;
  const changed = {};
  if (title.trim() && title.trim() !== (loaded.title || '')) changed.title = title.trim();
  if (due !== (loaded.dueDate || '')) changed.dueDate = due || null;
  if (loaded.notesReadable && notes !== (loaded.notes || '')) changed.notes = notes;
  const dirty = Object.keys(changed).length > 0;

  async function save() {
    // A rename on Planner is visible to the whole board, and there is no undo
    // from NEURO. Everything else here is private or trivially reversible, so
    // this is the one thing that stops and asks.
    if (changed.title && isPlanner) {
      const ok = window.confirm(
        `Rename this in Planner?\n\n"${loaded.title}"\n→ "${changed.title}"\n\n`
        + 'Planner boards are shared — your team will see the new name.'
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(apiUrl(`/api/todos/ms/${encodeURIComponent(todo.ms_id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...changed,
          source: todo.source || null,
          listId: loaded.listId || null,
          // Lets the server repaint the mirror line so the list stops showing
          // the old wording. It re-checks the ms_id before touching it.
          filePath: todo.filePath || null,
          lineNumber: todo.lineNumber != null ? todo.lineNumber : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.applied?.length) {
        setError(json.error || 'Microsoft rejected the edit.');
        return;
      }
      // A partial save is a real outcome — Planner's description sits behind its
      // own etag, so notes can fail while the title lands. Saying "saved" over
      // that would be the silent half-failure this whole path avoids.
      setResult(json);
      setState({ status: 'ready', loaded: { ...loaded, ...changed } });
      if (onSaved) onSaved();
    } catch {
      setError('Could not reach NEURO.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="todo-edit" onClick={(e) => e.stopPropagation()}>
      <div className="todo-edit-group todo-edit-stack">
        <span className="todo-edit-label">Title</span>
        <input
          className="todo-edit-input"
          value={title}
          disabled={saving}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="todo-edit-group">
        <span className="todo-edit-label">Due</span>
        {duePresets().map(p => (
          <button
            key={p.id}
            className={`todo-edit-btn${due === p.date ? ' active' : ''}`}
            disabled={saving}
            onClick={() => setDue(p.date)}
          >{p.label}</button>
        ))}
        <input
          type="date"
          className="todo-edit-date"
          value={due}
          disabled={saving}
          onChange={(e) => setDue(e.target.value || '')}
        />
        {due && (
          <button className="todo-edit-btn" disabled={saving} onClick={() => setDue('')}>Clear</button>
        )}
      </div>

      <div className="todo-edit-group todo-edit-stack">
        <span className="todo-edit-label">Notes</span>
        {loaded.notesReadable ? (
          <textarea
            className="todo-edit-textarea"
            value={notes}
            rows={3}
            disabled={saving}
            onChange={(e) => setNotes(e.target.value)}
          />
        ) : (
          <span className="todo-edit-note">
            The description could not be read, so it is not editable here — saving would overwrite
            whatever Planner actually holds.
          </span>
        )}
      </div>

      <div className="todo-edit-group">
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : `Save to ${isPlanner ? 'Planner' : 'To Do'}`}
        </button>
        <span className="todo-edit-note">
          {isPlanner
            ? 'Planner owns this task — the change goes straight to the board.'
            : 'Microsoft To Do owns this task — the change goes straight to your list.'}
        </span>
      </div>

      {error && <div className="todo-edit-error">{error}</div>}
      {result && (
        <div className="todo-edit-note">
          Saved: {result.applied.join(', ')}.
          {result.failed?.length > 0 && ` Not saved: ${result.failed.map(f => f.field).join(', ')} — reopen and try again.`}
          {result.applied.length > 0 && !result.mirrored && ' The list here may show the old wording until the next sync.'}
        </div>
      )}
    </div>
  );
}

// ── Shared todo item renderer ──
/**
 * A row's identity, stable across a refetch.
 *
 * ⚠ `todo.id` is a POSITIONAL INDEX — `/api/todos` assigns `id: i + 1` over the
 * parsed list — and `listTaskRows` orders by due date with the undated last. So
 * the moment a due date is set, that row jumps up the ordering, every index
 * below it shifts by one, and a key built from `id` names a DIFFERENT task.
 *
 * That is what made the due date impossible to edit: pick a date, the list
 * re-sorts, and the expanded row silently collapses or a neighbour opens
 * instead — indistinguishable from the control not working. It applied to every
 * control on the row; the date one just happens to be the one that moves the
 * row it lives on.
 *
 * `task_id` is the real identity for anything NEURO owns. A file-backed mirror
 * has none, so it falls back to where the line lives, and only then to the
 * positional id — which is still unstable, but is the best a row with no
 * identity of its own can offer.
 */
function rowKey(todo) {
  if (todo.task_id) return `task:${todo.task_id}`;
  if (todo.filePath) return `file:${todo.filePath}#${todo.lineNumber ?? ''}`;
  return `pos:${todo.source}-${todo.id}`;
}

/**
 * The handle for a task, on the card.
 *
 * Nick asked for the id on every task card, and the reason is that a task you
 * can NAME is one you can talk to SARA about, quote in a commit, or point at in
 * a conversation — without it, referring to a task means retyping its wording
 * and hoping it matches.
 *
 * ⚠ Only NEURO's own id is shown. A Microsoft mirror has no NEURO id, and its
 * Graph id is a 150-character base64 blob — which is the very thing that made
 * the suggestion cards unreadable, so putting one on a task card would be that
 * bug moved rather than fixed. Those rows keep the source badge, which already
 * says whose board the work is on, and get no id chip rather than a fake one.
 * `null` here means "NEURO has no id for this", never "no id was recorded".
 */
function taskIdBadge(todo) {
  return todo?.task_id ? `#${todo.task_id}` : null;
}

/**
 * Everything an open task card offers, wherever that card is rendered.
 *
 * Extracted so the Must Move lane and the full list below it show the SAME
 * controls from ONE place. The lane was read-only: a must could be ticked,
 * marked WIP or deferred, and nothing else about it could be changed without
 * scrolling down and finding the same task again in the list. That is the
 * screen Nick works from first, so the fields he most wants to correct were
 * the ones furthest away. Two copies of this block would be two cards free to
 * disagree about what a task can be told.
 */
function TaskEditPanel({ todo, busy, onPatch, onRefresh }) {
  if (todo.task_id) {
    return <TaskControls todo={todo} busy={busy} onPatch={onPatch} onRefresh={onRefresh} />;
  }
  // A Microsoft task is editable too — Microsoft still owns it, so the edit is
  // a PATCH to Graph rather than anything stored locally.
  if (todo.ms_id) {
    return (
      <>
        {/* NEURO's own view of the task first, because it always works — the
            Graph half below refuses to render when Microsoft cannot be read,
            and triage must not disappear with it. */}
        <MsLocalControls todo={todo} onSaved={onRefresh} />
        <MicrosoftTaskControls todo={todo} onSaved={onRefresh} />
      </>
    );
  }
  return (
    <div className="todo-edit todo-edit-readonly">
      Mirrored from {todo.source} — edit it there. Only tasks NEURO owns are editable here.
    </div>
  );
}

function TodoItem({ todo, toggling, onToggle, expanded, onExpand, onPatch, onRefresh }) {
  // ⚠ The date is still shown, and still says how late the card is — what
  // changes is that it stops being painted as Nick's failure. Hiding the date
  // would hide the fact that the board is waiting on somebody; painting it red
  // says he is late for work he has already finished. Same call the backend
  // makes on the ranking side.
  const myPartDone = todo.msLocalState === 'mine-done';
  const overdue = isOverdue(todo.due_date) && !myPartDone;
  const dueLabel = formatDue(todo.due_date);
  const toggleKey = todo.task_id ? `task:${todo.task_id}` : `${todo.filePath}:${todo.lineNumber}`;
  const isToggling = toggling[toggleKey];
  const isExpanded = expanded === rowKey(todo);
  const editable = Boolean(todo.task_id);

  return (
    <div className={`todo-item priority-${todo.priority} ${overdue ? 'overdue' : ''} ${isExpanded ? 'expanded' : ''}`}>
      <button
        className={`todo-checkbox ${isToggling ? 'toggling' : ''}`}
        onClick={() => onToggle(todo)}
        disabled={isToggling || (!editable && !todo.filePath)}
        title={todo.jiraKey
          ? `${todo.jiraKey} closes this one — resolve it in Jira`
          : 'Mark done'}
      />
      <div className="todo-text-col" onClick={() => onExpand(isExpanded ? null : rowKey(todo))} style={{ cursor: 'pointer' }}>
        <span className={`todo-text ${isExpanded ? '' : 'todo-text-truncated'}`}>{todo.text}</span>
        <div className="todo-meta-row">
          {/* The task's own id, first, so the card can be NAMED. Absent on a
              row NEURO does not own — see taskIdBadge. */}
          {taskIdBadge(todo) && (
            <span className="todo-task-id" title="NEURO task id — quote this to SARA or in a commit">{taskIdBadge(todo)}</span>
          )}
          {todo.source && <span className={`todo-source ${sourceClass(todo.source)}`}>{todo.source}</span>}
          {/* NEURO's own state for a task Microsoft owns. First on the row,
              because it describes what is happening NOW rather than how the
              task was filed — the same reason WIP leads on the Must Move card.
              Titled rather than labelled, so the row does not have to explain
              on every line that this is not on the board. */}
          {todo.msLocalState && MS_LOCAL_STATE_CHIP[todo.msLocalState] && (
            <span
              className={`todo-local-state ${todo.msLocalState}`}
              title={MS_LOCAL_STATE_CHIP[todo.msLocalState].title}
            >{MS_LOCAL_STATE_CHIP[todo.msLocalState].label}</span>
          )}
          {/* Which Planner board / To Do list this is on. Absent when NEURO
              could not read it — never a placeholder standing in for a board. */}
          {planBadge(todo) && <span className="todo-ms-plan" title="Microsoft board / list">{planBadge(todo)}</span>}
          {todo.moscow && (
            <span
              className={`todo-moscow-badge ${todo.moscow}`}
              title={todo.moscowProposed
                ? 'Proposed by the 12 Aug triage, not yet confirmed'
                : todo.msLocal
                  ? 'Your rating in NEURO — Microsoft does not hold a MoSCoW letter and has not been told'
                  : undefined}
            >
              {todo.moscow}{todo.moscowProposed ? '?' : ''}
            </span>
          )}
          {/* Only PERSONAL is marked. Nearly every task is work, so a "Work"
              chip on all of them is a label every row shares — it sorts nothing
              and reads as noise, the same finding that made
              nearly-every-task-a-MUST useless for ranking. domainBadge owns
              that rule so the panel, the phone and the capture page cannot
              disagree about when to show it. */}
          {domainBadge(todo) && (
            <span
              className="todo-domain-badge"
              title="Personal — never blocked into the work diary, never sent to a work system"
            >{domainBadge(todo)}</span>
          )}
          {/* ⚠ Unlike the domain chip above, BOTH values are shown and the
              silent case is the unclassified one. Which of the two a task is
              changes what missing it means, and neither is the overwhelming
              majority. A trailing '?' marks a proposal NEURO inferred from
              where the task came from, so a guess never reads as Nick's call. */}
          {originBadge(todo) && (
            <span
              className={`todo-origin-badge ${todo.origin}${todo.originProposed ? ' proposed' : ''}`}
              title={todo.originProposed
                ? `Proposed as "${LABELS[todo.origin]}" from where this came from — not confirmed`
                : DESCRIPTIONS[todo.origin]}
            >{originBadge(todo)}</span>
          )}
          {todo.taskPriority && <span className="todo-priority-num">P{todo.taskPriority}</span>}
          {dueLabel && (
            <span
              className={`todo-due ${overdue ? 'due-overdue' : ''}${myPartDone ? ' due-not-mine' : ''}`}
              title={myPartDone ? 'The board is still waiting on this — but not on you.' : undefined}
            >{dueLabel}</span>
          )}
          {todo.planDay != null && <span className="todo-due">Day {todo.planDay}</span>}
          {todo._scoreReason && <span className="todo-score-reason">{todo._scoreReason}</span>}
        </div>
        {/* The Microsoft half this row now stands for.

            A merged pair shows ONCE, which is the point — but it also means
            the board's wording disappears from the screen at the exact moment
            Nick confirmed the two are the same, and that wording is what his
            team is reading. The plan badge above says WHICH board; this says
            what the board calls it. Read live off the mirror on every parse,
            never copied onto the row, so a Planner rename shows up here rather
            than the card quoting words nobody uses any more. */}
        {todo.msCounterpart && (
          <div className="todo-counterpart" title="Merged: one task here, still open on the board. Ticking it completes both.">
            <span className="todo-counterpart-arrow">↳</span>
            also on the board as {String.fromCharCode(8220)}{todo.msCounterpart.text}{String.fromCharCode(8221)}
            {todo.msCounterpart.dueDate && ` — due ${formatDue(todo.msCounterpart.dueDate)}`}
          </div>
        )}
        {isExpanded && (
          <TaskEditPanel
            todo={todo}
            busy={Boolean(isToggling)}
            onPatch={(fields) => onPatch(todo, fields)}
            onRefresh={onRefresh}
          />
        )}
      </div>
      <span className={`todo-priority-badge ${todo.priority}`}>{todo.priority}</span>
    </div>
  );
}

/**
 * The tick landed, but the task is held until it has been written up.
 *
 * States the hold, the reason and the exact file to write in. A hold Nick cannot
 * see the cause of is a task that mysteriously refuses to complete — the whole
 * feature failing in the way it exists to prevent.
 */
function HoldNotice({ notice, onDismiss }) {
  return (
    <div className="todo-hold-notice" onClick={onDismiss}>
      <strong>Held for a write-up.</strong>{' '}
      “{notice.text}” had {notice.startTime} on {notice.dateKey} blocked out for it,
      and the outcome note is still empty ({notice.reason}). Add a couple of lines to{' '}
      <code>{notice.notePath}</code> and it closes on its own — or say there is nothing
      to write up under “waiting on a write-up”.
    </div>
  );
}

/**
 * The tick was REFUSED, and the server said why.
 *
 * Separate from HoldNotice on purpose: a hold means the completion landed and is
 * waiting for its write-up, a refusal means nothing moved at all. Rendering one
 * as the other would tell Nick to go and write a note for a task that is still
 * open. Until this existed the refusal was a console.error, so the checkbox for
 * a Jira-linked task simply did nothing — a working rule ("the ticket closes
 * it") experienced as a broken button, which is the failure this codebase
 * refuses everywhere else.
 */
function RefusalNotice({ notice, onDismiss }) {
  return (
    <div className="todo-hold-notice todo-refusal-notice" onClick={onDismiss}>
      <strong>Not closed.</strong>{' '}
      &ldquo;{notice.text}&rdquo; &mdash; {notice.reason}
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

function SuggestedTodoQueue({ items, actingId, selected, onToggleSelect, onSelectAll, onClearSelection, onBatch, batching, batchError, onApprove, onReject }) {
  if (!items.length) return null;

  const allSelected = selected.length === items.length;

  return (
    <section className="todo-suggestions">
      <div className="todo-suggestions-header">
        <div>
          <div className="todo-suggestions-label">Spotted, waiting on you</div>
          <div className="todo-suggestions-copy">From your meeting notes and your email. Nothing here is a task until you approve it.</div>
        </div>
        <div className="todo-suggestions-header-right">
          <button className="btn btn-secondary btn-sm" onClick={allSelected ? onClearSelection : onSelectAll}>
            {allSelected ? 'Clear' : `Select all ${items.length}`}
          </button>
          <span className="todo-suggestions-count">{items.length} waiting</span>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="todo-batch-bar">
          <span className="todo-batch-count">{selected.length} selected</span>
          <div className="todo-batch-actions">
            <button className="btn btn-secondary btn-sm" disabled={batching} onClick={onClearSelection}>
              Clear
            </button>
            <button className="btn btn-secondary btn-sm" disabled={batching} onClick={() => onBatch('reject')}>
              {batching ? 'Working...' : `Dismiss ${selected.length}`}
            </button>
            <button className="btn btn-primary btn-sm" disabled={batching} onClick={() => onBatch('approve')}>
              {batching ? 'Working...' : `Add ${selected.length} todos`}
            </button>
          </div>
        </div>
      )}

      {batchError && <div className="todo-batch-error">{batchError}</div>}

      <div className="todo-suggestions-list">
        {items.map((item) => {
          const isSelected = selected.includes(item.id);
          return (
            <div key={item.id} className={`todo-suggestion-card ${isSelected ? 'selected' : ''}`}>
              <input
                type="checkbox"
                className="todo-suggestion-check"
                checked={isSelected}
                disabled={batching}
                onChange={() => onToggleSelect(item.id)}
                aria-label={`Select: ${item.text}`}
              />
              <div className="todo-suggestion-main" onClick={() => !batching && onToggleSelect(item.id)}>
                <div className="todo-suggestion-text">{item.text}</div>
                <div className="todo-suggestion-meta">
                  {/* Where it came from, in words. This used to render
                      `item.sourcePath` raw — which for an email candidate is the
                      Graph message id, 150 characters of base64 that identify
                      the email to Microsoft and to nobody else. Nick cannot find
                      that email, so he cannot check the claim, so the only safe
                      thing left to do with the card is dismiss it. The words are
                      composed on the server (`candidate-provenance`) and shared
                      with the Actions approval card, so one suggestion cannot be
                      attributed to two different senders on two screens. */}
                  {item.provenance && (
                    <span className={`todo-suggestion-source ${item.provenance.kind}`} title={item.provenance.ref || undefined}>
                      {item.provenance.label}
                      {item.provenance.detail && (
                        <span className="todo-suggestion-source-detail"> · {item.provenance.detail}</span>
                      )}
                    </span>
                  )}
                  <span className="todo-due">Confidence {Math.round((item.confidence || 0) * 100)}%</span>
                  {item.duplicateIds?.length > 0 && (
                    <span className="todo-due">+{item.duplicateIds.length} duplicate{item.duplicateIds.length > 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
              <div className="todo-suggestion-actions">
                <button className="btn btn-secondary btn-sm" disabled={actingId === item.id || batching} onClick={() => onReject(item)}>
                  Dismiss
                </button>
                <button className="btn btn-primary btn-sm" disabled={actingId === item.id || batching} onClick={() => onApprove(item)}>
                  Add todo
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The lane had no way to complete anything on it.
 *
 * It is the card that says "these most directly protect your day", sits above
 * the task list, and was display-only — so the five things NEURO most wanted
 * done were the five you could not tick off without scrolling past it and
 * finding them again in the list below.
 *
 * ⚠ Completion goes through `task_id`, never the row's `id`. That field is a
 * display key — parseVaultTodos numbers todos as it walks them — so ticking by
 * it would complete an unrelated task.
 */
/**
 * Who can hold a "started" state, and under what key.
 *
 * A NEURO row keeps it in `tasks.status`. A Microsoft row keeps it in Planner or
 * To Do, because Microsoft owns that task — a local copy would be a second
 * source of truth for a field they already have. A daily-note checkbox has
 * neither and gets no button rather than a broken one.
 */
function wipKeyFor(todo) {
  if (todo.task_id) return `wip:${todo.task_id}`;
  if (todo.ms_id) return `wip:ms:${todo.ms_id}`;
  return null;
}

/**
 * Disagreeing with the lane.
 *
 * ⚠ The reason is the product, not decoration. A deferral goes through the
 * attention lifecycle and `friction.js` reads the reasons back — a task put off
 * three times for `too-big` is a finding ABOUT THE WORK, and "not today" with
 * no reason throws that away. So the button opens the reasons rather than
 * snoozing straight off, and each one is phrased as the thing Nick would
 * actually say.
 *
 * Deliberately no "never show me this": the task is still open and still owed,
 * and conflating a statement about TIMING with a statement about the TASK is
 * how work vanishes from the one place he looks to find what he owes.
 */
// The same vocabulary read back. A held row showing the raw `too-big` would be
// NEURO quoting its own enum at him.
const HELD_REASON_LABELS = {
  'too-big': 'too big',
  'waiting-on-someone': 'blocked on someone',
  'no-context': 'wrong context',
  'not-now': 'not today',
  unspecified: 'no reason given',
};

const NOT_TODAY_REASONS = [
  { key: 'too-big', label: "It's too big", desc: 'Needs breaking down before it can start' },
  { key: 'waiting-on-someone', label: "I'm blocked", desc: 'Waiting on somebody else' },
  { key: 'no-context', label: 'Wrong context', desc: "Can't do this from where I am" },
  { key: 'not-now', label: 'Just not today', desc: 'No reason beyond timing' },
];

function NotToday({ item, busy, onDefer }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        className="todo-nottoday-btn"
        disabled={busy}
        title="Move it out of today's lane. The task stays open and keeps its due date."
        onClick={() => setOpen(true)}
      >
        Not today
      </button>
    );
  }

  return (
    <div className="todo-nottoday">
      <span className="todo-nottoday-q">Why not?</span>
      {NOT_TODAY_REASONS.map(r => (
        <button
          key={r.key}
          className="todo-nottoday-reason"
          disabled={busy}
          title={r.desc}
          onClick={() => { setOpen(false); onDefer(item, r.key); }}
        >{r.label}</button>
      ))}
      <button className="todo-nottoday-reason" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function MustMoveLane({ items, held, gaps, toggling, onToggle, onSetWip, onDefer, onUndefer, error, onDismissError, expanded, onExpand, onPatch, onRefresh }) {
  // ⚠ Not `!items.length`. Once a row can be snoozed, an empty lane has two
  // meanings — nothing qualified, or everything that did has been put off —
  // and rendering nothing would show a clear day over four deferred musts.
  if (!items.length && !(held || []).length) return null;

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
        {items.map((item) => {
          // Same owner order as sara/app's completeTask: task_id, then the
          // file-backed line. A row with neither cannot be completed from here,
          // and the checkbox says so rather than failing on click.
          const toggleKey = item.task_id ? `task:${item.task_id}` : `${item.filePath}:${item.lineNumber}`;
          const canComplete = Boolean(item.task_id) || (item.filePath && item.lineNumber != null);
          const wipKey = wipKeyFor(item);
          const pct = item.percentComplete;
          // A Microsoft row is already in progress if Planner says so. That is
          // read, not clicked — those tasks were at 75% and 25% before this
          // button existed.
          const isWip = item.status === 'in-progress' || (pct != null && pct > 0 && pct < 100);
          // Never offer a control that would LOWER progress this button did not
          // set. Planner's own UI has three states and writes 0 / 50 / 100, so
          // 50 IS the canonical "in progress" and toggling it back to 0 is a
          // real undo. Any OTHER non-zero value (Nick's tasks sit at 25 and 75)
          // came from someone setting the number directly, and overwriting it
          // would throw away real work on a board his team reads — so those
          // render as a read-only badge and Planner stays the place to change
          // them.
          const msProgressIsOurs = pct == null || pct === 0 || pct === 50;
          const canToggleWip = Boolean(wipKey) && (item.task_id ? true : msProgressIsOurs);
          // ⚠ Prefixed, deliberately NOT the bare rowKey the list below uses.
          // A must-move task is usually in both places, so a shared key would
          // open BOTH cards at once — two TaskControls over one task, each with
          // its own unsaved draft and its own Save. One expansion state across
          // the whole panel then means only ever one draft in flight.
          const laneKey = `lane:${rowKey(item)}`;
          const isExpanded = expanded === laneKey;
          return (
          <div key={item.id} className={`todo-suggestion-card${isWip ? ' todo-suggestion-card-wip' : ''}`}>
            <button
              className={`todo-checkbox ${toggling[toggleKey] ? 'toggling' : ''}`}
              disabled={!canComplete || toggling[toggleKey]}
              title={canComplete ? 'Mark done' : 'Nothing here can complete this — open it in the list below'}
              onClick={() => onToggle(item)}
            />
            <div
              className="todo-suggestion-main"
              onClick={() => onExpand(isExpanded ? null : laneKey)}
              title={isExpanded ? 'Close' : 'Open to edit MoSCoW, due date, priority and the rest'}
            >
              <div className="todo-suggestion-text">{item.text}</div>
              {/* buildTodayLane returns a `why` per row and this rendered none
                  of it — so the one card claiming to "protect your day" never
                  said which of five reasons put a task here. That matters more
                  than it looks: a task joins this lane for containing the word
                  "customer", and stating the reason is what makes a bad
                  classification visible instead of merely plausible. */}
              {item.why && <div className="todo-suggestion-why">{item.why}</div>}
              <div className="todo-suggestion-meta">
                {/* Same id as the list row below, so the same task reads the
                    same way in both places. */}
                {taskIdBadge(item) && (
                  <span className="todo-task-id" title="NEURO task id — quote this to SARA or in a commit">{taskIdBadge(item)}</span>
                )}
                {/* WIP first, because it is the one tag that describes what is
                    happening now rather than how the task was filed. */}
                {isWip && (
                  <span className="todo-tag todo-tag-wip">
                    {pct != null && pct > 0 ? `WIP ${pct}%` : 'WIP'}
                  </span>
                )}
                <span className="todo-tag">{item.moscow}</span>
                {item.context && <span className="todo-tag">{item.context}</span>}
                {/* The lane names no source, so for a Microsoft row this is the
                    only thing on the card saying whose board the work is on. */}
                {msPlanBadge(item) && <span className="todo-tag todo-ms-plan" title="Microsoft board / list">{msPlanBadge(item)}</span>}
                {/* A recurring task comes BACK when you complete it — Microsoft
                    closes the occurrence and rolls the same task forward. Saying
                    so is the difference between "it reappeared" and "NEURO lost
                    my tick". */}
                {recurrenceLabel(item) && (
                  <span className="todo-tag todo-recurring" title="Recurring — completing this closes one occurrence and rolls it forward">
                    &#8635; {recurrenceLabel(item)}
                  </span>
                )}
                {typeof item.ageDays === 'number' && item.ageDays > 0 && (
                  <span className="todo-tag todo-tag-age">{item.ageDays}d old</span>
                )}
                {item.due_date && <span className="todo-due">{formatDue(item.due_date)}</span>}
              </div>
              {/* ⚠ Inside `main`, and its clicks stopped there. `main` is what
                  toggles the card open, so a click on any control inside it
                  would close the card underneath the button being pressed —
                  the same bubbling trap TaskControls itself already guards
                  against on the row below. */}
              {isExpanded && (
                <div className="todo-lane-edit" onClick={(e) => e.stopPropagation()}>
                  <TaskEditPanel
                    todo={item}
                    busy={Boolean(toggling[toggleKey])}
                    onPatch={(fields) => onPatch(item, fields)}
                    onRefresh={onRefresh}
                  />
                </div>
              )}
            </div>
            {/* Absent, not disabled, when nothing can hold the state — a
                daily-note checkbox has neither a NEURO row nor an ms_id. */}
            {canToggleWip && (
              <button
                className={`todo-wip-btn${isWip ? ' active' : ''}`}
                disabled={toggling[wipKey]}
                title={isWip
                  ? 'Started — click to put it back to not started'
                  : item.task_id
                    ? 'Mark as work in progress (it stays in this lane)'
                    : 'Mark in progress — this updates Planner, so your team sees it too'}
                onClick={() => onSetWip(item)}
              >
                {toggling[wipKey] ? '…' : isWip ? '● WIP' : 'WIP'}
              </button>
            )}
            {!canToggleWip && pct > 0 && (
              // Already under way in Planner. Shown, not offered — see above.
              <span className="todo-wip-btn active" title={`Planner has this at ${pct}% — change it there`}>
                ● {pct}%
              </span>
            )}
            {/* Disagreeing with the lane. Last on the row on purpose — the
                checkbox and the WIP control are what move work forward; this
                is the escape hatch, and an escape hatch that reads as loudly
                as the actions would invite it. */}
            <NotToday item={item} busy={Boolean(toggling[wipKey])} onDefer={onDefer} />
          </div>
          );
        })}
      </div>

      {/* ⚠ Held back, NEVER silently dropped. A lane that is simply shorter is
          indistinguishable from one that found less work — and if every must
          were snoozed, an empty lane would render as a clear day. Each row says
          what Nick said and when it comes back, with the way out beside it. */}
      {(held || []).length > 0 && (
        <div className="todo-lane-held">
          <div className="todo-lane-held-head">
            Not today ({held.length}) &mdash; still open, still due, back tomorrow morning
          </div>
          {held.map(h => (
            <div key={h.id} className="todo-lane-held-row">
              <span className="todo-lane-held-text">{h.text}</span>
              <span className="todo-lane-held-reason">{HELD_REASON_LABELS[h.snoozeReason] || h.snoozeReason}</span>
              <button
                className="todo-nottoday-reason"
                title="Put it back in the lane now. The deferral stays on the record either way."
                onClick={() => onUndefer(h)}
              >Bring it back</button>
            </div>
          ))}
        </div>
      )}

      {/* "I could not check what you snoozed" is not "nothing is snoozed" — on
          a failed read the lane shows everything rather than hiding work on the
          strength of not having looked, and says so. */}
      {error && (
        <div className="todo-lane-held-head todo-lane-error" onClick={onDismissError}>{error}</div>
      )}

      {(gaps || []).length > 0 && (
        <div className="todo-lane-held-head">
          Showing the whole lane &mdash; couldn&rsquo;t read what you&rsquo;d put off ({gaps.map(g => g.source).join(', ')}).
        </div>
      )}
    </section>
  );
}

export default function TodoPanel({ focusContext, onClearContext }) {
  // Determine initial mode: if arriving from Focus, start in focused shortlist mode
  const fromFocus = focusContext?.fromFocus;
  const initialFilter = focusContext?.filter || 'overdue';

  // A card asked for ONE task by name. That beats every filter and beats the
  // focused shortlist — arriving here from "open it" and landing on a list of
  // five other things is the dead end this exists to close.
  const [pin, setPin] = useState(() => pinFromContext(focusContext));

  const [mode, setMode] = useState(fromFocus && !pinFromContext(focusContext) ? 'focused' : 'full');
  const [focusFilter, setFocusFilter] = useState(initialFilter);
  const [focusExpansion, setFocusExpansion] = useState('compact'); // compact (5) | expanded (10) | all

  // Full mode state (original)
  const [showDone, setShowDone] = useState(false);
  // ── Stacked filters ────────────────────────────────────────────────────────
  //
  // One selection per DIMENSION, ANDed across dimensions, so "Commitments with
  // no due date" is expressible — which it was not when `filter` was a single
  // string and every chip replaced the last.
  //
  // ⚠ Grouped rather than free toggles, because within a dimension the options
  // are mutually exclusive by construction: a task cannot be both overdue and
  // undated, and cannot be a commitment and continual improvement at once.
  // Letting them stack would offer combinations that are always empty, which
  // teaches that the filters are broken.
  //
  // Pressing the selected chip again clears it, so every state is reachable
  // without hunting for "All".
  const [filters, setFilters] = useState({});
  const [subFilters, setSubFilters] = useState([]);
  const sourceFilter = filters.source || null;
  const [toggling, setToggling] = useState({});
  const [msPushWarning, setMsPushWarning] = useState(null);
  // Not a warning: the push LANDED. The task is open again because it recurs,
  // which is a different fact from "Microsoft would not take it" and has to read
  // differently or the two get conflated into "it didn't work".
  const [msRolledNotice, setMsRolledNotice] = useState(null);
  // A tick that was held for a write-up. Shown rather than swallowed: a task
  // that silently refuses to complete is far worse than no hold at all, and it
  // is the one moment Nick needs to be told which note to go and write.
  const [holdNotice, setHoldNotice] = useState(null);
  // A completion the server would not make, with its stated reason. Kept apart
  // from holdNotice above because "held until you write it up" and "this is
  // Jira's to close" ask for opposite things next.
  const [refusalNotice, setRefusalNotice] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [showMoscow, setShowMoscow] = useState(false);
  const [moscowRatings, setMoscowRatings] = useState({});
  const [actingSuggestionId, setActingSuggestionId] = useState(null);

  // Load MoSCoW ratings
  useEffect(() => {
    fetch(apiUrl('/api/todos/moscow')).then(r => r.json()).then(d => setMoscowRatings(d.ratings || {})).catch(() => {});
  }, [showMoscow]); // Refresh when moscow review closes

  // ⚠ Pin from the PROP as well as at mount. TodoPanel stays mounted while it
  // is the active view, so a second "open it" from a card on this page (the
  // dedupe list, a suggestion) would otherwise change nothing at all — the
  // classic already-on-that-screen no-op. Only ever set here, never cleared:
  // clearing is "Show all tasks", which is Nick's decision, not a side effect
  // of the parent tidying up its context.
  useEffect(() => {
    const next = pinFromContext(focusContext);
    if (next) { setPin(next); setMode('full'); }
  }, [focusContext]);

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
  const [localDone, setLocalDone] = useState({}); // "filePath:lineNumber" | "task:id" -> 1
  const [localPatches, setLocalPatches] = useState({}); // task_id -> pending field edits
  const [newTaskText, setNewTaskText] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedSuggestions, setSelectedSuggestions] = useState([]);
  const [batching, setBatching] = useState(false);
  const [batchError, setBatchError] = useState(null);

  const applyLocal = (t) => {
    const key = t.task_id ? `task:${t.task_id}` : `${t.filePath}:${t.lineNumber}`;
    const patch = t.task_id ? localPatches[t.task_id] : null;
    const merged = patch
      ? { ...t, ...patch, taskPriority: 'priority' in patch ? patch.priority : t.taskPriority }
      : t;
    return localDone[key] ? { ...merged, done: 1 } : merged;
  };

  const todos = (fullData?.todos || []).map(applyLocal);
  const suggestedTodos = (fullData?.suggested || []).filter(s => !resolvedSuggestions.includes(s.id));
  const todayLane = fullData?.todayLane || [];

  // Open the pinned row rather than merely showing it. The point of "open it"
  // is to land on the edit controls, not on a one-item list still needing a click.
  //
  // ⚠ Placed AFTER `todos`, not up with the other effects. A dependency array
  // is evaluated during render, so referencing `fullData` above its own `const`
  // is a temporal-dead-zone ReferenceError on every render — a crash the build
  // cannot see, because it compiles perfectly.
  //
  // ⚠ ONCE per pin, guarded by a ref. `todos` is rebuilt on every render, so an
  // unguarded effect re-expands the row continuously — and would silently
  // undo Nick collapsing it himself, which reads as a screen fighting back.
  const autoExpandedFor = useRef(null);
  useEffect(() => {
    if (!pin) { autoExpandedFor.current = null; return; }
    const key = `${pin.taskId}|${pin.msId}|${pin.filePath}|${pin.lineNumber}|${pin.text}`;
    if (autoExpandedFor.current === key) return;
    const hit = findPinned(todos, pin);
    if (!hit) return;                       // not loaded yet, or genuinely not here
    autoExpandedFor.current = key;
    setExpanded(`${hit.source}-${hit.id}`);
  }, [pin, todos]);

  const toggleSuggestionSelect = (id) => {
    setSelectedSuggestions(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // Batch: approve/dismiss every selected card in one round trip. Duplicates of an
  // approved card are dismissed rather than approved — the task only wants capturing once.
  const handleBatch = async (verb) => {
    const chosen = suggestedTodos.filter(s => selectedSuggestions.includes(s.id));
    if (!chosen.length) return;
    const primaries = chosen.map(s => s.id);
    const duplicates = chosen.flatMap(s => s.duplicateIds || []);
    setBatching(true);
    try {
      const post = (ids, v) => fetch(apiUrl('/api/actions/batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, verb: v }),
      }).then(r => r.json());

      const main = await post(primaries, verb);
      if (duplicates.length) await post(duplicates, 'reject');

      const done = main.succeeded || [];
      setResolvedSuggestions(prev => [...prev, ...done, ...duplicates]);
      setSelectedSuggestions(prev => prev.filter(id => !done.includes(id)));
      if (main.failed?.length) {
        console.error('[TodoPanel] Batch partially failed:', main.failed);
        setBatchError(`${main.failed.length} of ${primaries.length} failed — left selected.`);
      } else {
        setBatchError(null);
      }
      await fetchTodos();
    } catch (e) {
      console.error('[TodoPanel] Batch error:', e);
      setBatchError('Batch failed. Nothing was changed.');
    }
    setBatching(false);
  };

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

  // Edit a task NEURO owns. Optimistic: the row updates immediately and the refetch
  // confirms it, so setting a MoSCoW doesn't feel like it went nowhere.
  const patchTask = async (todo, fields) => {
    if (!todo.task_id) return;
    const key = `task:${todo.task_id}`;
    setToggling(prev => ({ ...prev, [key]: true }));
    setLocalPatches(prev => ({ ...prev, [todo.task_id]: { ...(prev[todo.task_id] || {}), ...fields } }));
    try {
      const res = await fetch(apiUrl(`/api/tasks/${todo.task_id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        console.error('[TodoPanel] Task patch failed:', res.status);
        setLocalPatches(prev => {
          const next = { ...prev };
          delete next[todo.task_id];
          return next;
        });
      }
      if (mode === 'focused') refreshFocus(); else await fetchTodos();
    } catch (e) {
      console.error('[TodoPanel] Task patch error:', e);
    }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  // A lane write that failed. Deliberately NOT HoldNotice, which is about a
  // write-up hold and renders a block's time and note path — handed a bare
  // reason it prints "had undefined on undefined blocked out for it".
  const [laneError, setLaneError] = useState(null);

  /**
   * "Not today" — and why.
   *
   * ⚠ Keyed on the task's TEXT, because that is what the attention record's
   * dedupe key is built from, and sharing that key is the whole point: this is
   * the same statement as deferring the task on the Now page. Sending a task id
   * instead would open a second, competing record for one decision.
   *
   * The reason is REQUIRED by the caller (the picker offers four and no
   * skip-it): `friction.js` reads those reasons back as evidence about the
   * work, and an unreasoned defer is a decision recorded with the useful half
   * thrown away.
   */
  const deferFromLane = useCallback(async (item, reason) => {
    try {
      const res = await fetch(apiUrl('/api/todos/lane/defer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await fetchTodos();
    } catch (e) {
      // Said out loud rather than swallowed: a "Not today" that silently did
      // nothing leaves the row exactly where it was, which reads as a dead
      // button — the failure this whole lane change exists to remove.
      setLaneError(`Couldn't put "${item.text}" off: ${e.message}`);
    }
  }, [fetchTodos]);

  const undeferFromLane = useCallback(async (item) => {
    try {
      const res = await fetch(apiUrl('/api/todos/lane/undefer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await fetchTodos();
    } catch (e) {
      setLaneError(`Couldn't bring "${item.text}" back: ${e.message}`);
    }
  }, [fetchTodos]);

  const addTask = async () => {
    const text = newTaskText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await fetch(apiUrl('/api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'manual' }),
      });
      if (res.ok) {
        setNewTaskText('');
        await fetchTodos();
      } else {
        console.error('[TodoPanel] Add task failed:', res.status);
      }
    } catch (e) {
      console.error('[TodoPanel] Add task error:', e);
    }
    setAdding(false);
  };

  /**
   * Mark a task started, or put it back.
   *
   * `in-progress` has been a valid status since the task store was written —
   * VALID_STATUS carries it, `activeTodos()` selects it, and the task-block hold
   * already parks work there. Nothing had ever been able to SET it, so the state
   * existed and was unreachable: the same hole as TodoPanel having no menu entry
   * and EOD having no nav item.
   *
   * The task deliberately STAYS in the Must Move lane (Nick's call, 27 Aug) —
   * marking something started must not be a way to make it disappear, which is
   * the failure mode of every "snooze" affordance on a list like this. It only
   * changes how it looks.
   *
   * DB-owned tasks only. A file-backed line (Microsoft, a daily note) has no row
   * to carry the status, and the button says so rather than failing on click.
   */
  const setWip = async (todo) => {
    const key = wipKeyFor(todo);
    if (!key) return;
    // A Microsoft row's started-ness lives in Planner's percentComplete, not in
    // the mirror's checkbox — that line is `- [ ]` whatever the progress is, so
    // reading `status` here would make the button one-way.
    const starting = todo.task_id
      ? todo.status !== 'in-progress'
      : !(todo.percentComplete > 0);
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      let res;
      if (todo.task_id) {
        res = await fetch(apiUrl(`/api/tasks/${todo.task_id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: starting ? 'in-progress' : 'open' }),
        });
      } else {
        // Microsoft owns this one, so its progress goes to Planner/To Do rather
        // than into a shadow copy here. Four of five Must Move rows are Planner
        // tasks, so without this the button would be missing from most of the
        // lane it was asked for.
        res = await fetch(apiUrl('/api/todos/wip-ms'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // filePath/lineNumber let the server update the mirror the lane reads
          // from. Without them the push reaches Planner and the screen does not
          // change for an hour, which is what made this look like a dead button.
          body: JSON.stringify({
            msId: todo.ms_id,
            source: todo.source,
            started: starting,
            filePath: todo.filePath,
            lineNumber: todo.lineNumber,
          }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('[TodoPanel] WIP toggle failed:', res.status, body.error || '');
        setHoldNotice({ reason: body.error || 'Could not update Microsoft', text: todo.text });
      }
      if (mode === 'focused') refreshFocus(); else await fetchTodos();
    } catch (e) {
      console.error('[TodoPanel] WIP toggle error:', e);
    }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  const toggleTodo = async (todo) => {
    // Tasks NEURO owns complete in the DB; file-backed mirrors still toggle the line.
    if (todo.task_id) {
      const key = `task:${todo.task_id}`;
      setToggling(prev => ({ ...prev, [key]: true }));
      try {
        const res = await fetch(apiUrl(`/api/tasks/${todo.task_id}/${todo.done ? 'reopen' : 'complete'}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.clone().json().catch(() => ({}));
        const held = data?.task?.held || null;
        // Only paint it done locally if it actually went done. Optimistically
        // ticking a held task would show the opposite of what happened, and the
        // next refresh would silently un-tick it.
        if (res.ok && !held) setLocalDone(prev => ({ ...prev, [key]: todo.done ? 0 : 1 }));
        setHoldNotice(held ? { ...held, text: todo.text } : null);
        // ⚠ A refusal is SHOWN, not logged. This was a console.error, so every
        // guard in updateTask — the Jira link, and anything added later — reached
        // Nick as a checkbox that did nothing at all. The server's own words are
        // used verbatim: it is the one place that knows which ticket, and a
        // second phrasing here is a second answer free to drift from it.
        setRefusalNotice(res.ok ? null : {
          text: todo.text,
          reason: data?.error || `the server refused it (${res.status}) and gave no reason`,
        });
        if (mode === 'focused') refreshFocus(); else await fetchTodos();
      } catch (e) { console.error('[TodoPanel] Task complete error:', e); }
      setToggling(prev => ({ ...prev, [key]: false }));
      return;
    }

    if (!todo.filePath || todo.lineNumber == null) return;
    const key = `${todo.filePath}:${todo.lineNumber}`;
    setToggling(prev => ({ ...prev, [key]: true }));
    try {
      let res;
      let rolled = null;
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
        // Vault is toggled either way, but say so when Microsoft didn't take it.
        const data = await res.clone().json().catch(() => ({}));
        setMsPushWarning(data.warning || null);
        // A recurring task rolled forward instead of closing. The server has
        // already repainted the mirror line to what Microsoft now holds, so the
        // row must NOT be painted done here — showing a tick that the next
        // refresh removes is precisely how this looked like a lost completion.
        rolled = data.rolled || null;
        setMsRolledNotice(rolled ? (data.notice || null) : null);
      } else {
        res = await fetch(apiUrl('/api/todos/toggle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: todo.filePath, lineNumber: todo.lineNumber })
        });
      }
      if (res.ok && !rolled) setLocalDone(prev => ({ ...prev, [key]: todo.done ? 0 : 1 }));
      else if (!res.ok) console.error('[TodoPanel] Toggle failed:', res.status);
      // Small delay to let vault cache invalidate before refetch
      await new Promise(r => setTimeout(r, 300));
      if (mode === 'focused') refreshFocus();
      else await fetchTodos();
    } catch (e) { console.error('[TodoPanel] Toggle error:', e); }
    setToggling(prev => ({ ...prev, [key]: false }));
  };

  // Reload after a write that happened somewhere other than this component —
  // the same short delay the toggle path uses, so the vault cache has invalidated
  // before the refetch and the row does not come back with the old wording.
  const refreshAfterWrite = async () => {
    await new Promise(r => setTimeout(r, 300));
    if (mode === 'focused') refreshFocus();
    else await fetchTodos();
  };

  // ── Focused Mode Render ──
  if (mode === 'focused') {
    const items = (focusData?.items || []).map(applyLocal);
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

        {msPushWarning && (
          <div className="todo-ms-warning" onClick={() => setMsPushWarning(null)}>
            Marked done here, but not in Microsoft — {msPushWarning}
          </div>
        )}

        {msRolledNotice && (
          <div className="todo-ms-recurred" onClick={() => setMsRolledNotice(null)}>
            {msRolledNotice}
          </div>
        )}

        {holdNotice && <HoldNotice notice={holdNotice} onDismiss={() => setHoldNotice(null)} />}
        {refusalNotice && <RefusalNotice notice={refusalNotice} onDismiss={() => setRefusalNotice(null)} />}

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
              selected={selectedSuggestions}
              onToggleSelect={toggleSuggestionSelect}
              onSelectAll={() => setSelectedSuggestions(suggestedTodos.map(s => s.id))}
              onClearSelection={() => setSelectedSuggestions([])}
              onBatch={handleBatch}
              batching={batching}
              batchError={batchError}
              onApprove={(item) => handleSuggestionAction(item, 'approve')}
              onReject={(item) => handleSuggestionAction(item, 'reject')}
            />
            <div className="todo-list">
              {items.map(todo => (
                <TodoItem
                  key={rowKey(todo)}
                  todo={todo}
                  toggling={toggling}
                  onToggle={toggleTodo}
                  expanded={expanded}
                  onExpand={setExpanded}
                  onPatch={patchTask}
                  onRefresh={refreshAfterWrite}
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
  // was `todos === null`, which can never be true: `todos` is built with
  // `(fullData?.todos || []).map(...)` and is therefore always an array. So the
  // "Loading vault tasks..." branch below was dead, and an unloaded panel said
  // "No open todos. Rare." — an empty list standing in for an unread one, which
  // is the one thing this codebase refuses everywhere else. `fullData` is the
  // real signal.
  const loading = fullData == null;
  const activeTodos = (todos || []).filter(t => !t.done);
  const doneTodos = (todos || []).filter(t => t.done);
  const overdueTodos = activeTodos.filter(isMineOverdue);
  const mustDoTodos = activeTodos.filter(t => t.mustdo);

  const subCategoryOptions = useMemo(() => {
    if (!sourceFilter) return [];
    const counts = {};
    for (const t of activeTodos) {
      if (getTopGroup(t.source) !== sourceFilter) continue;
      const sub = getSubCategory(t.source) || (
        sourceFilter === 'vault'
          ? (t.source?.startsWith('Master') ? 'Master Todo' : t.source?.startsWith('Daily') ? 'Daily Note' : 'Other')
          : (t.source?.startsWith('MS Planner') ? 'Planner' : t.source?.startsWith('MS ToDo') ? 'ToDo' : 'Other')
      );
      counts[sub] = (counts[sub] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [sourceFilter, activeTodos]);

  // ⚠ The pin outranks every filter. A card said "open THIS", and dropping it
  // into a filtered list is the same dead end as not linking at all — the row
  // may not be in the filter that happens to be selected.
  const pinnedTodo = pin ? findPinned(activeTodos, pin) : null;

  const activeFilterKeys = Object.values(filters).filter(Boolean);

  let filtered = activeTodos;
  if (pin) {
    // A miss renders as a stated miss below, never as an empty list: "it isn't
    // here" and "it's finished or I couldn't read it" are different facts.
    filtered = pinnedTodo ? [pinnedTodo] : [];
  } else {
    for (const key of activeFilterKeys) {
      const predicate = FILTER_PREDICATES[key];
      if (predicate) filtered = filtered.filter(predicate);
    }
    if (sourceFilter && subFilters.length > 0) {
      filtered = filtered.filter(t => subFilters.includes(subCategoryOf(t, sourceFilter)));
    }
  }

  const toggleSubFilter = (sub) => {
    setSubFilters(prev =>
      prev.includes(sub) ? prev.filter(s => s !== sub) : [...prev, sub]
    );
  };

  const setTopFilter = (key) => {
    if (key === 'all') {
      setFilters({});
      setSubFilters([]);
      return;
    }
    const group = FILTER_GROUPS[key];
    if (!group) return;
    setFilters(prev => {
      const next = { ...prev };
      // Pressing the selected chip again clears its dimension, so every state
      // is reachable without going via "All".
      if (next[group] === key) delete next[group];
      else next[group] = key;
      return next;
    });
    // Sub-filters belong to whichever source is selected; they cannot survive
    // it changing or being cleared.
    if (group === 'source') setSubFilters([]);
  };

  /**
   * What a chip would give you, given everything ELSE that is selected.
   *
   * ⚠ Counted against the other dimensions, never against the whole list. With
   * stacking, a static "Commitments (31)" beside an active "No due date" would
   * promise 31 and deliver the intersection — a count that does not respond to
   * the selection tells you nothing about what pressing it does.
   *
   * Its OWN dimension is excluded, or every chip in the selected group would
   * read 0 except the selected one.
   */
  const countFor = (key) => {
    const group = FILTER_GROUPS[key];
    let rows = activeTodos;
    for (const [g, k] of Object.entries(filters)) {
      if (g === group || !k) continue;
      const p = FILTER_PREDICATES[k];
      if (p) rows = rows.filter(p);
    }
    const own = FILTER_PREDICATES[key];
    return own ? rows.filter(own).length : rows.length;
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
      {msPushWarning && (
        <div className="todo-ms-warning" onClick={() => setMsPushWarning(null)}>
          Marked done here, but not in Microsoft — {msPushWarning}
        </div>
      )}
      {msRolledNotice && (
        <div className="todo-ms-recurred" onClick={() => setMsRolledNotice(null)}>
          {msRolledNotice}
        </div>
      )}
      {holdNotice && <HoldNotice notice={holdNotice} onDismiss={() => setHoldNotice(null)} />}
        {refusalNotice && <RefusalNotice notice={refusalNotice} onDismiss={() => setRefusalNotice(null)} />}
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
        selected={selectedSuggestions}
        onToggleSelect={toggleSuggestionSelect}
        onSelectAll={() => setSelectedSuggestions(suggestedTodos.map(s => s.id))}
        onClearSelection={() => setSelectedSuggestions([])}
        onBatch={handleBatch}
        batching={batching}
        batchError={batchError}
        onApprove={(item) => handleSuggestionAction(item, 'approve')}
        onReject={(item) => handleSuggestionAction(item, 'reject')}
      />
      {/* Above the lane on purpose: "what fits in the time I have" is the
          question that decides whether any of what follows is actionable right
          now. The lane says what matters; this says what is possible. */}
      {/* Starting or closing something here changes the list underneath it, so
          the panel refreshes rather than showing a task that has just been
          ticked. */}
      <TimeFitCard onStarted={refreshAfterWrite} onCompleted={refreshAfterWrite} />
      {/* Lives here rather than behind its own tab: the question "is this the same
          task twice?" is only ever asked while looking at the task list, and a
          screen you have to go and find is one that never gets found. It renders
          as a single quiet line when there is nothing to review, which is most
          days — that is the correct answer, not a broken check. */}
      <TaskDedupe />
      {/* Beside the dedupe check for the same reason, and above the lane: a task
          held open because it has not been written up is a task the lane will
          keep offering, so the explanation has to arrive before the list does. */}
      <TaskBlocks />
      <MustMoveLane
        items={todayLane}
        held={fullData?.laneHeld || []}
        gaps={fullData?.laneGaps || []}
        toggling={toggling}
        onToggle={toggleTodo}
        onSetWip={setWip}
        onDefer={deferFromLane}
        onUndefer={undeferFromLane}
        error={laneError}
        onDismissError={() => setLaneError(null)}
        expanded={expanded}
        onExpand={setExpanded}
        onPatch={patchTask}
        onRefresh={refreshAfterWrite}
      />

      <div className="todo-add">
        <input
          className="todo-add-input"
          placeholder="New task — Enter to add"
          value={newTaskText}
          disabled={adding}
          onChange={(e) => setNewTaskText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
        />
        <button className="btn btn-primary btn-sm" disabled={adding || !newTaskText.trim()} onClick={addTask}>
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>

      <div className="todo-filters">
        {[
          // ⚠ Every count is `countFor`, which measures the chip against the
          // OTHER dimensions currently selected. A static count beside an active
          // filter promises a number it will not deliver.
          { key: 'all', label: 'All' },
          ...(mustDoTodos.length > 0 ? [{ key: 'mustdo', label: `Must Do (${countFor('mustdo')})` }] : []),
          { key: 'overdue', label: `Overdue (${countFor('overdue')})` },
          { key: 'today', label: `Due today (${countFor('today')})` },
          { key: 'nodue', label: `No due date (${countFor('nodue')})` },
          { key: 'high', label: `High priority (${countFor('high')})` },
          // Nick's own split. Full labels rather than the badge's short forms:
          // a filter is a labelled control with room, and these have to read the
          // same as the headings in the report they feed.
          { key: 'commitment', label: `${LABELS.commitment}s (${countFor('commitment')})` },
          { key: 'improvement', label: `${LABELS.improvement} (${countFor('improvement')})` },
          { key: 'unclassified', label: `${UNCLASSIFIED_LABEL} (${countFor('unclassified')})` },
          { key: 'plan', label: `90-Day Plan (${countFor('plan')})` },
          { key: 'vault', label: `Vault Todos (${countFor('vault')})` },
          { key: 'ms', label: `MS Tasks (${countFor('ms')})` },
        ].map(f => (
          <button
            key={f.key}
            className={`todo-filter-btn ${
              f.key === 'all'
                ? (activeFilterKeys.length === 0 ? 'active' : '')
                : (filters[FILTER_GROUPS[f.key]] === f.key ? 'active' : '')
            }${f.key === 'mustdo' ? ' mustdo-filter' : ''}${['commitment', 'improvement', 'unclassified'].includes(f.key) ? ` origin-filter ${f.key}` : ''}`}
            onClick={() => setTopFilter(f.key)}
            title={f.key === 'all' ? 'Clear all filters' : 'Filters stack — one per group. Press again to clear.'}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/*
        What is currently narrowing the list, in words. With one filter the
        chips said it well enough; with several the row of highlights is easy to
        misread, and an unexpectedly short list reads as missing data rather
        than as a filter nobody noticed.
      */}
      {activeFilterKeys.length > 1 && (
        <p className="todo-filter-summary">
          Showing {filtered.length} — {activeFilterKeys.length} filters stacked.
          <button type="button" className="todo-filter-clear" onClick={() => setTopFilter('all')}>Clear</button>
        </p>
      )}

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

      {pin && (
        <div className="todo-pin-banner">
          {loading ? (
            /* ⚠ Not "couldn't find it" while the list is still arriving. The
               miss message is a STATEMENT, and stating it for the second before
               the fetch lands makes it wrong every single time — the same
               species as reading an unread domain as a zero. */
            <span>Finding it&hellip;</span>
          ) : pinnedTodo ? (
            <span>Showing the one task you came here for.</span>
          ) : (
            /* ⚠ Never an empty list. A card pointed at this and the row is not
               in the open list — finished, dropped, or in a source that could
               not be read. Saying which is not possible from here; saying that
               it is not here, is. */
            <span>
              Couldn&rsquo;t find that one in your open tasks &mdash; it may already be done,
              or it may live somewhere NEURO couldn&rsquo;t read. This is not confirmation
              that it doesn&rsquo;t exist.
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => setPin(null)}>Show all tasks</button>
        </div>
      )}

      {loading ? (
        <div className="todo-empty">Loading vault tasks...</div>
      ) : (
        <div className="todo-list">
          {filtered.length === 0 && (
            <div className="todo-empty">
              {activeFilterKeys.length === 0 ? 'No open todos. Rare.' : 'No matching todos.'}
            </div>
          )}
          {filtered.map(todo => (
            <TodoItem
              key={rowKey(todo)}
              todo={todo}
              toggling={toggling}
              onToggle={toggleTodo}
              expanded={expanded}
              onExpand={setExpanded}
              onPatch={patchTask}
              onRefresh={refreshAfterWrite}
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
                    {planBadge(todo) && <span className="todo-ms-plan" title="Microsoft board / list">{planBadge(todo)}</span>}
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
