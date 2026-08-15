import { useEffect, useRef, useState } from 'react';
import { apiFetch, chatStream } from '../api';
import { speakSara, isVoiceOutEnabled, setVoiceOutEnabled, unlockAudio } from '../voiceUtils';
import './Chat.css';

// Chat = talk to the brain, with real vault reasoning behind it.
// Streams over POST /api/chat (SSE). If streaming fails, falls back to POST /api/chat/sync.

// Web Speech errors are terse codes. On a phone there is no console to read, so the
// reason has to reach the screen — a mic that fails silently is indistinguishable from
// a mic that isn't wired up at all.
const VOICE_ERRORS = {
  'not-allowed': 'Microphone blocked. Allow it in Settings → Safari → Microphone, then reload.',
  'service-not-allowed': 'iOS refused speech recognition here. Try opening SARA in Safari rather than the installed app.',
  'audio-capture': 'No microphone available.',
  'no-speech': 'Didn’t hear anything — try again, closer to the mic.',
  'network': 'Speech recognition needs the network and couldn’t reach it.',
  aborted: '',
};
export default function Chat() {
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'api' | 'local'
  const [voiceOut, setVoiceOut] = useState(isVoiceOutEnabled);
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState('');
  const [speaking, setSpeaking] = useState(false);
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
    if (last.role !== 'assistant' || !last.content) return;

    const utterance = speakSara(last.content);
    if (!utterance) { setVoiceErr('Speech synthesis refused the reply.'); return; }
    // "Speaking…" appearing but nothing audible means the API worked and the phone
    // didn't — silent switch or volume. Never appearing means it never spoke at all.
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (evt) => {
      setSpeaking(false);
      if (evt?.error === 'interrupted' || evt?.error === 'canceled') return;
      setVoiceErr(`Couldn’t speak: ${evt?.error || 'unknown'}`);
      console.warn('[SARA Voice] utterance error', evt?.error, evt);
    };
  }, [busy]);

  const toggleVoiceOut = () => {
    // This tap is a guaranteed user gesture — the one moment iOS will accept an unlock.
    // Waiting for the generic first-touch listener is a coin flip on which tap wins.
    unlockAudio();
    setVoiceErr('');
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
    setVoiceErr('');
    rec.onresult = (evt) => {
      let chunk = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) chunk += evt.results[i][0].transcript;
      dictatedRef.current = (dictatedRef.current ? `${dictatedRef.current} ${chunk}` : chunk).trim();
      setInput(dictatedRef.current);
    };
    rec.onend = () => {
      setListening(false);
      const said = dictatedRef.current.trim();
      if (said) submit(said);
      // Ended with nothing and no error fired: iOS often cuts recognition off in a
      // standalone PWA without ever reporting why. Say so rather than sitting silent.
      else setVoiceErr((e) => e || 'Heard nothing. If that keeps happening, try Safari rather than the installed app.');
    };
    rec.onerror = (evt) => {
      setListening(false);
      setVoiceErr(VOICE_ERRORS[evt?.error] || `Mic error: ${evt?.error || 'unknown'}`);
      console.warn('[SARA Voice] recognition error', evt?.error, evt);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      // start() throws if one is already running — otherwise it's a real failure.
      console.warn('[SARA Voice] start() threw', err);
      setVoiceErr(`Couldn’t start the mic: ${err.message}`);
    }
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

      {(voiceErr || listening || speaking) && (
        <div className={`chat__voice-note${voiceErr ? ' chat__voice-note--err' : ''}`}>
          {voiceErr || (listening ? 'Listening… tap ⏺ to send.' : 'Speaking…')}
        </div>
      )}
      {!SpeechRecognition && (
        <div className="chat__voice-note chat__voice-note--err">
          This browser has no speech recognition, so there’s no mic. On iPhone that usually
          means the installed app rather than Safari.
        </div>
      )}

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
