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

  // ── Whole-stack AI health ──
  // The indicator used to watch Ollama only, so a dead cloud provider or a
  // six-week-dead Pi 4 worker showed nothing: answers just quietly got worse.
  // This widens it to every tier and leads on who is ACTUALLY serving calls.
  const aiHealth = ai.health || {};
  const byProvider = aiHealth.byProvider || {};
  const aiIssues = [];

  // Whoever served the most calls in the window is the honest "current" provider,
  // regardless of what the configured priority order claims.
  const dominant = Object.entries(byProvider)
    .filter(([name]) => name !== 'none')
    .sort((a, b) => b[1].calls - a[1].calls)[0];
  const servingLabel = dominant ? dominant[0] : (ollamaOk ? 'idle' : 'offline');

  if (!ollamaOk) aiIssues.push('Ollama unreachable');
  else if (ollamaQueue > 2) aiIssues.push(`Ollama queue ${ollamaQueue}`);

  if (ai.pi4Worker?.enabled && ai.pi4Worker?.lastHealthy !== true) {
    // null = never checked, which is not the same as healthy.
    aiIssues.push(ai.pi4Worker.lastHealthy == null ? 'Pi 4 worker unverified' : 'Pi 4 worker unreachable');
  }
  if (openrouterThrottled) aiIssues.push('OpenRouter throttled (daily limit)');

  // A configured cloud provider serving nothing is the silent-degradation case.
  if (ai.anthropic?.configured && ai.anthropic?.enabled && aiHealth.calls > 5 && !byProvider.anthropic) {
    aiIssues.push('Anthropic configured but serving 0 calls');
  }
  for (const [provider, err] of Object.entries(aiHealth.errors || {})) {
    if (err.errorClass === 'auth') aiIssues.push(`${provider}: auth failed`);
    else if (err.errorClass === 'rate_limit') aiIssues.push(`${provider}: rate limited`);
  }
  if (aiHealth.fallbackRate >= 30) aiIssues.push(`${aiHealth.fallbackRate}% falling back`);
  if (aiHealth.failureRate >= 20) aiIssues.push(`${aiHealth.failureRate}% failing`);

  const aiLevel = (!ollamaOk && !openrouterEnabled && !ai.anthropic?.configured) ? 'dead'
    : aiIssues.some(i => /unreachable|auth failed|failing/.test(i)) ? 'red'
    : aiIssues.length ? 'amber'
    : 'green';

  const aiTitle = aiIssues.length
    ? `AI: ${aiIssues.join(' · ')}`
    : `AI healthy — serving via ${servingLabel}${aiHealth.calls ? ` (${aiHealth.calls} recent calls)` : ''}`;

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
        <div className="topbar-indicator" title={aiTitle}>
          <span className={`status-dot ollama-${aiLevel}`} />
          <span className="topbar-label">
            AI
            <span className="topbar-sublabel">{servingLabel}</span>
            {aiIssues.length > 0 && <span className="topbar-issue-count">{aiIssues.length}</span>}
          </span>
        </div>
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
