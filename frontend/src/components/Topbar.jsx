import React from 'react';
import { apiUrl } from '../api';
import './Topbar.css';

function QuickAdd({ apiUrl: apiUrlFn }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [flash, setFlash] = React.useState(null); // 'ok' | 'err'
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setText(''); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrlFn('/api/capture/note'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed })
      });
      if (res.ok) {
        setText('');
        setFlash('ok');
        setTimeout(() => { setFlash(null); setOpen(false); }, 800);
      } else {
        setFlash('err');
        setTimeout(() => setFlash(null), 2000);
      }
    } catch {
      // Offline — store in localStorage queue
      try {
        const QUEUE_KEY = 'neuro_offline_queue';
        const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        q.push({
          url: apiUrlFn('/api/capture/note'),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: trimmed }),
          queuedAt: Date.now()
        });
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
        setText('');
        setFlash('ok');
        setTimeout(() => { setFlash(null); setOpen(false); }, 800);
      } catch {
        setFlash('err');
        setTimeout(() => setFlash(null), 2000);
      }
    }
    setSaving(false);
  };

  return (
    <div className="quickadd-wrapper">
      {open ? (
        <div className="quickadd-form">
          <input
            ref={inputRef}
            className="quickadd-input"
            type="text"
            placeholder="Quick note... (Enter to save)"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && text.trim()) submit();
              if (e.key === 'Escape') { setOpen(false); setText(''); }
            }}
            disabled={saving}
          />
          <button
            className={`quickadd-save ${flash === 'ok' ? 'ok' : flash === 'err' ? 'err' : ''}`}
            onClick={submit}
            disabled={saving || !text.trim()}
          >
            {flash === 'ok' ? '✓' : flash === 'err' ? '!' : saving ? '…' : '↵'}
          </button>
          <button className="quickadd-close" onClick={() => { setOpen(false); setText(''); }}>
            ✕
          </button>
        </div>
      ) : (
        <button className="quickadd-btn" onClick={() => setOpen(true)} title="Quick capture (note)">
          +
        </button>
      )}
    </div>
  );
}

export default function Topbar({ status, onMenuToggle, onChatToggle, chatOpen, weekend, onWeekendOverride, weekendOverride, children }) {
  const itIsWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

  // AI provider status
  const ai = status?.ai || {};
  const ollamaOk = status?.ollamaReachable;
  const ollamaQueue = ai.ollama?.queueDepth || 0;
  const ollamaInUse = ai.ollama?.inUse;
  const openrouterEnabled = ai.openrouter?.enabled && ai.openrouter?.configured;
  const openrouterThrottled = ai.openrouter?.throttled;

  // Ollama health: green=idle/ok, amber=busy/queued, red=overloaded, grey=dead
  const ollamaHealth = !ollamaOk ? 'dead' :
    ollamaQueue > 2 ? 'red' :
    ollamaInUse || ollamaQueue > 0 ? 'amber' : 'green';

  // Chat provider label
  const chatProvider = openrouterEnabled && !openrouterThrottled ? 'OpenRouter' :
    ollamaOk ? 'Ollama' : 'Offline';
  const chatOk = chatProvider !== 'Offline';

  const statusDot = (ok) => (
    <span className={`status-dot ${ok ? 'ok' : 'warn'}`} />
  );

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="topbar-menu-btn" onClick={onMenuToggle} aria-label="Menu">
          <span /><span /><span />
        </button>
        <span className="topbar-logo">NUERO</span>
        <span className="topbar-version">v1.0</span>
      </div>
      <div className="topbar-center">
        {weekend && (
          <button className="topbar-weekend-badge" onClick={onWeekendOverride} title="Weekend mode active — click to switch to work mode">
            🌿 Weekend
          </button>
        )}
        {!weekend && itIsWeekend && weekendOverride && (
          <button className="topbar-weekend-badge work-override" onClick={onWeekendOverride} title="Work mode override active — click to return to weekend mode">
            💼 Work mode
          </button>
        )}
        <div className="topbar-indicator">
          <span className={`status-dot ollama-${ollamaHealth}`} title={`Ollama: ${ollamaHealth}${ollamaQueue > 0 ? ` (${ollamaQueue} queued)` : ''}`} />
          <span className="topbar-label">Ollama</span>
        </div>
        {chatProvider !== 'Ollama' && (
          <div className="topbar-indicator">
            {statusDot(chatOk)}
            <span className="topbar-label">{chatProvider}</span>
          </div>
        )}
        <div className="topbar-indicator">
          {statusDot(status?.obsidian?.configured)}
          <span className="topbar-label">Vault</span>
        </div>
        <div className="topbar-indicator">
          {statusDot(status?.microsoft?.authenticated || status?.microsoft?.bridgeConnected)}
          <span className="topbar-label">Microsoft{
            status?.microsoft?.authenticated ? '' :
            status?.microsoft?.bridgeConnected ? ' (via NOVA)' :
            status?.microsoft?.bridgeConfigured ? ' (bridge offline)' :
            status?.microsoft?.configured ? ' (not signed in)' :
            ' (not configured)'
          }</span>
        </div>
      </div>
      <div className="topbar-right">
        {children}
        <QuickAdd apiUrl={apiUrl} />
        {atRisk > 0 && (
          <div className="topbar-alert">
            <span className="alert-count">{atRisk}</span>
            <span className="alert-label">SLA at risk</span>
          </div>
        )}
        <button className="topbar-reload-btn" onClick={() => window.location.reload()} aria-label="Reload" title="Reload app">
          ↻
        </button>
        <button className="topbar-chat-btn" onClick={onChatToggle} aria-label="Toggle chat">
          {chatOpen ? '✕' : 'Chat'}
        </button>
      </div>
    </header>
  );
}
