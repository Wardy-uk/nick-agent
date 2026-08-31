import { useState } from 'react';
import Section from './Section.jsx';
import * as api from '../api';

/**
 * Today's agenda, and a month to pick any other day from.
 *
 * ⚠ The copy NAMES Nick — never "his". Nick, 31 Aug 2026. VESTA is a shared
 * surface two people read, and a third-person pronoun makes it sound like a
 * system talking about somebody who is not there.
 *
 * Nick, 31 Aug 2026: today's agenda, and the rest behind a date picker. The
 * first cut showed a rolling three days as one flat list, which was neither
 * thing — too long to scan at a glance and too short to plan against.
 *
 * ⚠ NOTHING IS REDACTED HERE. A work event arrives with `title` already the
 * literal string "Busy" and NO subject and NO location on the object at all —
 * `services/vesta.js` does that before the response is built, so a devtools tab,
 * a cached response or a screenshot of a network panel shows the same "Busy"
 * this component does. If you ever need to filter a title in this file,
 * something upstream has broken and the fix is upstream.
 *
 * ⚠ Times are SLICED OUT OF THE STRING, never parsed into a Date. The backend
 * already asked Graph for Europe/London wall-clock times; re-parsing them here
 * would re-apply an offset and show every BST event an hour out — the exact bug
 * NEURO's calendar had once already.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// Monday-first, which is how a working week is read here.
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = iso => String(iso || '').slice(11, 16);

/** Monday-first column for a JS day index (0 = Sunday). */
const mondayIndex = jsDay => (jsDay + 6) % 7;

function EventList({ events }) {
  if (!events.length) return <p className="section__empty">Nothing in the diary.</p>;
  return (
    <ul className="day__events">
      {events.map(e => (
        <li key={e.id || `${e.start}-${e.title}`}
            className={`event ${e.personal ? 'event--personal' : 'event--work'}`}>
          <span className="event__time">
            {e.allDay ? 'All day' : `${timeOf(e.start)}–${timeOf(e.end)}`}
          </span>
          <span className="event__title">{e.title}</span>
          {e.location && <span className="event__where">{e.location}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function Calendar({ events, gap, todayKey }) {
  const today = todayKey || keyOf(new Date());
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split('-').map(Number);
    return { year: y, month: m - 1 };
  });
  const [picked, setPicked] = useState(null);
  const [dayEvents, setDayEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dayError, setDayError] = useState(null);

  async function pick(dateKey) {
    // Tapping today again closes the picked day and returns to the agenda,
    // rather than showing the same list twice.
    if (dateKey === picked) { setPicked(null); return; }
    setPicked(dateKey);
    setLoading(true);
    setDayError(null);
    try {
      const r = await api.calendarDay(api.getToken(), dateKey);
      setDayEvents(r.events || []);
    } catch (err) {
      // ⚠ Distinct from an empty day. "I couldn't read the diary" and "nothing
      // on that day" must never look alike.
      setDayError(err.message);
      setDayEvents([]);
    } finally {
      setLoading(false);
    }
  }

  const first = new Date(cursor.year, cursor.month, 1);
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const lead = mondayIndex(first.getDay());
  const cells = [
    ...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(cursor.year, cursor.month, i + 1)),
  ];

  const shift = by => setCursor(c => {
    const d = new Date(c.year, c.month + by, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const [py, pm, pd] = (picked || '').split('-').map(Number);

  return (
    <Section title="Nick's calendar" gap={gap}>
      <h3 className="day__label">Today</h3>
      <EventList events={events || []} />

      <div className="cal">
        <div className="cal__head">
          <button className="cal__nav" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <span className="cal__month">{MONTHS[cursor.month]} {cursor.year}</span>
          <button className="cal__nav" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>

        <div className="cal__grid">
          {DOW.map((d, i) => <span className="cal__dow" key={i}>{d}</span>)}
          {cells.map((d, i) => {
            if (!d) return <span key={`b${i}`} />;
            const k = keyOf(d);
            return (
              <button
                key={k}
                className={`cal__day${k === today ? ' cal__day--today' : ''}${k === picked ? ' cal__day--picked' : ''}`}
                onClick={() => pick(k)}
              >{d.getDate()}</button>
            );
          })}
        </div>
      </div>

      {picked && (
        <div className="day day--picked">
          <h3 className="day__label">
            {DAYS[new Date(py, pm - 1, pd).getDay()]} {pd} {MONTHS[pm - 1]}
          </h3>
          {loading ? (
            <p className="section__empty">Looking…</p>
          ) : dayError ? (
            <p className="section__gap" role="status">
              <span className="section__gap-lead">I couldn&rsquo;t read that day.</span> {dayError}
            </p>
          ) : (
            <EventList events={dayEvents} />
          )}
        </div>
      )}

      {/* Said once, quietly, rather than repeated on every grey row. Without it
          a screen full of "Busy" reads as a system that knows nothing, instead
          of one deliberately not telling.

          ⚠ Nick, 31 Aug 2026: VESTA names him, it never says "his". This is a
          shared surface used by two people, and third-person pronouns make it
          read as a system describing somebody who is not in the room. */}
      <p className="day__note">&ldquo;Busy&rdquo; is Nick&rsquo;s work &mdash; the details stay at work.</p>
    </Section>
  );
}
