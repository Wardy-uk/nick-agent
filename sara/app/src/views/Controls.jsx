import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { enableNotifications, permissionState, pushSupported } from '../hooks/usePushSubscription';
import './Controls.css';

// SARA Controls — the surface where Nick decides how much SARA is allowed to
// interrupt, and can see what she has already done.
//
// Two halves, and the second is the one that makes the first trustworthy:
//
//   * the controls themselves — on/off, quiet hours, how loud, pause, and the
//     work/personal split;
//   * the HISTORY — what was surfaced, when, and the reason each one was
//     surfaced. Without it "SARA feels inconsistent" is unanswerable, which is
//     exactly where this started: 661 sent and 141 suppressed in the live log,
//     and no way for Nick to see either number.
//
// ⚠ Every value here is read from and written to NEURO. Nothing is stored on the
// device: a second copy of the settings would be a second opinion about when to
// interrupt, and the whole point of the contract is that there is one.

const PAUSES = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: 'Rest of today', minutes: 8 * 60 },
];

const LEVELS = [
  { id: 'all', label: 'Everything', hint: 'Anything the brain ranks worth surfacing.' },
  { id: 'normal', label: 'Normal', hint: 'Skips low-urgency items. The default.' },
  { id: 'critical-only', label: 'Critical only', hint: 'Escalations and imminent meetings. Nothing else.' },
];

// The lifecycle states, said in words rather than as slugs. A screen that prints
// its own internal vocabulary at Nick is the "121 reminder" bug one layer up.
const STATE_WORDS = {
  active: 'Waiting',
  acknowledged: 'Seen',
  deferred: 'Snoozed',
  suppressed: 'Dismissed',
  resolved: 'Done',
  expired: 'Passed',
};

const EVENT_WORDS = {
  opened: 'noticed',
  surfaced: 'shown',
  notified: 'notified you',
  'notify-refused': 'held back',
  acknowledged: 'you marked it seen',
  deferred: 'you snoozed it',
  dismissed: 'you dismissed it',
  resolved: 'resolved',
  expired: 'expired',
};

function when(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function Controls() {
  const [settings, setSettings] = useState(null);
  const [records, setRecords] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(permissionState());
  const [permissionNote, setPermissionNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, r, h] = await Promise.all([
        apiFetch('/api/attention/settings'),
        apiFetch('/api/attention/records'),
        apiFetch('/api/attention/history?limit=40'),
      ]);
      setSettings(s.settings);
      setRecords(r.records || []);
      setHistory(h.events || []);
      setError(null);
    } catch (e) {
      // "I couldn't ask" is a different fact from "nothing is set", and a
      // controls screen that renders defaults over an unreachable brain would
      // show Nick settings that are not the ones in force.
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (body) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/attention/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setSettings(res.settings);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  async function turnOn() {
    setPermissionNote(null);
    const result = await enableNotifications();
    setPermission(result.state);
    if (!result.ok) { setPermissionNote(result.error); return; }
    await patch({ enabled: true });
  }

  if (error && !settings) {
    return (
      <div className="controls">
        <h2 className="controls__title">SARA Controls</h2>
        <p className="controls__error">I couldn't reach NEURO, so I can't show you what's set — {error}</p>
        <button className="controls__btn" onClick={load}>Try again</button>
      </div>
    );
  }

  if (!settings) return <div className="controls"><p className="controls__muted">Reading your settings…</p></div>;

  const paused = settings.pausedUntil && new Date(settings.pausedUntil) > new Date();

  return (
    <div className="controls">
      <h2 className="controls__title">SARA Controls</h2>
      {error && <p className="controls__error">Last change didn't save — {error}</p>}

      {/* Permission. Deliberately a button and never an automatic prompt: the
          browser asks once, and a denial is close to permanent on iOS. */}
      {pushSupported() && permission !== 'granted' && (
        <section className="controls__section">
          <h3 className="controls__heading">Notifications</h3>
          <p className="controls__muted">
            {permission === 'denied'
              ? 'Blocked for this app. iOS will not ask again — it has to be changed in Settings.'
              : 'Off. SARA can still be read here; she just will not interrupt you.'}
          </p>
          {permission !== 'denied' && (
            <button className="controls__btn controls__btn--primary" onClick={turnOn}>
              Turn notifications on
            </button>
          )}
          {permissionNote && <p className="controls__error">{permissionNote}</p>}
        </section>
      )}

      <section className="controls__section">
        <label className="controls__row">
          <span>
            <strong>Let SARA interrupt me</strong>
            <em className="controls__hint">Off means she still collects; she just never pushes.</em>
          </span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
        </label>
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">Pause</h3>
        {paused ? (
          <div className="controls__row">
            <span>Paused until <strong>{new Date(settings.pausedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</strong></span>
            <button className="controls__btn" disabled={busy} onClick={() => patch({ pausedUntil: null })}>Resume</button>
          </div>
        ) : (
          <div className="controls__chips">
            {PAUSES.map((p) => (
              <button key={p.minutes} className="controls__chip" disabled={busy} onClick={() => patch({ pauseMinutes: p.minutes })}>
                {p.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">How much gets through</h3>
        {LEVELS.map((l) => (
          <label key={l.id} className="controls__row controls__row--radio">
            <span>
              <strong>{l.label}</strong>
              <em className="controls__hint">{l.hint}</em>
            </span>
            <input
              type="radio"
              name="level"
              checked={settings.interruptionLevel === l.id}
              disabled={busy}
              onChange={() => patch({ interruptionLevel: l.id })}
            />
          </label>
        ))}
        <p className="controls__muted">
          Escalations and imminent meetings come through whatever this says. That is the only exception.
        </p>
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">Quiet hours</h3>
        <div className="controls__chips">
          {['off', '22:00-07:00', '21:00-08:00', '23:00-06:00'].map((q) => (
            <button
              key={q}
              className={`controls__chip${settings.quietHours === q ? ' controls__chip--on' : ''}`}
              disabled={busy}
              onClick={() => patch({ quietHours: q })}
            >
              {q === 'off' ? 'None' : q}
            </button>
          ))}
        </div>
        {settings.quietHoursSource === 'server' && (
          // Showing an inherited value as though Nick had chosen it is how a
          // control surface starts lying about what is in force.
          <p className="controls__muted">Inherited from the server — you have not set your own.</p>
        )}
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">What counts</h3>
        {['work', 'personal'].map((d) => (
          <label key={d} className="controls__row">
            <span style={{ textTransform: 'capitalize' }}>{d}</span>
            <input
              type="checkbox"
              checked={settings.domains?.[d] !== false}
              disabled={busy}
              onChange={(e) => patch({ domains: { [d]: e.target.checked } })}
            />
          </label>
        ))}
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">On SARA's mind ({records.length})</h3>
        {records.length === 0 && <p className="controls__muted">Nothing open. That is a real answer, not a blank screen.</p>}
        {records.map((r) => (
          <div key={r.recordId} className="controls__record">
            <div className="controls__recordTop">
              <span className={`controls__state controls__state--${r.state}`}>{STATE_WORDS[r.state] || r.state}</span>
              <span className="controls__recordTitle">{r.title}</span>
            </div>
            {/* The reason it is here, and what makes it true. Never invented:
                where NEURO can cite nothing, this says so rather than filling
                the space with something plausible. */}
            {r.reason && <p className="controls__why">{r.reason}</p>}
            <p className="controls__evidence">
              {r.evidence?.length
                ? r.evidence.map((e) => `${e.source}${e.ref ? ` · ${e.ref}` : ''}`).join(' — ')
                : 'No source to cite, so this will not interrupt you.'}
            </p>
            <p className="controls__stamps">
              seen {when(r.lastSeenAt)}
              {r.notifiedAt ? ` · notified ${when(r.notifiedAt)}` : ' · never notified'}
              {r.deferUntil ? ` · snoozed (${r.deferReason})` : ''}
            </p>
          </div>
        ))}
      </section>

      <section className="controls__section">
        <h3 className="controls__heading">Recently</h3>
        {history.length === 0 && <p className="controls__muted">Nothing yet.</p>}
        <ul className="controls__history">
          {history.map((e) => (
            <li key={e.id}>
              <span className="controls__historyWhen">{when(e.at)}</span>
              <span>
                <strong>{e.title || e.type}</strong> — {EVENT_WORDS[e.event] || e.event}
                {e.detail ? ` (${e.detail})` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
