import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api';
import './AppleSyncPanel.css';

/**
 * Apple Calendar and Reminders, pulled from iCloud.
 *
 * This replaces a phone-initiated push that delivered ONE payload in its whole
 * life — see `services/apple-caldav.js` for why the phone cannot be relied on to
 * start it, and why it cannot be triggered remotely either.
 *
 * Two things this screen has to keep straight, because conflating them is how a
 * sync screen starts lying:
 *   · NOT CONFIGURED is a choice, not a fault. No credential means nobody has
 *     connected it yet, and it says so quietly rather than in red.
 *   · A FAILED READ is not an empty diary. `ingestCalendar` clears the window
 *     before inserting, so a partial read that ingested would erase real events
 *     and report success. The server already refuses; this screen says why.
 *
 * The write is two-step, following Brain Health: "Sync now" refuses until a dry
 * run has been done, and the button quotes that dry run's real numbers.
 */

function Row({ label, children }) {
  return (
    <div className="as-row">
      <span className="as-row-label">{label}</span>
      <span className="as-row-value">{children}</span>
    </div>
  );
}

/**
 * Apple ID + app-specific password.
 *
 * A password input, and the value is never read back from the server — the
 * routes report only WHETHER a credential is set and which source answered.
 */
function ConnectBox({ onSaved }) {
  const [appleId, setAppleId] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch('/api/apple/caldav/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appleId, appPassword }),
      });
      const data = await r.json();
      if (data.ok) { setAppleId(''); setAppPassword(''); onSaved(); }
      else setError(data.error || 'Could not save the credentials.');
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="as-connect">
      <p className="as-muted">
        This needs an <strong>app-specific password</strong>, not your Apple ID password —
        Apple refuses the account password for CalDAV outright. Generate one at{' '}
        <code>appleid.apple.com</code> → Sign-In and Security → App-Specific Passwords.
        It can be revoked on its own without changing your Apple ID.
      </p>
      <div className="as-connect-fields">
        <input
          type="email"
          placeholder="Apple ID (email)"
          value={appleId}
          onChange={(e) => setAppleId(e.target.value)}
          autoComplete="off"
        />
        <input
          type="password"
          placeholder="app-specific password (xxxx-xxxx-xxxx-xxxx)"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          autoComplete="new-password"
        />
        <button onClick={submit} disabled={busy || !appleId || !appPassword}>
          {busy ? 'Saving…' : 'Connect'}
        </button>
      </div>
      {error && <div className="as-error">{error}</div>}
      <p className="as-muted as-fine">
        Stored in NEURO, never in the repository — which is public. It takes effect
        immediately; no restart.
      </p>
    </div>
  );
}

export default function AppleSyncPanel() {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [collections, setCollections] = useState(null);
  const [collectionsError, setCollectionsError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [applied, setApplied] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await apiFetch('/api/apple/caldav/status');
      setStatus(await r.json());
      setStatusError(null);
    } catch (e) {
      // "Could not ask" is a different fact from "not configured".
      setStatusError(e.message);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const lookAtAccount = async () => {
    setBusy('collections');
    setCollectionsError(null);
    try {
      const r = await apiFetch('/api/apple/caldav/collections');
      const data = await r.json();
      if (data.ok) setCollections(data.collections);
      else setCollectionsError(data.error || 'Could not read the account.');
    } catch (e) {
      setCollectionsError(e.message);
    } finally { setBusy(null); }
  };

  const runSync = async (apply) => {
    setBusy(apply ? 'apply' : 'dry');
    if (apply) setApplied(null);
    try {
      const r = await apiFetch('/api/apple/caldav/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply }),
      });
      const data = await r.json();
      if (apply) { setApplied(data); setPreview(null); loadStatus(); }
      else setPreview(data);
    } catch (e) {
      const failed = { ok: false, reason: 'request-failed', error: e.message };
      if (apply) setApplied(failed); else setPreview(failed);
    } finally { setBusy(null); }
  };

  const configured = status && status.configured;
  // The server refuses to ingest a partial read; the button must not offer it
  // either, or the screen and the service disagree about what is safe.
  const previewClean = preview && preview.ok && preview.failures && preview.failures.length === 0;

  return (
    <div className="apple-sync">
      <div className="as-head">
        <h2>Apple Sync</h2>
        <p className="as-muted">
          Your personal calendar and Reminders, read from iCloud by NEURO itself.
          Nothing runs on your phone.
        </p>
      </div>

      {statusError && (
        <div className="as-warn">
          Couldn’t read the sync status — <code>{statusError}</code>.
          This is not the same as it being switched off.
        </div>
      )}

      {status && !configured && (
        <div className="as-note">
          <strong>Not connected yet.</strong> That’s a choice, not a fault — nothing
          has been set up. Add an app-specific password below to start.
          {status.problems && status.problems.length > 0 && (
            <ul>{status.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
        </div>
      )}

      {status && (
        <div className="as-card">
          <h3>Connection</h3>
          <Row label="Configured">{configured ? 'yes' : 'no'}</Row>
          {configured && <Row label="Apple ID">{status.appleId}</Row>}
          {configured && (
            <Row label="Credential">
              set — from {status.credentialSource === 'env' ? 'the environment' : 'NEURO'}
              <span className="as-muted"> (never shown, here or anywhere)</span>
            </Row>
          )}
          <Row label="Last run">
            {status.lastRunAt
              ? <>{new Date(status.lastRunAt).toLocaleString('en-GB')}{' '}
                {status.lastOk === false && <span className="as-bad">— did not complete cleanly</span>}</>
              : <span className="as-muted">never run</span>}
          </Row>
          {status.lastRunAt && (
            <Row label="Last read">
              {status.lastEvents} event{status.lastEvents === 1 ? '' : 's'},{' '}
              {status.lastReminders} reminder{status.lastReminders === 1 ? '' : 's'}
            </Row>
          )}
        </div>
      )}

      <div className="as-card">
        <h3>{configured ? 'Change the credentials' : 'Connect'}</h3>
        <ConnectBox onSaved={loadStatus} />
      </div>

      {configured && (
        <div className="as-card">
          <h3>What the account can see</h3>
          <p className="as-muted">
            Reads nothing and writes nothing — it only lists what’s there. Calendars
            and Reminders lists are told apart by what they support, never by name.
          </p>
          <button onClick={lookAtAccount} disabled={busy === 'collections'}>
            {busy === 'collections' ? 'Looking…' : 'Look at the account'}
          </button>

          {collectionsError && (
            <div className="as-error">
              Couldn’t read the account — {collectionsError}
              <div className="as-muted as-fine">
                A 401 here almost always means the account password was used instead
                of an app-specific one.
              </div>
            </div>
          )}

          {collections && collections.length === 0 && (
            <div className="as-warn">
              The account returned no calendars at all. That’s a failed read, not an
              empty account — nothing will be ingested on it.
            </div>
          )}

          {collections && collections.length > 0 && (
            <ul className="as-list">
              {collections.map((c) => (
                <li key={c.href}>
                  <strong>{c.name}</strong>
                  <span className="as-muted">
                    {' '}— {c.supportsTodos ? 'Reminders list' : 'calendar'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {configured && (
        <div className="as-card">
          <h3>Sync</h3>
          <p className="as-muted">
            A dry run reads iCloud and reports what it found, changing nothing.
            Syncing rewrites the Apple half of the diary for the window it read —
            which is why it won’t run until a dry run has been done.
          </p>

          <div className="as-actions">
            <button onClick={() => runSync(false)} disabled={busy !== null}>
              {busy === 'dry' ? 'Reading…' : 'Dry run'}
            </button>
            <button
              className="as-primary"
              onClick={() => runSync(true)}
              disabled={busy !== null || !previewClean}
              title={previewClean ? undefined : 'Do a dry run first'}
            >
              {busy === 'apply'
                ? 'Syncing…'
                : previewClean
                  ? `Sync ${preview.events} event${preview.events === 1 ? '' : 's'} and ${preview.reminders} reminder${preview.reminders === 1 ? '' : 's'}`
                  : 'Sync now'}
            </button>
          </div>

          {preview && <Result title="Dry run" data={preview} />}
          {applied && <Result title="Sync" data={applied} />}
        </div>
      )}
    </div>
  );
}

/**
 * One run's outcome.
 *
 * The failure cases get more room than the success case on purpose: a clean run
 * is a number, and a refused one is the thing worth reading.
 */
function Result({ title, data }) {
  if (!data.ok) {
    return (
      <div className="as-warn">
        <strong>{title} didn’t complete</strong> — {data.reason}
        {data.error && <> — <code>{data.error}</code></>}
        {data.reason === 'no-collections' && (
          <div>The account returned no calendars. Nothing was written.</div>
        )}
        {data.reason === 'unauthorised' && (
          <div>Check the app-specific password — Apple refuses the account password here.</div>
        )}
      </div>
    );
  }

  const refused = data.calendarIngested === false && data.reason === 'partial-read';

  return (
    <div className={refused ? 'as-warn' : 'as-result'}>
      <strong>{title}</strong>
      <Row label="Window">{data.window.from} → {data.window.to}</Row>
      <Row label="Events">{data.events}</Row>
      <Row label="Reminders">{data.reminders}</Row>
      <Row label="Calendars seen">{data.calendarsSeen.join(', ') || '—'}</Row>

      {refused && (
        <div className="as-refusal">
          <strong>The diary was NOT updated, deliberately.</strong> These couldn’t be
          read, and writing a partial result would have erased the events they hold
          rather than leaving them stale:
          <ul>
            {data.failures.map((f) => (
              <li key={f.calendar}><strong>{f.calendar}</strong> — {f.error}</li>
            ))}
          </ul>
        </div>
      )}

      {data.reminderFailures && data.reminderFailures.length > 0 && (
        <div className="as-note">
          Some Reminders lists couldn’t be read — a missed task rather than a lost
          one, since reminders are only ever added:
          <ul>
            {data.reminderFailures.map((f) => (
              <li key={f.list}><strong>{f.list}</strong> — {f.error}</li>
            ))}
          </ul>
        </div>
      )}

      {data.unsupportedRecurrence && data.unsupportedRecurrence.length > 0 && (
        <div className="as-note">
          These repeat in a way NEURO can’t expand, so only their first occurrence
          is held — the diary may read emptier than it is for them:
          <ul>
            {data.unsupportedRecurrence.map((u, i) => (
              <li key={i}><strong>{u.summary}</strong> ({u.calendar}) — {u.why}</li>
            ))}
          </ul>
        </div>
      )}

      {data.reason === 'dry-run' && (
        <p className="as-muted as-fine">Nothing was written.</p>
      )}
    </div>
  );
}
