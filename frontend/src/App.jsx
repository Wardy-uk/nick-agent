import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { apiUrl, getPin, setPin, clearPin } from './api';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import NudgeBanner from './components/NudgeBanner';
import ErrorBoundary from './components/ErrorBoundary';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import useCachedFetch from './useCachedFetch';
import CacheIndicator from './components/CacheIndicator';
import './App.css';

// ── Eager: the surfaces used from a standing start ───────────────────────────
//
// `Now` is the default view, Capture is where a thought lands before it is
// lost, and Ask is one keystroke from anywhere. Putting any of those behind a
// chunk fetch would mean a spinner at the exact moment the barrier to acting
// needs to be lowest — and Capture behind a network round trip is a capture
// that fails when the network does. The auth screen and the offline queue live
// in this bundle too, for the same reason.
import AdhdPanel from './components/AdhdPanel';
import CapturePanel from './components/CapturePanel';
import ChatPanel from './components/ChatPanel';
import StateOfPlay from './components/StateOfPlay';

// ── Lazy: everything else ────────────────────────────────────────────────────
//
// The production build was emitting a single chunk over Vite's 500 kB warning
// threshold, because all ~35 panels were imported eagerly to render one. These
// are all specialist screens reached deliberately from the menu, where a short
// load is unremarkable — and each one is inside the SAME `ErrorBoundary`, so a
// chunk that fails to load is caught and named exactly like a panel that throws.
const Dashboard = lazy(() => import('./components/Dashboard'));
const PeopleBoard = lazy(() => import('./components/PeopleBoard'));
const StandupEditor = lazy(() => import('./components/StandupEditor'));
const NinetyDayPlan = lazy(() => import('./components/NinetyDayPlan'));
const TodoPanel = lazy(() => import('./components/TodoPanel'));
const CalendarView = lazy(() => import('./components/CalendarView'));
const InboxPanel = lazy(() => import('./components/InboxPanel'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const QATab = lazy(() => import('./components/QATab'));
const EscalationPanel = lazy(() => import('./components/EscalationPanel'));
const ActionsPanel = lazy(() => import('./components/ActionsPanel'));
const DecisionsPanel = lazy(() => import('./components/DecisionsPanel'));
const WeeklyRiskPanel = lazy(() => import('./components/WeeklyRiskPanel'));
const ImportsPanel = lazy(() => import('./components/ImportsPanel'));
const RecentPanel = lazy(() => import('./components/RecentPanel'));
const VaultBrowser = lazy(() => import('./components/VaultBrowser'));
const BrainHealthPanel = lazy(() => import('./components/BrainHealthPanel'));
const StravaPanel = lazy(() => import('./components/StravaPanel'));
const InsightsPanel = lazy(() => import('./components/InsightsPanel'));
const StandupsPanel = lazy(() => import('./components/StandupsPanel'));
const JournalPanel = lazy(() => import('./components/JournalPanel'));
const FocusPanel = lazy(() => import('./components/FocusPanel'));
const BriefingPanel = lazy(() => import('./components/BriefingPanel'));
const PiHealthPanel = lazy(() => import('./components/PiHealthPanel'));
const NotionSyncPanel = lazy(() => import('./components/NotionSyncPanel'));
const CataloguesPanel = lazy(() => import('./components/CataloguesPanel'));
const ProfilePanel = lazy(() => import('./components/ProfilePanel'));
const HealthPanel = lazy(() => import('./components/HealthPanel'));
const MeetingPrep = lazy(() => import('./components/MeetingPrep'));

function readNueroLaunchIntent() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const filter = params.get('filter');
  // `today` is the `Now` execution surface — the default landing view. A launch
  // intent from a notification still wins, so tapping a card lands on the thing
  // that pinged him rather than on the general screen.
  if (!view) return { view: 'today', context: null };
  return {
    view,
    context: filter ? { filter } : null,
  };
}

function syncNueroLaunchIntent(view, context = null) {
  const next = new URL(window.location.href);
  next.searchParams.set('view', view);
  if (context?.filter) next.searchParams.set('filter', context.filter);
  else next.searchParams.delete('filter');
  window.history.replaceState({}, '', `${next.pathname}${next.search}${next.hash}`);
}

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

// GPS location — requested once on load, refreshed every 30 minutes
function useLocation() {
  const [location, setLocation] = React.useState(null);
  // location shape: { lat, lng, place, accuracy, timestamp }

  const requestLocation = React.useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: Date.now(),
          place: null // populated by reverse geocode below
        });
      },
      () => {}, // silently ignore denied/unavailable
      { timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  React.useEffect(() => {
    requestLocation();
    const interval = setInterval(requestLocation, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [requestLocation]);

  return location;
}

function PinLogin({ onAuthenticated }) {
  const [pin, setPinVal] = useState('');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (data.ok) {
        setPin(pin);
        onAuthenticated();
      } else {
        setError('Wrong PIN');
      }
    } catch {
      setError('Server unreachable');
    }
    setChecking(false);
  };

  return (
    <div className="pin-login">
      <div className="pin-box">
        <h2 className="pin-title">NEURO</h2>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          className="pin-input"
          placeholder="Enter PIN"
          value={pin}
          onChange={e => setPinVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          autoFocus
        />
        {error && <div className="pin-error">{error}</div>}
        <button className="pin-submit" onClick={submit} disabled={checking || !pin}>
          {checking ? 'Checking...' : 'Unlock'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Check if PIN is required and if stored PIN is valid
  useEffect(() => {
    fetch(apiUrl('/api/auth/check'), {
      headers: { 'X-Neuro-Pin': getPin() }
    })
      .then(r => r.json())
      .then(d => {
        if (!d.required || d.authenticated) setAuthed(true);
        setAuthChecked(true);
      })
      .catch(() => {
        // Server unreachable — allow through if we have a stored PIN
        if (getPin()) setAuthed(true);
        setAuthChecked(true);
      });
  }, []);

  if (!authChecked) return null; // loading
  if (!authed) return <PinLogin onAuthenticated={() => setAuthed(true)} />;

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const isMobile = window.innerWidth <= 768;
  const [activeView, setActiveView] = useState(() => readNueroLaunchIntent().view);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [vaultOpenPath, setVaultOpenPath] = useState(null);
  const [navContext, setNavContext] = useState(() => readNueroLaunchIntent().context); // context passed from Focus to drill-down views
  const [weekendOverride, setWeekendOverride] = useState(false);
  const weekend = isWeekend() && !weekendOverride;
  const location = useLocation();
  const pushState = usePushNotifications();
  const [toast, setToast] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);

  // Online/offline detection
  useEffect(() => {
    const onOnline = () => { setOnline(true); setToast({ type: 'success', text: 'Back online' }); };
    const onOffline = () => { setOnline(false); setToast({ type: 'warn', text: 'Offline — captures will queue' }); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.type === 'warn' ? 5000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Dwell check — prompt to save location if at an unknown place for 30+ min
  const [dwellPrompt, setDwellPrompt] = useState(null);
  useEffect(() => {
    if (!location) return;
    const check = () => {
      fetch(apiUrl(`/api/location/dwell-check?lat=${location.lat}&lng=${location.lng}`))
        .then(r => r.json())
        .then(d => {
          if (d.shouldPrompt && !d.knownPlace) {
            setDwellPrompt({ lat: d.lat, lng: d.lng, minutes: d.minutesAtLocation });
          } else {
            setDwellPrompt(null);
          }
        })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [location]);

  const saveDwellPlace = async (name) => {
    if (!dwellPrompt || !name.trim()) return;
    try {
      await fetch(apiUrl('/api/location/places'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), lat: dwellPrompt.lat, lng: dwellPrompt.lng })
      });
      setDwellPrompt(null);
      setToast({ type: 'success', text: `Saved "${name.trim()}"` });
    } catch {}
  };

  const statusFetch = useCachedFetch('/api/status', { interval: 30000 });

  const status = statusFetch.data;

  const worstStatus = statusFetch.status;
  const worstCacheAge = statusFetch.cacheAge || null;

  // Track tab opens
  React.useEffect(() => {
    if (!activeView) return;
    fetch(apiUrl('/api/activity/tab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: activeView })
    }).catch(() => {}); // fire and forget — never block UI
  }, [activeView]);

  const handleNavigate = (view, context = null) => {
    if (view === 'chat') {
      setChatOpen(true);
      setSidebarOpen(false);
      return; // do NOT change activeView — chat lives in aside only
    }
    setChatOpen(false); // close aside when navigating away
    setNavContext(context); // pass context to drill-down view (e.g. { filter: 'overdue' })
    setActiveView(view);
    syncNueroLaunchIntent(view, context);
    setSidebarOpen(false);
  };

  const renderView = () => {
    switch (activeView) {
      case 'state': return <StateOfPlay onNavigate={handleNavigate} />;
      case 'briefing': return <BriefingPanel onNavigate={handleNavigate} />;
      case 'focus': return <FocusPanel onNavigate={handleNavigate} />;
      case 'today': return <AdhdPanel onNavigate={handleNavigate} />;
      case 'dashboard': return <Dashboard onNavigate={handleNavigate} />;
      case 'standup': return <StandupEditor />;
      // EOD is the same screen with the end-of-day half already open. It had no
      // menu entry at all and sat behind a three-letter button in the standup
      // header — the identical hole the 'standup' entry above was added to fix.
      case 'eod': return <StandupEditor startWithEod />;
      case 'people': return <PeopleBoard />;
      case 'plan': return <NinetyDayPlan />;
      case 'todos': return <TodoPanel focusContext={navContext} onClearContext={() => setNavContext(null)} />;
      case 'calendar': return <CalendarView />;
      case 'meeting-prep': return <MeetingPrep />;
      case 'capture': return <CapturePanel />;
      case 'recent': return <RecentPanel onOpenFile={(path) => { setVaultOpenPath(path); setActiveView('vault'); }} />;
      case 'imports': return <ImportsPanel />;
      case 'strava': return <StravaPanel />;
      case 'inbox': return <InboxPanel focusContext={navContext} />;
      case 'vault': return <VaultBrowser initialOpenPath={vaultOpenPath} onClearInitialPath={() => setVaultOpenPath(null)} />;
      case 'brain-health': return <BrainHealthPanel />;
      case 'qa': return <QATab />;
      case 'escalations': return <EscalationPanel />;
      case 'actions': return <ActionsPanel onNavigate={handleNavigate} />;
      case 'decisions': return <DecisionsPanel />;
      case 'weekly-risk': return <WeeklyRiskPanel />;
      case 'journal': return <JournalPanel />;
      case 'standups': return <StandupsPanel />;
      case 'insights': return <InsightsPanel onNavigate={handleNavigate} />;
      case 'health': return <HealthPanel />;
      case 'pi-health': return <PiHealthPanel />;
      case 'notion-sync': return <NotionSyncPanel />;
      case 'catalogues': return <CataloguesPanel />;
      case 'about-me': return <ProfilePanel />;
      case 'admin': return <AdminPanel pushState={pushState} />;
      // An unknown view lands on the execution surface, not on the briefing.
      default: return <AdhdPanel onNavigate={handleNavigate} />;
    }
  };

  return (
    <div className="app-layout">
      <Topbar status={status} onMenuToggle={() => setSidebarOpen(o => !o)} onChatToggle={() => setChatOpen(o => !o)} chatOpen={chatOpen} weekend={weekend} onWeekendOverride={() => setWeekendOverride(o => !o)} weekendOverride={weekendOverride}>
        <CacheIndicator status={worstStatus} cacheAge={worstCacheAge} />
      </Topbar>
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="app-body">
        <Sidebar activeView={activeView} onNavigate={handleNavigate} open={sidebarOpen} />
        <main className="main-panel">
          {/* ⚠ Inside the shell, not around it: the sidebar and chat must keep
              working when a view throws. Before this, one panel crashing
              unmounted the whole root and every menu went dead — which is how a
              single stale field in StateOfPlay read as "a number of menus fail
              to open". `viewKey` clears the boundary on navigation, so a bad
              screen never latches the good ones shut. */}
          <ErrorBoundary viewKey={activeView}>
            {/* Suspense INSIDE the boundary, so a chunk that fails to download
                is caught and named by the same mechanism that catches a panel
                throwing — a lazy panel must not be able to take the shell down
                any more than an eager one can. */}
            <Suspense fallback={<div className="app-view-loading">Loading&hellip;</div>}>
              {renderView()}
            </Suspense>
          </ErrorBoundary>
        </main>
        <aside className={`chat-panel ${chatOpen ? 'chat-open' : ''}`}>
          <ChatPanel location={location} />
        </aside>
      </div>
      <NudgeBanner onGoToStandup={() => { setActiveView('standup'); setSidebarOpen(false); }} onGoToTodos={() => { setActiveView('todos'); setSidebarOpen(false); }} onGoToJournal={() => { setActiveView('journal'); setSidebarOpen(false); }} onGoToPeople={() => { setActiveView('people'); setSidebarOpen(false); }} onGoToBriefing={() => { setActiveView('briefing'); setSidebarOpen(false); }} onGoToInbox={() => { setActiveView('inbox'); setSidebarOpen(false); }} />
      <InstallBanner />
      {/* Mobile bottom nav */}
      <nav className={`mobile-bottom-nav ${chatOpen ? 'chat-active-hide' : ''}`}>
        {/* Matches the sidebar's primary group: Now first, on both. Two navs
            disagreeing about what the main screen is was how "Today" ended up
            being the view nobody opened. */}
        <button className={activeView === 'today' ? 'active' : ''} onClick={() => handleNavigate('today')}>
          <span className="bottom-nav-icon">&#x25D0;</span>
          <span>Now</span>
        </button>
        <button className={chatOpen ? 'active' : ''} onClick={() => handleNavigate('chat')}>
          <span className="bottom-nav-icon">&#x203A;</span>
          <span>Ask</span>
        </button>
        <button className={activeView === 'capture' ? 'active' : ''} onClick={() => handleNavigate('capture')}>
          <span className="bottom-nav-icon">+</span>
          <span>Capture</span>
        </button>
        {/* On mobile the sidebar is behind a hamburger, so an approval queue
            that only lives there is two taps and a memory away. The count is on
            the sidebar entry; this is the route to it. */}
        <button className={activeView === 'actions' ? 'active' : ''} onClick={() => handleNavigate('actions')}>
          <span className="bottom-nav-icon">&#x2713;</span>
          <span>Actions</span>
        </button>
      </nav>
      {/* Dwell prompt — save this location? */}
      {dwellPrompt && (
        <div className="app-dwell-prompt">
          <span>You've been here {dwellPrompt.minutes} min. Save this location?</span>
          <div className="dwell-prompt-btns">
            {['Work', 'Home', 'Gym', 'Other'].map(name => (
              <button key={name} onClick={() => {
                if (name === 'Other') {
                  const custom = window.prompt('Name this location:');
                  if (custom) saveDwellPlace(custom);
                } else {
                  saveDwellPlace(name);
                }
              }}>{name}</button>
            ))}
            <button onClick={() => setDwellPrompt(null)} className="dwell-dismiss">Not now</button>
          </div>
        </div>
      )}
      {/* Toast notifications */}
      {toast && (
        <div className={`app-toast app-toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
      {/* Offline indicator */}
      {!online && (
        <div className="app-offline-bar">Offline</div>
      )}
    </div>
  );
}
