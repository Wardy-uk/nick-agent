import React, { useState } from 'react';
import useCachedFetch from '../useCachedFetch';
import { apiUrl } from '../api';
import './MeetingPrep.css';

export default function MeetingPrep() {
  const [mode, setMode] = useState('next'); // next | week | detail
  const [selectedId, setSelectedId] = useState(null);

  // Next meeting
  const { data: nextData, refresh } = useCachedFetch('/api/meeting-prep', { interval: 60000 });

  // Week view
  const { data: weekData } = useCachedFetch(
    mode === 'week' ? '/api/meeting-prep/week' : null,
    { interval: 120000 }
  );

  // Detail view
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openDetail = async (eventId) => {
    if (!eventId) return;
    setDetailLoading(true);
    setDetailData(null);
    setSelectedId(eventId);
    setMode('detail');
    try {
      // Event ids contain '/', ':' and spaces — must be encoded or the route won't match
      const r = await fetch(apiUrl(`/api/meeting-prep/${encodeURIComponent(eventId)}`));
      const d = await r.json();
      setDetailData(d.meeting || null);
    } catch {
      setDetailData(null);
    }
    setDetailLoading(false);
  };

  const meeting = mode === 'detail' ? detailData : nextData?.meeting;
  const laterToday = nextData?.laterToday || [];

  return (
    <div className="prep-container">
      <div className="prep-header">
        <h2 className="prep-title">Meeting Prep</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={`btn btn-secondary btn-sm ${mode === 'next' ? 'active' : ''}`}
            onClick={() => setMode('next')}
          >Next</button>
          <button
            className={`btn btn-secondary btn-sm ${mode === 'week' ? 'active' : ''}`}
            onClick={() => setMode('week')}
          >Week</button>
          <button className="btn btn-secondary btn-sm" onClick={refresh}>↻</button>
        </div>
      </div>

      {/* ── Week view ── */}
      {mode === 'week' && (
        weekData?.days?.length > 0 ? (
          <div className="prep-week">
            <div className="prep-week-summary">{weekData.totalMeetings} meetings this week</div>
            {weekData.days.map(day => (
              <div key={day.date} className="prep-week-day">
                <div className="prep-week-day-label">{day.dayLabel}</div>
                {day.meetings.map(m => (
                  <div
                    key={m.event_id}
                    className="prep-week-meeting"
                    onClick={() => openDetail(m.event_id)}
                  >
                    <span className="prep-week-time">{m.startFormatted}</span>
                    <span className="prep-week-subject">{m.subject}</span>
                    {m.prep?.attendees?.length > 0 && (
                      <span className="prep-week-people">
                        {m.prep.attendees.map(a => a.name.split(' ')[0]).join(', ')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="prep-empty">
            <div className="prep-empty-text">No meetings this week</div>
          </div>
        )
      )}

      {/* ── Detail / Next view ── */}
      {(mode === 'next' || mode === 'detail') && (
        <>
          {detailLoading && <div className="prep-empty-text">Loading...</div>}

          {!meeting && !detailLoading && (
            <div className="prep-empty">
              <div className="prep-empty-icon">📅</div>
              <div className="prep-empty-text">No upcoming meetings</div>
              <div className="prep-empty-sub">
                {mode === 'next' ? 'Next 4 hours are clear.' : 'Meeting not found.'}
              </div>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setMode('week')}>
                Browse this week
              </button>
            </div>
          )}

          {meeting && (
            <>
              {mode === 'detail' && (
                <button className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }} onClick={() => setMode('week')}>
                  ← Back to week
                </button>
              )}

              {/* Meeting card */}
              <div className={`prep-meeting-card ${meeting.minutesAway != null && meeting.minutesAway <= 15 ? 'prep-imminent' : ''}`}>
                <div className="prep-meeting-time">
                  {meeting.minutesAway != null && meeting.minutesAway > 0
                    ? (meeting.minutesAway <= 15 ? `Starting in ${meeting.minutesAway} min` : `In ${meeting.minutesAway} min`)
                    : meeting.dayLabel || ''}
                  <span className="prep-meeting-slot">{meeting.startFormatted}–{meeting.endFormatted}</span>
                </div>
                <h3 className="prep-meeting-subject">{meeting.subject}</h3>
                {meeting.location && <div className="prep-meeting-location">{meeting.location}</div>}
              </div>

              {/* Attendees */}
              {meeting.prep?.attendees?.length > 0 && (
                <div className="prep-section">
                  <div className="prep-section-title">People</div>
                  {meeting.prep.attendees.map((att, i) => (
                    <div key={i} className="prep-person">
                      <div className="prep-person-header">
                        <span className="prep-person-name">{att.name}</span>
                        {att.role && <span className="prep-person-role">{att.role}</span>}
                        {att.rsvp && att.rsvp !== 'none' && (
                          <span className={`prep-rsvp prep-rsvp-${att.rsvp}`}>{att.rsvp}</span>
                        )}
                      </div>
                      {att.email && !att.last121 && !att.recentNotes && (
                        <div className="prep-person-meta">{att.email}</div>
                      )}
                      {att.last121 && <div className="prep-person-meta">Last 1-2-1: {att.last121}</div>}
                      {att.recentNotes && <div className="prep-person-notes">{att.recentNotes}</div>}
                      {att.tags?.length > 0 && (
                        <div className="prep-person-tags">
                          {att.tags.map(t => <span key={t} className="prep-tag">{t}</span>)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Vault context */}
              {meeting.prep?.vaultContext?.length > 0 && (
                <div className="prep-section">
                  <div className="prep-section-title">Related Notes</div>
                  {meeting.prep.vaultContext.map((v, i) => (
                    <div key={i} className="prep-vault-ref">
                      <span className="prep-vault-label">{v.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Suggested topics */}
              {meeting.prep?.suggestedTopics?.length > 0 && (
                <div className="prep-section">
                  <div className="prep-section-title">Suggested Topics</div>
                  <ul className="prep-topics">
                    {meeting.prep.suggestedTopics.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}

              {/* Recent decisions */}
              {meeting.prep?.recentDecisions?.length > 0 && (
                <div className="prep-section">
                  <div className="prep-section-title">Recent Decisions</div>
                  {meeting.prep.recentDecisions.map((d, i) => (
                    <div key={i} className="prep-decision">
                      <span className="prep-decision-date">{d.date}</span>
                      <span className="prep-decision-text">{d.text}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Checklist */}
              {meeting.prep?.checklist?.length > 0 && (
                <div className="prep-section">
                  <div className="prep-section-title">Checklist</div>
                  <ul className="prep-checklist">
                    {meeting.prep.checklist.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* Later today (next mode only) */}
          {mode === 'next' && laterToday.length > 0 && (
            <div className="prep-section">
              <div className="prep-section-title">Later Today</div>
              {laterToday.map((m, i) => (
                <div key={i} className="prep-later" onClick={() => openDetail(m.event_id || '')} style={{ cursor: m.event_id ? 'pointer' : 'default' }}>
                  <span className="prep-later-time">
                    {new Date(m.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="prep-later-subject">{m.subject}</span>
                </div>
              ))}
            </div>
          )}

          {/* Browse week link (next mode) */}
          {mode === 'next' && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setMode('week')}>
                Browse this week's meetings
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
