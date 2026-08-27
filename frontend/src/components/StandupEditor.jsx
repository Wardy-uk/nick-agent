import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import ReactMarkdown from 'react-markdown';
import StandupSession from './StandupSession';
import './StandupEditor.css';

function EodCapture({ onDone }) {
  const [win, setWin] = React.useState('');
  const [didntGo, setDidntGo] = React.useState('');
  const [feeling, setFeeling] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const handleSave = async () => {
    if (!win.trim() && !didntGo.trim() && !feeling.trim()) { setMessage('Fill in at least one field'); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/eod'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ win: win.trim() || null, didntGo: didntGo.trim() || null, feeling: feeling.trim() || null })
      });
      if (res.ok) { setMessage('Saved to daily note ✓'); setTimeout(() => { if (onDone) onDone(); }, 1500); }
      else setMessage('Save failed');
    } catch { setMessage('Save failed'); }
    setSaving(false);
  };
  return (
    <div className="backup-standup">
      <h3>End of Day — Quick</h3>
      <p style={{ color: '#888', fontSize: '13px', margin: '0 0 16px' }}>2 minutes. Then close the laptop.</p>
      <input className="backup-input" type="text" placeholder="One win today..." value={win} onChange={e => setWin(e.target.value)} inputMode="text" autoFocus />
      <input className="backup-input" type="text" placeholder="One thing that didn't go to plan..." value={didntGo} onChange={e => setDidntGo(e.target.value)} inputMode="text" />
      <input className="backup-input" type="text" placeholder="How are you feeling?" value={feeling} onChange={e => setFeeling(e.target.value)} inputMode="text" />
      <div className="standup-actions" style={{ marginTop: '12px' }}>
        {message && <span className="standup-message">{message}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save EOD'}</button>
      </div>
    </div>
  );
}

function MustDoPanel({ items }) {
  const [expanded, setExpanded] = useState(false);
  if (!items || items.length === 0) return null;
  return (
    <div className="mustdo-panel">
      <div className="mustdo-header" onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer' }}>
        <span className="mustdo-icon">!</span>
        <span className="mustdo-title">Must Do Today — Non-Negotiable</span>
        <span className="mustdo-count">{items.length}</span>
        <span className="mustdo-expand">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <ul className="mustdo-list">
          {items.map((item, i) => (
            <li key={i} className="mustdo-item">
              <span className="mustdo-bullet" />
              <span>{item.text}</span>
              {item.due_date && <span className="mustdo-due">{item.due_date}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Accountability card — what Nick said he'd do vs what actually happened.
// Anything rolling 3+ days must get a Today/Drop decision before the standup proceeds.
function TodayStandup() {
  const [content, setContent] = React.useState(null);

  React.useEffect(() => {
    fetch(apiUrl('/api/obsidian/daily'))
      .then(r => r.json())
      .then(data => {
        if (!data.content) return;
        // Extract standup and focus sections from daily note
        const lines = data.content.split('\n');
        const sections = [];
        let capture = false;
        let current = [];

        for (const line of lines) {
          if (/^## (Standup|Must Do Today|Focus Today|Carry)/i.test(line)) {
            if (current.length > 0) sections.push(current.join('\n'));
            current = [line];
            capture = true;
          } else if (/^## /.test(line) && capture) {
            if (current.length > 0) sections.push(current.join('\n'));
            current = [];
            capture = false;
          } else if (capture) {
            current.push(line);
          }
        }
        if (current.length > 0) sections.push(current.join('\n'));

        if (sections.length > 0) {
          setContent(sections.join('\n\n'));
        }
      })
      .catch(() => {});
  }, []);

  if (!content) return null;

  return (
    <div className="today-standup">
      <div className="today-standup-label">Today's standup</div>
      <div className="today-standup-content">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

export default function StandupEditor({ startWithEod = false }) {
  const [mode, setMode] = useState('guided'); // 'guided' | 'manual'
  const [content, setContent] = useState('');
  const [contentSet, setContentSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // Arriving from the "End of day" menu entry opens straight into EOD rather
  // than the morning standup.
  const [showEod, setShowEod] = useState(startWithEod);
  const [eodMode, setEodMode] = useState('guided'); // 'guided' | 'quick'
  const [guidedDone, setGuidedDone] = useState(false);
  const [forceRedo, setForceRedo] = useState(false);

  const { data: standupData, status: standupStatus } = useCachedFetch('/api/standup');
  const { data: ritualData } = useCachedFetch('/api/standup/ritual-state');

  // Check if standup already done today — forceRedo overrides
  const standupDone = forceRedo ? false : (ritualData?.standupDoneToday || guidedDone);

  useEffect(() => {
    if (standupData && !contentSet) {
      setContent(standupData.content || '# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    } else if (standupStatus === 'unavailable' && !contentSet) {
      setContent('# Standup\n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- ');
      setContentSet(true);
    }
  }, [standupData, standupStatus, contentSet]);

  // Auto-show EOD after 5pm
  useEffect(() => {
    if (startWithEod) return;
    const now = new Date();
    if (now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 17) setShowEod(true);
  }, [startWithEod]);

  const handleSaveToDaily = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl('/api/standup/save-to-daily'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      setMessage('Saved to daily note');
      setTimeout(() => setMessage(''), 2000);
    } catch {
      setMessage('Save failed');
    }
    setSaving(false);
  };

  return (
    <div className="standup-editor">

      {/* EOD section */}
      {showEod && (
        <div style={{ marginBottom: '16px' }}>
          <div className="standup-mode-toggle" style={{ marginBottom: '12px' }}>
            <button className={`mode-btn ${eodMode === 'guided' ? 'active' : ''}`} onClick={() => setEodMode('guided')}>Guided</button>
            <button className={`mode-btn ${eodMode === 'quick' ? 'active' : ''}`} onClick={() => setEodMode('quick')}>Quick</button>
          </div>
          {eodMode === 'guided'
            ? (
              // Carries its own SARA header.
              <StandupSession
                kind="eod"
                onDone={() => { setShowEod(false); setEodMode('quick'); }}
                onSwitchToManual={() => setEodMode('quick')}
              />
            )
            : (
              <>
                {/* Quick EOD is a form, not a conversation, but it is still
                    her asking — the screen should not go anonymous just
                    because the input got shorter. */}
                <div className="ss__who">
                  <span className="ss__who-name">SARA</span>
                  <span className="ss__who-what">End of day — the short version</span>
                </div>
                <EodCapture onDone={() => setShowEod(false)} />
              </>
            )
          }
        </div>
      )}

      {/* Mode toggle + EOD button */}
      <div className="standup-header">
        <div className="standup-mode-toggle">
          <button
            className={`mode-btn ${mode === 'guided' ? 'active' : ''}`}
            onClick={() => setMode('guided')}
          >
            Guided
          </button>
          <button
            className={`mode-btn ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
          >
            Manual
          </button>
        </div>
        <div className="standup-header-actions">
          {message && <span className="standup-message">{message}</span>}
          {!showEod && (
            <button className="btn btn-secondary" onClick={() => setShowEod(true)}>
              EOD
            </button>
          )}
        </div>
      </div>

      {/* Already done banner */}
      {standupDone && mode === 'guided' && (
        <div className="standup-done-banner">
          ✓ Standup already done today.
          <button className="standup-redo-btn" onClick={() => setForceRedo(true)}>
            Redo
          </button>
        </div>
      )}

      {/* Guided mode — now a real conversation with the brain, not a fixed
          three-question stepper. The transcript lives on the Pi, so a dropped
          request is a retry rather than a lost standup. */}
      {mode === 'guided' && !standupDone && !guidedDone && (
        <StandupSession
          kind="standup"
          // ⚠ Do NOT setMode('manual') here. Finishing used to flip to manual,
          // which meant the "Standup done — written to vault" panel below (gated
          // on mode === 'guided') was unreachable BY CONSTRUCTION: pressing
          // "Write the daily note" appeared to abandon the conversation and drop
          // Nick into a raw editor holding the empty `## Yesterday / ## Today`
          // template. The note had in fact been written; nothing on screen said
          // so, and the empty template read as if the standup had been lost.
          onDone={() => { setGuidedDone(true); setForceRedo(false); }}
          onSwitchToManual={() => setMode('manual')}
        />
      )}

      {/* Guided done */}
      {mode === 'guided' && (standupDone || guidedDone) && !showEod && (
        <div className="guided-done">
          <div className="guided-done-icon">✓</div>
          <div className="guided-done-title">Standup done.</div>
          <div className="guided-done-sub">Written to vault.</div>
        </div>
      )}

      {/* Today's standup content — shown when standup is done */}
      {standupDone && <TodayStandup />}

      {/* Manual mode */}
      {mode === 'manual' && (
        <>
          <textarea
            className="standup-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
          <div className="standup-actions" style={{ marginTop: '8px' }}>
            <button className="btn btn-primary" onClick={handleSaveToDaily} disabled={saving}>
              {saving ? 'Saving...' : 'Save to daily note'}
            </button>
          </div>
        </>
      )}

    </div>
  );
}
