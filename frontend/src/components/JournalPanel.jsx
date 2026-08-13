import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './JournalPanel.css';

export default function JournalPanel() {
  const [prompts, setPrompts] = useState([]);
  const [responses, setResponses] = useState(['', '', '']);
  const [currentStep, setCurrentStep] = useState(0); // 0, 1, 2 = prompts; 3 = done
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [date, setDate] = useState('');
  const [nudgeTime, setNudgeTime] = useState('21:00');
  const [savingTime, setSavingTime] = useState(false);
  const [timeMsg, setTimeMsg] = useState('');

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/journal/prompts'));
      const data = await res.json();
      setPrompts(data.prompts || []);
      setAlreadyDone(data.alreadyDone || false);
      setDate(data.date || '');
    } catch {}
    setLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/journal/settings'));
      const data = await res.json();
      setNudgeTime(data.nudgeTime || '21:00');
    } catch {}
  }, []);

  useEffect(() => {
    loadPrompts();
    loadSettings();
  }, [loadPrompts, loadSettings]);

  const updateResponse = (idx, val) => {
    setResponses(prev => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const handleNext = () => {
    if (responses[currentStep].trim().length < 3) return;
    if (currentStep < prompts.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      handleSave();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const entries = prompts.map((prompt, i) => ({
        prompt,
        response: responses[i].trim() || '(skipped)'
      }));
      const res = await fetch(apiUrl('/api/journal/save'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, date })
      });
      if (res.ok) {
        setCurrentStep(prompts.length); // done state
      }
    } catch {}
    setSaving(false);
  };

  const saveNudgeTime = async () => {
    if (!/^\d{2}:\d{2}$/.test(nudgeTime)) {
      setTimeMsg('Format must be HH:MM');
      return;
    }
    setSavingTime(true);
    try {
      await fetch(apiUrl('/api/journal/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nudgeTime })
      });
      setTimeMsg('Saved');
      setTimeout(() => setTimeMsg(''), 2000);
    } catch {
      setTimeMsg('Save failed');
    }
    setSavingTime(false);
  };

  if (loading) {
    return (
      <div className="journal-panel">
        <div className="journal-loading">Loading...</div>
      </div>
    );
  }

  if (alreadyDone) {
    return (
      <div className="journal-panel">
        <div className="journal-done">
          <div className="journal-done-icon">✓</div>
          <h2>Already done today.</h2>
          <p>Reflections/{date}-journal.md</p>
          <div className="journal-settings">
            <div className="journal-settings-label">Evening nudge time</div>
            <div className="journal-settings-row">
              <input
                className="journal-time-input"
                type="time"
                value={nudgeTime}
                onChange={e => setNudgeTime(e.target.value)}
              />
              <button className="btn btn-secondary" onClick={saveNudgeTime} disabled={savingTime}>
                {savingTime ? 'Saving...' : 'Save'}
              </button>
              {timeMsg && <span className="journal-time-msg">{timeMsg}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Completion screen
  if (currentStep >= prompts.length) {
    return (
      <div className="journal-panel">
        <div className="journal-done">
          <div className="journal-done-icon">✓</div>
          <h2>Filed. That's today done.</h2>
          <p>Reflections/{date}-journal.md</p>
        </div>
      </div>
    );
  }

  const progress = Math.round((currentStep / prompts.length) * 100);

  return (
    <div className="journal-panel">
      <div className="journal-sara">
        <span className="journal-sara-label">SARA</span>
        <span className="journal-sara-line">Three questions. Two minutes. Then you're done.</span>
      </div>
      <div className="journal-header">
        <h2>Journal</h2>
        <div className="journal-meta">
          <span className="journal-date">{date}</span>
          <span className="journal-step">{currentStep + 1} of {prompts.length}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="journal-progress-track">
        <div className="journal-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* Current prompt */}
      <div className="journal-prompt-card">
        <div className="journal-prompt-text">{prompts[currentStep]}</div>
        <textarea
          className="journal-response"
          placeholder="Write freely — this is just for you..."
          value={responses[currentStep]}
          onChange={e => updateResponse(currentStep, e.target.value)}
          rows={5}
          autoFocus
          spellCheck={true}
          autoCorrect="on"
        />
      </div>

      <div className="journal-actions">
        {currentStep > 0 && (
          <button className="btn btn-secondary" onClick={() => setCurrentStep(prev => prev - 1)}>
            Back
          </button>
        )}
        <button
          className="journal-skip"
          onClick={() => {
            updateResponse(currentStep, responses[currentStep] || '(skipped)');
            handleNext();
          }}
        >
          Skip
        </button>
        <button
          className="btn btn-primary"
          onClick={handleNext}
          disabled={saving || responses[currentStep].trim().length < 3}
        >
          {saving ? 'Saving...' : currentStep === prompts.length - 1 ? 'Finish' : 'Next'}
        </button>
      </div>

      {/* Settings — nudge time */}
      <div className="journal-settings">
        <div className="journal-settings-label">Nudge time</div>
        <div className="journal-settings-row">
          <input
            className="journal-time-input"
            type="time"
            value={nudgeTime}
            onChange={e => setNudgeTime(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={saveNudgeTime} disabled={savingTime}>
            {savingTime ? '...' : 'Save'}
          </button>
          {timeMsg && <span className="journal-time-msg">{timeMsg}</span>}
        </div>
      </div>
    </div>
  );
}
