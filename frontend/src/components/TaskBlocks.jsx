import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './TaskBlocks.css';

/**
 * Push a task into the O365 calendar, and the write-up that closes it.
 *
 * Two surfaces, deliberately in different places.
 *
 * `BlockTimeControl` sits inside TaskControls — the row that is already open
 * when Nick is deciding what to do with a task. "Block an hour for this" is a
 * thought you have while looking AT the task, and a scheduling screen you have
 * to go and find is one that never gets found (the same call TaskDedupe made).
 *
 * `TaskBlocks` is the outstanding-write-ups list, mounted in TodoPanel beside
 * TaskDedupe. It is empty most days and that is the correct answer, not a broken
 * check — it only fills when a block has passed with nothing written about it.
 *
 * The card always says the block is HOLDING the task, never just that a note is
 * missing. A hold Nick cannot see the cause of is a task that mysteriously
 * refuses to complete, which is worse than no hold at all.
 */

// ── Blocking time for one task ───────────────────────────────────────────────

// The same coarse buckets task-store snaps estimates to. Offered as presets
// because "quick / half an hour / a couple of hours" is a judgement anyone can
// make in one second, and that is the only kind that actually gets filled in —
// asking for "37 minutes" asks for a number nobody has.
const DURATIONS = [5, 15, 30, 45, 60, 90, 120];

export function BlockTimeControl({ todo, busy }) {
  const [draft, setDraft] = useState(null);
  const [state, setState] = useState('idle');   // idle | planning | drafted | saving | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const propose = useCallback(async (minutes = null) => {
    setState('planning');
    setError(null);
    try {
      const qs = minutes ? `?minutes=${minutes}` : '';
      const res = await fetch(apiUrl(`/api/task-blocks/plan/${todo.task_id}${qs}`));
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDraft(body);
      setState('drafted');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [todo.task_id]);

  const create = useCallback(async () => {
    setState('saving');
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/task-blocks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: todo.task_id,
          date: draft.slot.date,
          startTime: draft.slot.startTime,
          minutes: draft.minutes,
        }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      setState('done');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [todo.task_id, draft]);

  if (state === 'done' && result) {
    return (
      <div className="todo-edit-group">
        <span className="todo-edit-label">Calendar</span>
        <span className="blocks-outcome blocks-outcome-ok">
          Blocked {result.slot.date} {result.slot.startTime}–{result.slot.endTime} ({result.minutes} min).
          {' '}This task stays open until <code>{result.notePath}</code> has something in it.
        </span>
      </div>
    );
  }

  return (
    <div className="todo-edit-group blocks-control">
      <span className="todo-edit-label">Calendar</span>

      {state === 'idle' && (
        <button className="todo-edit-btn" disabled={busy} onClick={() => propose()}>Block time</button>
      )}
      {state === 'planning' && <span className="blocks-quiet">Looking for a slot…</span>}

      {state === 'drafted' && draft && (
        <>
          <span className="blocks-slot">
            {draft.slot.date} {draft.slot.startTime}–{draft.slot.endTime}
          </span>
          {/* How long, set here. This is the moment Nick is already thinking
              about duration, which is the only moment an estimate gets given —
              0 of 154 open tasks had one, because nothing had ever asked at a
              useful time. What he picks is saved back onto the task. */}
          <span className="blocks-durations">
            {DURATIONS.map(m => (
              <button
                key={m}
                className={`todo-edit-btn${draft.minutes === m ? ' active' : ''}`}
                onClick={() => propose(m)}
              >{m < 60 ? `${m}m` : `${m / 60}h`}</button>
            ))}
          </span>
          {/* #87's rule, carried through: an assumed duration is stated every
              time it is used. A "this fits" that turns out to be a guess is the
              answer you stop trusting after the second time it is wrong. */}
          {draft.minutesAssumed && (
            <span className="blocks-warn" title="No estimate on this task — pick one above and it will be saved">
              assuming {draft.assumedMinutes} min
            </span>
          )}
          {draft.calendarKnown === false && (
            <span className="blocks-warn">
              can't see your diary — this slot may clash
            </span>
          )}
          <input
            type="date"
            className="todo-edit-date"
            value={draft.slot.date}
            onChange={(e) => e.target.value && setDraft({ ...draft, slot: { ...draft.slot, date: e.target.value } })}
          />
          <input
            type="time"
            className="todo-edit-date"
            value={draft.slot.startTime}
            onChange={(e) => e.target.value && setDraft({ ...draft, slot: { ...draft.slot, startTime: e.target.value } })}
          />
          <button className="todo-edit-btn active" onClick={create}>Create</button>
          <button className="todo-edit-btn" onClick={() => { setDraft(null); setState('idle'); }}>Cancel</button>
        </>
      )}

      {state === 'saving' && <span className="blocks-quiet">Creating…</span>}
      {state === 'error' && (
        <>
          <span className="blocks-outcome blocks-outcome-fail">{error}</span>
          <button className="todo-edit-btn" onClick={() => { setState('idle'); setError(null); }}>Try again</button>
        </>
      )}
    </div>
  );
}

// ── Batching several tasks into one window ───────────────────────────────────

/**
 * Pick a few short jobs, block one window for the lot.
 *
 * Lives in this panel rather than as checkboxes down the task list: the list is
 * filtered, grouped and progressively expanded, so a selection made in it would
 * be one Nick loses the moment he changes a filter.
 *
 * The window is chosen independently of what is in it — a 30-minute block
 * holding 20 minutes of work is a normal thing to want, so the overflow is
 * reported rather than enforced.
 */
function BatchComposer({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [picked, setPicked] = useState([]);
  const [minutes, setMinutes] = useState(30);
  const [draft, setDraft] = useState(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || tasks.length) return;
    fetch(apiUrl('/api/tasks?status=open'))
      .then(r => r.json())
      .then(d => setTasks(d.tasks || []))
      .catch(e => setError(e.message));
  }, [open, tasks.length]);

  const toggle = (id) => {
    setDraft(null);
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  };

  const packed = picked
    .map(id => tasks.find(t => t.id === id))
    .filter(Boolean)
    .reduce((sum, t) => sum + (t.estimate_minutes || 0), 0);

  const preview = useCallback(async () => {
    setState('planning');
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/plan/${picked.join(',')}?minutes=${minutes}`));
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDraft(body);
      setState('drafted');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [picked, minutes]);

  const create = useCallback(async () => {
    setState('saving');
    try {
      const res = await fetch(apiUrl('/api/task-blocks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds: picked,
          minutes,
          date: draft.slot.date,
          startTime: draft.slot.startTime,
        }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setState('idle');
      setPicked([]);
      setDraft(null);
      setOpen(false);
      onCreated?.(body);
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [picked, minutes, draft, onCreated]);

  if (!open) {
    return (
      <button className="btn btn-sm blocks-batch-open" onClick={() => setOpen(true)}>
        Block a window for several tasks
      </button>
    );
  }

  return (
    <div className="blocks-batch">
      <div className="blocks-batch-head">
        <strong>Pick the tasks, then the window</strong>
        <button className="btn btn-sm" onClick={() => { setOpen(false); setPicked([]); setDraft(null); }}>Cancel</button>
      </div>

      <div className="blocks-batch-list">
        {tasks.length === 0 && <span className="blocks-quiet">Loading open tasks…</span>}
        {tasks.map(t => (
          <label key={t.id} className={`blocks-batch-item${picked.includes(t.id) ? ' picked' : ''}`}>
            <input type="checkbox" checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
            <span className="blocks-batch-item-text">{t.text}</span>
            {/* An un-estimated task shows a dash, never a number it does not
                have — the same reason time-fit flags every assumption. */}
            <span className="blocks-chip blocks-chip-quiet">
              {t.estimate_minutes ? `${t.estimate_minutes}m` : '—'}
            </span>
          </label>
        ))}
      </div>

      <div className="blocks-batch-foot">
        <span className="blocks-quiet">
          {picked.length} picked, {packed} min estimated
        </span>
        <span className="blocks-durations">
          {DURATIONS.map(m => (
            <button
              key={m}
              className={`todo-edit-btn${minutes === m ? ' active' : ''}`}
              onClick={() => { setMinutes(m); setDraft(null); }}
            >{m < 60 ? `${m}m` : `${m / 60}h`}</button>
          ))}
        </span>
        <button className="btn btn-sm" disabled={!picked.length || state === 'planning'} onClick={preview}>
          Find a slot
        </button>
      </div>

      {/* Reported, not refused: Nick chooses the window, and a deliberately
          tight one is his call to make. */}
      {draft?.overpacked && (
        <div className="blocks-warn">
          {draft.estimatedMinutes} min of work in a {draft.minutes} min window — it will overrun.
        </div>
      )}

      {state === 'drafted' && draft && (
        <div className="blocks-batch-confirm">
          <span className="blocks-slot">
            {draft.slot.date} {draft.slot.startTime}–{draft.slot.endTime}
          </span>
          {draft.calendarKnown === false && (
            <span className="blocks-warn">can't see your diary — this slot may clash</span>
          )}
          <span className="blocks-quiet">One note for all {picked.length}.</span>
          <button className="btn btn-sm btn-primary" onClick={create}>Create</button>
        </div>
      )}

      {state === 'saving' && <span className="blocks-quiet">Creating…</span>}
      {error && <div className="blocks-error">{error}</div>}
    </div>
  );
}

// ── What is waiting to be written up ─────────────────────────────────────────

function Row({ block, onRelease, onDrop, busy, outcome }) {
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="blocks-row">
      <div className="blocks-row-main">
        {block.tasks.map(t => (
          <div key={t.taskId} className="blocks-row-text">
            {t.text}
            {/* Ticked tasks will complete when the note lands; untouched ones
                will not. Saying which is the difference between a write-up that
                does what Nick expects and one that quietly closes work he never
                did. */}
            <span className={`blocks-tick${t.awaiting ? ' blocks-tick-on' : ''}`}>
              {t.awaiting ? 'ticked — completes on write-up' : 'not ticked — stays open'}
            </span>
          </div>
        ))}
        <div className="blocks-row-meta">
          <span className="blocks-chip">{block.dateKey} {block.startTime}–{block.endTime}</span>
          <span className="blocks-chip blocks-chip-quiet">{block.minutes} min{block.minutesAssumed ? ' (assumed)' : ''}</span>
          {block.status === 'awaiting-writeup' && (
            <span className="blocks-chip blocks-chip-hold">holding your tick</span>
          )}
          {/* "not written up" and "the vault could not be read" are different
              facts, and only one of them is about Nick. */}
          {block.vaultError
            ? <span className="blocks-chip blocks-chip-warn">vault unreadable: {block.vaultError}</span>
            : !block.noteExists && <span className="blocks-chip blocks-chip-warn">stub missing</span>}
        </div>
        <div className="blocks-row-note">
          Write it up in <code>{block.notePath}</code>
        </div>
      </div>

      <div className="blocks-row-actions">
        {outcome && <span className={`blocks-outcome blocks-outcome-${outcome.ok ? 'ok' : 'fail'}`}>{outcome.text}</span>}
        {!outcome && !releasing && (
          <>
            <button className="btn btn-sm" disabled={busy} onClick={() => setReleasing(true)}>
              Nothing to write up
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => onDrop(block)}>
              Didn't happen
            </button>
          </>
        )}
        {!outcome && releasing && (
          <div className="blocks-release">
            {/* A reason is required, not encouraged. Without one, "release"
                quietly becomes a second way of saying done and the evidence rule
                stops meaning anything. */}
            <input
              className="blocks-release-input"
              placeholder="Why? (required)"
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) onRelease(block, reason.trim()); }}
            />
            <button className="btn btn-sm btn-primary" disabled={busy || !reason.trim()} onClick={() => onRelease(block, reason.trim())}>
              Close it
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => { setReleasing(false); setReason(''); }}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TaskBlocks() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // Outcomes persist after the row has gone. A released block drops out of the
  // list, so without this a vanished row is indistinguishable from a failure
  // (the same rule ActionsPanel and TaskDedupe follow).
  const [outcomes, setOutcomes] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/task-blocks'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setData(body);
      setError(body.error || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (block, path, body, label) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/${path}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: true, text: label } }));
      load();
    } catch (e) {
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: false, text: e.message } }));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const blocks = data?.blocks || [];

  // One quiet line when there is nothing waiting — which is most days, and is
  // the correct answer rather than a check that has stopped working.
  if (!open) {
    return (
      <div className="blocks-collapsed">
        <span onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
          {loading && 'Checking blocked time…'}
          {!loading && error && <span className="blocks-warn">Write-ups: couldn't check — {error}</span>}
          {!loading && !error && blocks.length === 0 && 'Nothing waiting to be written up.'}
          {!loading && !error && blocks.length > 0 && (
            <span className="blocks-collapsed-active">
              {blocks.length} block{blocks.length === 1 ? '' : 's'} waiting to be written up →
            </span>
          )}
        </span>
        <BatchComposer onCreated={load} />
      </div>
    );
  }

  return (
    <div className="blocks-panel">
      <div className="blocks-header">
        <h4>Waiting on a write-up</h4>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
      </div>

      <p className="blocks-explain">
        A block in the diary is a plan, not finished work — the same rule a meeting
        follows, where the Plaud note is the evidence. Nothing records a solo block,
        so the note you write is the evidence. These tasks stay open until there is
        one.
      </p>

      <BatchComposer onCreated={load} />

      {error && <div className="blocks-error">Couldn't read the list — {error}</div>}
      {!error && blocks.length === 0 && <div className="blocks-empty">Nothing waiting. </div>}

      {blocks.map(block => (
        <Row
          key={block.blockId}
          block={block}
          busy={busyId === block.blockId}
          outcome={outcomes[block.blockId]}
          onRelease={(b, reason) => act(b, 'release', { reason }, `Closed — ${reason}`)}
          onDrop={(b) => act(b, 'drop', {}, 'Block dropped, task still open')}
        />
      ))}
    </div>
  );
}
