import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import HealthCard from './HealthCard';
import './InsightsPanel.css';

export default function InsightsPanel({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [knowledge, setKnowledge] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [applying, setApplying] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [dismissed, setDismissed] = useState(new Set());
  const [eodHistory, setEodHistory] = useState([]);
  const [ritualHistory, setRitualHistory] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const [summariesRes, suggestionsRes, todayStatusRes, eodHistoryRes, ritualRes, knowledgeRes] = await Promise.all([
        fetch(apiUrl('/api/activity/summaries?days=14')),
        fetch(apiUrl('/api/activity/suggestions')),
        fetch(apiUrl('/api/standup/today-status')),
        fetch(apiUrl('/api/standup/eod-history?days=14')),
        fetch(apiUrl('/api/standup/ritual-history?days=7')),
        fetch(apiUrl('/api/knowledge-memory/overview'))
      ]);
      const json = await summariesRes.json();
      const sugJson = await suggestionsRes.json();
      const todayLive = await todayStatusRes.json();
      const eodJson = await eodHistoryRes.json();
      const knowledgeJson = await knowledgeRes.json();

      // Merge live status into today
      if (json.today) {
        json.today.eod_done = todayLive.eodDone || json.today.eod_done;
        json.today.standup_done = todayLive.standupDone || json.today.standup_done;
        json.today._eodContent = todayLive.eodContent;
      }

      setData(json);
      setKnowledge(knowledgeJson.ok ? knowledgeJson : null);
      setSuggestions(sugJson.suggestions || []);
      setEodHistory(eodJson.entries || []);
      const ritualJson = await ritualRes.json();
      setRitualHistory(ritualJson.entries || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const promoteCandidate = async (candidate) => {
    const suggestedDomain = candidate.path.startsWith('Plaud/') ? 'Meetings' : 'General';
    const chosenDomain = window.prompt('Promote into which Knowledge domain/folder?', suggestedDomain);
    if (!chosenDomain) return;
    setPromoting(candidate.path);
    try {
      const res = await fetch(apiUrl('/api/knowledge-memory/promote'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: candidate.path, domain: chosenDomain })
      });
      const result = await res.json();
      if (result.ok) {
        await fetchData();
      }
    } catch {}
    setPromoting(null);
  };

  const applySuggestion = async (suggestion) => {
    if (suggestion.action.navigate) {
      if (onNavigate) onNavigate(suggestion.action.navigate);
      setDismissed(prev => new Set([...prev, suggestion.id]));
      return;
    }
    if (!suggestion.action.endpoint) return;
    setApplying(suggestion.id);
    try {
      const res = await fetch(apiUrl(suggestion.action.endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suggestion.action.body)
      });
      const result = await res.json();
      if (result.success) {
        setDismissed(prev => new Set([...prev, suggestion.id]));
      }
    } catch {}
    setApplying(null);
  };

  if (loading) return <div className="insights-panel"><div className="insights-loading">Loading insights...</div></div>;
  // Health is rendered here too, not only below: it fetches independently of the
  // activity summary, and a quiet activity feed must not take the stress score
  // off the screen with it.
  if (!data) return (
    <div className="insights-panel">
      <HealthCard />
      <div className="insights-empty">No activity data yet.</div>
    </div>
  );

  const { today, summaries } = data;
  const visibleSuggestions = suggestions.filter(s => !dismissed.has(s.id));

  const formatHour = (h) => {
    if (h === null || h === undefined) return '—';
    return `${h}:00`;
  };

  const fmtTopics = (json) => {
    try {
      const t = JSON.parse(json || '[]');
      return t.length > 0 ? t.join(', ') : '—';
    } catch { return '—'; }
  };

  const fmtTabs = (json) => {
    try {
      const t = JSON.parse(json || '{}');
      const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
      return entries.length > 0 ? entries.map(([tab, n]) => `${tab}(${n})`).join(' ') : '—';
    } catch { return '—'; }
  };

  const fmtCaptureTypes = (types) => {
    if (!types || Object.keys(types).length === 0) return null;
    return Object.entries(types).map(([k, v]) => `${k}(${v})`).join(' ');
  };

  // Parse summary_json for extended fields
  const parseSummary = (row) => {
    try { return JSON.parse(row.summary_json || '{}'); } catch { return {}; }
  };

  const todayTopics = today.chat_topics?.length > 0 ? today.chat_topics.join(', ') : '—';
  const todayTabs = Object.entries(today.tabs_opened || {})
    .sort((a, b) => b[1] - a[1])
    .map(([tab, n]) => `${tab}(${n})`).join(' ') || '—';

  return (
    <div className="insights-panel">
      <div className="insights-header">
        <h2 className="insights-title">Insights</h2>
        <button className="insights-refresh" onClick={fetchData}>Refresh</button>
      </div>

      {/* #42 — the stress score had no reader anywhere in the frontend. */}
      <HealthCard />

      {/* Suggestions */}
      {visibleSuggestions.length > 0 && (
        <div className="insights-suggestions">
          <div className="insights-suggestions-title">Suggestions</div>
          {visibleSuggestions.map(s => (
            <div key={s.id} className={`insights-suggestion severity-${s.severity}`}>
              <div className="suggestion-header">
                <span className="suggestion-title">{s.title}</span>
                <button className="suggestion-dismiss" onClick={() => setDismissed(prev => new Set([...prev, s.id]))} title="Dismiss">{'\u00d7'}</button>
              </div>
              <div className="suggestion-description">{s.description}</div>
              {s.action && (
                <button className="suggestion-action-btn" onClick={() => applySuggestion(s)} disabled={applying === s.id}>
                  {applying === s.id ? 'Applying...' : s.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {knowledge && (
        <div className="knowledge-memory-panel">
          <div className="insights-history-title">Knowledge Memory</div>

          <div className="knowledge-stats-grid">
            <div className="knowledge-stat-card">
              <span className="knowledge-stat-label">Raw Memory</span>
              <span className="knowledge-stat-value">{knowledge.counts.rawNotes}</span>
              <span className="knowledge-stat-copy">Recent notes waiting to be distilled.</span>
            </div>
            <div className="knowledge-stat-card">
              <span className="knowledge-stat-label">Trusted Notes</span>
              <span className="knowledge-stat-value">{knowledge.counts.trustedNotes}</span>
              <span className="knowledge-stat-copy">Curated context SARA can lean on.</span>
            </div>
            <div className="knowledge-stat-card">
              <span className="knowledge-stat-label">Promote Next</span>
              <span className="knowledge-stat-value">{knowledge.counts.promotionCandidates}</span>
              <span className="knowledge-stat-copy">Likely signal trapped in raw intake.</span>
            </div>
            <div className="knowledge-stat-card">
              <span className="knowledge-stat-label">Reflection Notes</span>
              <span className="knowledge-stat-value">{knowledge.counts.reflectionNotes}</span>
              <span className="knowledge-stat-copy">Weekly consolidation already written back.</span>
            </div>
          </div>

          <div className="knowledge-section-grid">
            <div className="knowledge-section-card">
              <div className="knowledge-section-header">
                <span className="knowledge-section-title">Active Context</span>
              </div>
              {knowledge.activeContext?.length > 0 ? knowledge.activeContext.map(item => (
                <div key={item.path} className="knowledge-list-item">
                  <div className="knowledge-item-topline">
                    <span className="knowledge-item-title">{item.name}</span>
                    <span className="knowledge-item-meta">{item.knowledgeState}</span>
                  </div>
                  <div className="knowledge-item-copy">{item.excerpt}</div>
                </div>
              )) : (
                <div className="knowledge-empty">No trusted context yet. Promote a few high-signal notes and this wakes up quickly.</div>
              )}
            </div>

            <div className="knowledge-section-card">
              <div className="knowledge-section-header">
                <span className="knowledge-section-title">Promotion Queue</span>
                <button className="knowledge-inline-btn" onClick={() => onNavigate?.('imports')}>Open imports</button>
              </div>
              {knowledge.promotionCandidates?.length > 0 ? knowledge.promotionCandidates.map(candidate => (
                <div key={candidate.path} className="knowledge-list-item">
                  <div className="knowledge-item-topline">
                    <span className="knowledge-item-title">{candidate.name}</span>
                    <span className="knowledge-item-meta">{candidate.folder}</span>
                  </div>
                  <div className="knowledge-item-copy">{candidate.excerpt}</div>
                  <button
                    className="knowledge-promote-btn"
                    onClick={() => promoteCandidate(candidate)}
                    disabled={promoting === candidate.path}
                  >
                    {promoting === candidate.path ? 'Promoting...' : 'Promote to Knowledge'}
                  </button>
                </div>
              )) : (
                <div className="knowledge-empty">Nothing obvious to promote right now.</div>
              )}
            </div>
          </div>

          <div className="knowledge-section-grid">
            <div className="knowledge-section-card">
              <div className="knowledge-section-header">
                <span className="knowledge-section-title">Top Domains</span>
              </div>
              {knowledge.topDomains?.length > 0 ? knowledge.topDomains.map(domain => (
                <div key={domain.domain} className="knowledge-domain-row">
                  <span>{domain.domain}</span>
                  <strong>{domain.count}</strong>
                </div>
              )) : (
                <div className="knowledge-empty">No curated domains yet.</div>
              )}
            </div>

            <div className="knowledge-section-card">
              <div className="knowledge-section-header">
                <span className="knowledge-section-title">Knowledge Gaps</span>
              </div>
              {knowledge.knowledgeGaps?.length > 0 ? knowledge.knowledgeGaps.map(gap => (
                <div key={gap.topic} className="knowledge-list-item">
                  <div className="knowledge-item-topline">
                    <span className="knowledge-item-title">{gap.topic}</span>
                    <span className="knowledge-item-meta">{gap.count} mentions</span>
                  </div>
                </div>
              )) : (
                <div className="knowledge-empty">No repeat gaps surfaced yet.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Today card */}
      <div className="insights-today">
        <div className="insights-today-title">Today</div>
        <div className="insights-today-grid">
          <div className="insights-stat">
            <span className="insights-stat-label">Standup</span>
            <span className={`insights-stat-value ${today.standup_done ? 'ok' : 'warn'}`}>
              {today.standup_done ? `✓ ${formatHour(today.standup_hour)}` : 'not done'}
            </span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Snoozed</span>
            <span className="insights-stat-value">
              standup {today.standup_snooze_count || 0}× · todo {today.todo_snooze_count || 0}×
              {(today.nudge_dismiss_count || 0) > 0 && ` · ${today.nudge_dismiss_count} dismissed`}
            </span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Captures</span>
            <span className="insights-stat-value">
              {today.captures_count || 0}
              {fmtCaptureTypes(today.capture_types) && (
                <span className="insights-stat-sub"> {fmtCaptureTypes(today.capture_types)}</span>
              )}
            </span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Chat msgs</span>
            <span className="insights-stat-value">{today.chat_count || 0}</span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">EOD</span>
            <span className={`insights-stat-value ${today.eod_done ? 'ok' : ''}`}>
              {today.eod_done ? '✓' : '—'}
            </span>
          </div>
          {(today.vault_writes || 0) > 0 && (
            <div className="insights-stat">
              <span className="insights-stat-label">Notes written</span>
              <span className="insights-stat-value ok">{today.vault_writes}</span>
            </div>
          )}
          {((today.imports_routed || 0) > 0 || (today.imports_flagged || 0) > 0) && (
            <div className="insights-stat">
              <span className="insights-stat-label">Imports</span>
              <span className="insights-stat-value">
                {today.imports_routed || 0} filed{(today.imports_flagged || 0) > 0 && ` · ${today.imports_flagged} flagged`}
              </span>
            </div>
          )}
          {((today.escalations_raised || 0) > 0 || (today.escalations_resolved || 0) > 0) && (
            <div className="insights-stat">
              <span className="insights-stat-label">Escalations</span>
              <span className="insights-stat-value warn">
                {today.escalations_raised || 0} raised{(today.escalations_resolved || 0) > 0 && ` · ${today.escalations_resolved} resolved`}
              </span>
            </div>
          )}
          {(today.one_two_ones || []).length > 0 && (
            <div className="insights-stat wide">
              <span className="insights-stat-label">1-2-1s</span>
              <span className="insights-stat-value ok">{today.one_two_ones.join(', ')}</span>
            </div>
          )}
          {(today.plan_tasks_done || 0) > 0 && (
            <div className="insights-stat">
              <span className="insights-stat-label">Plan tasks</span>
              <span className="insights-stat-value ok">{today.plan_tasks_done}</span>
            </div>
          )}
          {/* Queue EOD stat removed 27 Aug 2026 with the Jira queue cache. It had
              never rendered: activity_log held zero queue_snapshot rows. */}
          {today.standup_with_note !== undefined && today.standup_done && (
            <div className="insights-stat">
              <span className="insights-stat-label">Note saved</span>
              <span className={`insights-stat-value ${today.standup_with_note ? 'ok' : 'warn'}`}>
                {today.standup_with_note ? '✓' : '—'}
              </span>
            </div>
          )}
          {today._eodContent && (
            <div className="insights-eod-preview">
              <div className="insights-eod-content">{today._eodContent}</div>
            </div>
          )}
          <div className="insights-stat wide">
            <span className="insights-stat-label">Topics</span>
            <span className="insights-stat-value">{todayTopics}</span>
          </div>
          <div className="insights-stat wide">
            <span className="insights-stat-label">Tabs</span>
            <span className="insights-stat-value mono">{todayTabs}</span>
          </div>
        </div>
      </div>

      {/* History table */}
      <div className="insights-history">
        <div className="insights-history-title">Last 14 Days</div>
        <div className="insights-table-wrapper">
          <table className="insights-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Standup</th>
                <th>Snooze</th>
                <th>Caps</th>
                <th>Chats</th>
                <th>EOD</th>
                <th>Plan</th>
                <th>Imports</th>
                <th>Escl</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(row => {
                const s = parseSummary(row);
                return (
                  <tr key={row.date_key}>
                    <td className="insights-date">{row.date_key}</td>
                    <td className={row.standup_done ? 'ok' : 'warn'}>
                      {row.standup_done ? `✓ ${formatHour(row.standup_hour)}` : '✗'}
                    </td>
                    <td>
                      {(() => {
                        const st = row.standup_snooze_count || 0;
                        const t = row.todo_snooze_count || 0;
                        if (st + t === 0) return '—';
                        return `s${st} t${t}`;
                      })()}
                    </td>
                    <td>{row.captures_count || 0}</td>
                    <td>{row.chat_count || 0}</td>
                    <td className={row.eod_done ? 'ok' : ''}>{row.eod_done ? '✓' : '—'}</td>
                    <td className={(s.plan_tasks_done || 0) > 0 ? 'ok' : ''}>
                      {(s.plan_tasks_done || 0) > 0 ? s.plan_tasks_done : '—'}
                    </td>
                    <td>
                      {(() => {
                        const r = s.imports_routed || 0;
                        const f = s.imports_flagged || 0;
                        if (r + f === 0) return '—';
                        return `${r}↗${f > 0 ? ` ${f}?` : ''}`;
                      })()}
                    </td>
                    <td>
                      {(() => {
                        const raised = s.escalations_raised || 0;
                        const resolved = s.escalations_resolved || 0;
                        if (raised + resolved === 0) return '—';
                        return `${raised > 0 ? `${raised}↑` : ''}${resolved > 0 ? ` ${resolved}✓` : ''}`.trim();
                      })()}
                    </td>
                  </tr>
                );
              })}
              {summaries.length === 0 && (
                <tr><td colSpan={9} className="insights-empty-row">No history yet — data builds after the first 10pm rollup</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>



      {/* EOD History */}
      {eodHistory.length > 0 && (
        <div className="insights-eod-history">
          <div className="insights-history-title">EOD Reflections</div>
          <div className="eod-history-list">
            {eodHistory.map(entry => (
              <div key={entry.date} className="eod-history-entry">
                <div className="eod-history-date">{entry.date}</div>
                <div className="eod-history-fields">
                  {entry.win && (
                    <div className="eod-field">
                      <span className="eod-field-label">Win</span>
                      <span className="eod-field-value">{entry.win}</span>
                    </div>
                  )}
                  {entry.didntGo && (
                    <div className="eod-field">
                      <span className="eod-field-label">Didn't go</span>
                      <span className="eod-field-value">{entry.didntGo}</span>
                    </div>
                  )}
                  {entry.feeling && (
                    <div className="eod-field">
                      <span className="eod-field-label">Feeling</span>
                      <span className="eod-field-value">{entry.feeling}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
