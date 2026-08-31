import { useEffect, useMemo, useState } from 'react';
import { getPin, clearPin, apiFetch } from './api';
import { usePushSubscription } from './hooks/usePushSubscription';
import { useWakeLock } from './hooks/useWakeLock';
import LockScreen from './components/LockScreen';
import NotificationActionCard from './components/NotificationActionCard';
import { startAutoFlush } from './mobile/outbox';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
import Field from '../../shared-ui/Field';
import { useFieldDrive } from '../../shared-ui/useFieldDrive';
import { PRIMARY, SECONDARY, TABS, VALID_TABS, DEFAULT_TAB, revealsSecondary } from '../../shared-ui/tabs';
import DeploymentGuard from './components/DeploymentGuard';
import { readRuntime } from './runtime';
import './App.css';

// SARA mobile app shell.
//
// SARA is the J.A.R.V.I.S. layer — voice, ears and eyes — and should NOT be a
// menu (Nick, 25 Aug 2026). So the tab strip is no longer how you navigate: the
// default and root view is Surface, which renders GET /api/attention and shows
// the ONE thing the brain decided is worth his attention, in the context it
// decided it in. The views below are still all here, but they are places the
// brain routes TO, not a list to go shopping in.
//
// ⚠ The strip is HIDDEN, not deleted, and "Show me everything" reveals it. Nick's
// failure mode is avoidance, and a thing he cannot find is worse than a menu he
// does not need — an ambient surface that is sometimes wrong must always have a
// way round it, or being wrong once costs the whole feature.
// ── Phase 2: three primary modes ─────────────────────────────────────────────
//
// Neuro Mobile is the app Nick opens; SARA is the layer that comes to him. So
// this app has exactly THREE primary modes, always on screen:
//
//   Capture — get it out of his head immediately, online or off
//   Now     — one current action and the next transition, sourced and stamped
//   Review  — morning orientation, shutdown, weekly reset
//
// ⚠ Everything else is SECONDARY, not deleted — including the SARA Surface,
// which remains what notifications route to and is one tap away. The "a thing
// he cannot find is worse than a menu he does not need" rule from 25 Aug is
// unchanged; the strip below just no longer leads with ten equal choices.
// Retrieval (Chat, Brain) stays available and deliberately does not compete
// with the three above for the primary row.
// ⚠ THE SCREEN SET MOVED to `sara/shared-ui/tabs.jsx` (31 Aug 2026), where the
// Pi kiosk mounts the SAME list. Nick: "make the Pi version of SARA the same as
// the phone app." Two registries over two backends was the drift that
// `AttentionSurface` and `voiceUtils` each had to be undone from, one level up;
// there is one now. The three primary modes, the rule that everything else is
// secondary rather than deleted, and what each screen is FOR are all documented
// there.

const { resolveSaraLitePlan, resolveSaraLiteTab } = actionSurfaces;

// Module scope so the hook's effect is not re-created on every render.
const fetchAttentionForField = () => apiFetch('/api/attention');

function readLaunchIntent() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  const tab = params.get('tab');
  const type = params.get('type');
  const url = params.get('url');
  const title = params.get('title');
  const body = params.get('body');
  const payload = params.get('payload');

  if (source !== 'notification' && !tab && !type && !url && !payload) return null;

  let raw = {};
  if (payload) {
    try {
      raw = JSON.parse(payload);
    } catch {
      raw = {};
    }
  }

  return {
    source: source || 'notification',
    tab: VALID_TABS.has(tab) ? tab : resolveSaraLiteTab({ tab, type: type || raw.type, url: url || raw.url, payload: raw }),
    type: type || raw.type || null,
    url: url || raw.url || null,
    title: title || raw.title || null,
    body: body || raw.body || null,
    payload: raw,
  };
}

function clearLaunchIntentFromUrl() {
  if (typeof window === 'undefined') return;
  const next = new URL(window.location.href);
  next.searchParams.delete('source');
  next.searchParams.delete('tab');
  next.searchParams.delete('type');
  next.searchParams.delete('url');
  next.searchParams.delete('title');
  next.searchParams.delete('payload');
  window.history.replaceState({}, '', `${next.pathname}${next.search}${next.hash}`);
}

export default function App() {
  const runtime = readRuntime();
  const [authed, setAuthed] = useState(() => !!getPin());
  // ⚠ SARA is the default screen, always (Nick, 30 Aug 2026). Phase 2 opened on
  // `Now`, and that was wrong: opening on a list makes this an app you read,
  // when the whole point is that SARA is PRESENT and comes to him. Her field —
  // the substrate she is visible in — is the first thing on screen.
  //
  // A launch INTENT still wins, and must: tapping a notification has to land on
  // the thing that pinged him, not on the home screen. This is only the default
  // when he opened the app himself.
  const [active, setActive] = useState(() => readLaunchIntent()?.tab || DEFAULT_TAB);
  // The strip is revealed on request, and stays revealed while Nick is off the
  // Surface — otherwise the one screen with no menu is also the only way back.
  const [navOpen, setNavOpen] = useState(false);
  // What SARA said when she pinged him, carried onto the Surface so tapping a
  // notification lands somewhere that acknowledges WHY he is there. Without it
  // the push and the screen are two unconnected events.
  const [arrivedFrom, setArrivedFrom] = useState(null);
  const [actionIntent, setActionIntent] = useState(() => readLaunchIntent());
  // Which ritual a notification meant, when it routed straight to a tab. The
  // resolved TAB is the same for standup and EOD ('standup'), so without this
  // the kind is dropped and a 5pm EOD nudge opens the morning standup. Cleared
  // on any manual navigation so it can't go stale behind a tab switch.
  const [intentKind, setIntentKind] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  usePushSubscription(authed);
  const wakeLock = useWakeLock(authed);

  // Drain the outbox on the foreground triggers iOS actually gives us: launch,
  // returning to the app, coming back online. Deliberately NOT Background Sync
  // — Safari does not implement it, and a queue Nick believes is draining in his
  // pocket is worse than one he knows he has to open the app for.
  useEffect(() => {
    if (!authed) return undefined;
    return startAutoFlush();
  }, [authed]);

  useEffect(() => {
    const intent = readLaunchIntent();
    if (!intent) return;
    const plan = resolveSaraLitePlan(intent);
    setActive(intent.tab);
    setIntentKind(plan.presentation === 'tab' ? plan.kind : null);
    setActionIntent(plan.presentation === 'tab' ? null : intent);
    if (intent.tab === 'surface') setArrivedFrom({ title: intent.title, body: intent.body });
    clearLaunchIntentFromUrl();
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    function onMessage(event) {
      const data = event.data || {};
      if (data?.type !== 'sara-notification-open') return;
      const tab = VALID_TABS.has(data.tab) ? data.tab : resolveSaraLiteTab(data);
      const intent = {
        source: 'notification',
        tab,
        type: data.notificationType || null,
        url: data.notificationUrl || null,
        title: data.notificationTitle || null,
        body: data.notificationBody || null,
        payload: data.notificationData || {},
      };
      const plan = resolveSaraLitePlan(intent);
      setActive(intent.tab);
      setIntentKind(plan.presentation === 'tab' ? plan.kind : null);
      setActionIntent(plan.presentation === 'tab' ? null : intent);
      if (intent.tab === 'surface') setArrivedFrom({ title: intent.title, body: intent.body });
    }

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // Any navigation that did not come from a notification drops the remembered
  // kind — a 5pm EOD nudge must not still be steering the Ritual tab tomorrow.
  function goTab(tab) {
    setActive(tab);
    setIntentKind(null);
    setArrivedFrom(null);
    // Landing on a primary mode puts the extra row away again; it is meant to be
    // an escape hatch, not a thing that creeps back into being the navigation.
    if (PRIMARY.some((t) => t.id === tab)) setNavOpen(false);
  }

  async function refreshApp() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.update().catch(() => {})));
      }
    } finally {
      window.location.reload();
    }
  }

  // Must sit above the early returns — unlocking flips `authed` and any hook
  // below a conditional return changes the hook count between renders, which
  // React rejects outright ("rendered more hooks than during the previous render").
  const ActiveView = useMemo(
    // Falls back to the default tab's component rather than a named import, so
    // the registry stays the only place that knows what a screen IS.
    () => TABS.find((t) => t.id === active)?.Component
      || TABS.find((t) => t.id === DEFAULT_TAB)?.Component,
    [active]
  );
  // The primary row is ALWAYS visible — three modes is navigation, not a menu.
  // The secondary row is revealed on request, and stays revealed while Nick is
  // on one of its screens, or the way back is only through the way he came.
  // ⚠ Her substrate is now DRIVEN on every screen, not hardcoded. Skipped on
  // the Surface, which has a live read of its own and mounts its own field.
  const fieldDrive = useFieldDrive(fetchAttentionForField, active !== 'surface');

  const isSecondary = revealsSecondary(active);
  const moreVisible = navOpen || isSecondary;

  if (runtime.deploymentIssue) return <DeploymentGuard />;

  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  return (
    <div className="app">
      {/* ⚠ SARA's substrate is present on EVERY screen (Nick, 31 Aug 2026), not
          only on her own. It sits behind the whole shell rather than being
          re-mounted per view, so switching tabs does not tear the field down
          and rebuild it — the substrate would flicker on every tap.

          It is driven `quiet`: dim and near-still. That is deliberate and it is
          the honesty rule, not a look. The field's whole claim is that the
          coherence on screen is the coherence of the READ, and the shell reads
          nothing — only the Surface polls `/api/attention`. A confident settle
          out here would be the field asserting a read that never happened.

          Hence it is also SUPPRESSED on the Surface, which mounts its own,
          driven by the real payload. Two stacked fields would double the
          substrate and put a dishonest one under an honest one. */}
      {active !== 'surface' && (
        <div className="app__field" aria-hidden="true"><Field {...fieldDrive} /></div>
      )}
      <header className="app__header">
        <span className="app__brand">SARA</span>
        <span className="app__sub">mobile</span>
        {runtime.buildLabel && <span className="app__build">{runtime.buildLabel}</span>}
        <button
          className="app__refresh"
          type="button"
          onClick={refreshApp}
          aria-label="Refresh SARA mobile"
          title="Refresh SARA mobile"
          disabled={refreshing}
        >{refreshing ? '…' : '↻'}</button>
        {wakeLock.supported && (
          <button
            className={`app__wake${wakeLock.enabled ? ' app__wake--on' : ''}`}
            type="button"
            onClick={wakeLock.toggle}
            aria-pressed={wakeLock.enabled}
            aria-label={wakeLock.enabled ? 'Let the screen sleep' : 'Keep the screen awake'}
            title={wakeLock.enabled
              ? (wakeLock.held ? 'Screen held awake' : 'Stay awake — tap the screen to arm')
              : 'Keep the screen awake'}
          >{wakeLock.enabled && !wakeLock.held ? '◐' : '☀'}</button>
        )}
        <button
          className="app__lock"
          type="button"
          onClick={() => { clearPin(); setAuthed(false); }}
          aria-label="Lock / change PIN"
          title="Lock / change PIN"
        >🔒</button>
      </header>

      <main className="app__view">
        {actionIntent && (
          <NotificationActionCard
            intent={actionIntent}
            onDismiss={() => setActionIntent(null)}
            onNavigate={goTab}
          />
        )}
        {/* key forces a fresh mount when switching Capture↔Voice so autoRecord
            re-fires — and on intentKind so an EOD nudge tapped while already
            sitting on the Ritual tab re-opens it as EOD instead of being
            ignored by the view's mount-time default. */}
        <ActiveView
          key={`${active}:${intentKind || ''}`}
          autoRecord={active === 'voice'}
          intentKind={intentKind}
          onNavigate={goTab}
          onActionIntent={setActionIntent}
          onShowAll={() => setNavOpen(true)}
          arrivedFrom={arrivedFrom}
          onClearArrival={() => setArrivedFrom(null)}
        />
      </main>

      {/* ⚠ `.app__nav[hidden]{display:none}` is load-bearing — the rule above it
          is display:flex, which beats the bare `hidden` attribute. Without it
          the secondary row renders permanently open. */}
      <nav className="app__nav app__nav--more" aria-label="Everything else" hidden={!moreVisible}>
        {SECONDARY.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`navbtn${active === t.id ? ' navbtn--on' : ''}`}
            aria-current={active === t.id ? 'page' : undefined}
            onClick={() => goTab(t.id)}
          >
            <span className="navbtn__icon" aria-hidden="true">{t.icon}</span>
            <span className="navbtn__label">{t.label}</span>
          </button>
        ))}
      </nav>

      <nav className="app__nav" aria-label="Neuro Mobile">
        {PRIMARY.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`navbtn${active === t.id ? ' navbtn--on' : ''}`}
            aria-current={active === t.id ? 'page' : undefined}
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
    </div>
  );
}
