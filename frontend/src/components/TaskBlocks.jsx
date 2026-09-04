import { useState, useEffect, useCallback, useMemo } from 'react';
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

/**
 * Where a window ends is DERIVED from its start, never carried on the draft.
 *
 * Moving the start has to move the end, or the confirm row states a time that
 * is not the one being created — the same species as a "this fits" built on an
 * assumed duration it does not mention. Past midnight it returns null rather
 * than wrapping into the small hours: a slot that cannot be created should say
 * so before the button is pressed, not after.
 */
function endOf(startTime, minutes) {
  const [h, m] = String(startTime || '').split(':').map(n => parseInt(n, 10));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const end = h * 60 + m + (minutes || 0);
  if (end > 24 * 60) return null;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

/**
 * The proposed slot, editable.
 *
 * A found slot is a suggestion, not a decision — Nick's diary moves under him,
 * and half of what he blocks is work he already knows the right hour for. The
 * backend has always accepted an explicit date and time; nothing on screen had
 * ever offered them.
 *
 * It says plainly when the slot is his rather than NEURO's, because those are
 * not the same claim: a proposed slot was checked against the diary and a typed
 * one is deliberately NOT second-guessed (task-blocks.plan, 'explicit'). Letting
 * the "found you a gap" framing stand over a hand-typed time is how a scheduling
 * tool comes to assert a clash-check it never ran.
 */
function SlotEdit({ slot, minutes, edited, onChange }) {
  const end = endOf(slot.startTime, minutes);
  return (
    <>
      <input
        type="date"
        className="todo-edit-date"
        aria-label="Block date"
        value={slot.date}
        onChange={(e) => e.target.value && onChange({ ...slot, date: e.target.value })}
      />
      <input
        type="time"
        className="todo-edit-date"
        aria-label="Block start time"
        value={slot.startTime}
        onChange={(e) => e.target.value && onChange({ ...slot, startTime: e.target.value })}
      />
      {end
        ? <span className="blocks-slot">– {end} ({minutes} min)</span>
        : <span className="blocks-warn">that start runs past midnight</span>}
      {edited && (
        <span className="blocks-quiet">your slot — not checked against your diary</span>
      )}
    </>
  );
}

/**
 * What blocking this does to the due dates.
 *
 * Blocking a task IS deciding when it is being done, so the due date follows the
 * window — otherwise a task sits in the overdue lane on a day it is already
 * scheduled for.
 *
 * Derived from the CURRENT slot rather than read off the plan, because the slot
 * is editable: a count computed server-side against the proposed day is wrong
 * the moment Nick moves the block, which is exactly the trap the end time fell
 * into.
 *
 * Pulling a date in is bookkeeping and needs no comment. Pushing one OUT moves a
 * deadline — possibly one somebody else is waiting on — so it is said before the
 * button is pressed, never discovered afterwards.
 */
function DueNote({ draft }) {
  const date = draft.slot.date;
  const rows = draft.tasks || [];
  const later = rows.filter(t => t.dueDate && t.dueDate < date);
  const label = `Due date${rows.length === 1 ? '' : 's'} set to ${date}`;
  return later.length === 0
    ? <span className="blocks-quiet">{label}.</span>
    : <span className="blocks-warn">
        {label} — that pushes {later.length} deadline{later.length === 1 ? '' : 's'} out
        {later.length === 1 && later[0].dueDate ? ` (was ${later[0].dueDate})` : ''}.
      </span>;
}

/**
 * The blocks a task could join: still ahead, still a window.
 *
 * ⚠ Three answers, and they must stay apart. `error` is "I could not read your
 * blocks", which is not "you have none" — rendering the first as the second
 * sends Nick to create a second block on top of one he already has. `rows: []`
 * with no error is genuinely nothing upcoming.
 *
 * A block that has PASSED is deliberately not offered: the server refuses it
 * (adding work to a sitting that has been is a claim it was done then), and an
 * option that always answers 400 is worse than no option.
 */
function useJoinableBlocks(open) {
  const [state, setState] = useState({ loading: false, rows: [], error: null, loaded: false });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    fetch(apiUrl('/api/task-blocks'))
      .then(r => r.json())
      .then(body => {
        if (!live) return;
        if (!body.ok) throw new Error(body.error || 'could not read your blocks');
        setState({
          loading: false,
          loaded: true,
          error: null,
          rows: (body.blocks || []).filter(b => !b.passed && b.status === 'scheduled'),
        });
      })
      .catch(e => live && setState({ loading: false, loaded: true, rows: [], error: e.message }));
    return () => { live = false; };
  }, [open]);

  return state;
}

/**
 * What happened when the task joined a block.
 *
 * States the window it landed in AND what the window did, because those are two
 * different facts and only the server knows the second: the block is lengthened
 * by what the task is thought to take, capped by whatever is next in the diary.
 * A shortfall is said out loud rather than left to be discovered at 11:00 —
 * overpacking is Nick's call to make, but only if he is told.
 */
function AddOutcome({ result }) {
  if (result.already) {
    return <span className="blocks-outcome blocks-outcome-ok">Already in that block — nothing to do.</span>;
  }
  return (
    <span className="blocks-outcome blocks-outcome-ok">
      Added — that block now runs to {result.endTime} ({result.minutes} min, {result.total} tasks
      {result.extendedBy > 0 ? `, +${result.extendedBy} min` : ', window unchanged'}).
      {result.extendNote && <><br /><span className="blocks-warn">{result.extendNote}.</span></>}
      {result.estimateAssumed && <><br /><span className="blocks-warn">No estimate on this task, so that length is a guess.</span></>}
      {result.dueUpdate?.later && (
        <><br /><span className="blocks-warn">
          That pushed its due date out to {result.dueUpdate.to} (was {result.dueUpdate.from}).
        </span></>
      )}
      {result.eventUpdate && result.eventUpdate.updated === false && (
        <><br /><span className="blocks-warn">
          The calendar event was not updated ({result.eventUpdate.reason}) — the block itself is right.
        </span></>
      )}
    </span>
  );
}

export function BlockTimeControl({ todo, busy }) {
  const [draft, setDraft] = useState(null);
  const [edited, setEdited] = useState(false);
  // idle | choose | planning | drafted | saving | done | adding | added | error
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [addResult, setAddResult] = useState(null);
  const joinable = useJoinableBlocks(state === 'choose');

  /**
   * Put this task into a window that already exists.
   *
   * ⚠ Every refusal is SHOWN. The server has a lot of reasons to say no here —
   * the window has gone, the task is blocked elsewhere, the block is full — and
   * each one names what to do instead. Swallowing them would leave a button
   * that appears to do nothing, which is the failure this panel keeps hitting.
   */
  const addToBlock = useCallback(async (blockId) => {
    setState('adding');
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${blockId}/tasks`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: todo.task_id }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setAddResult(body);
      setState('added');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [todo.task_id]);

  const propose = useCallback(async (minutes = null) => {
    setState('planning');
    setError(null);
    try {
      const qs = minutes ? `?minutes=${minutes}` : '';
      const res = await fetch(apiUrl(`/api/task-blocks/plan/${todo.task_id}${qs}`));
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDraft(body);
      setEdited(false);
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

  if (state === 'added' && addResult) {
    return (
      <div className="todo-edit-group">
        <span className="todo-edit-label">Focus</span>
        <AddOutcome result={addResult} />
      </div>
    );
  }

  if (state === 'done' && result) {
    return (
      <div className="todo-edit-group">
        <span className="todo-edit-label">Calendar</span>
        <span className="blocks-outcome blocks-outcome-ok">
          Blocked {result.slot.date} {result.slot.startTime}–{result.slot.endTime} ({result.minutes} min).
          {result.dueUpdates?.length > 0 && ` Due ${result.dueUpdates[0].to}${result.dueUpdates[0].from ? ` (was ${result.dueUpdates[0].from})` : ''}.`}
          {' '}This task stays open until <code>{result.notePath}</code> has something in it.
        </span>
      </div>
    );
  }

  return (
    <div className="todo-edit-group blocks-control">
      <span className="todo-edit-label">Calendar</span>

      {state === 'idle' && (
        <button className="todo-edit-btn" disabled={busy} onClick={() => setState('choose')}>
          Add to focus block
        </button>
      )}

      {/* Join one, or make one. Joining is offered FIRST because it is the
          cheaper act and the one that had no route at all — a block already
          holding four tasks used to mean dropping it and re-picking all five to
          add a fifth, which is five steps to do a thing Nick had already
          decided to do. */}
      {state === 'choose' && (
        <span className="blocks-choose">
          {joinable.loading && <span className="blocks-quiet">Reading your blocks…</span>}

          {/* ⚠ "I could not look" is never rendered as "you have none". */}
          {joinable.error && (
            <span className="blocks-warn">
              Couldn't read your existing blocks ({joinable.error}) — you can still make a new one.
            </span>
          )}

          {joinable.loaded && !joinable.error && joinable.rows.length === 0 && (
            <span className="blocks-quiet">No blocks coming up.</span>
          )}

          {joinable.rows.map(b => (
            <button
              key={b.blockId}
              className="todo-edit-btn"
              disabled={busy}
              title={`${b.tasks.length} task${b.tasks.length === 1 ? '' : 's'} in this window — `
                + 'adding one lengthens it, as far as the next thing in your diary allows'}
              onClick={() => addToBlock(b.blockId)}
            >
              {b.dateKey} {b.startTime}–{b.endTime} · {b.tasks.length}
            </button>
          ))}

          <button className="todo-edit-btn active" disabled={busy} onClick={() => propose()}>
            New block…
          </button>
          <button className="todo-edit-btn" onClick={() => setState('idle')}>Cancel</button>
        </span>
      )}

      {state === 'adding' && <span className="blocks-quiet">Adding…</span>}
      {state === 'planning' && <span className="blocks-quiet">Looking for a slot…</span>}

      {state === 'drafted' && draft && (
        <>
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
          {draft.calendarKnown === false && !edited && (
            <span className="blocks-warn">
              can't see your diary — this slot may clash
            </span>
          )}
          <SlotEdit
            slot={draft.slot}
            minutes={draft.minutes}
            edited={edited}
            onChange={(slot) => { setEdited(true); setDraft({ ...draft, slot }); }}
          />
          <DueNote draft={draft} />
          <button
            className="todo-edit-btn active"
            disabled={!endOf(draft.slot.startTime, draft.minutes)}
            onClick={create}
          >Create</button>
          <button className="todo-edit-btn" onClick={() => { setDraft(null); setEdited(false); setState('idle'); }}>Cancel</button>
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
function BatchComposer({ onCreated, allocated }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [picked, setPicked] = useState([]);
  const [minutes, setMinutes] = useState(30);
  const [draft, setDraft] = useState(null);
  const [edited, setEdited] = useState(false);
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
    if (allocated?.byTask.has(id)) return;
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
      setEdited(false);
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
          minutes: draft.minutes,
          date: draft.slot.date,
          startTime: draft.slot.startTime,
        }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setState('idle');
      setPicked([]);
      setDraft(null);
      setEdited(false);
      setOpen(false);
      onCreated?.(body);
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, [picked, draft, onCreated]);

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
        <button className="btn btn-sm" onClick={() => { setOpen(false); setPicked([]); setDraft(null); setEdited(false); }}>Cancel</button>
      </div>

      <div className="blocks-batch-list">
        {tasks.length === 0 && <span className="blocks-quiet">Loading open tasks…</span>}
        {tasks.map(t => {
          // Already in a live block, so it is not something to pack into a
          // second window — but it stays VISIBLE and says why, because a task
          // that silently vanished from this list would read as one that had
          // been done, or as a list that had stopped working.
          const when = allocated?.byTask.get(t.id) || null;
          return (
            <label
              key={t.id}
              className={`blocks-batch-item${picked.includes(t.id) ? ' picked' : ''}${when ? ' allocated' : ''}`}
              title={when ? `Already blocked ${when}` : undefined}
            >
              <input
                type="checkbox"
                checked={picked.includes(t.id)}
                disabled={Boolean(when)}
                onChange={() => toggle(t.id)}
              />
              <span className="blocks-batch-item-text">{t.text}</span>
              {when
                ? <span className="blocks-chip blocks-chip-quiet">allocated · {when}</span>
                /* An un-estimated task shows a dash, never a number it does not
                   have — the same reason time-fit flags every assumption. */
                : <span className="blocks-chip blocks-chip-quiet">
                    {t.estimate_minutes ? `${t.estimate_minutes}m` : '—'}
                  </span>}
            </label>
          );
        })}
      </div>

      {allocated && !allocated.known && (
        <div className="blocks-warn">
          Couldn't check what's already blocked{allocated.why ? ` — ${allocated.why}` : ''}, so nothing
          here is marked allocated. A task may already have a window.
        </div>
      )}

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
          <SlotEdit
            slot={draft.slot}
            minutes={draft.minutes}
            edited={edited}
            onChange={(slot) => { setEdited(true); setDraft({ ...draft, slot }); }}
          />
          {draft.calendarKnown === false && !edited && (
            <span className="blocks-warn">can't see your diary — this slot may clash</span>
          )}
          <DueNote draft={draft} />
          <span className="blocks-quiet">One note for all {picked.length}.</span>
          <button
            className="btn btn-sm btn-primary"
            disabled={!endOf(draft.slot.startTime, draft.minutes)}
            onClick={create}
          >Create</button>
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

/**
 * The window went by and the work did not happen. Move what is left.
 *
 * Before this the only way back was "Didn't happen — drop all N" and then
 * rebuilding the block by hand in the picker, which for a nine-task window is
 * nine re-selections. Nick's difficulty is initiation; a recovery that costs
 * more than the missed block did is a block that never gets rebooked.
 *
 * ⚠ Only the UN-TICKED tasks move, and the form says so before it is used
 * rather than reporting it afterwards. A tick is finished work owed a write-up,
 * and carrying it into a future slot would put a completion back in the diary.
 *
 * The time is OPTIONAL on purpose. "Tomorrow, wherever it fits" is the answer
 * most of the time, and making him pick an hour is the friction this is
 * removing; the picker is there for when a specific slot is the point.
 */
function RescheduleForm({ block, busy, onCancel, onMove }) {
  const movable = block.tasks.filter(t => !t.awaiting);
  const staying = block.tasks.length - movable.length;
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    // Local getters, never toISOString() — the Pi may run UTC.
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [startTime, setStartTime] = useState('');

  if (!movable.length) {
    return (
      <span className="blocks-confirm">
        Everything here is ticked — this needs its write-up, not a new slot.
        <button className="btn btn-sm" disabled={busy} onClick={onCancel}>OK</button>
      </span>
    );
  }

  return (
    <span className="blocks-confirm blocks-reschedule">
      <span className="blocks-reschedule-copy">
        Move {movable.length} outstanding task{movable.length === 1 ? '' : 's'}
        {staying > 0 && ` (${staying} ticked, staying here for the write-up)`} to:
      </span>
      <input
        type="date"
        className="blocks-reschedule-date"
        value={date}
        disabled={busy}
        onChange={(e) => setDate(e.target.value)}
      />
      <input
        type="time"
        className="blocks-reschedule-time"
        value={startTime}
        disabled={busy}
        title="Leave empty and NEURO finds the first gap that fits"
        onChange={(e) => setStartTime(e.target.value)}
      />
      <button
        className="btn btn-sm btn-primary"
        disabled={busy || !date}
        onClick={() => onMove(block, { date, startTime: startTime || null })}
      >
        {startTime ? 'Move it' : 'Move it — first gap that fits'}
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
    </span>
  );
}

function Row({ block, onRelease, onDrop, onReschedule, onToggleTask, onRemoveTask, onEditNote, editing, onCloseEditor, onSaved, busy, outcome }) {
  const [releasing, setReleasing] = useState(false);
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const [moving, setMoving] = useState(false);
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
        {!outcome && !releasing && !confirmingDrop && !moving && (
          <>
            {/* First of the three, because it is the only one that keeps the
                work moving. The other two end the block; this one recovers it,
                and a recovery buried behind two ways to give up is one that
                does not get used. */}
            <button className="btn btn-sm" disabled={busy} onClick={() => setMoving(true)}>
              Didn't get to it — move it
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setReleasing(true)}>
              Nothing to write up — close all {block.tasks.length}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmingDrop(true)}>
              Didn't happen — drop all {block.tasks.length}
            </button>
          </>
        )}
        {!outcome && moving && (
          <RescheduleForm
            block={block}
            busy={busy}
            onCancel={() => setMoving(false)}
            onMove={(b, when) => { setMoving(false); onReschedule(b, when); }}
          />
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

  /**
   * Move a missed block, or the part of it that did not happen.
   *
   * ⚠ 409 is the diary saying that slot is taken, which is a different problem
   * from NEURO refusing the move, and the message says which. The server is the
   * one that decides what moves — this sends the block and the time, never a
   * task list computed here, so the "a tick never travels" rule has exactly one
   * implementation.
   */
  const rescheduleBlock = useCallback(async (block, when) => {
    setBusyId(block.blockId);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/${block.blockId}/reschedule`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: when.date, startTime: when.startTime }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const to = json.to || {};
      const stayed = json.from?.action === 'kept' ? json.from.ticked : 0;
      setOutcomes(o => ({
        ...o,
        [block.blockId]: {
          ok: true,
          text: `Moved ${json.moved.length} to ${to.block?.date_key || when.date} `
            + `${to.block?.start_time || ''}–${to.block?.end_time || ''}`
            // Never silent about what stayed: a count that only mentions what
            // moved reads as the whole block having gone.
            + (stayed ? ` — ${stayed} ticked task${stayed === 1 ? '' : 's'} stayed here, still owed a write-up.` : '.'),
        },
      }));
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

  /**
   * Which open tasks already have a window.
   *
   * Derived from the blocks just read rather than a second fetch, so the picker
   * and the list under it cannot disagree about what is allocated.
   *
   * `known` is separate from the map on purpose: an unread block list means we
   * cannot say, and marking nothing allocated would present that as "none of
   * these are blocked" — the same conflation the panel's own empty state avoids.
   * `/api/task-blocks` returns open blocks only, so a released, dropped or
   * completed one correctly frees its tasks again.
   */
  const allocated = useMemo(() => {
    const byTask = new Map();
    if (loading || error || !data) {
      return { known: false, byTask, why: error || null };
    }
    for (const b of (data.blocks || [])) {
      for (const t of b.tasks) byTask.set(t.taskId, `${b.dateKey} ${b.startTime}`);
    }
    return { known: true, byTask, why: null };
  }, [data, loading, error]);

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
        <BatchComposer onCreated={load} allocated={allocated} />
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

      <BatchComposer onCreated={load} allocated={allocated} />

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
          onReschedule={(b, when) => rescheduleBlock(b, when)}
        />
      ))}
    </div>
  );
}
