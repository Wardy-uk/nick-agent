import { useState } from 'react';
import { setPin, clearPin, apiUrl } from '../api';
import Field from '../../../shared-ui/Field';
import './LockScreen.css';

// PIN gate. Validates the PIN against the brain BEFORE unlocking, so a wrong PIN
// can't get stored and silently 401 every screen. Only an explicit 401 rejects —
// a network/other error still lets you in (the app's own error states take over).
export default function LockScreen({ onUnlock }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const pin = value.trim();
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/focus'), { headers: { 'X-Neuro-Pin': pin } });
      if (res.status === 401) {
        clearPin();
        setError('Incorrect PIN — try again.');
        return;
      }
      setPin(pin);
      onUnlock();
    } catch {
      // Couldn't reach the brain to validate — store and let the app surface it.
      setPin(pin);
      onUnlock();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock">
      {/* Nick, 31 Aug 2026 — the field must be present whenever he SEES SARA,
          and the PIN gate carries her mark. Degraded: at this point she has not
          been let in to anything, so there is nothing for her to resolve. */}
      <Field confidenceLevel="low" degraded />
      <form className="lock__box" onSubmit={submit}>
        <div className="lock__brand">SARA</div>
        <p className="lock__hint">Enter your NEURO PIN</p>
        <input
          className="lock__input"
          type="password"
          inputMode="numeric"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          aria-label="NEURO PIN"
        />
        {error && <div className="lock__error">{error}</div>}
        <button className="lock__btn" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
