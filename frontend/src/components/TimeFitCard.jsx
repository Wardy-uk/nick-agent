import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './TimeFitCard.css';

/**
 * "You have forty minutes before your next meeting — here's what fits."
 *
 * The one ADHD accommodation nothing else in NEURO substituted for. Focus tells
 * you what matters, quick wins tell you what's small, the lane tells you what's
 * urgent — and none of them knew how long anything takes or how much time there
 * was, so every one of them could hand you a two-hour job at 4:40pm.
 *
 * Two rules it holds to:
 *
 * · An assumed duration is labelled as one. The backend flags every task with no
 *   estimate and this says so on the row. A card that quietly treats an unknown
 *   as half an hour is right until it isn't, and then it is never trusted again.
 *
 * · The estimate control lives HERE, on the row where the assumption is
 *   showing. That is the only moment the question "how long is this?" is worth
 *   answering — asking for 128 estimates up front is how the priority field
 *   ended up 18% populated and meaningless.
 */

// Coarse on purpose. "About how long?" is a judgement anyone can make in a
// second; "37 minutes" is a number nobody has and nobody can check.
const BUCKETS = [
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hr' },
  { minutes: 240, label: 'half a day' },
];

export default function TimeFitCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [override, setOverride] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback((minutes = override) => {
    const qs = minutes ? `?minutes=${minutes}` : '';
    fetch(apiUrl(`/api/time/what-fits${qs}`))
      .then(r => r.json())
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message));
  }, [override]);

  useEffect(() => { load(); }, [load]);

  const setEstimate = async (taskId, minutes) => {
    if (!taskId) return;
    setSavingId(taskId);
    try {
      await fetch(apiUrl(`/api/tasks/${taskId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateMinutes: minutes }),
      });
    } catch { /* the reload below is the feedback */ }
    setSavingId(null);
    load();
  };

  if (error) return null;          // never let this push a real error at anyone
  if (!data) return null;

  const { gap, items = [], assumedCount = 0, calendarKnown, coverage } = data;

  // "I can't see the calendar" and "you're free" must not look the same. One of
  // them means calendar-sync has stopped.
  if (!calendarKnown) {
    return (
      <section className="tf-card tf-unknown">
        <div className="tf-head">Time</div>
        <p className="tf-blurb">No calendar data cached, so I can't tell you what's ahead.</p>
      </section>
    );
  }

  if (gap?.openEnded && !override) {
    return (
      <section className="tf-card">
        <div className="tf-head">Nothing in the diary for the rest of today</div>
        <p className="tf-blurb">
          So nothing here has to fit around anything.
          {' '}
          <button className="tf-inline" onClick={() => { setOverride(30); }}>
            Got half an hour?
          </button>
        </p>
      </section>
    );
  }

  const minutes = data.minutes ?? gap?.minutes;

  return (
    <section className="tf-card">
      <div className="tf-head">
        {override
          ? `${minutes} minutes`
          : `${minutes} minutes before ${gap?.nextEvent?.subject || 'your next meeting'}`}
        {!override && gap?.until && <span className="tf-until">until {gap.until}</span>}
      </div>

      {items.length === 0 ? (
        <p className="tf-blurb">
          Nothing on the list fits in {minutes} minutes
          {assumedCount === 0 && coverage?.unestimated > 0 && <> that I have a duration for</>}.
        </p>
      ) : (
        <ul className="tf-list">
          {items.map(item => (
            <li className="tf-row" key={item.task_id || item.text}>
              <span className="tf-text">{item.text}</span>
              <span className={`tf-mins${item.assumed ? ' tf-assumed' : ''}`}>
                {item.minutes} min{item.assumed && <em> assumed</em>}
              </span>
              {/* Fix the assumption right where it is showing. */}
              <select
                className="tf-est"
                value=""
                disabled={savingId === item.task_id}
                onChange={e => setEstimate(item.task_id, Number(e.target.value))}
                aria-label="How long does this take?"
              >
                <option value="">{item.assumed ? 'How long?' : 'Change'}</option>
                {BUCKETS.map(b => <option key={b.minutes} value={b.minutes}>{b.label}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}

      <div className="tf-foot">
        {assumedCount > 0 && (
          <span className="tf-note">
            {assumedCount} of these {assumedCount === 1 ? 'is a guess' : 'are guesses'} — {data.assumedMinutes} min assumed.
          </span>
        )}
        {coverage && coverage.total > 0 && (
          <span className="tf-coverage">{coverage.estimated}/{coverage.total} tasks estimated</span>
        )}
        {override && <button className="tf-inline" onClick={() => setOverride(null)}>Use my diary</button>}
      </div>
    </section>
  );
}
