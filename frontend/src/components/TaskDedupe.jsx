import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './TaskDedupe.css';

/**
 * "Is this the same task twice?" — NEURO against Microsoft Planner / To Do.
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
      const body = kind === 'link'
        ? { taskId: pair.neuro.id, msId: pair.ms.ms_id, msSource: pair.ms.source }
        : { taskId: pair.neuro.id, msId: pair.ms.ms_id };
      const res = await fetch(apiUrl(`/api/task-dedupe/${kind}`), {
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
            text: kind === 'link'
              ? 'Linked — this now shows once, and ticking it off in NEURO completes it in Microsoft too.'
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
  const links = data?.links || [];
  const compared = data?.compared || {};
  const strong = candidates.filter(c => c.confidence === 'strong').length;

  // Nothing to review and nothing linked: stay out of the way entirely rather
  // than adding a permanent "0 duplicates" row to a screen that already has a lot
  // on it. The check still runs; it just has nothing to say.
  if (!candidates.length && !links.length && !open && !weak) {
    return (
      <div className="dedupe-quiet">
        <button className="dedupe-quiet-btn" onClick={() => setOpen(true)}>
          No duplicate tasks found · checked {compared.microsoft ?? 0} Microsoft against {compared.neuro ?? 0} NEURO
        </button>
      </div>
    );
  }

  return (
    <div className="dedupe-card">
      <div className="dedupe-head">
        <span className="dedupe-title">
          Possible duplicates
          {candidates.length > 0 && <span className="dedupe-count">{candidates.length}</span>}
        </span>
        <button className="dedupe-toggle" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide' : 'Review'}
        </button>
      </div>

      <div className="dedupe-sub">
        {candidates.length === 0
          ? (data?.microsoftAvailable
              ? `Nothing matched — ${compared.microsoft} Microsoft tasks compared against ${compared.neuro} NEURO tasks.`
              : 'No Microsoft tasks to compare against. Tasks/Microsoft Tasks.md is empty or has not synced.')
          : `${strong} likely, ${candidates.length - strong} worth a look. NEURO's wording is kept; the Microsoft task stays in Microsoft and gets completed when you tick this one off.`}
      </div>

      {open && (
        <>
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
                    label={pair.ms.source || 'Microsoft'}
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
                    <button
                      className="dedupe-btn dedupe-btn-link"
                      disabled={busyKey === pair.pairKey}
                      onClick={() => act(pair, 'link')}
                    >
                      Same task — keep NEURO's
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

          {links.length > 0 && (
            <div className="dedupe-links">
              <div className="dedupe-links-head">Linked ({links.length})</div>
              {links.map(l => (
                <div key={l.taskId} className="dedupe-link-row">
                  <span className="dedupe-link-text">{l.text}</span>
                  <span className="dedupe-chip dedupe-chip-quiet">{l.ms_source || 'Microsoft'}</span>
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
