import { useEffect, useMemo, useState } from 'react';
import { getPin, clearPin } from './api';
import { usePushSubscription } from './hooks/usePushSubscription';
import LockScreen from './components/LockScreen';
import NotificationActionCard from './components/NotificationActionCard';
import Capture from './views/Capture';
import Focus from './views/Focus';
import Chat from './views/Chat';
import MeetingPrep from './views/MeetingPrep';
import BrainManagement from './views/BrainManagement';
import actionSurfaces from '../../../shared/action-surfaces.cjs';
import './App.css';

// SARA light-touch app shell.
// Five areas, nothing else — see the "NEURO & SARA — What They Are" vault note.
// The heavy command-centre lives on the kiosk/desktop SARA surfaces, not here.
const TABS = [
  { id: 'focus', label: 'Focus', icon: '🎯', Component: Focus },
  { id: 'capture', label: 'Capture', icon: '➕', Component: Capture },
  { id: 'voice', label: 'Voice', icon: '🎙️', Component: Capture }, // jumps straight into recording
  { id: 'chat', label: 'Chat', icon: '💬', Component: Chat },
  { id: 'prep', label: 'Prep', icon: '📅', Component: MeetingPrep },
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
  const [authed, setAuthed] = useState(() => !!getPin());
  const [active, setActive] = useState(() => readLaunchIntent()?.tab || 'focus');
  const [actionIntent, setActionIntent] = useState(() => readLaunchIntent());
  usePushSubscription(authed);

  useEffect(() => {
    const intent = readLaunchIntent();
    if (!intent) return;
    setActive(intent.tab);
    setActionIntent(resolveSaraLitePlan(intent).presentation === 'tab' ? null : intent);
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
        payload: data.notificationData || {},
      };
      setActive(intent.tab);
      setActionIntent(resolveSaraLitePlan(intent).presentation === 'tab' ? null : intent);
    }

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  const ActiveView = useMemo(
    () => TABS.find((t) => t.id === active)?.Component || Focus,
    [active]
  );

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">SARA</span>
        <span className="app__sub">light-touch</span>
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
            onNavigate={(tab) => setActive(tab)}
          />
        )}
        {/* key forces a fresh mount when switching Capture↔Voice so autoRecord re-fires */}
        <ActiveView
          key={active}
          autoRecord={active === 'voice'}
          onNavigate={setActive}
          onActionIntent={setActionIntent}
        />
      </main>

      <nav className="app__nav" aria-label="SARA sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`navbtn${active === t.id ? ' navbtn--on' : ''}`}
            aria-current={active === t.id ? 'page' : undefined}
            onClick={() => setActive(t.id)}
          >
            <span className="navbtn__icon" aria-hidden="true">{t.icon}</span>
            <span className="navbtn__label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
