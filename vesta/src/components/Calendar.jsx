import Section from './Section.jsx';

/**
 * His next three days, as much of them as he agreed to share.
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

function localDayKey(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayLabel(key, todayKey, tomorrowKey) {
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()];
}

const timeOf = iso => String(iso || '').slice(11, 16);

export default function Calendar({ events, gap }) {
  const now = new Date();
  const todayKey = localDayKey(now);
  const tomorrowKey = localDayKey(new Date(now.getTime() + 86400000));

  const byDay = new Map();
  for (const e of events || []) {
    const key = String(e.start || '').slice(0, 10);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Section
      title="His diary"
      gap={gap}
      empty={events && events.length === 0 ? 'Nothing in the diary for the next few days.' : null}
    >
      {days.map(([key, list]) => (
        <div className="day" key={key}>
          <h3 className="day__label">{dayLabel(key, todayKey, tomorrowKey)}</h3>
          <ul className="day__events">
            {list.map(e => (
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
        </div>
      ))}
      {/* Said once, quietly, rather than repeated on every grey row. Without it
          a screen full of "Busy" reads as a system that knows nothing, instead
          of one deliberately not telling. */}
      {days.length > 0 && (
        <p className="day__note">&ldquo;Busy&rdquo; is work &mdash; the details stay at work.</p>
      )}
    </Section>
  );
}
