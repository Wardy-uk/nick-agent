import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl, getPin, setPin, clearPin } from './api';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import PeopleBoard from './components/PeopleBoard';
import StandupEditor from './components/StandupEditor';
import NinetyDayPlan from './components/NinetyDayPlan';
import TodoPanel from './components/TodoPanel';
import CalendarView from './components/CalendarView';
import InboxPanel from './components/InboxPanel';
import AdminPanel from './components/AdminPanel';
import NudgeBanner from './components/NudgeBanner';
import ChatPanel from './components/ChatPanel';
import QATab from './components/QATab';
import ImportsPanel from './components/ImportsPanel';
import CapturePanel from './components/CapturePanel';
import RecentPanel from './components/RecentPanel';
import VaultBrowser from './components/VaultBrowser';
import StravaPanel from './components/StravaPanel';
import InsightsPanel from './components/InsightsPanel';
import StandupsPanel from './components/StandupsPanel';
import JournalPanel from './components/JournalPanel';
import FocusPanel from './components/FocusPanel';
import BriefingPanel from './components/BriefingPanel';
import PiHealthPanel from './components/PiHealthPanel';
import MeetingPrep from './components/MeetingPrep';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import useCachedFetch from './useCachedFetch';
import CacheIndicator from './components/CacheIndicator';
import './App.css';

function readNueroLaunchIntent() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const filter = params.get('filter');
  if (!view) return { view: 'briefing', context: null };
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
      case 'briefing': return <BriefingPanel onNavigate={handleNavigate} />;
      case 'focus': return <FocusPanel onNavigate={handleNavigate} />;
      case 'dashboard': return <Dashboard onNavigate={handleNavigate} />;
      case 'standup': return <StandupEditor />;
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
      case 'qa': return <QATab />;
      case 'journal': return <JournalPanel />;
      case 'standups': return <StandupsPanel />;
      case 'insights': return <InsightsPanel onNavigate={handleNavigate} />;
      case 'pi-health': return <PiHealthPanel />;
      case 'admin': return <AdminPanel pushState={pushState} />;
      default: return <BriefingPanel onNavigate={handleNavigate} />;
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
          {renderView()}
        </main>
        <aside className={`chat-panel ${chatOpen ? 'chat-open' : ''}`}>
          <ChatPanel location={location} />
        </aside>
      </div>
      <NudgeBanner onGoToStandup={() => { setActiveView('standup'); setSidebarOpen(false); }} onGoToTodos={() => { setActiveView('todos'); setSidebarOpen(false); }} onGoToJournal={() => { setActiveView('journal'); setSidebarOpen(false); }} onGoToPeople={() => { setActiveView('people'); setSidebarOpen(false); }} />
      <InstallBanner />
      {/* Mobile bottom nav */}
      <nav className={`mobile-bottom-nav ${chatOpen ? 'chat-active-hide' : ''}`}>
        <button className={activeView === 'briefing' ? 'active' : ''} onClick={() => handleNavigate('briefing')}>
          <span className="bottom-nav-icon">&#x25C9;</span>
          <span>Briefing</span>
        </button>
        <button className={chatOpen ? 'active' : ''} onClick={() => handleNavigate('chat')}>
          <span className="bottom-nav-icon">&#x203A;</span>
          <span>Ask</span>
        </button>
        <button className={activeView === 'capture' ? 'active' : ''} onClick={() => handleNavigate('capture')}>
          <span className="bottom-nav-icon">+</span>
          <span>Capture</span>
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
