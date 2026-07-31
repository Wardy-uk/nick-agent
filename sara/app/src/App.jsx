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

function normalisePath(value) {
  if (!value) return '/';
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname || '/';
  } catch {
    return String(value).trim() || '/';
  }
}

function resolveNotificationTab({ tab, url, type } = {}) {
  if (tab && VALID_TABS.has(tab)) return tab;

  const pathname = normalisePath(url).toLowerCase();
  const kind = String(type || '').trim().toLowerCase();

  if (pathname.startsWith('/meeting') || pathname.startsWith('/calendar')) return 'prep';
  if (pathname.startsWith('/imports') || pathname.startsWith('/vault') || pathname.startsWith('/insights') || pathname.startsWith('/journal')) return 'brain';
  if (pathname.startsWith('/capture')) return 'capture';
  if (pathname.startsWith('/chat')) return 'chat';
  if (pathname.startsWith('/queue') || pathname.startsWith('/todos') || pathname.startsWith('/standup') || pathname.startsWith('/plan') || pathname.startsWith('/people')) return 'focus';

  if (['brief', 'escalation', 'standup', 'todo', 'eod', 'plan_milestone', '121', 'weekly_review'].includes(kind)) return 'focus';
  if (['meeting', 'meeting_prep', 'calendar'].includes(kind)) return 'prep';
  if (['plaud', 'journal', 'vault_hygiene', 'knowledge_reflection', 'sweep_complete'].includes(kind)) return 'brain';

  return 'focus';
}

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
    tab: resolveNotificationTab({ tab, type: type || raw.type, url: url || raw.url }),
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
  const [launchNotice, setLaunchNotice] = useState(() => readLaunchIntent());
  usePushSubscription(authed);

  useEffect(() => {
    const intent = readLaunchIntent();
    if (!intent) return;
    setActive(intent.tab);
    setLaunchNotice(intent);
    clearLaunchIntentFromUrl();
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    function onMessage(event) {
      const data = event.data || {};
      if (data?.type !== 'sara-notification-open') return;
      const intent = {
        source: 'notification',
        tab: resolveNotificationTab(data),
        type: data.notificationType || null,
        url: data.notificationUrl || null,
        title: data.notificationTitle || null,
        payload: data.notificationData || {},
      };
      setActive(intent.tab);
      setLaunchNotice(intent);
    }

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!launchNotice) return undefined;
    const id = window.setTimeout(() => setLaunchNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [launchNotice]);

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
        {launchNotice && (
          <NotificationActionCard
            intent={launchNotice}
            onDismiss={() => setLaunchNotice(null)}
            onNavigate={(tab) => setActive(tab)}
          />
        )}
        {/* key forces a fresh mount when switching Capture↔Voice so autoRecord re-fires */}
        <ActiveView key={active} autoRecord={active === 'voice'} />
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
