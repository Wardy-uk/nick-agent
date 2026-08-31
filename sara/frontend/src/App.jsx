import { useMemo, useState } from 'react';
import { SaraStateProvider, useSaraState } from './state/saraState';
import { useDisplayState } from './state/useDisplayState';
import { PRIMARY, SECONDARY, TABS, DEFAULT_TAB, revealsSecondary } from '../../shared-ui/tabs';
import Field from '../../shared-ui/Field';
import ExitButton from './components/ExitButton';
import LockScreen from './components/LockScreen';
import ClockScreen from './components/ClockScreen';
import ConnectionStatus from './components/ConnectionStatus';
import './App.css';
// ⚠ Imported AFTER the kiosk's own sheet, deliberately. `App.css` above carries
// the THEME (`:root` tokens, the body wash) the remaining chrome is built on;
// this one carries the SHELL — `.app`, `.app__view`, `.app__nav`, `.navbtn` —
// and where the two collide the phone's must win, because the whole point is
// that the two shells are one shell. `KioskShell.css` loads last and holds only
// what genuinely differs: a desk panel is 1280px wide, has no safe-area insets,
// and is read from a metre rather than from the hand.
import '../../app/src/App.css';
import './KioskShell.css';

// SARA on the Pi — the same app as the phone.
//
// ⚠ WHAT THIS REPLACED, and why. Nick, 31 Aug 2026: "make the Pi version of
// SARA the same as phone app - same for the desktop." It was not. The kiosk had
// its own fourteen-screen registry rendering `sara/backend`'s state model,
// while the phone had thirteen rendering NEURO's own contracts, and exactly ONE
// kiosk screen (Presence) had ever read the attention feed. Two screen sets
// over two backends is the drift `AttentionSurface` and `voiceUtils` each had
// to be undone from, one level up — so there is now ONE registry
// (`sara/shared-ui/tabs.jsx`) and both shells mount it.
//
// The DESKTOP comes free: `sara/desktop-electron` loads this same frontend from
// `SARA_URL`, so it is the same app by construction rather than by a third port.
//
// ── What is still the kiosk's own, and why ──────────────────────────────────
// The screens are shared; the chrome is not, exactly as `AttentionSurface`
// splits them. The kiosk brings the provenance banner, the Exit control, and
// the two display states NEURO composes for it — clock (at home, not in this
// room) and lock (out of the house). The phone brings a PIN gate, push
// registration and a wake lock, none of which mean anything on a screen that is
// simply on and has nobody to log in.
//
// ⚠ THE KIOSK HOLDS NO NEURO CREDENTIAL. The shared views call `/api/*`
// same-origin; `sara/backend` answers its own named routes and forwards the
// rest through an ALLOWLIST (`src/routes/neuroProxy.js`), attaching the
// credential server-side. That was always the reason the two apps could not be
// one, and it turned out to be a fact about the BROWSER, not about the screens.
function AppShell() {
  const { now } = useSaraState();
  const [active, setActive] = useState(DEFAULT_TAB);
  const [navOpen, setNavOpen] = useState(false);

  // ⚠ The kiosk no longer decides when to hide itself. NEURO composes the
  // verdict, so this screen, the phone and the widget cannot each invent their
  // own idea of what a missing watch means: watch here → SARA, watch elsewhere
  // → clock, out of the house → off.
  const { state: displayState, detail: displayDetail } = useDisplayState();
  const locked = displayState === 'locked';
  const showClock = displayState === 'clock';

  const ActiveView = useMemo(
    // Falls back to the default tab's component rather than a named import, so
    // the registry stays the only place that knows what a screen IS.
    () => TABS.find((t) => t.id === active)?.Component
      || TABS.find((t) => t.id === DEFAULT_TAB)?.Component,
    [active]
  );

  // Same rule as the phone: the primary row is always there, the secondary row
  // is revealed on request AND stays revealed while he is on one of its
  // screens, or the way back is only through the way he came.
  const isSecondary = revealsSecondary(active);
  const moreVisible = navOpen || isSecondary;

  function goTab(tab) {
    if (!tab) return;
    setActive(tab);
    if (PRIMARY.some((t) => t.id === tab)) setNavOpen(false);
  }

  return (
    <div className="app">
      {/* Her substrate, behind the whole shell — present on every screen, not
          only on her own (Nick, 31 Aug 2026). Suppressed on the Surface, which
          mounts its own driven by the real attention payload; two stacked
          fields would put a `quiet` placeholder under an honest one. */}
      {active !== 'surface' && (
        <div className="app__field" aria-hidden="true"><Field quiet confidenceLevel="low" /></div>
      )}

      <header className="app__header">
        <span className="app__brand">SARA</span>
        {/* Not chrome. "This is demo data" and "nothing here is current" are
            facts about everything below, and this is the surface with nobody
            standing at it to ask. Silent when live. */}
        <ConnectionStatus />
        <ExitButton />
      </header>

      <main className="app__view">
        {/* `key` forces a fresh mount when switching Capture↔Voice so
            `autoRecord` re-fires — the phone's rule, and the same component. */}
        <ActiveView
          key={active}
          autoRecord={active === 'voice'}
          onNavigate={goTab}
          onShowAll={() => setNavOpen(true)}
        />
      </main>

      {/* ⚠ `.app__nav[hidden]{display:none}` in the phone's sheet is
          load-bearing — the rule above it is `display:flex`, which beats the
          bare `hidden` attribute. Without it this row renders permanently
          open. */}
      <nav className="app__nav app__nav--more" aria-label="Everything else" hidden={!moreVisible}>
        {SECONDARY.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`navbtn${active === t.id ? ' navbtn--on' : ''}`}
            onClick={() => goTab(t.id)}
          >
            <span className="navbtn__icon" aria-hidden="true">{t.icon}</span>
            <span className="navbtn__label">{t.label}</span>
          </button>
        ))}
      </nav>

      <nav className="app__nav" aria-label="SARA">
        {PRIMARY.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`navbtn${active === t.id ? ' navbtn--on' : ''}`}
            onClick={() => goTab(t.id)}
          >
            <span className="navbtn__icon" aria-hidden="true">{t.icon}</span>
            <span className="navbtn__label">{t.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={`navbtn${moreVisible ? ' navbtn--on' : ''}`}
          aria-expanded={moreVisible}
          onClick={() => setNavOpen((open) => !open)}
        >
          <span className="navbtn__icon" aria-hidden="true">⋯</span>
          <span className="navbtn__label">More</span>
        </button>
      </nav>

      {showClock && <ClockScreen now={now} say={displayDetail?.say} />}
      {locked && <LockScreen reason={displayDetail?.reason} now={now} />}
    </div>
  );
}

export default function App() {
  return (
    <SaraStateProvider>
      <AppShell />
    </SaraStateProvider>
  );
}
