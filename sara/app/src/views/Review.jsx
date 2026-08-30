import { useCallback, useEffect, useState } from 'react';
import { useNickNow, stampFor } from '../mobile/useNickNow';
import { describeStorage, clearLocalData, SCHEMA_VERSION } from '../mobile/localStore';
import { pending as pendingOps, subscribe, flush } from '../mobile/outbox';
import Freshness from '../components/Freshness';
import './Review.css';

// REVIEW — morning orientation, shutdown, and the weekly reset.
//
// Built from the SAME snapshot as Now, deliberately: two screens fetching two
// payloads is two screens free to disagree about the same day. Which of the
// three modes it opens in is chosen from the clock, because Nick arriving here
// at 08:10 and at 17:40 wants opposite things — but all three are always
// reachable, because a guess about the time of day is a guess.
//
// The local-data controls live here rather than on Capture or Now. This is the
// screen you come to on purpose; the other two are used in a hurry.

const MODES = [
  { id: 'morning', label: 'Orientation' },
  { id: 'shutdown', label: 'Shutdown' },
  { id: 'week', label: 'Week' },
];

function defaultMode(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h >= 16) return 'shutdown';
  return 'morning';
}

export default function Review() {
  const { snapshot, freshness, fetchedAt, error, busy, refresh } = useNickNow();
  const [mode, setMode] = useState(() => defaultMode());
  const [storage, setStorage] = useState(null);
  const [queue, setQueue] = useState([]);
  const [clearing, setClearing] = useState(null);

  const reload = useCallback(async () => {
    try { setQueue(await pendingOps()); } catch {}
    try { setStorage(await describeStorage()); } catch (e) { setStorage({ available: false, error: e.message }); }
  }, []);

  useEffect(() => {
    reload();
    return subscribe(() => reload());
  }, [reload]);

  async function onClear(force) {
    setClearing('working');
    try {
      const result = await clearLocalData({ force });
      if (!result.ok) {
        // The refusal is the feature: clearing while things are unsent would
        // delete the only copy of something Nick typed.
        setClearing(`Refused — ${result.unsent} capture${result.unsent === 1 ? '' : 's'} on this device haven't reached NEURO yet.`);
      } else {
        setClearing(force
          ? `Cleared, including ${result.clearedOperations} unsent item${result.clearedOperations === 1 ? '' : 's'}.`
          : 'Cached data cleared. Your queue was left alone.');
      }
    } catch (e) {
      setClearing(`Couldn't clear: ${e.message}`);
    } finally {
      reload();
    }
  }

  const s = snapshot;
  const unsent = queue.length;

  return (
    <section className="rev">
      <h1 className="view__title">Review</h1>
      <p className="view__lede">
        {s ? `Snapshot from ${stampFor(s.generatedAt) || '—'}` : 'Loading…'}
      </p>

      <div className="rev__modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`rev__mode${mode === m.id ? ' rev__mode--on' : ''}`}
            onClick={() => setMode(m.id)}
          >{m.label}</button>
        ))}
      </div>

      <Freshness
        freshness={freshness}
        fetchedAt={fetchedAt}
        error={error}
        busy={busy}
        onRetry={() => refresh()}
      />

      {s && mode === 'morning' && (
        <>
          <h2 className="rev__h">The shape of today</h2>
          {s.agenda.known === false ? (
            <div className="card rev__unread">I couldn&rsquo;t read the diary — {s.agenda.why}.</div>
          ) : s.agenda.items.length === 0 ? (
            <div className="card rev__calm">Nothing in the diary{s.agenda.scope !== 'today' ? ` until ${s.agenda.scope}` : ''}.</div>
          ) : (
            s.agenda.items.map((e) => (
              <div className="card rev__row" key={e.id}>
                <span className="rev__row-title">{e.title}</span>
                <span className="rev__row-meta">{e.allDay ? 'all day' : String(e.start || '').slice(11, 16)}</span>
              </div>
            ))
          )}

          <h2 className="rev__h">Where your body is</h2>
          {s.readiness && s.readiness.known ? (
            <div className="card">
              <div className="rev__big">{s.readiness.score ?? '—'}</div>
              <div className="rev__row-meta">
                {s.readiness.status || 'no reading'}
                {/* stress-score's caveats are inherited, never quietly dropped. */}
                {Array.isArray(s.readiness.caveats) && s.readiness.caveats.length > 0 && (
                  <> · {s.readiness.caveats.join(' · ')}</>
                )}
              </div>
            </div>
          ) : (
            <div className="card rev__unread">
              No reading{s.readiness && s.readiness.why ? ` — ${s.readiness.why}` : ''}.
            </div>
          )}
        </>
      )}

      {s && mode === 'shutdown' && (
        <>
          <h2 className="rev__h">Still open</h2>
          {s.tasks.known === false ? (
            <div className="card rev__unread">I couldn&rsquo;t read your tasks — {s.tasks.why}.</div>
          ) : (
            <div className="card">
              <div className="rev__big">{s.tasks.total}</div>
              <div className="rev__row-meta">open task{s.tasks.total === 1 ? '' : 's'} in NEURO</div>
            </div>
          )}

          <h2 className="rev__h">Captured today</h2>
          {s.captures.known === false ? (
            <div className="card rev__unread">I couldn&rsquo;t read your captures — {s.captures.why}.</div>
          ) : s.captures.items.length === 0 ? (
            <div className="card rev__calm">Nothing captured recently.</div>
          ) : (
            s.captures.items.slice(0, 5).map((c) => (
              <div className="card rev__row" key={c.id}>
                <span className="rev__row-title">{c.title || c.preview || c.path}</span>
                <span className="rev__row-meta">{stampFor(c.updatedAt)}</span>
              </div>
            ))
          )}

          <h2 className="rev__h">Anything still on this phone</h2>
          {unsent === 0 ? (
            <div className="card rev__calm">Nothing waiting — everything reached NEURO.</div>
          ) : (
            <div className="card rev__unread">
              {unsent} item{unsent === 1 ? '' : 's'} still on this device.
              <button type="button" className="rev__btn" onClick={() => flush({ force: true })}>Send now</button>
            </div>
          )}
        </>
      )}

      {s && mode === 'week' && (
        <>
          <h2 className="rev__h">This week</h2>
          {s.weeklyTarget ? (
            <div className="card">
              {/* Four states, kept apart on purpose: `unset` is not a target of
                  zero, and `unknown` is not a target that was missed. */}
              <div className="rev__big">
                {s.weeklyTarget.done ?? '—'}
                {s.weeklyTarget.target ? ` / ${s.weeklyTarget.target}` : ''}
              </div>
              <div className="rev__row-meta">{s.weeklyTarget.say || s.weeklyTarget.state}</div>
            </div>
          ) : (
            <div className="card rev__unread">No weekly target reading.</div>
          )}

          <h2 className="rev__h">People in the diary</h2>
          {s.people.known === false ? (
            <div className="card rev__unread">I couldn&rsquo;t read this — {s.people.why}.</div>
          ) : s.people.items.length === 0 ? (
            <div className="card rev__calm">Nobody matched.</div>
          ) : (
            s.people.items.map((p) => (
              <div className="card rev__row" key={p.id}>
                <span className="rev__row-title">{p.name}</span>
                <span className="rev__row-meta">{p.meeting}</span>
              </div>
            ))
          )}
        </>
      )}

      {/* ── This device ───────────────────────────────────────────────────── */}
      <h2 className="rev__h">This device</h2>
      <div className="card rev__storage">
        <p className="rev__note">
          Neuro Mobile keeps a small working set in this app&rsquo;s own browser storage so it
          still works with no signal. <strong>It is not encrypted</strong>, and iOS may clear it
          if the app goes unused or the phone runs low on space. Your PIN is not kept here.
          NEURO remains the only canonical copy of anything.
        </p>
        {storage && storage.available === false && (
          <p className="err">Local storage is unavailable{storage.error ? ` — ${storage.error}` : ''}. Offline capture will not work.</p>
        )}
        {storage && storage.available && (
          <ul className="rev__stats">
            <li>Store version {SCHEMA_VERSION}</li>
            <li>Snapshot cached {storage.snapshotFetchedAt ? stampFor(storage.snapshotFetchedAt) : 'never'}</li>
            <li>{storage.operations.queued} queued · {storage.operations.failed} failed · {storage.operations.needsAttention} need attention</li>
            <li>{storage.receipts} receipt{storage.receipts === 1 ? '' : 's'} kept</li>
            {storage.estimate && storage.estimate.usage != null && (
              <li>{Math.round(storage.estimate.usage / 1024)} KB used</li>
            )}
          </ul>
        )}
        <div className="rev__clear">
          <button type="button" className="rev__btn" onClick={() => onClear(false)}>Clear cached data</button>
          <button type="button" className="rev__btn rev__btn--danger" onClick={() => onClear(true)}>
            Clear everything, including unsent
          </button>
        </div>
        {clearing && <p className="rev__row-meta">{clearing === 'working' ? 'Clearing…' : clearing}</p>}
        <p className="rev__note rev__note--small">
          iOS cannot read your Obsidian vault or a Notion workspace directly. NEURO ingests and
          indexes those, and this app syncs only the derived working set above.
          Background sync is not guaranteed on iOS — the queue is sent when the app is open.
        </p>
      </div>
    </section>
  );
}
