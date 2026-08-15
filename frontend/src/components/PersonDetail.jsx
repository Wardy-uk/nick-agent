import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import WaitingOn from './WaitingOn';
import './PersonDetail.css';

export default function PersonDetail({ name, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    fetch(apiUrl(`/api/person/${encodeURIComponent(name)}`))
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [name]);

  if (!name) return null;

  const fm = data?.vaultNote?.frontmatter || {};
  const sections = data?.vaultNote?.sections || [];

  return (
    <div className="person-detail-overlay" onClick={onClose}>
      <div className="person-detail" onClick={e => e.stopPropagation()}>
        <div className="pd-header">
          <div>
            <h2 className="pd-name">{name}</h2>
            {fm.role && <div className="pd-role">{fm.role}</div>}
            {fm.team && <span className="pd-tag">{fm.team}</span>}
            {fm.status && fm.status !== 'Active' && <span className="pd-tag pd-tag-warn">{fm.status}</span>}
          </div>
          <button className="pd-close" onClick={onClose}>×</button>
        </div>

        {loading && <div className="pd-loading">Loading...</div>}

        {!loading && data && (
          <div className="pd-body">
            {/* Key info */}
            <div className="pd-info-row">
              {fm['last-1-2-1'] && <span className="pd-info">Last 1-2-1: {fm['last-1-2-1']}</span>}
              {fm['next-1-2-1-due'] && <span className="pd-info">Next due: {fm['next-1-2-1-due']}</span>}
              {fm.cadence && <span className="pd-info">Cadence: {fm.cadence}</span>}
              {fm.contract && <span className="pd-info">{fm.contract}</span>}
            </div>

            {/* What they owe Nick. Keyed on the first name, which is what
                waiting-on canonicalises to — renders nothing when they're clear. */}
            <WaitingOn person={name.split(' ')[0]} embedded />

            {/* Vault note sections */}
            {sections.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Vault Notes</div>
                {sections.map((s, i) => (
                  <details key={i} className="pd-collapsible" open={i === 0}>
                    <summary>{s.title} {s.lineCount > 10 && <span className="pd-more">({s.lineCount} lines)</span>}</summary>
                    <pre className="pd-note-content">{s.content}</pre>
                  </details>
                ))}
              </div>
            )}

            {/* Meetings */}
            {data.meetings?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Meetings ({data.meetings.length})</div>
                {data.meetings.map((m, i) => (
                  <div key={i} className="pd-item">
                    {m.date && <span className="pd-item-date">{m.date}</span>}
                    <span className="pd-item-text">{m.title}</span>
                  </div>
                ))}
              </div>
            )}

            {/* HR Documents */}
            {data.hrDocs?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">HR Documents ({data.hrDocs.length})</div>
                {data.hrDocs.map((d, i) => (
                  <div key={i} className="pd-item">
                    <span className="pd-item-text">{d.title}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tasks */}
            {data.tasks?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Tasks ({data.tasks.length})</div>
                {data.tasks.map((t, i) => (
                  <div key={i} className="pd-item">
                    <span className="pd-item-text">{t.text}</span>
                    {t.source && <span className="pd-item-source">{t.source}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Decisions */}
            {data.decisions?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Decisions ({data.decisions.length})</div>
                {data.decisions.map((d, i) => (
                  <div key={i} className="pd-item">
                    <span className="pd-item-date">{d.date}</span>
                    <span className="pd-item-text">{d.text}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Daily mentions */}
            {data.dailyMentions?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Daily Note Mentions ({data.dailyMentions.length})</div>
                {data.dailyMentions.map((d, i) => (
                  <div key={i} className="pd-item pd-daily">
                    <span className="pd-item-date">{d.date}</span>
                    <div className="pd-daily-lines">
                      {d.lines.map((l, j) => <div key={j} className="pd-daily-line">{l}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Other mentions */}
            {data.mentions?.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">Other Mentions ({data.mentions.length})</div>
                {data.mentions.map((m, i) => (
                  <div key={i} className="pd-item">
                    <span className="pd-item-text">{m.title}</span>
                  </div>
                ))}
              </div>
            )}

            {!data.vaultNote && data.meetings?.length === 0 && data.tasks?.length === 0 && (
              <div className="pd-empty">No vault data found for {name}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
