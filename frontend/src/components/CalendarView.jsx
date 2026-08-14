import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import EventComposer from './EventComposer';
import './CalendarView.css';

function formatDateLabel(date) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const d = new Date(date);
  d.setHours(0,0,0,0);
  const diff = Math.round((d - today) / (1000 * 60 * 60 * 24));
  const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (diff === 0) return `Today — ${label}`;
  if (diff === -1) return `Yesterday — ${label}`;
  if (diff === 1) return `Tomorrow — ${label}`;
  return label;
}

function formatTime(isoStr) {
  return isoStr.split('T')[1]?.substring(0, 5) || '';
}

// Local wall-clock, not toISOString() — that returns the UTC date, so on a BST
// evening it reports tomorrow. Matters now that this date is what gets booked.
function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return isoLocal(d);
}

export default function CalendarView() {
  const [events, setEvents] = useState([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [composing, setComposing] = useState(false);

  const currentDate = dateStr(dayOffset);

  const fetchEvents = (date, retries = 2) => {
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/obsidian/calendar?start=${date}&end=${date}`))
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => { setEvents(data.events || []); setLoading(false); })
      .catch(err => {
        if (retries > 0) {
          setTimeout(() => fetchEvents(date, retries - 1), 1500);
        } else {
          setError('Calendar unavailable — tap retry');
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    fetchEvents(currentDate);
  }, [dayOffset]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => fetchEvents(dateStr(dayOffset), 1), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [dayOffset]);

  // Quick-nav dates (show 5-day strip centered on current day)
  const stripDays = [];
  for (let i = -2; i <= 2; i++) {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset + i);
    stripDays.push(d);
  }

  const isNow = (startStr, endStr) => {
    const now = new Date();
    return now >= new Date(startStr) && now < new Date(endStr);
  };

  const isPast = (endStr) => new Date() > new Date(endStr);

  return (
    <div className="calendar-container">
      <div className="calendar-header">
        <h2 className="calendar-title">Calendar</h2>
        <div className="calendar-nav">
          <button className="cal-nav-btn" onClick={() => setDayOffset(o => o - 1)}>&lt;</button>
          <button className="cal-nav-btn today-btn" onClick={() => setDayOffset(0)}>Today</button>
          <button className="cal-nav-btn" onClick={() => setDayOffset(o => o + 1)}>&gt;</button>
          <button className="cal-nav-btn today-btn" onClick={() => setComposing(c => !c)}>
            {composing ? 'Close' : '+ New'}
          </button>
        </div>
      </div>

      {composing && (
        <EventComposer
          defaultDate={currentDate}
          onCreated={() => fetchEvents(currentDate)}
          onClose={() => setComposing(false)}
        />
      )}

      <div className="calendar-day-strip">
        {stripDays.map((d, i) => {
          const iso = isoLocal(d);
          const isSelected = iso === currentDate;
          const isToday = iso === dateStr(0);
          return (
            <button
              key={i}
              className={`strip-day ${isSelected ? 'selected' : ''} ${isToday ? 'is-today' : ''}`}
              onClick={() => setDayOffset(dayOffset + i - 2)}
            >
              <span className="strip-day-name">{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <span className="strip-day-num">{d.getDate()}</span>
            </button>
          );
        })}
      </div>

      <div className="calendar-date-label">{formatDateLabel(currentDate)}</div>

      {loading && <div className="calendar-loading">Loading...</div>}

      {error && (
        <div className="calendar-error">
          <span>{error}</span>
          <button className="cal-retry-btn" onClick={() => fetchEvents(currentDate)}>Retry</button>
        </div>
      )}

      <div className="calendar-day-list">
        {!loading && !error && events.length === 0 && (
          <div className="calendar-empty">
            No calendar entries for this day.
            <span className="calendar-empty-hint">Events are fetched from your Outlook ICS feed.</span>
          </div>
        )}
        {events.map((event, i) => {
          const cancelled = event.showAs === 'cancelled';
          const current = !cancelled && isNow(event.start, event.end);
          const past = !cancelled && isPast(event.end);

          return (
            <div key={i} className={`cal-event ${cancelled ? 'cancelled' : ''} ${current ? 'current' : ''} ${past ? 'past' : ''}`}>
              <div className="cal-event-time">
                {event.isAllDay ? 'All day' : (
                  <>
                    <span className="cal-time-start">{formatTime(event.start)}</span>
                    <span className="cal-time-sep">–</span>
                    <span className="cal-time-end">{formatTime(event.end)}</span>
                  </>
                )}
              </div>
              <div className="cal-event-details">
                <span className={`cal-event-subject ${cancelled ? 'cancelled-text' : ''}`}>{event.subject}</span>
                {event.location && <span className="cal-event-location">{event.location}</span>}
              </div>
              {current && <span className="cal-now-badge">NOW</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
