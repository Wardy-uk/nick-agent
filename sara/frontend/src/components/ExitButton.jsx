import { useState } from 'react';
import './ExitButton.css';

// Exit control for the Pi kiosk (WS2-WP2).
//
// The Pi touchscreen has no keyboard, so there is no other way out of the Chromium
// kiosk. This lives in the app shell, so it appears on EVERY view. It is two-step
// (confirm-then-quit) so a stray touch can't drop you out: tap shows "Close SARA?",
// and only "Close" actually quits. On confirm it asks the SARA backend to close the
// kiosk browser (POST /api/kiosk/exit); the desktop launcher restores the Pi taskbar
// as it exits. Off-Pi (e.g. a desktop browser) the backend kill is a no-op and we
// fall back to window.close().
//
// ── `variant="nav"` (31 Aug 2026) ───────────────────────────────────────────
// Nick moved it out of the top bar and into the bottom nav, styled like the
// tabs. So it renders as a `navbtn` — the phone's class, not a copy — and the
// two-step becomes a POPOVER above the bar rather than three controls fighting
// for one tab-width slot.
//
// ⚠ The confirm step is not cosmetic and does not get dropped to make it fit.
// This is the only way out of a kiosk with no keyboard, on a touchscreen, and
// a stray palm must not close SARA. Cancel is the wider of the two, because
// the safe answer should be the easier one to hit.
export default function ExitButton({ variant = 'chrome' }) {
  const [phase, setPhase] = useState('idle'); // idle | confirm | closing

  async function quit() {
    setPhase('closing');
    try {
      await fetch('/api/kiosk/exit', { method: 'POST' });
    } catch {
      window.close();
    }
  }

  if (variant === 'nav') {
    return (
      <div className="exitnav">
        {phase === 'confirm' && (
          <div className="exitnav__confirm" role="dialog" aria-label="Close SARA?">
            <span className="exitnav__ask">Close SARA?</span>
            <div className="exitnav__acts">
              <button type="button" className="exitnav__act exitnav__act--no" onClick={() => setPhase('idle')}>
                Cancel
              </button>
              <button type="button" className="exitnav__act exitnav__act--yes" onClick={quit}>
                Close
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          className={`navbtn${phase === 'confirm' ? ' navbtn--on' : ''}`}
          aria-label="Exit SARA"
          aria-expanded={phase === 'confirm'}
          disabled={phase === 'closing'}
          onClick={() => setPhase(phase === 'confirm' ? 'idle' : 'confirm')}
        >
          <span className="navbtn__icon" aria-hidden="true">⏻</span>
          <span className="navbtn__label">{phase === 'closing' ? 'Closing…' : 'Exit'}</span>
        </button>
      </div>
    );
  }

  if (phase === 'closing') {
    return (
      <div className="exit exit--status" role="status">
        Closing SARA…
      </div>
    );
  }

  if (phase === 'confirm') {
    return (
      <div className="exit exit--confirm" role="dialog" aria-label="Close SARA?">
        <span className="exit__ask">Close SARA?</span>
        <button type="button" className="exit__act exit__act--yes" onClick={quit}>
          Close
        </button>
        <button
          type="button"
          className="exit__act exit__act--no"
          onClick={() => setPhase('idle')}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="exit exit__trigger"
      aria-label="Exit SARA"
      title="Exit SARA"
      onClick={() => setPhase('confirm')}
    >
      <span aria-hidden="true">⏻</span>
    </button>
  );
}
