import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './DecisionsPanel.css';

/**
 * Decisions logged from chat (#28).
 *
 * `GET /api/chat/decisions` and the `decisions` table both existed and nothing
 * in either frontend read them — the route even carried its own TODO. But the
 * ticket's premise ("logged decisions render nowhere") was only half true:
 * measured first, the table held **0 rows**, because both system prompts
 * document `[DECISION: text]` while the parser matched `[DECISION] text`.
 * Nothing was ever logged, so a view built on top would have rendered an empty
 * screen forever and looked finished. The capture bug is fixed alongside this.
 *
 * Which is why the empty state below says the system is *working and waiting*
 * rather than something is wrong: on the day this shipped the correct content
 * was genuinely nothing, and an empty list that reads as a fault is how a
 * working screen gets reported as broken.
 */
export default function DecisionsPanel() {
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDecisions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/chat/decisions'));
      const data = await res.json();
      setDecisions(data.decisions || []);
      setError(null);
    } catch (e) {
      // "I couldn't ask" and "there are none" are different answers, and only
      // one of them is a problem.
      setError(e.message || 'Could not load decisions');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchDecisions(); }, [fetchDecisions]);

  const formatDate = (raw) => {
    if (!raw) return '';
    const d = new Date(String(raw).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // Grouped by day, because a decision is remembered by when it was taken.
  const groups = [];
  for (const d of decisions) {
    const key = formatDate(d.created_at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(d);
    else groups.push({ key, items: [d] });
  }

  return (
    <div className="decisions-panel">
      <div className="decisions-header">
        <h2 className="decisions-title">Decisions</h2>
        <button className="decisions-refresh" onClick={fetchDecisions} title="Refresh">
          Refresh
        </button>
      </div>

      <p className="decisions-sub">
        Logged from chat with <code>[DECISION: …]</code>, and mirrored into
        <span className="decisions-path"> Decision Log/decisions.md</span> in the vault.
      </p>

      {loading && <div className="decisions-loading">Loading decisions…</div>}

      {!loading && error && (
        <div className="decisions-error">Couldn’t load decisions — {error}</div>
      )}

      {!loading && !error && decisions.length === 0 && (
        <div className="decisions-empty">
          <strong>No decisions logged yet.</strong>
          <span>
            Ask SARA to record one, or say so in chat — anything she marks with
            {' '}<code>[DECISION: …]</code> lands here and in the vault.
          </span>
        </div>
      )}

      {!loading && !error && groups.map(group => (
        <div className="decisions-group" key={group.key}>
          <div className="decisions-date">{group.key}</div>
          {group.items.map(d => (
            <div className="decisions-item" key={d.id}>
              <span className="decisions-text">{d.decision_text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
