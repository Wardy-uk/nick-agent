import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl } from '../api';
import './StandupsPanel.css';

export default function StandupsPanel() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);

  useEffect(() => {
    setLoading(true);
    fetch(apiUrl(`/api/standup/ritual-history?days=${days}`))
      .then(r => r.json())
      .then(d => setEntries(d.entries || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [days]);

  // ⚠ This is a COUNT of days logged in the window, not a streak — the days it
  // counts need not be consecutive, so "12-day streak" could be twelve days
  // scattered across a month. It was the last streak left in NEURO after the
  // wins one was retired for being unbreakable, and it was measuring something
  // different from what it said. Named for what it actually is.
  const loggedCount = entries.filter(e => e.standup).length;
  const missCount = entries.filter(e => !e.standup).length;
  const saraLine = missCount === 0
    ? `${loggedCount} of ${entries.length} days logged.`
    : missCount === 1
    ? `${loggedCount} of ${entries.length} days logged. One miss.`
    : `${missCount} missed standups in ${days} days. That's drift.`;

  if (loading) return <div className="standups-panel"><div className="standups-loading">Loading...</div></div>;

  return (
    <div className="standups-panel">
      <div className="standups-sara">
        <span className="standups-sara-label">SARA</span>
        <span className="standups-sara-line">{saraLine}</span>
      </div>
      <div className="standups-header">
        <h2 className="standups-title">Standup</h2>
        <div className="standups-range">
          {[7, 14, 30].map(d => (
            <button
              key={d}
              className={`standups-range-btn ${days === d ? 'active' : ''}`}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 && (
        <div className="standups-empty">No standups in the last {days} days. Start one.</div>
      )}

      {entries.map(entry => (
        <div key={entry.date} className="standups-entry">
          <div className="standups-entry-header">
            <span className="standups-entry-date">{entry.day} {entry.date.slice(5)}</span>
            <div className="standups-entry-badges">
              {entry.standup && <span className="standups-badge standups-badge-ok">Morning</span>}
              {entry.eod && <span className="standups-badge standups-badge-ok">EOD</span>}
              {entry.journal && <span className="standups-badge standups-badge-ok">Journal</span>}
              {!entry.standup && <span className="standups-badge standups-badge-miss">No standup</span>}
            </div>
          </div>

          {entry.standup && (
            <div className="standups-section">
              <div className="standups-section-label">Morning Standup</div>
              <div className="standups-section-content">
                <ReactMarkdown>{entry.standup}</ReactMarkdown>
              </div>
            </div>
          )}

          {entry.eod && (
            <div className="standups-section">
              <div className="standups-section-label">End of Day</div>
              <div className="standups-section-content">
                <ReactMarkdown>{entry.eod}</ReactMarkdown>
              </div>
            </div>
          )}

          {entry.journal && (
            <div className="standups-section">
              <div className="standups-section-label">Journal</div>
              <div className="standups-section-content">
                <ReactMarkdown>{entry.journal}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
