import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './MeetingPrep.css';

// Meeting prep / calendar = glance at what's next and its prep before you walk in.
// GET /api/meeting-prep → { meeting: {..., prep}, laterToday[], message? }
function fromNow(mins) {
  if (mins == null) return '';
  if (mins < 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `in ${h}h${m ? ` ${m}m` : ''}`;
}

export default function MeetingPrep() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let live = true;
    apiFetch('/api/meeting-prep')
      .then((data) => live && setState({ loading: false, error: null, data }))
      .catch((error) => live && setState({ loading: false, error: error.message, data: null }));
    return () => { live = false; };
  }, []);

  const { loading, error, data } = state;
  const meeting = data?.meeting;
  const prep = meeting?.prep;

  return (
    <section>
      <h1 className="view__title">Prep</h1>
      <p className="view__lede">What’s next, and what you need for it.</p>

      {loading && <div className="card">Checking your calendar…</div>}
      {error && <div className="card err">Couldn’t reach the brain: {error}</div>}

      {data && !meeting && <div className="card mp__none">{data.message || 'No meetings coming up. 🎉'}</div>}

      {meeting && (
        <div className="card mp__meeting">
          <div className="mp__when">
            {meeting.startFormatted}{meeting.endFormatted ? `–${meeting.endFormatted}` : ''} · {fromNow(meeting.minutesAway)}
          </div>
          <div className="mp__subject">{meeting.subject}</div>
          {meeting.location && <div className="mp__loc">📍 {meeting.location}</div>}

          {prep?.attendees?.length > 0 && (
            <div className="mp__block">
              <div className="mp__h">Attendees</div>
              {prep.attendees.map((a, i) => (
                <div className="mp__person" key={i}>
                  <div className="mp__person-name">{a.name}{a.role ? <span className="mp__role"> · {a.role}</span> : ''}</div>
                  {a.recentNotes && <div className="mp__person-notes">{a.recentNotes}</div>}
                  {/* What they owe Nick. Read-only on purpose — chasing needs an
                      approval step, and that lives in NEURO's People board. */}
                  {a.waitingOn?.length > 0 && (
                    <div className="mp__owes">
                      <div className="mp__owes-h">Owes you ({a.waitingOn.length})</div>
                      {a.waitingOn.map((w, j) => (
                        <div className="mp__owes-item" key={j}>
                          <span className="mp__owes-text">{w.text}</span>
                          <span className={`mp__owes-age${w.stale ? ' stale' : ''}`}>
                            {w.ageDays}d{w.chaseCount > 0 ? ` · chased ${w.chaseCount}×` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {prep?.suggestedTopics?.length > 0 && (
            <div className="mp__block">
              <div className="mp__h">Topics</div>
              <ul className="mp__list">{prep.suggestedTopics.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {prep?.checklist?.length > 0 && (
            <div className="mp__block">
              <div className="mp__h">Checklist</div>
              <ul className="mp__list">{prep.checklist.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {prep?.recentDecisions?.length > 0 && (
            <div className="mp__block">
              <div className="mp__h">Recent decisions</div>
              {prep.recentDecisions.map((d, i) => (
                <div className="mp__decision" key={i}>{d.text}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {data?.laterToday?.length > 0 && (
        <div className="mp__later">
          <div className="mp__h">Later today</div>
          {data.laterToday.map((m, i) => (
            <div className="card mp__later-item" key={i}>
              <span className="mp__later-time">{new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="mp__later-subject">{m.subject}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
