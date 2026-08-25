import { useEffect, useMemo, useState } from 'react';
import { getPin, clearPin } from './api';
import { usePushSubscription } from './hooks/usePushSubscription';
import { useWakeLock } from './hooks/useWakeLock';
import LockScreen from './components/LockScreen';
import NotificationActionCard from './components/NotificationActionCard';
import Surface from './views/Surface';
import Capture from './views/Capture';
import Focus from './views/Focus';
import Today from './views/Today';
import Tasks from './views/Tasks';
import Chat from './views/Chat';
import MeetingPrep from './views/MeetingPrep';
import Standup from './views/Standup';
import BrainManagement from './views/BrainManagement';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
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
const TABS = [
  // The root. Everything below is reachable from here, by SARA's choice or Nick's.
  { id: 'surface', label: 'SARA', icon: '◉', Component: Surface },
  { id: 'today', label: 'Today', icon: '◐', Component: Today },
  { id: 'focus', label: 'Focus', icon: '🎯', Component: Focus },
  { id: 'tasks', label: 'Tasks', icon: '✓', Component: Tasks },
  { id: 'capture', label: 'Capture', icon: '➕', Component: Capture },
  { id: 'voice', label: 'Voice', icon: '🎙️', Component: Capture }, // jumps straight into recording
  { id: 'chat', label: 'Chat', icon: '💬', Component: Chat },
  { id: 'prep', label: 'Prep', icon: '📅', Component: MeetingPrep },
  // #26 — the standup was reachable ONLY by tapping a notification, and what
  // that opened was the retired stepper. Handles EOD too; the view picks which
  // is outstanding and shows a toggle either way.
  { id: 'standup', label: 'Ritual', icon: '📝', Component: Standup },
  { id: 'brain', label: 'Brain', icon: '🧠', Component: BrainManagement },
];

const VALID_TABS = new Set(TABS.map((tab) => tab.id));
const { resolveSaraLitePlan, resolveSaraLiteTab } = actionSurfaces;

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
  const [active, setActive] = useState(() => readLaunchIntent()?.tab || 'surface');
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
    // Landing back on the Surface puts the menu away again; it is meant to be
    // an escape hatch, not a thing that creeps back into being the navigation.
    if (tab === 'surface') setNavOpen(false);
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
    () => TABS.find((t) => t.id === active)?.Component || Surface,
    [active]
  );
  const navVisible = navOpen || active !== 'surface';

  if (runtime.deploymentIssue) return <DeploymentGuard />;

  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  return (
    <div className="app">
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

      <nav className="app__nav" aria-label="SARA sections" hidden={!navVisible}>
        {TABS.map((t) => (
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
    </div>
  );
}
