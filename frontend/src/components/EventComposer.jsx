import React, { useState } from 'react';
import { apiUrl } from '../api';
import './EventComposer.css';

// Local wall-clock, not toISOString() — that shifts the date across midnight
// during BST and would book the wrong day.
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addMins(date, time, mins) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm + mins);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export default function EventComposer({ defaultDate, onCreated, onClose }) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const [subject, setSubject] = useState('');
  const [date, setDate] = useState(defaultDate || localDateStr());
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('09:30');
  const [isAllDay, setIsAllDay] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [location, setLocation] = useState('');
  const [body, setBody] = useState('');

  const [attendees, setAttendees] = useState([]);
  const [attendeeInput, setAttendeeInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [candidates, setCandidates] = useState(null); // { query, options: [] }

  // Keep the duration when the start moves, the way every calendar app does.
  const changeStart = (value) => {
    if (value && startTime && endTime) {
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins > 0) setEndTime(addMins(date, value, mins));
    }
    setStartTime(value);
  };

  const parse = () => {
    if (!text.trim()) return;
    setParsing(true);
    setError('');
    setCandidates(null);
    fetch(apiUrl('/api/calendar/parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then(r => r.json())
      .then(d => {
        if (!d.ok || !d.draft) throw new Error(d.error || 'Could not read that');
        const draft = d.draft;
        setSubject(draft.subject || '');
        setDate(draft.date);
        setStartTime(draft.startTime);
        setEndTime(draft.endTime);
        setIsOnline(Boolean(draft.isOnline));
        setAttendees(draft.attendees || []);

        // Say what it guessed at rather than silently defaulting.
        const notes = [];
        if (d.needs?.includes('date')) notes.push('no date found — assumed today');
        if (d.needs?.includes('time')) notes.push('no time found — assumed 09:00');
        const missing = (d.resolution || []).filter(r => r.status !== 'resolved');
        for (const m of missing) {
          notes.push(m.status === 'ambiguous'
            ? `"${m.query}" matches ${m.candidates.length} people — pick one below`
            : `couldn't find an address for "${m.query}"`);
        }
        if (draft.endsNextDay) notes.push('that runs past midnight — check the end time');
        setError(notes.join(' · '));

        const ambiguous = missing.find(m => m.status === 'ambiguous');
        if (ambiguous) setCandidates({ query: ambiguous.query, options: ambiguous.candidates });
      })
      .catch(e => setError(e.message))
      .finally(() => setParsing(false));
  };

  const addAttendee = (person) => {
    if (!person?.email) return;
    setAttendees(list =>
      list.some(a => a.email.toLowerCase() === person.email.toLowerCase()) ? list : [...list, person]
    );
    setAttendeeInput('');
    setCandidates(null);
  };

  const submitAttendee = () => {
    const q = attendeeInput.trim();
    if (!q) return;
    if (q.includes('@')) return addAttendee({ name: q, email: q });

    setResolving(true);
    setCandidates(null);
    fetch(apiUrl(`/api/calendar/resolve?q=${encodeURIComponent(q)}`))
      .then(r => r.json())
      .then(d => {
        if (d.status === 'resolved') addAttendee({ name: d.name, email: d.email });
        else if (d.status === 'ambiguous') setCandidates({ query: q, options: d.candidates });
        else setError(`No address found for "${q}" — type the full email instead.`);
      })
      .catch(() => setError('Lookup failed'))
      .finally(() => setResolving(false));
  };

  const create = () => {
    setCreating(true);
    setError('');
    fetch(apiUrl('/api/calendar/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject, date, startTime, endTime, isAllDay, isOnline,
        location: location.trim() || null,
        body: body.trim() || null,
        attendees,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) throw new Error(d.error || 'Create failed');
        setCreated(d.event);
        onCreated?.(d.event);
      })
      .catch(e => setError(e.message))
      .finally(() => setCreating(false));
  };

  if (created) {
    return (
      <div className="composer">
        <div className="composer-done">
          <div className="composer-done-title">
            Created — {created.subject}
            {attendees.length > 0 && ` · invited ${attendees.length}`}
          </div>
          <div className="composer-actions">
            {created.webLink && (
              <a className="composer-btn" href={created.webLink} target="_blank" rel="noreferrer">
                Open in Outlook
              </a>
            )}
            <button className="composer-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const canCreate = subject.trim() && date && (isAllDay || (startTime && endTime && endTime > startTime));

  return (
    <div className="composer">
      <div className="composer-nl">
        <input
          className="composer-nl-input"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); parse(); } }}
          placeholder='e.g. "meeting at 2pm tomorrow with abdi for 30 mins about the SLA review"'
        />
        <button className="composer-btn composer-btn-accent" onClick={parse} disabled={parsing || !text.trim()}>
          {parsing ? 'Reading...' : 'Read it'}
        </button>
      </div>
      <div className="composer-hint">Or just fill the fields in yourself.</div>

      <div className="composer-row">
        <label className="composer-label">Title</label>
        <input className="composer-input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Meeting title" />
      </div>

      <div className="composer-row composer-row-split">
        <div className="composer-field">
          <label className="composer-label">Date</label>
          <input className="composer-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        {!isAllDay && (
          <>
            <div className="composer-field composer-field-sm">
              <label className="composer-label">Start</label>
              <input className="composer-input" type="time" value={startTime} onChange={e => changeStart(e.target.value)} />
            </div>
            <div className="composer-field composer-field-sm">
              <label className="composer-label">End</label>
              <input className="composer-input" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </>
        )}
      </div>

      <div className="composer-row composer-toggles">
        <label className="composer-check">
          <input type="checkbox" checked={isAllDay} onChange={e => setIsAllDay(e.target.checked)} /> All day
        </label>
        <label className="composer-check">
          <input type="checkbox" checked={isOnline} onChange={e => setIsOnline(e.target.checked)} /> Teams meeting
        </label>
      </div>

      <div className="composer-row">
        <label className="composer-label">Attendees</label>
        <div className="composer-chips">
          {attendees.map(a => (
            <span className="composer-chip" key={a.email} title={a.email}>
              {a.name || a.email}
              <button className="composer-chip-x" onClick={() => setAttendees(attendees.filter(x => x.email !== a.email))} aria-label={`Remove ${a.email}`}>×</button>
            </span>
          ))}
          <input
            className="composer-chip-input"
            value={attendeeInput}
            onChange={e => setAttendeeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); submitAttendee(); } }}
            onBlur={() => attendeeInput.trim() && submitAttendee()}
            placeholder={resolving ? 'Looking up...' : (attendees.length ? 'Add...' : 'name or email')}
          />
        </div>
      </div>

      {candidates && (
        <div className="composer-candidates">
          <span className="composer-candidates-label">Which "{candidates.query}"?</span>
          {candidates.options.map(c => (
            <button className="composer-candidate" key={c.email} onClick={() => addAttendee(c)}>
              {c.name} <span className="composer-candidate-email">{c.email}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-row composer-row-split">
        <div className="composer-field">
          <label className="composer-label">Location</label>
          <input className="composer-input" value={location} onChange={e => setLocation(e.target.value)} placeholder="optional" />
        </div>
      </div>

      <div className="composer-row">
        <label className="composer-label">Notes</label>
        <textarea className="composer-input composer-textarea" value={body} onChange={e => setBody(e.target.value)} rows={2} placeholder="optional agenda" />
      </div>

      {error && <div className="composer-error">{error}</div>}

      <div className="composer-actions">
        <button className="composer-btn composer-btn-accent" onClick={create} disabled={creating || !canCreate}>
          {creating ? 'Creating...' : (attendees.length ? `Create & invite ${attendees.length}` : 'Create event')}
        </button>
        <button className="composer-btn" onClick={onClose} disabled={creating}>Cancel</button>
      </div>
    </div>
  );
}
