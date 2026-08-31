import { SaraStateProvider, useSaraState } from './state/saraState';
import { useDisplayState } from './state/useDisplayState';
import { SARA_VIEWS, normalizeViewId } from './state/views';
import ViewSwitcher from './components/ViewSwitcher';
import ViewRouter from './components/ViewRouter';
import ExitButton from './components/ExitButton';
import LockScreen from './components/LockScreen';
import ClockScreen from './components/ClockScreen';
import ConnectionStatus from './components/ConnectionStatus';

// SARA app shell (WS2-WP1; inference strip WS5-WP1; Exit + auto-lock WS2-WP2/WP3).
//
// The shell provides the shared-state context for every screen, the manual view switcher
// (proof of the many-views architecture), SARA's advisory context inference, an Exit
// control, and a privacy auto-lock. The lock + clock live in an inner component so they
// can read the shared clock from context; the provider itself wraps everything.
function AppShell() {
  const { now, currentView } = useSaraState();
  // Fast watch-driven lock: poll 2s, lock on the first away report. The presence
  // service already does noise-smoothing (7/10 over ~5s), so a second streak layer
  // here would only add latency — awayStreak:1 keeps end-to-end lock ~5-6s.
  // Watch-presence is the primary lock trigger; idle is a long safety-net (15 min) so a
  // glance-display doesn't keep locking itself while you're nearby.
  // ⚠ The kiosk no longer decides when to hide itself. `usePresenceLock` did,
  // and it had two faults that only showed on the wall: unlock was MANUAL, so
  // Nick came home from an evening out to a locked screen that had to be
  // tapped; and it locked on IDLE, which measures the wrong thing entirely for
  // a display that is looked at rather than touched. Neither was in his spec:
  // watch here -> SARA, watch elsewhere -> clock, out of the house -> off.
  //
  // NEURO composes the verdict now, so this screen, the phone and the widget
  // cannot each invent their own idea of what a missing watch means.
  const { state: displayState, detail: displayDetail } = useDisplayState();
  const locked = displayState === 'locked';
  const showClock = displayState === 'clock';

  // Some views are full-bleed: they draw their OWN nav, header and footer, so the shell
  // hides its chrome (ViewSwitcher + SARA-thinks strip) to avoid doubling up. The Briefing
  // (JARVIS) and the Cognition Environment are both full-bleed. Every other view keeps the
  // shared shell chrome.
  const view = normalizeViewId(currentView);
  const fullBleed = view === SARA_VIEWS.BRIEFING || view === SARA_VIEWS.COGNITION;
  // The Cognition Environment owns its own bottom bar and presence affordances, so the
  // shell's floating lock/power column would collide with it. Auto-lock still runs (the
  // hook + lock overlay are unconditional), so only the manual buttons are hidden there.
  const showFloatingSys = view === SARA_VIEWS.BRIEFING;

  // ⚠ The pause and manual-lock buttons went with the self-deciding lock. Both
  // controlled a thing that no longer exists here: there is no auto-lock timer
  // to pause, and "lock now" would be overruled by the next poll four seconds
  // later, which is worse than no button at all. Locking is NEURO's decision
  // and the backlight's job. ExitButton stays — leaving the kiosk is a real
  // thing a person at this screen may want to do.
  const sysControls = (
    <div className="app__sys">
      <ExitButton />
    </div>
  );

  if (fullBleed) {
    return (
      <div className="app app--bleed">
        {/* JARVIS view fills everything and owns its own nav/header/footer. The shell
            still provides the global lock/power controls (fixed) and the lock overlay. */}
        {/* Even a full-bleed view that owns its own chrome must carry the provenance
            banner: "this is demo data" and "nothing here is current" are not chrome. */}
        <div className="app__connstatus app__connstatus--pinned">
          <ConnectionStatus />
        </div>
        <main className="app__bleed-view">
          <ViewRouter />
        </main>
        {showFloatingSys && <div className="app__sys app__sys--floating">{sysControls.props.children}</div>}
        {showClock && <ClockScreen now={now} say={displayDetail?.say} />}
        {locked && <LockScreen reason={displayDetail?.reason} now={now} />}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app__main">
        <div className="app__nav">
          <ViewSwitcher />
          {sysControls}
        </div>
        <main className="app__view">
          <div className="app__connstatus">
            <ConnectionStatus />
          </div>
          <ViewRouter />
        </main>
      </div>
      {/* ⚠ The "SARA thinks" strip was REMOVED on 30 Aug 2026 (Gate 2).
          It rendered `model.inference` — the retired inference layer — as a
          persistent overlay, so the kiosk carried TWO accounts of Nick's state
          at once. Caught on the panel: it read "You're set up for focused work
          — Suggested view: Focus, High 0.75" directly beneath NEURO saying
          "Not a working day. It's the weekend."

          Consumers render NEURO's attention decision; they do not independently
          rerank work, invent urgency, or phrase the same state differently.
          An advisory "suggested view" is also a menu, which is the one thing
          SARA is not. */}
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
