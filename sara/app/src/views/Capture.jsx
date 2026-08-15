import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import './Capture.css';

// Capture = zero-friction input straight to the brain. Must work on a bad day.
//   Note    → POST /api/capture/note {title?, content}
//   Todo    → POST /api/capture/todo {text, priority?}
//   Feature → POST /api/capture/feature {title, notes?, system?} — straight into the
//             NEURO Feature Tracker in the vault, NOT the task list: the backlog is
//             where it gets ranked, and a feature idea filed as a todo is one nobody
//             reads next to the other ninety.
// Optional voice dictation via the Web Speech API (append to the text box).
const RECENT_LIMIT = 5;

export default function Capture({ autoRecord = false }) {
  const [mode, setMode] = useState('note'); // 'note' | 'todo' | 'feature'
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('normal'); // todo only
  const [system, setSystem] = useState('NEURO'); // feature only
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null); // { ok, msg }
  const [recent, setRecent] = useState([]);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const SpeechRecognition = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);

  async function loadRecent() {
    try {
      const data = await apiFetch('/api/capture/recent');
      setRecent((data.items || []).slice(0, RECENT_LIMIT));
    } catch { /* recent is a nicety — never block capture on it */ }
  }
  useEffect(() => { loadRecent(); }, []);

  // A feature is titled, not typed at — the one line IS the item, and the notes
  // are optional context. Everything else is the other way round.
  const ready = mode === 'feature' ? title.trim().length > 0 : text.trim().length > 0;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFlash(null);
    try {
      if (mode === 'feature') {
        const res = await apiFetch('/api/capture/feature', {
          method: 'POST',
          body: JSON.stringify({ title: title.trim(), notes: text.trim() || undefined, system, source: 'SARA Capture' }),
        });
        setFlash({ ok: true, msg: `Tracker #${res.number} — ${res.system}` });
      } else if (mode === 'note') {
        const res = await apiFetch('/api/capture/note', {
          method: 'POST',
          body: JSON.stringify({ title: title.trim() || undefined, content: text.trim() }),
        });
        setFlash({ ok: true, msg: `Saved → ${res.filename || 'vault'}` });
      } else {
        await apiFetch('/api/capture/todo', {
          method: 'POST',
          body: JSON.stringify({ text: text.trim(), priority: priority === 'high' ? 'high' : undefined }),
        });
        setFlash({ ok: true, msg: 'Todo added' });
      }
      setTitle('');
      setText('');
      loadRecent();
    } catch (err) {
      setFlash({ ok: false, msg: err.message });
    } finally {
      setBusy(false);
    }
  }

  function startVoice() {
    if (!SpeechRecognition || listening) return;
    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      setText((prev) => (prev ? `${prev} ${chunk}` : chunk).trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* start() throws if already running — ignore */ }
  }

  function stopVoice() { recognitionRef.current?.stop(); }

  function toggleVoice() {
    if (!SpeechRecognition) return;
    if (listening) stopVoice(); else startVoice();
  }

  // "Talk now" entry point — the Voice nav button mounts Capture with autoRecord,
  // so dictation starts immediately. The nav tap is the user gesture that unlocks the mic.
  useEffect(() => {
    if (autoRecord) startVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section>
      <h1 className="view__title">Capture</h1>
      <p className="view__lede">Get it out of your head. Zero friction.</p>

      <div className="cap__modes">
        <button type="button" className={`cap__mode${mode === 'note' ? ' cap__mode--on' : ''}`} onClick={() => setMode('note')}>Note</button>
        <button type="button" className={`cap__mode${mode === 'todo' ? ' cap__mode--on' : ''}`} onClick={() => setMode('todo')}>Todo</button>
        <button type="button" className={`cap__mode${mode === 'feature' ? ' cap__mode--on' : ''}`} onClick={() => setMode('feature')}>Feature</button>
      </div>

      <form className="cap__form" onSubmit={submit}>
        {(mode === 'note' || mode === 'feature') && (
          <input
            className="cap__title"
            type="text"
            placeholder={mode === 'feature' ? 'What should it do? (one line)' : 'Title (optional)'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus={mode === 'feature'}
          />
        )}
        <div className="cap__textwrap">
          <textarea
            className="cap__text"
            placeholder={mode === 'note' ? "What's on your mind?"
              : mode === 'todo' ? 'What needs doing?'
              : 'Why does it matter? (optional, but it needs one before it can be ranked)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            autoFocus={mode !== 'feature'}
          />
          {SpeechRecognition && (
            <button
              type="button"
              className={`cap__mic${listening ? ' cap__mic--on' : ''}`}
              onClick={toggleVoice}
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              title={listening ? 'Stop dictation' : 'Dictate'}
            >
              {listening ? '⏺' : '🎤'}
            </button>
          )}
        </div>

        {mode === 'todo' && (
          <label className="cap__prio">
            <input
              type="checkbox"
              checked={priority === 'high'}
              onChange={(e) => setPriority(e.target.checked ? 'high' : 'normal')}
            />
            High priority
          </label>
        )}

        {mode === 'feature' && (
          <div className="cap__modes cap__modes--sub">
            {['NEURO', 'SARA', 'NOVA'].map((s) => (
              <button
                key={s}
                type="button"
                className={`cap__mode${system === s ? ' cap__mode--on' : ''}`}
                onClick={() => setSystem(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <button className="cap__submit" type="submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : mode === 'note' ? 'Save to vault' : mode === 'todo' ? 'Add todo' : 'Add to tracker'}
        </button>
      </form>

      {flash && <div className={`cap__flash${flash.ok ? '' : ' err'}`}>{flash.msg}</div>}

      {recent.length > 0 && (
        <div className="cap__recent">
          <div className="cap__recent-h">Recent captures</div>
          {recent.map((r) => (
            <div className="card cap__recent-item" key={r.relativePath}>
              <div className="cap__recent-title">{r.title || r.filename}</div>
              {r.preview && <div className="cap__recent-preview">{r.preview}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
