import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiUrl, apiFetch } from '../api';
import { speakSara, isVoiceOutEnabled, setVoiceOutEnabled } from '../voiceUtils';
import './ChatPanel.css';

const STORAGE_KEY = 'neuro_last_conversation_id';

/**
 * The roster, fetched rather than typed (#13).
 *
 * This file carried a hardcoded list of fifteen first names that still included
 * Arman (left the business) and Willem (moved teams). The frontend cannot
 * require a backend service, which is how it got there — so the roster now
 * comes from `/api/team-health/roster`, which derives it from People/
 * frontmatter and does the ambiguous-first-name filtering server-side.
 *
 * Module-level so the whole panel shares one fetch, and deliberately never
 * falls back to a baked-in list: no roster means no draft button, which is a
 * missing affordance rather than a document filed under a departed colleague.
 */
let _rosterCache = null;
let _rosterPromise = null;

function fetchRoster() {
  if (_rosterCache) return Promise.resolve(_rosterCache);
  if (!_rosterPromise) {
    _rosterPromise = apiFetch('/api/team-health/roster')
      .then(r => r.json())
      .then(d => {
        _rosterCache = d?.ok ? { firstNames: d.firstNames || {}, people: d.people || [] } : { firstNames: {}, people: [] };
        return _rosterCache;
      })
      .catch(() => ({ firstNames: {}, people: [] }));
  }
  return _rosterPromise;
}

function useRoster() {
  const [roster, setRoster] = useState(_rosterCache);
  useEffect(() => {
    let live = true;
    fetchRoster().then(r => { if (live) setRoster(r); });
    return () => { live = false; };
  }, []);
  return roster;
}

// Detect if a message contains actionable language
function extractActionableItems(text) {
  const ACTION_PATTERNS = [
    /you should (.+?)(?:\.|$)/gi,
    /(?:follow up|follow-up) (?:with|on) (.+?)(?:\.|$)/gi,
    /(?:don't forget|remember) to (.+?)(?:\.|$)/gi,
    /(?:make sure|ensure) (?:you |to )?(.+?)(?:\.|$)/gi,
    /(?:book|schedule|arrange) (.+?)(?:\.|$)/gi,
    /(?:send|email|message|ping|contact) (.+?)(?:\.|$)/gi,
    /(?:action|task|todo)[:\s]+(.+?)(?:\.|$)/gi,
    /\[ADD TODO:\s*(.+?)\]/gi,
  ];

  const items = [];
  for (const pattern of ACTION_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length > 5 && item.length < 120) {
        items.push(item);
      }
    }
  }
  // Deduplicate
  return [...new Set(items)].slice(0, 3);
}

function TodoSaveButton({ messageContent, apiUrlFn }) {
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [showPicker, setShowPicker] = React.useState(false);
  const [items, setItems] = React.useState([]);

  React.useEffect(() => {
    const detected = extractActionableItems(messageContent);
    setItems(detected);
  }, [messageContent]);

  if (items.length === 0) return null;

  const saveTodo = async (text) => {
    setSaving(true);
    try {
      const res = await fetch(apiUrlFn('/api/capture/todo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, priority: 'normal' })
      });
      if (res.ok) {
        setSaved(true);
        setShowPicker(false);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {}
    setSaving(false);
  };

  if (saved) {
    return <div className="chat-todo-saved">✓ Added to Master Todo</div>;
  }

  return (
    <div className="chat-todo-wrapper">
      {!showPicker ? (
        <button
          className="chat-todo-btn"
          onClick={() => setShowPicker(true)}
          title="Save action to Master Todo"
        >
          → Todo
        </button>
      ) : (
        <div className="chat-todo-picker">
          <div className="chat-todo-picker-label">Save to Master Todo:</div>
          {items.map((item, i) => (
            <button
              key={i}
              className="chat-todo-item-btn"
              onClick={() => saveTodo(item)}
              disabled={saving}
            >
              {saving ? '...' : item}
            </button>
          ))}
          <button className="chat-todo-cancel" onClick={() => setShowPicker(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function detectPersonDraft(userMessage, assistantMessage, roster) {
  if (!userMessage || !assistantMessage || !roster) return null;

  const low = userMessage.toLowerCase();
  const hasWord = (term) => {
    const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(low);
  };

  // Full name first, then a first name that identifies exactly one person. The
  // server has already dropped the ambiguous ones, so "Nathan" never resolves
  // while both Nathans exist.
  let mentionedPerson = (roster.people || []).map(p => p.name).find(hasWord);
  if (!mentionedPerson) {
    const entry = Object.entries(roster.firstNames || {}).find(([first]) => hasWord(first));
    // Resolve to the FULL name: it is what lands in the document's `person:`
    // frontmatter, and People notes are keyed on full names.
    mentionedPerson = entry ? entry[1] : null;
  }
  if (!mentionedPerson) return null;

  const isDraft = /draft|write|put together|performance|review|feedback|pip|summary/i.test(userMessage);
  if (!isDraft) return null;

  const DOC_TYPES = {
    'performance': 'performance-review',
    'pip': 'pip',
    'feedback': 'feedback',
    '1-2-1': '1-2-1-summary',
    'summary': '1-2-1-summary'
  };

  const docType = Object.keys(DOC_TYPES).find(k =>
    userMessage.toLowerCase().includes(k)
  );

  return { personName: mentionedPerson, docType: DOC_TYPES[docType] || 'general' };
}

function SaveDocButton({ userMessage, assistantContent }) {
  const roster = useRoster();
  const draft = detectPersonDraft(userMessage, assistantContent, roster);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  if (!draft) return null;
  if (saved) return <span className="chat-export-result">Saved to vault</span>;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/vault/person-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personName: draft.personName,
          docType: draft.docType,
          content: assistantContent
        })
      });
      if ((await res.json()).ok) setSaved(true);
    } catch {}
    setSaving(false);
  };

  return (
    <button className="chat-export-btn" onClick={handleSave} disabled={saving}>
      {saving ? 'Saving...' : `Save to ${draft.personName}'s vault folder`}
    </button>
  );
}

function detectExportIntent(message) {
  const patterns = [
    /export (this|that) as (a |an )?(word |docx )?doc(ument)?/i,
    /save (this|that) as (a |an )?(word |docx )?doc(ument)?/i,
    /create (a |an )?(word |docx )?doc(ument)? (from|with) this/i,
    /turn this into (a |an )?(word |docx )?doc(ument)?/i,
    /(download|get) (this |that )?as (a |an )?(word |docx )?doc(ument)?/i
  ];
  return patterns.some(p => p.test(message));
}

function ExportButton({ content }) {
  const [exporting, setExporting] = React.useState(false);
  const [exported, setExported] = React.useState(null);

  const handleExport = async () => {
    setExporting(true);
    const firstLine = content.split('\n')[0]
      .replace(/^#+\s*/, '')
      .replace(/[^a-z0-9\s]/gi, '')
      .trim()
      .substring(0, 40) || 'neuro-export';

    try {
      const res = await apiFetch('/api/vault/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: firstLine })
      });
      const data = await res.json();
      if (data.ok) setExported(data);
    } catch {}
    setExporting(false);
  };

  if (exported) {
    return (
      <div className="chat-export-result">
        Saved to vault: <code>{exported.path}</code>
        {exported.converted && ' (Word doc)'}
      </div>
    );
  }

  return (
    <button className="chat-export-btn" onClick={handleExport} disabled={exporting}>
      {exporting ? 'Exporting...' : 'Export as Document'}
    </button>
  );
}

function useVoiceInput() {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef(null);

  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const start = () => {
    if (!supported || listening) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setTranscript(final || interim);
    };

    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
    setTranscript('');
  };

  const stop = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  return { listening, transcript, start, stop, supported };
}

// speakSara imported from voiceUtils

export default function ChatPanel({ location }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) || `conv_${Date.now()}`;
  });
  const [conversations, setConversations] = useState([]);
  const [showConvList, setShowConvList] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [confirmation, setConfirmation] = React.useState(null);
  const [voiceOut, setVoiceOut] = useState(isVoiceOutEnabled);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const voice = useVoiceInput();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);

  // Detect vault write markers in latest assistant message
  useEffect(() => {
    if (streaming || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant') return;

    // [ADD TODO] — show confirmation
    const todoMatch = last.content.match(/\[ADD TODO:\s*(.+?)\]/);
    if (todoMatch) {
      // Already handled server-side — just show a toast
      setConfirmation({ type: 'todo', text: todoMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 4000);
    }

    // [MEETING NOTE] — show confirmation
    const meetingMatch = last.content.match(/\[MEETING NOTE:\s*(.+?)\]/);
    if (meetingMatch) {
      setConfirmation({ type: 'meeting', text: meetingMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 4000);
    }

    // [UPDATE PERSON] — show person update UI
    const personMatch = last.content.match(/\[UPDATE PERSON:\s*(.+?)\]/);
    if (personMatch) {
      setConfirmation({ type: 'person', text: personMatch[1].trim() });
      setTimeout(() => setConfirmation(null), 8000);
    }
  }, [messages, streaming]);

  // Voice input → fill input field
  useEffect(() => {
    if (voice.transcript) setInput(voice.transcript);
  }, [voice.transcript]);

  // Auto-send when voice input finishes
  const prevListening = useRef(false);
  useEffect(() => {
    if (prevListening.current && !voice.listening && voice.transcript.trim()) {
      setTimeout(() => sendMessage(), 100);
    }
    prevListening.current = voice.listening;
  }, [voice.listening]);

  // Speak SARA's response when streaming ends
  useEffect(() => {
    if (streaming || !voiceOut || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && last.content) {
      speakSara(last.content);
    }
  }, [streaming]);

  // Persist voice output preference
  const toggleVoiceOut = () => {
    setVoiceOut(v => {
      const next = !v;
      setVoiceOutEnabled(next);
      return next;
    });
  };

  // Persist conversationId
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, conversationId);
  }, [conversationId]);

  // Load last conversation on mount
  useEffect(() => {
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (savedId) {
      loadConversation(savedId);
    }
  }, []);

  // Fetch recent conversations list
  const refreshConvList = () => {
    fetch(apiUrl('/api/chat/conversations'))
      .then(r => r.json())
      .then(data => setConversations(data.conversations || []))
      .catch(() => {});
  };

  useEffect(() => { refreshConvList(); }, []);

  const loadConversation = async (convId) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(apiUrl(`/api/chat/history/${encodeURIComponent(convId)}`));
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        const msgs = data.messages.map(m => ({ role: m.role, content: m.content }));
        setMessages(msgs);
        setConversationId(convId);
      }
    } catch { /* ignore */ }
    setLoadingHistory(false);
    setShowConvList(false);
  };

  const startNew = () => {
    const newId = `conv_${Date.now()}`;
    setMessages([]);
    setConversationId(newId);
    setShowConvList(false);
    refreshConvList();
  };

  const [chatMode, setChatMode] = useState(null); // 'api' | 'local' | null

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreaming(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    const body = JSON.stringify({
      message: text,
      conversationId,
      location: location ? { lat: location.lat, lng: location.lng, accuracy: location.accuracy } : null
    });

    // Try streaming first (works with OpenAI through proxies)
    let streamed = false;
    try {
      const response = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.ok && response.headers.get('content-type')?.includes('event-stream')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'mode') {
                setChatMode(data.mode);
              } else if (data.type === 'text') {
                streamed = true;
                setMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: last.content + data.content };
                  }
                  return updated;
                });
              } else if (data.type === 'done') {
                if (data.provider) setChatMode(data.provider === 'openrouter' ? 'api' : 'local');
              } else if (data.type === 'error') {
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.content}` };
                  return updated;
                });
              }
            } catch {}
          }
        }
      }
    } catch (streamErr) {
      // Streaming failed — fall through to sync
      console.warn('Stream failed, trying sync:', streamErr.message);
    }

    // Sync fallback if streaming didn't produce content
    if (!streamed) {
      try {
        const response = await fetch(apiUrl('/api/chat/sync'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const data = await response.json();
        if (data.message) {
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: data.message };
            return updated;
          });
          setChatMode(data.mode || (data.provider === 'openrouter' ? 'api' : 'local'));
          if (data.conversationId) setConversationId(data.conversationId);
        } else if (data.error) {
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: `Error: ${data.error}` };
            return updated;
          });
        }
      } catch (syncErr) {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: `Connection error: ${syncErr.message}` };
          return updated;
        });
      }
    }

    setStreaming(false);
    refreshConvList();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span className="chat-title" onClick={() => setShowConvList(!showConvList)} style={{ cursor: 'pointer' }}>
          SARA {conversations.length > 0 && <span className="chat-conv-toggle">▾</span>}
        </span>
        <div className="chat-header-right">
          {'speechSynthesis' in window && (
            <button
              className={`chat-voice-toggle ${voiceOut ? 'active' : ''}`}
              onClick={toggleVoiceOut}
              title={voiceOut ? 'Voice on' : 'Voice off'}
            >
              {voiceOut ? '🔊' : '🔇'}
            </button>
          )}
          <span className="chat-status">
            {streaming ? '' : loadingHistory ? 'loading' : ''}
            {chatMode && !streaming && <span className="chat-mode">{chatMode === 'api' || chatMode === 'openrouter' ? 'API' : 'Local'}</span>}
          </span>
          <button className="chat-new-btn" onClick={startNew}>New</button>
        </div>
      </div>

      {showConvList && conversations.length > 0 && (
        <div className="chat-conv-list">
          {conversations.map(c => (
            <div
              key={c.conversation_id}
              className={`chat-conv-item ${c.conversation_id === conversationId ? 'active' : ''}`}
              onClick={() => loadConversation(c.conversation_id)}
            >
              <span className="chat-conv-preview">{c.preview || 'Empty'}</span>
              <span className="chat-conv-meta">{c.message_count} msgs</span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !loadingHistory && (
          <div className="chat-empty">
            <span className="chat-empty-label">SARA</span>
            <span className="chat-empty-text">Queue, team, priorities, vault — ask or tell me what to do.</span>
          </div>
        )}
        {messages.map((msg, i) => {
          const prevMsg = i > 0 ? messages[i - 1] : null;
          const isLast = i === messages.length - 1;
          const showExport = msg.role === 'assistant' && msg.content && msg.content.length > 200
            && !streaming && prevMsg?.role === 'user' && detectExportIntent(prevMsg.content);
          const isThinking = msg.role === 'assistant' && isLast && streaming && !msg.content;
          return (
            <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
              {msg.role === 'assistant' && (
                <span className="chat-msg-label">SARA</span>
              )}
              {msg.role === 'user' && (
                <span className="chat-msg-label chat-msg-label-user">You</span>
              )}
              {isThinking ? (
                <div className="chat-thinking">
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                </div>
              ) : msg.role === 'assistant' ? (
                <div className="chat-msg-body">
                  <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                  {msg.content && msg.content.length > 20 && !streaming && (
                    <TodoSaveButton messageContent={msg.content} apiUrlFn={apiUrl} />
                  )}
                  {showExport && <ExportButton content={msg.content} />}
                  {!streaming && prevMsg?.role === 'user' && (
                    <SaveDocButton userMessage={prevMsg.content} assistantContent={msg.content} />
                  )}
                </div>
              ) : (
                <div className="chat-msg-body">{msg.content}</div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {confirmation && (
        <div className={`chat-vault-confirmation ${confirmation.type}`}>
          {confirmation.type === 'todo' && `✓ Added to Master Todo: "${confirmation.text}"`}
          {confirmation.type === 'meeting' && `✓ Meeting note saved: "${confirmation.text}"`}
          {confirmation.type === 'person' && (
            <>
              Person update for <strong>{confirmation.text}</strong> — open People tab to update
            </>
          )}
        </div>
      )}

      <div className="chat-input-row">
        {voice.supported && (
          <button
            className={`chat-mic-btn ${voice.listening ? 'chat-mic-active' : ''}`}
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={streaming}
            title={voice.listening ? 'Stop listening' : 'Voice input'}
          >
            {voice.listening ? '◉' : '◎'}
          </button>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={voice.listening ? 'Listening...' : 'Message SARA...'}
          rows={1}
          disabled={streaming}
        />
        <button className="chat-send" onClick={sendMessage} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
