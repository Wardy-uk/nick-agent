import { useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * VESTA accounts — who can sign in to the household surface, and what they see.
 *
 * ⚠ These are NOT NEURO logins and must never be mistaken for one. VESTA sits on
 * `/api/v`, the one mount exempt from the PIN and reachable from the open
 * internet, so an account here is a wholly separate credential that deliberately
 * cannot reach Nick's queue, inbox, people notes or health. His own NEURO PIN is
 * refused by `/api/v` on purpose, and that refusal is a tested invariant.
 *
 * Before this screen the only way to add someone was a curl command against the
 * Pi, and the only way to widen an account was to DELETE it and issue a new PIN —
 * because `setScopes` had no route. Both of those are why this exists.
 *
 * Its own file rather than another section inside `AdminPanel.jsx`, which is
 * already 1,100 lines of inline sections.
 */
export default function VestaAccounts() {
  const [accounts, setAccounts] = useState(null);
  const [vocab, setVocab] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', username: '', pin: '', scopes: ['tasks'] });
  const [resetting, setResetting] = useState(null);
  const [newPin, setNewPin] = useState('');

  const load = () => {
    fetch(apiUrl('/api/capture-links'))
      .then(r => r.json())
      .then(d => {
        if (d && d.ok) setAccounts(d.accounts);
        else setError((d && d.error) || 'Could not load accounts.');
      })
      .catch(e => setError(e.message));

    // ⚠ The scope names come from the SERVER, never a copy kept here. A second
    // list is how a screen comes to offer a permission that does not exist, or
    // quietly miss one that does.
    fetch(apiUrl('/api/capture-links/scopes'))
      .then(r => r.json())
      .then(d => { if (d && d.ok) setVocab(d.scopes); })
      .catch(() => { /* the list still renders; the checkboxes just don't */ });
  };
  useEffect(load, []);

  const send = async (path, body, method = 'POST') => {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || 'That did not work.');
    return data;
  };

  const act = async (key, fn) => {
    setBusy(key);
    setError('');
    try { await fn(); load(); }
    catch (e) { setError(e.message); }
    setBusy('');
  };

  const toggle = (list, scope) =>
    list.includes(scope) ? list.filter(s => s !== scope) : [...list, scope];

  const row = { display: 'flex', gap: '12px', flexWrap: 'wrap' };
  const box = { display: 'flex', alignItems: 'center', gap: '5px' };

  return (
    <div className="admin-section">
      <div className="admin-section-title">VESTA Accounts</div>

      {/* Said plainly and permanently. The whole point of this screen is handing
          somebody a credential, and what it does NOT unlock is the part worth
          being certain about every time you look at it. */}
      <div className="admin-card-detail" style={{ marginBottom: '12px' }}>
        Logins for <strong>vesta.nickward.co.uk</strong>, the shared home surface.
        Separate from your NEURO PIN, which VESTA refuses on purpose — these
        accounts can never reach your queue, inbox, people notes or health.
      </div>

      {error && (
        <div className="admin-card-detail" style={{ color: 'var(--danger, #ef4444)', marginBottom: '10px' }}>
          {error}
        </div>
      )}

      {accounts === null ? (
        <div className="admin-card-detail">Loading…</div>
      ) : accounts.length === 0 ? (
        // "Nobody can sign in" is the real state and is worth saying — an empty
        // list otherwise reads as a screen that failed to load.
        <div className="admin-card-detail" style={{ marginBottom: '12px' }}>
          No accounts yet — nobody can sign in to VESTA, including you.
        </div>
      ) : accounts.map(a => {
        const locked = a.lockedUntil && new Date(a.lockedUntil) > new Date();
        return (
          <div className="admin-card" key={a.username} style={{ marginBottom: '10px' }}>
            <div className="admin-card-header">
              <span className="admin-card-name">
                {a.label} <span style={{ opacity: 0.6 }}>@{a.username}</span>
              </span>
              {locked && (
                <span style={{ color: 'var(--accent-warn, #f59e0b)', fontSize: '12px' }}>
                  locked until {new Date(a.lockedUntil).toLocaleTimeString()}
                </span>
              )}
            </div>

            <div className="admin-card-detail">
              {a.submitted} sent · {a.lastSeenAt
                ? `last seen ${new Date(a.lastSeenAt).toLocaleDateString()}`
                : 'never signed in'}
            </div>

            <div className="admin-card-detail" style={{ ...row, marginTop: '8px' }}>
              {vocab.map(scope => (
                <label key={scope} style={box}>
                  <input
                    type="checkbox"
                    checked={a.scopes.includes(scope)}
                    /* `tasks` is what an account IS — one without it is a login
                       that can do nothing, a confusing way to spell "disabled".
                       The server enforces this too; this only stops it looking
                       like a choice. */
                    disabled={scope === 'tasks' || busy === a.username}
                    onChange={() => act(a.username, () =>
                      send(`/api/capture-links/${a.username}/scopes`, { scopes: toggle(a.scopes, scope) }))}
                  />
                  {scope}
                </label>
              ))}
            </div>

            {resetting === a.username ? (
              <div className="admin-card-detail" style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={newPin}
                  onChange={e => setNewPin(e.target.value)}
                  placeholder="new PIN or passphrase (4+)"
                  style={{ flex: 1 }}
                />
                <button
                  className="admin-ms-connect-btn"
                  disabled={newPin.trim().length < 4}
                  onClick={() => act(a.username, async () => {
                    await send(`/api/capture-links/${a.username}/pin`, { pin: newPin.trim() });
                    setResetting(null);
                    setNewPin('');
                  })}
                >Set</button>
                <button
                  className="admin-ms-connect-btn"
                  onClick={() => { setResetting(null); setNewPin(''); }}
                >Cancel</button>
              </div>
            ) : (
              <div className="admin-card-detail" style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                {/* Resetting also clears a lockout — it is the way back in for
                    somebody who has locked themselves out of a public screen. */}
                <button className="admin-ms-connect-btn" onClick={() => setResetting(a.username)}>
                  {locked ? 'Reset PIN & unlock' : 'Reset PIN'}
                </button>
                <button
                  className="admin-ms-connect-btn"
                  disabled={busy === a.username}
                  onClick={() => {
                    // The one irreversible control on this screen.
                    const ok = window.confirm(
                      `Remove ${a.label}'s access to VESTA? They will not be able to sign in again.`
                    );
                    if (!ok) return;
                    act(a.username, () => send(`/api/capture-links/${a.username}`, null, 'DELETE'));
                  }}
                >Revoke</button>
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="admin-card">
          <div className="admin-card-header"><span className="admin-card-name">New account</span></div>
          <div className="admin-card-detail" style={{ display: 'grid', gap: '6px', marginTop: '6px' }}>
            <input
              value={form.label}
              onChange={e => setForm({ ...form, label: e.target.value })}
              placeholder="Name (shown on their screen)"
            />
            <input
              value={form.username}
              onChange={e => setForm({ ...form, username: e.target.value })}
              placeholder="username (what they type to sign in)"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <input
              value={form.pin}
              onChange={e => setForm({ ...form, pin: e.target.value })}
              placeholder="PIN or passphrase (4+, letters allowed)"
            />

            <div style={row}>
              {vocab.map(scope => (
                <label key={scope} style={box}>
                  <input
                    type="checkbox"
                    checked={form.scopes.includes(scope)}
                    disabled={scope === 'tasks'}
                    onChange={() => setForm({ ...form, scopes: toggle(form.scopes, scope) })}
                  />
                  {scope}
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="admin-ms-connect-btn"
                disabled={
                  busy === 'new' || !form.label.trim() || !form.username.trim() || form.pin.trim().length < 4
                }
                onClick={() => act('new', async () => {
                  await send('/api/capture-links', {
                    label: form.label.trim(),
                    username: form.username.trim(),
                    pin: form.pin.trim(),
                    scopes: form.scopes,
                  });
                  setForm({ label: '', username: '', pin: '', scopes: ['tasks'] });
                  setAdding(false);
                })}
              >Create</button>
              <button className="admin-ms-connect-btn" onClick={() => setAdding(false)}>Cancel</button>
            </div>

            {/* The PIN is hashed on write and returned by no endpoint in any
                form, so this is genuinely the only moment it exists in readable
                shape. Saying so beats them discovering it later. */}
            {/* ⚠ Both halves matter. The PIN is unrecoverable, AND letters are
                allowed — the sign-in field used to show a numeric keypad on a
                phone, which made an alphanumeric PIN impossible to type and
                looked exactly like a wrong password. */}
            <div style={{ fontSize: '12px', opacity: 0.7 }}>
              Tell them the PIN now — it is hashed on save and can never be read back, only reset.
              Letters are allowed; they can reveal it as they type when signing in.
            </div>
          </div>
        </div>
      ) : (
        <button className="admin-ms-connect-btn" onClick={() => setAdding(true)}>Add someone</button>
      )}
    </div>
  );
}
