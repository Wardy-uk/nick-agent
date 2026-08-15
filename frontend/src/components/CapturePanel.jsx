import React, { useState, useRef, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './CapturePanel.css';

const MAX_SIZE = 10 * 1024 * 1024;
const QUEUE_KEY = 'neuro_offline_queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function addToQueue(item) {
  const q = getQueue();
  q.push({ ...item, queuedAt: Date.now() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

async function drainQueue(onDrained) {
  const q = getQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: item.headers || { 'Content-Type': 'application/json' },
        body: item.body
      });
      if (!res.ok) remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  if (remaining.length < q.length && onDrained) onDrained(q.length - remaining.length);
}

// Auto-detect if text looks like a todo
function looksLikeTodo(text) {
  const t = text.trim();
  return /^-?\s*\[.\]/.test(t) ||              // checkbox syntax
    /^(todo|task|action|reminder):/i.test(t) || // explicit prefix
    /^(buy|call|email|book|send|fix|update|check|schedule|remind)\s/i.test(t); // action verbs
}

// Feature ideas go to the NEURO Feature Tracker, not the task list — but only on an
// EXPLICIT prefix. Everything here is guessed from prose, and guessing "that's a
// feature" from a note would file thinking as backlog, which is the harder mistake
// to notice. "feature: X", "idea: X", or "neuro:/sara:/nova: X" (which also picks
// the system).
const FEATURE_RE = /^(feature|idea|neuro|sara|nova)\s*:\s*/i;
const FEATURE_SYSTEMS = { neuro: 'NEURO', sara: 'SARA', nova: 'NOVA' };

function parseFeature(text) {
  const t = text.trim();
  const m = t.match(FEATURE_RE);
  if (!m) return null;
  const body = t.slice(m[0].length).trim();
  const [title, ...rest] = body.split('\n');
  // Just the prefix and nothing after it isn't a feature yet — let it fall through
  // to a note rather than POSTing a title the server will reject.
  if (!title.trim()) return null;
  return {
    title: title.trim(),
    notes: rest.join('\n').trim() || undefined,
    system: FEATURE_SYSTEMS[m[1].toLowerCase()] || 'NEURO',
    source: 'NEURO Capture',
  };
}

export default function CapturePanel() {
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const [queueCount, setQueueCount] = useState(getQueue().length);
  const [showAttach, setShowAttach] = useState(false);
  const fileRef = useRef(null);
  const textRef = useRef(null);

  const resetForm = () => {
    setContent('');
    setFile(null);
    setPreview(null);
    setResult(null);
    setShowAttach(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/capture/recent'));
      const data = await res.json();
      setRecent(data.items || []);
    } catch {}
  }, []);

  useEffect(() => { fetchRecent(); }, [fetchRecent]);

  useEffect(() => {
    const drain = () => drainQueue((count) => {
      setQueueCount(getQueue().length);
      if (count > 0) fetchRecent();
    });
    drain();
    const onVisible = () => { if (!document.hidden) drain(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchRecent]);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_SIZE) {
      setResult({ error: 'File too large — 10MB maximum' });
      return;
    }
    setFile(f);
    setResult(null);
    if (f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target.result);
      reader.readAsDataURL(f);
    } else {
      setPreview(null);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setResult(null);

    const feature = file ? null : parseFeature(content);

    try {
      let res;

      if (feature) {
        res = await fetch(apiUrl('/api/capture/feature'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(feature)
        });
      } else if (file) {
        // File/photo upload
        const formData = new FormData();
        formData.append('file', file);
        const endpoint = file.type.startsWith('image/') ? '/api/capture/photo' : '/api/capture/file';
        res = await fetch(apiUrl(endpoint), { method: 'POST', body: formData });
      } else if (looksLikeTodo(content)) {
        // Auto-detected as todo
        const text = content.trim()
          .replace(/^-?\s*\[.\]\s*/, '')  // strip checkbox if present
          .replace(/^(todo|task|action|reminder):\s*/i, ''); // strip prefix
        res = await fetch(apiUrl('/api/capture/todo'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, priority: 'normal' })
        });
      } else {
        // Default: note capture
        res = await fetch(apiUrl('/api/capture/note'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: null, content: content.trim() })
        });
      }

      const data = await res.json();
      if (!res.ok) {
        const errorMsg = res.status === 401
          ? 'Not logged in — open Settings and re-enter your PIN'
          : data.error || `Capture failed (${res.status})`;
        setResult({ error: errorMsg });
        // Vibrate on error
        try { navigator.vibrate?.([200, 100, 200, 100, 200]); } catch {}
      } else {
        const isTodo = !file && !feature && looksLikeTodo(content);
        setResult({
          success: true,
          type: feature ? 'feature' : isTodo ? 'todo' : file ? 'file' : 'note',
          number: data.number
        });
        // Haptic success
        try { navigator.vibrate?.(100); } catch {}
        fetchRecent();
        setTimeout(resetForm, 3000);
      }
    } catch (err) {
      // Offline — queue text captures
      if (!file && content.trim()) {
        const isTodo = !feature && looksLikeTodo(content);
        const text = content.trim();
        if (feature) {
          addToQueue({
            url: apiUrl('/api/capture/feature'),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feature)
          });
        } else if (isTodo) {
          const cleanText = text.replace(/^-?\s*\[.\]\s*/, '').replace(/^(todo|task|action|reminder):\s*/i, '');
          addToQueue({
            url: apiUrl('/api/capture/todo'),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, priority: 'normal' })
          });
        } else {
          addToQueue({
            url: apiUrl('/api/capture/note'),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: null, content: text })
          });
        }
        setQueueCount(getQueue().length);
        setResult({ success: true, queued: true });
        setTimeout(resetForm, 2000);
      } else {
        setResult({ error: 'Offline — files cannot be queued' });
      }
    }

    setSubmitting(false);
  };

  const canSubmit = content.trim().length > 0 || !!file;
  const detectedFeature = file ? null : parseFeature(content);
  const detectedType = file ? (file.type.startsWith('image/') ? 'photo' : 'file')
    : detectedFeature ? 'feature'
    : content.trim() && looksLikeTodo(content) ? 'todo' : 'note';

  return (
    <div className="capture-panel">
      <div className="capture-sara">
        <span className="capture-sara-label">SARA</span>
        <span className="capture-sara-line">Get it out of your head. I'll route it.</span>
      </div>

      {result && (
        <div className={`capture-result-banner ${result.error ? 'capture-result-error' : result.queued ? 'capture-result-queued' : 'capture-result-ok'}`}>
          <span className="capture-result-icon">{result.error ? '✗' : result.queued ? '⏳' : '✓'}</span>
          <span className="capture-result-text">
            {result.error || (result.queued ? 'Queued. Will sync when online.'
              : result.type === 'todo' ? 'Added to todos.'
              : result.type === 'feature' ? `Added to the feature tracker${result.number ? ` as #${result.number}` : ''}.`
              : 'Captured.')}
          </span>
        </div>
      )}

      <div className="capture-form">
        <textarea
          ref={textRef}
          className="capture-textarea"
          placeholder="Type it. I'll sort it."
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={4}
          autoFocus
          disabled={!!file}
        />

        {/* Type indicator */}
        {content.trim() && !file && (
          <div className="capture-type-hint">
            {detectedType === 'feature' ? `Will go to the feature tracker (${detectedFeature.system})`
              : detectedType === 'todo' ? 'Will save as todo' : 'Will save as note'}
          </div>
        )}

        {/* File attachment area */}
        {showAttach && (
          <div className="capture-attach-area">
            <input
              ref={fileRef}
              type="file"
              onChange={handleFileSelect}
              className="capture-file-input"
            />
            {preview && <img src={preview} alt="Preview" className="capture-preview-img" />}
            {file && !preview && (
              <div className="capture-file-info">
                <span>{file.name}</span>
                <span className="capture-file-size">{(file.size / 1024).toFixed(1)} KB</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="capture-actions">
        <button
          className="capture-attach-btn"
          onClick={() => setShowAttach(o => !o)}
          title="Attach file or photo"
        >
          {showAttach ? 'Cancel' : 'Attach'}
        </button>

        <button
          className="capture-submit"
          onClick={submit}
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Saving...' : 'Capture'}
        </button>
      </div>

      {/* Escalation section */}
      <EscalateSection />

      {/* Location capture */}
      <LocationCapture />

      {queueCount > 0 && (
        <div className="capture-queue-notice">
          {queueCount} item{queueCount !== 1 ? 's' : ''} queued — will sync when online
        </div>
      )}

      {recent.length > 0 && (
        <div className="capture-recent">
          <div className="capture-recent-header">Recent ({recent.length})</div>
          <div className="capture-recent-list">
            {recent.slice(0, 8).map((item, i) => (
              <div key={i} className="capture-recent-item">
                <span className="capture-recent-name">
                  {item.title || item.filename.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '').replace('.md', '')}
                </span>
                {item.preview && (
                  <span className="capture-recent-preview">{item.preview}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Escalate ticket (collapsible) ─────────────────────────────────────────

function EscalateSection() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null); // null | 'ok' | 'error'
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const k = key.trim().toUpperCase();
    if (!k.match(/^[A-Z]+-\d+$/)) {
      setStatus('error');
      setMessage('Enter a valid ticket key e.g. NT-12345');
      return;
    }
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await fetch(apiUrl(`/api/jira/flagged/${k}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || null })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');
      setStatus('ok');
      setMessage(`${k} flagged`);
      setKey('');
      setNote('');
      setTimeout(() => setStatus(null), 2500);
    } catch (e) {
      setStatus('error');
      setMessage(e.message);
    }
    setSubmitting(false);
  };

  return (
    <div className="capture-escalate-section">
      <button className="capture-escalate-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} Flag Escalation
      </button>
      {open && (
        <div className="capture-escalate-form">
          <input
            className="capture-input capture-escalate-key"
            type="text"
            placeholder="Ticket key e.g. NT-12345"
            value={key}
            onChange={e => { setKey(e.target.value.toUpperCase()); setStatus(null); }}
            onKeyDown={e => e.key === 'Enter' && !submitting && submit()}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="capture-input"
            type="text"
            placeholder="Note (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !submitting && submit()}
          />
          {status === 'ok' && <div className="capture-escalate-ok">{message}</div>}
          {status === 'error' && <div className="capture-escalate-error">{message}</div>}
          <button className="review-action-btn" onClick={submit} disabled={submitting || !key.trim()}>
            {submitting ? 'Flagging...' : 'Flag'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Location capture ──────────────────────────────────────────────────────

function LocationCapture() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [places, setPlaces] = useState([]);
  const [gettingLoc, setGettingLoc] = useState(false);

  useEffect(() => {
    fetch(apiUrl('/api/location/places'))
      .then(r => r.json())
      .then(d => setPlaces(d.places || []))
      .catch(() => {});
  }, []);

  const savePlace = async () => {
    if (!name.trim()) return;
    setGettingLoc(true);

    // Get current position from browser
    if (!navigator.geolocation) {
      setGettingLoc(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setGettingLoc(false);
        setSaving(true);
        try {
          const res = await fetch(apiUrl('/api/location/places'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              lat: pos.coords.latitude,
              lng: pos.coords.longitude
            })
          });
          const data = await res.json();
          if (data.ok) {
            setPlaces(data.places);
            setSaved(true);
            setName('');
            setTimeout(() => setSaved(false), 3000);
          }
        } catch {}
        setSaving(false);
      },
      () => { setGettingLoc(false); },
      { timeout: 10000 }
    );
  };

  const deletePlace = async (placeName) => {
    try {
      const res = await fetch(apiUrl(`/api/location/places/${encodeURIComponent(placeName)}`), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) setPlaces(data.places);
    } catch {}
  };

  return (
    <div className="capture-escalate-section">
      <button className="capture-escalate-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} Save Location
      </button>
      {open && (
        <div className="capture-escalate-form">
          <div className="capture-location-hint">Save your current GPS position with a name</div>
          <input
            className="capture-input"
            type="text"
            placeholder="e.g. Work, Home, Gym"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && savePlace()}
          />
          {saved && <div className="capture-escalate-ok">Saved</div>}
          <button className="review-action-btn" onClick={savePlace} disabled={saving || gettingLoc || !name.trim()}>
            {gettingLoc ? 'Getting location...' : saving ? 'Saving...' : 'Save this location'}
          </button>

          {places.length > 0 && (
            <div className="capture-location-places">
              <div className="capture-location-places-label">Saved places</div>
              {places.map(p => (
                <div key={p.name} className="capture-location-place">
                  <span className="capture-location-place-name">{p.name}</span>
                  <button className="capture-location-place-del" onClick={() => deletePlace(p.name)} title="Remove">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
