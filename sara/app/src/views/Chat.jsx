import { useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../api';
import { speakSara, isVoiceOutEnabled, setVoiceOutEnabled } from '../voiceUtils';
import './Chat.css';

// Chat = talk to the brain, with real vault reasoning behind it.
// Streams over POST /api/chat (SSE). If streaming fails, falls back to POST /api/chat/sync.
export default function Chat() {
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'api' | 'local'
  const [voiceOut, setVoiceOut] = useState(isVoiceOutEnabled);
  const [listening, setListening] = useState(false);
  const convRef = useRef(null);
  const endRef = useRef(null);
  const recognitionRef = useRef(null);
  const dictatedRef = useRef('');   // onend fires from a stale closure — read the text from here
  const busyRef = useRef(false);    // ditto for the in-flight guard

  const SpeechRecognition = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  // Speak SARA's reply once it has finished arriving.
  // Gated on `busy`, NOT `messages` — keying on messages speaks every streamed token.
  useEffect(() => {
    if (busy || !voiceOut || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && last.content) speakSara(last.content);
  }, [busy]);

  const toggleVoiceOut = () => {
    setVoiceOut((v) => {
      const next = !v;
      setVoiceOutEnabled(next);
      return next;
    });
  };

  // Dictation: tap 🎤 to talk, tap ⏺ to stop — stopping sends. Continuous, so a pause
  // mid-thought doesn't fire it off early. The stop tap is also the iOS audio-unlock gesture.
  function startVoice() {
    if (!SpeechRecognition || listening) return;
    const rec = new SpeechRecognition();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = true;
    dictatedRef.current = '';
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      dictatedRef.current = (dictatedRef.current ? `${dictatedRef.current} ${chunk}` : chunk).trim();
      setInput(dictatedRef.current);
    };
    rec.onend = () => {
      setListening(false);
      if (dictatedRef.current.trim()) submit(dictatedRef.current);
    };
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* start() throws if already running — ignore */ }
  }

  function toggleVoice() {
    if (!SpeechRecognition) return;
    if (listening) recognitionRef.current?.stop(); else startVoice();
  }

  function send(e) {
    e.preventDefault();
    return submit(input);
  }

  async function submit(raw) {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    dictatedRef.current = '';

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    const body = { message: text, conversationId: convRef.current || undefined };
    const appendToLast = (chunk) =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: 'assistant', content: copy[copy.length - 1].content + chunk };
        return copy;
      });

    try {
      let got = false;
      await chatStream(body, {
        onMode: setMode,
        onChunk: (c) => { got = true; appendToLast(c); },
        onError: (msg) => appendToLast(got ? '' : `⚠️ ${msg}`),
      });
    } catch {
      // Streaming unavailable — fall back to the sync endpoint.
      try {
        const res = await apiFetch('/api/chat/sync', { method: 'POST', body: JSON.stringify(body) });
        convRef.current = res.conversationId || convRef.current;
        setMode(res.mode || null);
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'assistant', content: res.message || '(no reply)' };
          return copy;
        });
      } catch (err) {
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'assistant', content: `⚠️ Couldn’t reach the brain: ${err.message}` };
          return copy;
        });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <div className="chat__head">
        <div>
          <h1 className="view__title">Chat</h1>
          <p className="view__lede">Talk to the brain.</p>
        </div>
        <div className="chat__head-right">
          {'speechSynthesis' in window && (
            <button
              type="button"
              className={`chat__voice-toggle ${voiceOut ? 'is-on' : ''}`}
              onClick={toggleVoiceOut}
              title={voiceOut ? 'Voice on' : 'Voice off'}
            >
              {voiceOut ? '🔊' : '🔇'}
            </button>
          )}
          {mode && <span className={`chat__mode chat__mode--${mode}`}>{mode === 'api' ? 'cloud' : 'local'}</span>}
        </div>
      </div>

      <div className="chat__thread">
        {messages.length === 0 && (
          <div className="chat__empty">Ask anything — the brain has your vault, queue and calendar in context.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat__msg chat__msg--${m.role}`}>
            {m.content || (busy && i === messages.length - 1 ? <span className="chat__typing">…</span> : '')}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="chat__composer" onSubmit={send}>
        {SpeechRecognition && (
          <button
            type="button"
            className={`chat__mic${listening ? ' chat__mic--on' : ''}`}
            onClick={toggleVoice}
            aria-label={listening ? 'Stop and send' : 'Dictate'}
            title={listening ? 'Stop and send' : 'Dictate'}
          >
            {listening ? '⏺' : '🎤'}
          </button>
        )}
        <input
          className="chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message SARA…"
          autoFocus
        />
        <button className="chat__send" type="submit" disabled={busy || !input.trim()}>↑</button>
      </form>
    </section>
  );
}
