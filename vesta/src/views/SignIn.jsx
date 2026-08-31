import { useState } from 'react';
import * as api from '../api';

/**
 * Username + PIN.
 *
 * ⚠ The lockout message is the reason this screen has a real error line rather
 * than a red border. Five wrong tries locks the account for fifteen minutes and
 * the API returns that as a sentence; swallowing it leaves her retrying a
 * locked account, getting the same refusal, with nothing on screen explaining
 * why the right PIN stopped working.
 */
export default function SignIn({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username.trim(), pin.trim());
      api.setToken(result.token);
      onSignedIn(result);
    } catch (err) {
      // The server's own words, verbatim — including "Try again in 14 minutes."
      setError(err.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin__hearth" aria-hidden="true" />
      <h1 className="signin__title">Vesta</h1>
      <p className="signin__sub">The house.</p>

      <form className="signin__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            enterKeyHint="next"
          />
        </label>

        <label className="field">
          <span className="field__label">PIN</span>
          <div className="field__withreveal">
            <input
              className="field__input"
              type={reveal ? 'text' : 'password'}
              value={pin}
              onChange={e => setPin(e.target.value)}
              /* ⚠ NO inputMode="numeric". A PIN here is any 4+ characters — the
                 server sets no charset — and an alphanumeric one is exactly what
                 the Settings screen invites. A numeric keypad on a phone has no
                 letters on it, so that attribute made a perfectly correct PIN
                 IMPOSSIBLE to type, and the masked field hid the fact. It cost
                 an afternoon of "username or PIN is not right". */
              autoComplete="current-password"
              enterKeyHint="go"
            />
            {/* And a way to SEE it. A field you cannot read is a field you
                cannot debug, which is the other half of the same afternoon. */}
            <button
              type="button"
              className="field__reveal"
              onClick={() => setReveal(r => !r)}
              aria-label={reveal ? 'Hide PIN' : 'Show PIN'}
            >{reveal ? 'Hide' : 'Show'}</button>
          </div>
        </label>

        <button className="btn btn--primary" disabled={busy || !username || !pin}>
          {busy ? 'One moment…' : 'Come in'}
        </button>
      </form>

      {error && <p className="signin__error" role="alert">{error}</p>}
    </div>
  );
}
