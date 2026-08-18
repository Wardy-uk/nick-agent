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

export function BlockTimeControl({ todo, busy }) {
  const [draft, setDraft] = useState(null);
  const [state, setState] = useState('idle');   // idle | planning | drafted | saving | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const propose = useCallback(async () => {
    setState('planning');
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/task-blocks/plan/${todo.task_id}`));
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
          Blocked {result.slot.date} {result.slot.startTime}–{result.slot.endTime}.
          {' '}This task stays open until <code>{result.notePath}</code> has something in it.
        </span>
      </div>
    );
  }

  return (
    <div className="todo-edit-group blocks-control">
      <span className="todo-edit-label">Calendar</span>

      {state === 'idle' && (
        <button className="todo-edit-btn" disabled={busy} onClick={propose}>Block time</button>
      )}
      {state === 'planning' && <span className="blocks-quiet">Looking for a slot…</span>}

      {state === 'drafted' && draft && (
        <>
          <span className="blocks-slot">
            {draft.slot.date} {draft.slot.startTime}–{draft.slot.endTime}
          </span>
          {/* #87's rule, carried through: an assumed duration is stated every
              time it is used. A "this fits" that turns out to be a guess is the
              answer you stop trusting after the second time it is wrong. */}
          {draft.minutesAssumed && (
            <span className="blocks-warn" title="No estimate on this task">
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

// ── What is waiting to be written up ─────────────────────────────────────────

function Row({ block, onRelease, onDrop, busy, outcome }) {
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="blocks-row">
      <div className="blocks-row-main">
        <div className="blocks-row-text">{block.text}</div>
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
      <div className="blocks-collapsed" onClick={() => setOpen(true)}>
        {loading && <span>Checking blocked time…</span>}
        {!loading && error && <span className="blocks-warn">Write-ups: couldn't check — {error}</span>}
        {!loading && !error && blocks.length === 0 && <span>Nothing waiting to be written up.</span>}
        {!loading && !error && blocks.length > 0 && (
          <span className="blocks-collapsed-active">
            {blocks.length} block{blocks.length === 1 ? '' : 's'} waiting to be written up →
          </span>
        )}
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
