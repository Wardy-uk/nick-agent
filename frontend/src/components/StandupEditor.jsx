import React, { useState, useEffect, useRef } from 'react';
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

function GuidedEod({ onDone }) {
  const [loading, setLoading] = useState(true);
  const [briefing, setBriefing] = useState('');
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch(apiUrl('/api/standup/eod/questions'))
      .then(r => r.json())
      .then(d => {
        setBriefing(d.briefing || 'Time to wrap up.');
        setQuestions(d.questions || ["What was your biggest win today?", "Anything that didn't go to plan?", "How are you feeling?"]);
        setAnswers(new Array(d.questions?.length || 3).fill(''));
        setLoading(false);
      })
      .catch(() => {
        setQuestions(["What was your biggest win today?", "Anything that didn't go to plan?", "How are you feeling?"]);
        setAnswers(['', '', '']);
        setBriefing('Time to wrap up.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!loading && inputRef.current) inputRef.current.focus();
  }, [step, loading]);

  const handleNext = () => {
    if (step < questions.length - 1) {
      setStep(s => s + 1);
    } else {
      handleSubmit();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (answers[step]?.trim()) handleNext();
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/eod/submit-guided'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, questions })
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError('Failed to save EOD');
      }
    } catch {
      setError('Connection error');
    }
    setSaving(false);
  };

  if (loading) return <div className="guided-loading">Loading your EOD...</div>;

  if (error) {
    return (
      <div className="standup-done-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
        <span>{error}</span>
        <button className="btn btn-secondary" onClick={onDone}>Switch to Quick</button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="guided-done">
        <div className="guided-done-icon">✓</div>
        <div className="guided-done-title">EOD filed.</div>
        <div className="guided-done-sub">Close the laptop.</div>
        {onDone && <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onDone}>Close</button>}
      </div>
    );
  }

  return (
    <div className="guided-standup">
      {briefing && step === 0 && (
        <div className="guided-sara-line">
          <span className="guided-sara-label">SARA</span>
          <span className="guided-sara-text">{briefing}</span>
        </div>
      )}

      {questions.slice(0, step).map((q, i) => (
        <React.Fragment key={i}>
          <div className="guided-bubble assistant">{q}</div>
          <div className="guided-bubble user"><span>{answers[i]}</span></div>
        </React.Fragment>
      ))}

      <div className="guided-bubble assistant">{questions[step]}</div>

      <div className="guided-progress">
        {questions.map((_, i) => (
          <span key={i} className={`guided-progress-dot ${i < step ? 'done' : i === step ? 'active' : ''}`} />
        ))}
      </div>

      <div className="guided-input-row">
        <textarea
          ref={inputRef}
          className="guided-input"
          value={answers[step] || ''}
          onChange={e => {
            const next = [...answers];
            next[step] = e.target.value;
            setAnswers(next);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Your answer..."
          rows={2}
          disabled={saving}
          autoFocus
          spellCheck={true}
          autoCorrect="on"
        />
        <button
          className="guided-send"
          onClick={handleNext}
          disabled={saving || !(answers[step]?.trim())}
        >
          {saving ? '...' : step === questions.length - 1 ? '✓' : '→'}
        </button>
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
function AccountabilityCard({ data, decisions, onDecide }) {
  if (!data) return null;
  const { headline, today, yesterday, openCommitments = [], skippedDays = [], overdueMustDos = [], queue } = data;
  const hasBody = today || yesterday || openCommitments.length > 0 || overdueMustDos.length > 0 || queue;
  if (!headline && !hasBody) return null;

  return (
    <div className="accountability-card">
      {headline && <div className="accountability-headline">{headline}</div>}

      {today?.standupDone && today.committed > 0 && (
        <div className="accountability-section">
          <div className="accountability-section-title">Today — already committed</div>
          {today.items.map((item, i) => (
            <div key={i} className={`accountability-item ${item.done ? 'decided-drop' : ''}`}>
              <span className="accountability-days">{item.done ? '✓' : '○'}</span>
              <span className="accountability-item-text">{item.text}</span>
            </div>
          ))}
        </div>
      )}

      {yesterday && (
        <div className="accountability-score">
          <span className="accountability-label">{yesterday.date}</span>
          <span className={yesterday.done === 0 && yesterday.committed > 0 ? 'accountability-bad' : ''}>
            {yesterday.done}/{yesterday.committed} done
          </span>
          {!yesterday.eodDone && <span className="accountability-bad">no EOD</span>}
        </div>
      )}

      {yesterday?.unresolved && (
        <div className="accountability-note">Yesterday you flagged: “{yesterday.unresolved}”</div>
      )}

      {openCommitments.length > 0 && (
        <div className="accountability-section">
          <div className="accountability-section-title">Still open — commit or drop</div>
          {openCommitments.map(c => {
            const stale = c.daysCarried >= 3;
            const decision = decisions[c.key];
            return (
              <div key={c.key} className={`accountability-item ${stale ? 'stale' : ''} ${decision ? `decided-${decision}` : ''}`}>
                <span className="accountability-item-text">{c.text}</span>
                <span className="accountability-days">day {c.daysCarried}</span>
                <button
                  className={`accountability-btn ${decision === 'today' ? 'active' : ''}`}
                  onClick={() => onDecide(c, decision === 'today' ? null : 'today')}
                >Today</button>
                <button
                  className={`accountability-btn drop ${decision === 'drop' ? 'active' : ''}`}
                  onClick={() => onDecide(c, decision === 'drop' ? null : 'drop')}
                >Drop</button>
              </div>
            );
          })}
        </div>
      )}

      {overdueMustDos.length > 0 && (
        <div className="accountability-section">
          <div className="accountability-section-title">Overdue must-dos</div>
          {overdueMustDos.slice(0, 4).map((m, i) => (
            <div key={i} className="accountability-item">
              <span className="accountability-item-text">{m.text}</span>
              <span className="accountability-days bad">{m.daysLate}d late</span>
            </div>
          ))}
        </div>
      )}

      {(queue || skippedDays.length >= 2) && (
        <div className="accountability-footer">
          {queue && <span>{queue.total} open · {queue.atRisk} at risk · {queue.p1s} P1</span>}
          {skippedDays.length >= 2 && <span className="accountability-bad">standup skipped {skippedDays.length}d</span>}
        </div>
      )}
    </div>
  );
}

function BackupStandup({ onDone }) {
  const [items, setItems] = useState(['', '', '']);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [mustDos, setMustDos] = useState([]);

  useEffect(() => {
    fetch(apiUrl('/api/standup/must-dos'))
      .then(r => r.json())
      .then(d => setMustDos(d.items || []))
      .catch(() => {});
  }, []);

  const updateItem = (idx, val) => {
    const next = [...items];
    next[idx] = val;
    setItems(next);
  };

  const handleSave = async () => {
    const focusItems = items.filter(i => i.trim());
    if (focusItems.length === 0) {
      setMessage('Add at least one focus item');
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/standup/backup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focusItems })
      });
      if (res.ok) {
        setMessage('Backup standup saved to daily note');
        if (onDone) onDone();
      } else {
        const data = await res.json();
        setMessage(data.error || 'Save failed');
      }
    } catch (e) {
      setMessage('Save failed');
    }
    setSaving(false);
    setTimeout(() => setMessage(''), 3000);
  };

  return (
    <div className="backup-standup">
      <MustDoPanel items={mustDos} />
      <h3>Quick Standup (max 3 items)</h3>
      <p style={{ color: '#888', fontSize: '13px', margin: '0 0 16px' }}>
        Lightweight backup — what matters today?
      </p>
      {items.map((item, i) => (
        <input
          key={i}
          type="text"
          className="backup-input"
          placeholder={`Focus item ${i + 1}${i === 0 ? ' (required)' : ' (optional)'}`}
          value={item}
          onChange={e => updateItem(i, e.target.value)}
        />
      ))}
      <div className="standup-actions" style={{ marginTop: '12px' }}>
        {message && <span className="standup-message">{message}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save backup standup'}
        </button>
      </div>
    </div>
  );
}

// ── Guided standup (deterministic stepper — AI generates questions, code asks them) ──

function GuidedStandup({ onDone }) {
  const [loading, setLoading] = useState(true);
  const [briefing, setBriefing] = useState('');
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [step, setStep] = useState(0); // 0..questions.length-1 = answering, questions.length = saving
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [mustDos, setMustDos] = useState([]);
  const [accountability, setAccountability] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [gateMessage, setGateMessage] = useState('');
  const inputRef = useRef(null);

  // Load must-dos + accountability + questions on mount
  useEffect(() => {
    fetch(apiUrl('/api/standup/must-dos')).then(r => r.json()).then(d => setMustDos(d.items || [])).catch(() => {});
    fetch(apiUrl('/api/standup/accountability')).then(r => r.json()).then(setAccountability).catch(() => {});
    fetch(apiUrl('/api/standup/questions'))
      .then(r => r.json())
      .then(d => {
        setBriefing(d.briefing || 'Good morning.');
        setQuestions(d.questions || ["What's your main focus today?", "Any blockers?", "Anything else?"]);
        setAnswers(new Array(d.questions?.length || 3).fill(''));
        setLoading(false);
      })
      .catch(() => {
        setQuestions(["What's your main focus today?", "Any blockers or things that need escalating?", "Anything else before I write this up?"]);
        setAnswers(['', '', '']);
        setBriefing('Good morning.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!loading && inputRef.current) inputRef.current.focus();
  }, [step, loading]);

  // Anything rolling 3+ days has to be explicitly committed to or dropped —
  // that's the accountability bit. Younger items can just carry.
  const undecidedStale = (accountability?.openCommitments || [])
    .filter(c => c.daysCarried >= 3 && !decisions[c.key]);

  const handleNext = () => {
    if (step === 0 && undecidedStale.length > 0) {
      setGateMessage(`${undecidedStale.length} item${undecidedStale.length > 1 ? 's have' : ' has'} been rolling 3+ days. Commit or drop before moving on.`);
      return;
    }
    setGateMessage('');
    if (step < questions.length - 1) {
      setStep(s => s + 1);
    } else {
      handleSubmit();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (answers[step]?.trim()) handleNext();
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    const commitments = (accountability?.openCommitments || []).map(c => ({
      key: c.key,
      text: c.text,
      daysCarried: c.daysCarried,
      decision: decisions[c.key] || 'hold',
    }));
    try {
      const res = await fetch(apiUrl('/api/standup/submit-guided'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, questions, commitments })
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError('Failed to save daily note');
      }
    } catch {
      setError('Connection error');
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="guided-loading">Loading your standup...</div>;
  }

  if (error) {
    return (
      <div className="standup-done-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
        <span>{error}</span>
        <button className="btn btn-secondary" onClick={onDone}>Switch to Manual</button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="guided-done">
        <div className="guided-done-icon">✓</div>
        <div className="guided-done-title">Daily note written.</div>
        <div className="guided-done-sub">Go.</div>
        {onDone && <button className="btn btn-secondary" style={{ marginTop: '16px' }} onClick={onDone}>Close</button>}
      </div>
    );
  }

  return (
    <div className="guided-standup">
      <MustDoPanel items={mustDos} />

      {/* Accountability — yesterday's commitments, what slipped */}
      {step === 0 && (
        <AccountabilityCard
          data={accountability}
          decisions={decisions}
          onDecide={(item, decision) => {
            setDecisions(d => {
              const next = { ...d };
              if (decision) next[item.key] = decision; else delete next[item.key];
              return next;
            });
            setGateMessage('');
          }}
        />
      )}

      {/* SARA briefing */}
      {briefing && step === 0 && (
        <div className="guided-sara-line">
          <span className="guided-sara-label">SARA</span>
          <span className="guided-sara-text">{briefing}</span>
        </div>
      )}

      {/* Previous Q&A pairs */}
      {questions.slice(0, step).map((q, i) => (
        <React.Fragment key={i}>
          <div className="guided-bubble assistant">{q}</div>
          <div className="guided-bubble user"><span>{answers[i]}</span></div>
        </React.Fragment>
      ))}

      {/* Current question */}
      <div className="guided-bubble assistant">
        {questions[step]}
      </div>

      {gateMessage && <div className="accountability-gate">{gateMessage}</div>}

      {/* Progress */}
      <div className="guided-progress">
        {questions.map((_, i) => (
          <span key={i} className={`guided-progress-dot ${i < step ? 'done' : i === step ? 'active' : ''}`} />
        ))}
      </div>

      {/* Input */}
      <div className="guided-input-row">
        <textarea
          ref={inputRef}
          className="guided-input"
          value={answers[step] || ''}
          onChange={e => {
            const next = [...answers];
            next[step] = e.target.value;
            setAnswers(next);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Your answer..."
          rows={2}
          disabled={saving}
          autoFocus
          spellCheck={true}
          autoCorrect="on"
        />
        <button
          className="guided-send"
          onClick={handleNext}
          disabled={saving || !(answers[step]?.trim())}
        >
          {saving ? '...' : step === questions.length - 1 ? '✓' : '→'}
        </button>
      </div>
    </div>
  );
}

// ── Main StandupEditor ────────────────────────────────────────────────────

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

export default function StandupEditor() {
  const [mode, setMode] = useState('guided'); // 'guided' | 'manual'
  const [content, setContent] = useState('');
  const [contentSet, setContentSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showEod, setShowEod] = useState(false);
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
    const now = new Date();
    if (now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 17) setShowEod(true);
  }, []);

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
              <StandupSession
                kind="eod"
                onDone={() => { setShowEod(false); setEodMode('quick'); }}
                onSwitchToManual={() => setEodMode('quick')}
              />
            )
            : <EodCapture onDone={() => setShowEod(false)} />
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
      {mode === 'guided' && !standupDone && (
        <StandupSession
          kind="standup"
          onDone={() => { setGuidedDone(true); setForceRedo(false); setMode('manual'); }}
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
