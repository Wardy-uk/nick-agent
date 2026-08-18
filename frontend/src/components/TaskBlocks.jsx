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

/**
 * Write the outcome note without leaving NEURO.
 *
 * The note is the one thing between a block and being finished, so making Nick
 * switch to Obsidian to write two lines is exactly the friction that stops it
 * happening — and an unwritten note holds the tasks open indefinitely.
 *
 * It edits the real file in the vault, and says plainly how far off the bar the
 * text currently is. The count is shown while typing rather than only on save,
 * because "that didn't count" after the fact is how a rule stops being trusted.
 */
function NoteEditor({ block, onClose, onSaved }) {
  const [state, setState] = useState('loading');
  const [note, setNote] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(apiUrl(`/api/task-blocks/${block.blockId}/note`))
      .then(r => r.json())
      .then(j => {
        if (!live) return;
        if (!j.ok) { setError(j.error); setState('error'); return; }
        setNote(j);
        setText(j.raw);
        setState('editing');
      })
      .catch(e => { if (live) { setError(e.message); setState('error'); } });
    return () => { live = false; };
  }, [block.blockId]);

  const save = useCallback(async () => {
    setState('saving');
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/note`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, baseHash: note?.hash ?? null }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error);
        // A conflict is recoverable and worth distinguishing: the note moved in
        // the vault, so reloading is the fix rather than retrying the save.
        setState(json.conflict ? 'conflict' : 'error');
        return;
      }
      setResult(json);
      setState('saved');
      onSaved?.(json);
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [block.blockId, text, note, onSaved]);

  if (state === 'loading') return <div className="blocks-editor blocks-quiet">Opening the note…</div>;

  if (state === 'saved' && result) {
    return (
      <div className="blocks-editor">
        <div className={`blocks-outcome blocks-outcome-${result.released ? 'ok' : 'fail'}`}>
          {result.released
            ? `Saved. ${result.completedTaskIds.length} task${result.completedTaskIds.length === 1 ? '' : 's'} completed${result.stillOpenTaskIds.length ? `, ${result.stillOpenTaskIds.length} still open (not ticked)` : ''}.`
            : `Saved, but it does not count yet — ${result.reason}. The block stays open.`}
        </div>
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
    );
  }

  // Only Nick's own prose counts, so the live number is measured the same way
  // the release check measures it — the stub, the headings and the checklist are
  // all excluded.
  const enough = countProse(text) >= (note?.minChars ?? 25);

  return (
    <div className="blocks-editor">
      <textarea
        className="blocks-editor-text"
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        rows={16}
      />
      <div className="blocks-editor-foot">
        <span className={enough ? 'blocks-note-ok' : 'blocks-warn'}>
          {enough
            ? 'That counts — saving will complete the ticked tasks'
            : `${countProse(text)} / ${note?.minChars ?? 25} characters of your own words`}
        </span>
        <button className="btn btn-sm btn-primary" disabled={state === 'saving'} onClick={save}>
          {state === 'saving' ? 'Saving…' : 'Save to vault'}
        </button>
        <button className="btn btn-sm" onClick={onClose}>Cancel</button>
      </div>
      {state === 'conflict' && (
        <div className="blocks-error">
          {error} <button className="btn btn-sm" onClick={onClose}>Reload</button>
        </div>
      )}
      {state === 'error' && <div className="blocks-error">{error}</div>}
    </div>
  );
}

/**
 * How much of this is Nick's own writing — the same subtraction the backend
 * makes, so the number on screen and the rule that releases the block agree.
 * Kept simple deliberately: the server is the authority, this only has to stop
 * the count being obviously wrong while typing.
 */
function countProse(raw) {
  let t = String(raw || '').replace(/\r\n/g, '\n');
  t = t.replace(/^---\n[\s\S]*?\n---/, ' ');
  for (const [open, close] of [
    ['<!-- neuro:task-outcome-stub -->', '<!-- /neuro:task-outcome-stub -->'],
    ['<!-- neuro:task-outcome-list -->', '<!-- /neuro:task-outcome-list -->'],
  ]) {
    t = t.split(open).map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf(close);
      return end === -1 ? '' : part.slice(end + close.length);
    }).join(' ');
  }
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/^#{1,6}[^\n]*$/gm, ' ');
  t = t.replace(/^\s*[-*+]\s*(\[[ xX]\])?\s*$/gm, ' ');
  return t.replace(/\s+/g, ' ').trim().length;
}

// ── What is waiting to be written up ─────────────────────────────────────────

function Row({ block, onRelease, onDrop, onToggleTask, onRemoveTask, onEditNote, editing, onCloseEditor, onSaved, busy, outcome }) {
  const [releasing, setReleasing] = useState(false);
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className={`blocks-row${block.passed ? '' : ' blocks-row-upcoming'}`}>
      <div className="blocks-row-main">
        {/* The tasks in this window, grouped — which is the point of grouping
            them. Before this they were scattered back through the main list in
            score order, so the batch Nick had just made was not a thing he could
            see or work through anywhere. */}
        <div className="blocks-tasks-label">In this block — tick or remove one at a time:</div>
        {block.tasks.map(t => (
          <div key={t.taskId} className="blocks-task">
            <button
              className={`todo-checkbox${t.awaiting ? ' blocks-task-ticked' : ''}`}
              disabled={busy || t.awaiting}
              title={t.awaiting ? 'Ticked — completes when the note is written' : 'Mark done'}
              onClick={() => onToggleTask(block, t)}
            />
            <span className="blocks-task-text">{t.text}</span>
            {/* Ticked tasks will complete when the note lands; untouched ones
                will not. Saying which is the difference between a write-up that
                does what Nick expects and one that quietly closes work he never
                did. */}
            <span className={`blocks-tick${t.awaiting ? ' blocks-tick-on' : ''}`}>
              {t.awaiting ? 'completes on write-up' : 'not ticked'}
            </span>
            {/* Taking it out returns it to being an ordinary open task — the
                task is never deleted, only its membership. */}
            <button
              className="blocks-task-remove"
              disabled={busy || block.tasks.length === 1}
              title={block.tasks.length === 1
                ? 'The only task in this block — drop the block instead'
                : 'Take this out of the block'}
              onClick={() => onRemoveTask(block, t)}
            >×</button>
          </div>
        ))}
        <div className="blocks-row-meta">
          <span className="blocks-chip">{block.dateKey} {block.startTime}–{block.endTime}</span>
          <span className="blocks-chip blocks-chip-quiet">{block.minutes} min{block.minutesAssumed ? ' (assumed)' : ''}</span>
          {/* In the diary versus behind us. Different words, same rows — a block
              that has not happened yet owes nothing. */}
          {!block.passed && <span className="blocks-chip blocks-chip-quiet">upcoming</span>}
          {block.passed && block.status === 'awaiting-writeup' && (
            <span className="blocks-chip blocks-chip-hold">holding your tick</span>
          )}
          {/* "not written up" and "the vault could not be read" are different
              facts, and only one of them is about Nick. */}
          {block.vaultError
            ? <span className="blocks-chip blocks-chip-warn">vault unreadable: {block.vaultError}</span>
            : !block.noteExists && <span className="blocks-chip blocks-chip-warn">stub missing</span>}
        </div>
        <div className="blocks-row-note">
          {block.passed ? 'Write it up in ' : 'Will be written up in '}<code>{block.notePath}</code>
          {/* Edit, not create — the note is written when the block is created,
              so the thing standing between here and completion is never the
              file, it is the words in it. A missing note opens as a fresh stub,
              so this one button covers both. */}
          <button className="btn btn-sm blocks-note-create" disabled={busy} onClick={() => onEditNote(block)}>
            {block.noteExists ? 'Write it up' : 'Start the note'}
          </button>
        </div>
      </div>

      {editing && (
        <NoteEditor block={block} onClose={onCloseEditor} onSaved={onSaved} />
      )}

      {/* Block-level actions, fenced off and labelled with what they affect.
          They used to sit in a row that lined up beside the FIRST task, so
          "Didn't happen" read as belonging to that task — it does not, it ends
          the whole block, and it was clicked on that understanding. Anything
          that acts on every task in the window now says how many, and asks. */}
      <div className="blocks-row-actions">
        <span className="blocks-actions-label">
          Whole block ({block.tasks.length} task{block.tasks.length === 1 ? '' : 's'}):
        </span>
        {outcome && <span className={`blocks-outcome blocks-outcome-${outcome.ok ? 'ok' : 'fail'}`}>{outcome.text}</span>}
        {!outcome && !releasing && !confirmingDrop && (
          <>
            <button className="btn btn-sm" disabled={busy} onClick={() => setReleasing(true)}>
              Nothing to write up — close all {block.tasks.length}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmingDrop(true)}>
              Didn't happen — drop all {block.tasks.length}
            </button>
          </>
        )}
        {!outcome && confirmingDrop && (
          <span className="blocks-confirm">
            Drop the whole block? The {block.tasks.length} task{block.tasks.length === 1 ? '' : 's'} stay open.
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => { setConfirmingDrop(false); onDrop(block); }}>
              Yes, drop it
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmingDrop(false)}>
              Keep it
            </button>
          </span>
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

  /**
   * Tick a task off from inside its block.
   *
   * Goes through the ordinary task-completion route, so the hold applies exactly
   * as it does everywhere else — the tick is recorded, the task waits for the
   * write-up. Reusing that route rather than adding a block-specific one is what
   * keeps a single answer to "what does completing a task do".
   */
  const toggleTask = useCallback(async (block, task) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/tasks/${task.taskId}/complete`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      load();
    } catch (e) {
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: false, text: e.message } }));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const removeTask = useCallback(async (block, task) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/tasks/${task.taskId}`), {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // Say what Outlook did rather than implying it agreed — the membership is
      // already gone here either way.
      if (json.eventUpdate && json.eventUpdate.updated === false) {
        setOutcomes(o => ({
          ...o,
          [block.blockId]: { ok: true, text: `Removed — but Outlook still lists it (${json.eventUpdate.reason})` },
        }));
      }
      load();
    } catch (e) {
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: false, text: e.message } }));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  /**
   * Write the outcome note now.
   *
   * A repair action: the stub is written when the block is created, so this is
   * for when that failed or the note was deleted. It never overwrites, so the
   * worst case of pressing it is being told the note is already there.
   */
  const [editingId, setEditingId] = useState(null);
  // A dropped block leaves the list immediately, taking any undo button inside
  // its card with it. So the way back lives here, above the list, and survives
  // the row disappearing.
  const [lastDropped, setLastDropped] = useState(null);

  const createNote = useCallback(async (block) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/note`), { method: 'POST' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setOutcomes(o => ({
        ...o,
        [block.blockId]: {
          ok: true,
          text: json.created ? `Note written to ${json.notePath}` : 'That note already exists — nothing was overwritten',
        },
      }));
      load();
    } catch (e) {
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: false, text: e.message } }));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const dropBlock = useCallback(async (block) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/drop`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setLastDropped({ blockId: block.blockId, tasks: block.tasks.length, when: `${block.dateKey} ${block.startTime}` });
      load();
    } catch (e) {
      setOutcomes(o => ({ ...o, [block.blockId]: { ok: false, text: e.message } }));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const undoDrop = useCallback(async () => {
    if (!lastDropped) return;
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${lastDropped.blockId}/restore`), { method: 'POST' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setLastDropped(null);
      load();
    } catch (e) {
      setLastDropped(d => (d ? { ...d, error: e.message } : d));
    }
  }, [lastDropped, load]);

  const blocks = data?.blocks || [];
  const owed = blocks.filter(b => b.passed);

  // One quiet line when there is nothing waiting — which is most days, and is
  // the correct answer rather than a check that has stopped working.
  if (!open) {
    return (
      <div className="blocks-collapsed">
        <span onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
          {loading && 'Checking blocked time…'}
          {!loading && error && <span className="blocks-warn">Write-ups: couldn't check — {error}</span>}
          {!loading && !error && blocks.length === 0 && 'No blocked time.'}
          {/* Two different facts, and only the first is asking anything of Nick:
              blocks that have happened and owe a write-up, versus blocks simply
              sitting in the diary. */}
          {!loading && !error && owed.length > 0 && (
            <span className="blocks-collapsed-active">
              {owed.length} block{owed.length === 1 ? '' : 's'} waiting to be written up →
            </span>
          )}
          {!loading && !error && owed.length === 0 && blocks.length > 0 && (
            <span>{blocks.length} block{blocks.length === 1 ? '' : 's'} in the diary →</span>
          )}
        </span>
        <BatchComposer onCreated={load} />
      </div>
    );
  }

  return (
    <div className="blocks-panel">
      <div className="blocks-header">
        <h4>Blocked time</h4>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
      </div>

      <p className="blocks-explain">
        A block in the diary is a plan, not finished work — the same rule a meeting
        follows, where the Plaud note is the evidence. Nothing records a solo block,
        so the note you write is the evidence. These tasks stay open until there is
        one.
      </p>

      <BatchComposer onCreated={load} />

      {lastDropped && (
        <div className="blocks-undo">
          Dropped the {lastDropped.when} block ({lastDropped.tasks} task{lastDropped.tasks === 1 ? '' : 's'}).
          {' '}Nothing was deleted — the tasks are still open.
          <button className="btn btn-sm btn-primary" onClick={undoDrop}>Undo</button>
          <button className="btn btn-sm" onClick={() => setLastDropped(null)}>Dismiss</button>
          {lastDropped.error && <span className="blocks-error"> {lastDropped.error}</span>}
        </div>
      )}

      {error && <div className="blocks-error">Couldn't read the list — {error}</div>}
      {!error && blocks.length === 0 && <div className="blocks-empty">No blocked time.</div>}

      {blocks.map(block => (
        <Row
          key={block.blockId}
          block={block}
          busy={busyId === block.blockId}
          outcome={outcomes[block.blockId]}
          onToggleTask={toggleTask}
          onRemoveTask={removeTask}
          onEditNote={(b) => setEditingId(b.blockId)}
          editing={editingId === block.blockId}
          onCloseEditor={() => { setEditingId(null); load(); }}
          onSaved={() => load()}
          onRelease={(b, reason) => act(b, 'release', { reason }, `Closed — ${reason}`)}
          onDrop={(b) => dropBlock(b)}
        />
      ))}
    </div>
  );
}
