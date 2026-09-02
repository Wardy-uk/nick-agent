import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './TaskDedupe.css';

/**
 * "Is this the same task twice?" — two halves.
 *
 * NEURO against MICROSOFT, and (31 Aug 2026) NEURO against ITSELF. The second
 * half was the bigger hole and nothing had ever looked at it: measured on the
 * live list, 143 open NEURO tasks held four pairs scoring 1.000 and two more
 * above 0.7 — one commitment captured twice out of two wordings of the same
 * meeting. The only guard on that side was `dedupe_key`, the first 80 characters
 * of normalised text, which matches a re-import of identical wording and nothing
 * else. Confirming an internal pair MERGES rather than links: the kept row
 * absorbs what the other knew and the other is marked `dropped`, never deleted,
 * and there is an Undo.
 *
 * NEURO owns tasks, Microsoft owns its own, and nothing ever compared the two —
 * so a job written into To Do and then promoted out of a meeting note sat in the
 * list twice, under different wording. `dedupe_key` cannot close that: it matches
 * identical text, and the whole problem is that the text is different.
 *
 * So the backend RANKS pairs and this screen shows them side by side. It never
 * merges on its own, and that is the point rather than caution for its own sake:
 * a wrong auto-merge hides a real task behind an unrelated one, silently, in the
 * one place Nick looks to find out what he owes.
 *
 * Three things the card is careful about:
 *
 * · It shows WHY, not just a percentage. The shared distinctive words are on the
 *   card, because "78%" is not something a person can check and "shares:
 *   succession, plan" is.
 *
 * · Empty is the normal state, and it says which kind of empty. "Nothing matched"
 *   and "there was nothing to compare" look identical otherwise, and only one of
 *   them means this is working.
 *
 * · "Not the same" is remembered. 2,500-odd pairs are scored every time this
 *   opens, so a rejected pair would come back for ever.
 */

function Side({ label, tone, text, due, meta }) {
  return (
    <div className={`dedupe-side dedupe-side-${tone}`}>
      <div className="dedupe-side-label">{label}</div>
      <div className="dedupe-side-text">{text}</div>
      <div className="dedupe-side-meta">
        {due && <span className="dedupe-chip">📅 {due}</span>}
        {meta && <span className="dedupe-chip dedupe-chip-quiet">{meta}</span>}
        {!due && <span className="dedupe-chip dedupe-chip-quiet">no due date</span>}
      </div>
    </div>
  );
}

/** The server refuses a merge in named cases; say which, in words. A bare
 *  "failed" sends Nick to work out what happened, and the reasons are all
 *  actionable ones. */
const REFUSALS = {
  drop_is_linked_to_microsoft: 'That one is linked to a Microsoft task — unlink it first, or merge the other way round.',
  already_dropped: 'That task has already been merged away.',
  drop_is_done: 'That task is already done — nothing to merge.',
  same_task: 'Those are the same row.',
  keep_not_found: 'The task to keep no longer exists.',
  drop_not_found: 'The other task no longer exists.',
};

function refusalText(json) {
  return REFUSALS[json?.reason] || json?.reason || json?.error || 'Could not merge.';
}

export default function TaskDedupe() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [weak, setWeak] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  // Outcomes stay on screen after the pair has gone. A linked pair drops out of
  // the candidate list, so without this a card that vanished would be
  // indistinguishable from one that failed (same rule as ActionsPanel).
  const [outcomes, setOutcomes] = useState({});

  const load = useCallback(async (weakMode) => {
    setLoading(true);
    try {
      const qs = weakMode ? '?minScore=0.25' : '';
      const res = await fetch(apiUrl(`/api/task-dedupe/candidates${qs}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(weak); }, [load, weak]);

  async function act(pair, kind) {
    setBusyKey(pair.pairKey);
    try {
      // `lead` decides whose WORDING the surviving row carries and nothing
      // else — both records stay either way, NEURO counts it once either way,
      // and ticking it completes both either way. msText/msDue travel ONLY when
      // the board is leading, so nothing can be adopted by accident.
      const lead = kind === 'link-ms' ? 'microsoft' : 'neuro';
      const body = kind.startsWith('link')
        ? {
          taskId: pair.neuro.id,
          msId: pair.ms.ms_id,
          msSource: pair.ms.source,
          msPlan: pair.ms.msPlan || null,
          lead,
          msText: lead === 'microsoft' ? pair.ms.text : null,
          msDue: lead === 'microsoft' ? (pair.ms.due_date || null) : null,
        }
        : { taskId: pair.neuro.id, msId: pair.ms.ms_id };
      const res = await fetch(apiUrl(`/api/task-dedupe/${kind === 'link-ms' ? 'link' : kind}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOutcomes(o => ({ ...o, [pair.pairKey]: { ok: false, text: json.reason || json.error || `HTTP ${res.status}` } }));
      } else {
        setOutcomes(o => ({
          ...o,
          [pair.pairKey]: {
            ok: true,
            // ⚠ Says what actually happened, per branch. A failed adoption
            // still leaves the pair merged, and reporting that as a clean
            // "merged, using Planner's wording" would be a claim about the
            // card's title that anyone can see is untrue.
            text: kind.startsWith('link')
              ? (
                json.adopted && json.adopted.ok === false
                  ? `Merged — shows once now, and ticking it completes both. Planner's wording was NOT adopted: ${json.adopted.reason}`
                  : `Merged — shows once now, and ticking it completes both. Leading with ${lead === 'microsoft' ? "Planner's" : "NEURO's"} wording.`
              )
              : "Kept separate. You won't be asked about this pair again.",
          },
        }));
        load(weak);
      }
    } catch (e) {
      setOutcomes(o => ({ ...o, [pair.pairKey]: { ok: false, text: e.message } }));
    } finally {
      setBusyKey(null);
    }
  }

  // NEURO against itself. `merge` keeps the older row and drops the newer one;
  // `internal-dismiss` remembers that they are different jobs. The refusal cases
  // (a Microsoft-linked row, an already-dropped one) come back as a reason, and
  // the reason is what the card shows — an approve that quietly fails is worse
  // than one that says why.
  async function actInternal(pair, kind) {
    setBusyKey(pair.pairKey);
    try {
      const body = kind === 'merge'
        ? { keepId: pair.keep.id, dropId: pair.drop.id }
        : { aId: pair.keep.id, bId: pair.drop.id };
      const res = await fetch(apiUrl(`/api/task-dedupe/${kind === 'merge' ? 'merge' : 'internal-dismiss'}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        setOutcomes(o => ({ ...o, [pair.pairKey]: { ok: false, text: refusalText(json) } }));
      } else {
        setOutcomes(o => ({
          ...o,
          [pair.pairKey]: {
            ok: true,
            text: kind === 'merge'
              ? `Merged into #${pair.keep.id}. The other one is dropped, not deleted — undo it below.`
              : 'Kept separate. You won\'t be asked about this pair again.',
          },
        }));
        load(weak);
      }
    } catch (e) {
      setOutcomes(o => ({ ...o, [pair.pairKey]: { ok: false, text: e.message } }));
    } finally {
      setBusyKey(null);
    }
  }

  async function unmerge(droppedId) {
    setBusyKey(`unmerge-${droppedId}`);
    try {
      await fetch(apiUrl('/api/task-dedupe/unmerge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dropId: droppedId }),
      });
      load(weak);
    } finally {
      setBusyKey(null);
    }
  }

  async function unlink(taskId) {
    setBusyKey(`unlink-${taskId}`);
    try {
      await fetch(apiUrl('/api/task-dedupe/unlink'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      load(weak);
    } finally {
      setBusyKey(null);
    }
  }

  if (loading && !data) return null;

  if (error) {
    return (
      <div className="dedupe-card dedupe-card-error">
        <div className="dedupe-head">
          <span className="dedupe-title">Duplicate check</span>
          <span className="dedupe-status">couldn't run — {error}</span>
        </div>
      </div>
    );
  }

  const candidates = data?.candidates || [];
  const internal = data?.internal || [];
  const links = data?.links || [];
  const merges = data?.merges || [];
  const compared = data?.compared || {};
  const strong = candidates.filter(c => c.confidence === 'strong').length;
  const total = candidates.length + internal.length;

  // Nothing to review and nothing decided: stay out of the way entirely rather
  // than adding a permanent "0 duplicates" row to a screen that already has a lot
  // on it. The check still runs; it just has nothing to say.
  if (!total && !links.length && !merges.length && !open && !weak) {
    return (
      <div className="dedupe-quiet">
        <button className="dedupe-quiet-btn" onClick={() => setOpen(true)}>
          No duplicate tasks found · checked {compared.neuro ?? 0} NEURO tasks against each other and against {compared.microsoft ?? 0} Microsoft
        </button>
      </div>
    );
  }

  return (
    <div className="dedupe-card">
      <div className="dedupe-head">
        <span className="dedupe-title">
          Possible duplicates
          {total > 0 && <span className="dedupe-count">{total}</span>}
        </span>
        <button className="dedupe-toggle" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide' : 'Review'}
        </button>
      </div>

      <div className="dedupe-sub">
        {total === 0
          ? (data?.microsoftAvailable
              ? `Nothing matched — ${compared.neuro} NEURO tasks scored against each other and against ${compared.microsoft} Microsoft tasks.`
              : `${compared.neuro} NEURO tasks scored against each other, nothing matched. No Microsoft tasks to compare against — Tasks/Microsoft Tasks.md is empty or has not synced.`)
          : [
              internal.length ? `${internal.length} written twice in NEURO` : null,
              candidates.length ? `${candidates.length} against Microsoft (${strong} likely)` : null,
            ].filter(Boolean).join(' · ')}
      </div>

      {open && (
        <>
          {internal.length > 0 && (
            <div className="dedupe-group">
              <div className="dedupe-group-head">
                Written twice in NEURO
                <span className="dedupe-group-note">
                  Merging keeps the older task and fills in anything only the other one knew. The other is dropped, not deleted.
                </span>
              </div>
              {internal.map(pair => {
                const outcome = outcomes[pair.pairKey];
                return (
                  <div key={pair.pairKey} className={`dedupe-pair dedupe-${pair.confidence}`}>
                    <div className="dedupe-pair-head">
                      <span className={`dedupe-badge dedupe-badge-${pair.confidence}`}>
                        {pair.confidence === 'strong' ? 'Likely the same' : 'Possibly the same'}
                      </span>
                      <span className="dedupe-shared">
                        shares: {pair.sharedWords.map(w => w.token).join(', ')}
                      </span>
                    </div>

                    <div className="dedupe-sides">
                      <Side
                        label={`Keep · #${pair.keep.id}`}
                        tone="neuro"
                        text={pair.keep.text}
                        due={pair.keep.due_date}
                        meta={pair.keep.source}
                      />
                      <div className="dedupe-vs">vs</div>
                      <Side
                        label={`Drop · #${pair.drop.id}`}
                        tone="neuro"
                        text={pair.drop.text}
                        due={pair.drop.due_date}
                        meta={pair.drop.source}
                      />
                    </div>

                    {pair.notes.length > 0 && (
                      <div className="dedupe-notes">{pair.notes.join(' · ')}</div>
                    )}

                    {outcome ? (
                      <div className={`dedupe-outcome ${outcome.ok ? 'ok' : 'bad'}`}>{outcome.text}</div>
                    ) : (
                      <div className="dedupe-actions">
                        <button
                          className="dedupe-btn dedupe-btn-link"
                          disabled={busyKey === pair.pairKey}
                          onClick={() => actInternal(pair, 'merge')}
                        >
                          Same task — keep #{pair.keep.id}
                        </button>
                        <button
                          className="dedupe-btn"
                          disabled={busyKey === pair.pairKey}
                          onClick={() => actInternal(pair, 'dismiss')}
                        >
                          Different tasks
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {candidates.length > 0 && (
            <div className="dedupe-group-head">Against Microsoft</div>
          )}

          {candidates.map(pair => {
            const outcome = outcomes[pair.pairKey];
            return (
              <div key={pair.pairKey} className={`dedupe-pair dedupe-${pair.confidence}`}>
                <div className="dedupe-pair-head">
                  <span className={`dedupe-badge dedupe-badge-${pair.confidence}`}>
                    {pair.confidence === 'strong' ? 'Likely the same' : 'Possibly the same'}
                  </span>
                  <span className="dedupe-shared">
                    shares: {pair.sharedWords.map(w => w.token).join(', ')}
                  </span>
                </div>

                <div className="dedupe-sides">
                  <Side
                    label="NEURO"
                    tone="neuro"
                    text={pair.neuro.text}
                    due={pair.neuro.due_date}
                    meta={pair.neuro.source}
                  />
                  <div className="dedupe-vs">vs</div>
                  <Side
                    label={pair.ms.msPlan
                      ? `${pair.ms.source || 'Microsoft'} · ${pair.ms.msPlan}`
                      : (pair.ms.source || 'Microsoft')}
                    tone="ms"
                    text={pair.ms.text}
                    due={pair.ms.due_date}
                  />
                </div>

                {pair.notes.length > 0 && (
                  <div className="dedupe-notes">{pair.notes.join(' · ')}</div>
                )}

                {outcome ? (
                  <div className={`dedupe-outcome ${outcome.ok ? 'ok' : 'bad'}`}>{outcome.text}</div>
                ) : (
                  <div className="dedupe-actions">
                    {/* ⚠ "Merge", not "keep NEURO's". NOTHING is discarded:
                        both records survive, the pair counts as ONE task, and
                        ticking it completes both. The old wording read as a
                        choice about which task to THROW AWAY, which is the one
                        thing this never does — the only choice is whose words
                        the single surviving row carries. */}
                    <button
                      className="dedupe-btn dedupe-btn-link"
                      disabled={busyKey === pair.pairKey}
                      title="Both stay. Counts as one task, ticking it completes both, and the row keeps NEURO's wording."
                      onClick={() => act(pair, 'link')}
                    >
                      Merge — lead with NEURO’s
                    </button>
                    <button
                      className="dedupe-btn dedupe-btn-link"
                      disabled={busyKey === pair.pairKey}
                      title="The same merge, but the row takes the board's title and due date so you and your team read the same words."
                      onClick={() => act(pair, 'link-ms')}
                    >
                      Merge — lead with {pair.ms.source === 'MS ToDo' ? 'To Do' : 'Planner'}’s
                    </button>
                    <button
                      className="dedupe-btn"
                      disabled={busyKey === pair.pairKey}
                      onClick={() => act(pair, 'dismiss')}
                    >
                      Different tasks
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {merges.length > 0 && (
            <div className="dedupe-links">
              <div className="dedupe-links-head">Merged ({merges.length})</div>
              {merges.map(m => (
                <div key={m.droppedId} className="dedupe-link-row">
                  {/* The dropped wording, not the kept one — the kept task is
                      still in the list above; this row exists to say what was
                      folded away, which is the thing you cannot otherwise see. */}
                  <span className="dedupe-link-text">{m.droppedText || `#${m.droppedId}`}</span>
                  <span className="dedupe-chip dedupe-chip-quiet">into #{m.keptId}</span>
                  <button
                    className="dedupe-btn dedupe-btn-small"
                    disabled={busyKey === `unmerge-${m.droppedId}`}
                    onClick={() => unmerge(m.droppedId)}
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          )}

          {links.length > 0 && (
            <div className="dedupe-links">
              <div className="dedupe-links-head">Linked ({links.length})</div>
              {links.map(l => (
                <div key={l.taskId} className="dedupe-link-row">
                  <span className="dedupe-link-text">{l.text}</span>
                  <span className="dedupe-chip dedupe-chip-quiet">
                    {/* The board, when it is known — "MS Planner" alone is true
                        of every Planner task and so identifies none of them. */}
                    {l.ms_plan ? `${l.ms_source || 'Microsoft'} · ${l.ms_plan}` : (l.ms_source || 'Microsoft')}
                  </span>
                  <button
                    className="dedupe-btn dedupe-btn-small"
                    disabled={busyKey === `unlink-${l.taskId}`}
                    onClick={() => unlink(l.taskId)}
                  >
                    Unlink
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Deliberately reachable rather than a hidden cap. The default floor was
              set just above the highest-scoring pair that is NOT a duplicate, so
              looking under it is a real choice with a real cost in noise. */}
          <label className="dedupe-weak">
            <input type="checkbox" checked={weak} onChange={e => setWeak(e.target.checked)} />
            Include weaker matches (more noise)
          </label>
        </>
      )}
    </div>
  );
}
