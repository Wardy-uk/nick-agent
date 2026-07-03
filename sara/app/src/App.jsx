import { useState } from 'react';
import { getPin, clearPin } from './api';
import { usePushSubscription } from './hooks/usePushSubscription';
import LockScreen from './components/LockScreen';
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

export default function App() {
  const [authed, setAuthed] = useState(() => !!getPin());
  const [active, setActive] = useState('focus');
  usePushSubscription(authed);

  if (!authed) return <LockScreen onUnlock={() => setAuthed(true)} />;

  const ActiveView = TABS.find((t) => t.id === active).Component;

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
