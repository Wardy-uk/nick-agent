import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { SHARED_PRESENTATION } from './presentation';
import { DEFAULT_VIEW, normalizeViewId, SARA_VIEWS } from './views';

// SARA shared state/context — the single in-app source of truth for every screen
// (WS2-WP1).
//
// Charter principle 7: all screens must read from the same shared state/context
// model; a screen may format, prioritise, or hide data, but must not become a
// separate source of truth. This provider is that shared layer for the frontend.
//
// It assembles three things into ONE value that screens consume read-only:
//   1. `model`        — the WS1 State Engine model, fetched from /api/state. This is
//                       the authoritative shared state (current state, location,
//                       confidence, current goal/focus, domains). The frontend does
//                       NOT re-derive or own any of it.
//   2. `presentation` — the shared placeholder UI-only fields (What Matters Now, Up
//                       Next, Quick Actions) housed in shared state (see
//                       presentation.js), NOT inside any screen. Every view reads
//                       this one block.
//   3. `now`          — a live clock ticked here, so screens read the current time
//                       from shared state instead of owning a timer of their own.
//
// It also holds the current-view selection (`currentView` / `setCurrentView`) — the
// concrete "current view" concept the architecture is built around.

const SaraStateContext = createContext(null);

function createMessage(role, text, extra = {}) {
  return {
    id: extra.id || `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    ...extra,
  };
}

function deriveOpeningMessages(model) {
  if (!model) return [];
  const messages = [
    createMessage('sara', `Hi Nick. You're at ${model.location?.label || 'an unknown spot'}.`, { kind: 'opening' }),
  ];
  if (model.briefing?.line) {
    messages.push(createMessage('sara', model.briefing.line, { kind: 'briefing' }));
  }
  return messages;
}

function extractAssistantDelta(payload) {
  if (!payload || payload === '[DONE]') return '';

  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed.delta === 'string') return parsed.delta;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.reply === 'string') return parsed.reply;
    if (Array.isArray(parsed.choices)) {
      const [choice] = parsed.choices;
      if (choice?.delta?.content) return String(choice.delta.content);
      if (choice?.message?.content) return String(choice.message.content);
      if (choice?.text) return String(choice.text);
    }
  } catch {
    return payload;
  }

  return '';
}

function parseSseChunk(rest, chunk) {
  const blocks = `${rest}${chunk}`.split(/\r?\n\r?\n/);
  const nextRest = blocks.pop() || '';
  const deltas = [];

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))
      .join('\n');

    const delta = extractAssistantDelta(data);
    if (!delta) continue;
    deltas.push(delta);
  }

  return { deltas, rest: nextRest };
}

function isWindowBackgrounded() {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

function mapFocusActionTargetToView(target) {
  const normalized = String(target || '').trim().toLowerCase();
  if (normalized === 'queue') return SARA_VIEWS.QUEUE;
  if (normalized === 'todos') return SARA_VIEWS.TODOS;
  if (normalized === 'standup' || normalized === 'meeting-prep') return SARA_VIEWS.STANDUP;
  if (normalized === 'imports' || normalized === 'brain') return SARA_VIEWS.VAULT;
  if (normalized === 'capture') return SARA_VIEWS.CAPTURE;
  if (normalized === 'chat' || normalized === 'inbox') return SARA_VIEWS.SARA;
  return SARA_VIEWS.FOCUS;
}

function focusActionFeedback(action) {
  if (!action) return 'Focus opened';
  return action.label || action.reason || 'Focus action opened';
}

function buildUrgentSnapshot(model) {
  if (!model) return null;

  const focus = model.domains?.focus?.current;
  const queue = model.domains?.queue;
  const eyesOn = model.nova?.eyesOn;
  const urgentItems = [];

  if (focus?.id) {
    urgentItems.push({
      key: `focus:${focus.id}`,
      title: focus.title || 'Current focus needs attention',
      detail: focus.reason || '',
      score: focus.deferCount > 0 ? 3 : 2,
      viewId: SARA_VIEWS.FOCUS,
    });
  }

  if ((queue?.breaching || 0) > 0) {
    urgentItems.push({
      key: `queue:breaching:${queue.breaching}`,
      title: `${queue.breaching} ticket${queue.breaching === 1 ? '' : 's'} breaching SLA`,
      detail: 'Queue needs a holding reply or re-triage.',
      score: 4 + Math.min(queue.breaching, 3),
      viewId: SARA_VIEWS.QUEUE,
    });
  }

  if ((queue?.overdue || 0) > 0) {
    urgentItems.push({
      key: `queue:overdue:${queue.overdue}`,
      title: `${queue.overdue} overdue customer${queue.overdue === 1 ? '' : 's'}`,
      detail: 'Customers are waiting beyond target.',
      score: 3 + Math.min(Math.ceil(queue.overdue / 10), 3),
      viewId: SARA_VIEWS.QUEUE,
    });
  }

  if (Array.isArray(eyesOn?.items)) {
    eyesOn.items
      .filter((item) => (item.priority ?? 99) <= 2)
      .slice(0, 5)
      .forEach((item) => {
        urgentItems.push({
          key: `eyes:${item.id}:${item.priority ?? 'x'}`,
          title: item.title || 'NOVA needs your eyes',
          detail: item.detail || item.ticketId || '',
          score: item.priority === 1 ? 6 : 5,
          viewId: SARA_VIEWS.ATWORK,
        });
      });
  }

  if ((eyesOn?.stats?.approvalsPending || 0) > 0) {
    urgentItems.push({
      key: `nova:approvals:${eyesOn.stats.approvalsPending}`,
      title: `${eyesOn.stats.approvalsPending} approval${eyesOn.stats.approvalsPending === 1 ? '' : 's'} waiting`,
      detail: 'NOVA has approvals queued for you.',
      score: 3 + Math.min(eyesOn.stats.approvalsPending, 3),
      viewId: SARA_VIEWS.ATWORK,
    });
  }

  if ((eyesOn?.stats?.customersOverdue || 0) > 0) {
    urgentItems.push({
      key: `nova:customers:${eyesOn.stats.customersOverdue}`,
      title: `${eyesOn.stats.customersOverdue} overdue customer${eyesOn.stats.customersOverdue === 1 ? '' : 's'}`,
      detail: 'NOVA is tracking overdue customers.',
      score: 3 + Math.min(Math.ceil(eyesOn.stats.customersOverdue / 10), 3),
      viewId: SARA_VIEWS.ATWORK,
    });
  }

  if (urgentItems.length === 0) return null;

  urgentItems.sort((a, b) => b.score - a.score);
  return {
    signature: urgentItems.map((item) => item.key).join('|'),
    score: urgentItems[0].score,
    top: urgentItems[0],
  };
}

async function maybeNotifyUrgentChange(snapshot, onOpen) {
  if (!snapshot || !isWindowBackgrounded()) return;

  if (snapshot.top.viewId) onOpen(snapshot.top.viewId);
  window.saraNative?.attention?.(true);

  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (Notification.permission === 'granted') {
    try {
      const notification = new Notification('SARA needs your eyes', {
        body: snapshot.top.detail ? `${snapshot.top.title} — ${snapshot.top.detail}` : snapshot.top.title,
        tag: `sara-urgent-${snapshot.top.key}`,
        renotify: true,
      });
      notification.onclick = () => {
        window.focus();
        if (snapshot.top.viewId) onOpen(snapshot.top.viewId);
        window.saraNative?.attention?.(true);
      };
    } catch {
      // Notification support varies between shells; attention() still covers desktop.
    }
  }
}

export function SaraStateProvider({ children }) {
  const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [currentView, setCurrentView] = useState(DEFAULT_VIEW);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatStatus, setChatStatus] = useState('idle'); // idle | sending | streaming | unavailable | error
  const [chatError, setChatError] = useState(null);
  const [chatBridge, setChatBridge] = useState({ status: 'checking', detail: null, available: false });
  const [neuroAuth, setNeuroAuth] = useState({ status: 'checking', configured: false, source: 'none', detail: null });
  const [actionFeedback, setActionFeedback] = useState(null);
  const [focusAssist, setFocusAssist] = useState({
    status: 'checking',
    error: null,
    nextAction: null,
    secondaryAction: null,
    canWait: [],
    autoExecuted: [],
  });
  const [interruptionNotice, setInterruptionNotice] = useState(null);
  const urgentSnapshotRef = useRef(null);
  const hasHydratedStateRef = useRef(false);
  const openUrgentViewRef = useRef((viewId) => setCurrentView(normalizeViewId(viewId)));

  useEffect(() => {
    openUrgentViewRef.current = (viewId) => setCurrentView(normalizeViewId(viewId));
  }, []);

  function applyIncomingModel(data) {
    const nextUrgentSnapshot = buildUrgentSnapshot(data);
    const previousUrgentSnapshot = urgentSnapshotRef.current;

    setModel(data);
    urgentSnapshotRef.current = nextUrgentSnapshot;

    if (
      hasHydratedStateRef.current &&
      nextUrgentSnapshot &&
      nextUrgentSnapshot.signature !== previousUrgentSnapshot?.signature &&
      nextUrgentSnapshot.score >= (previousUrgentSnapshot?.score ?? 0)
    ) {
      setInterruptionNotice({
        id: nextUrgentSnapshot.top.key,
        title: nextUrgentSnapshot.top.title,
        detail: nextUrgentSnapshot.top.detail || 'SARA detected a new urgent change.',
        viewId: nextUrgentSnapshot.top.viewId || null,
        createdAt: Date.now(),
      });
      void maybeNotifyUrgentChange(nextUrgentSnapshot, openUrgentViewRef.current);
    }

    hasHydratedStateRef.current = true;
  }

  function applyFocusAssist(data) {
    setFocusAssist({
      status: 'ready',
      error: null,
      nextAction: data?.nextAction || null,
      secondaryAction: data?.secondaryAction || null,
      canWait: Array.isArray(data?.canWait) ? data.canWait : [],
      autoExecuted: Array.isArray(data?.autoExecuted) ? data.autoExecuted : [],
    });
  }

  async function refreshFocusAssist() {
    try {
      const res = await fetch('/api/focus');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyFocusAssist(await res.json());
    } catch (e) {
      setFocusAssist((current) => ({
        ...current,
        status: 'error',
        error: e.message,
      }));
    }
  }

  function openFocusAction(action) {
    if (!action) {
      setCurrentView(normalizeViewId(SARA_VIEWS.FOCUS));
      setActionFeedback('Focus opened');
      return { ok: true };
    }

    const viewId = mapFocusActionTargetToView(action.target);
    setCurrentView(normalizeViewId(viewId));
    setActionFeedback(focusActionFeedback(action));
    return { ok: true, viewId, action };
  }

  // Read the one shared state model from the backend (the WS1 runtime path).
  useEffect(() => {
    let cancelled = false;
    async function loadState() {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        applyIncomingModel(data);
        setStatus('connected');
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e.message);
        setStatus('disconnected');
      }
    }

    loadState();
    const id = setInterval(loadState, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFocus() {
      try {
        const res = await fetch('/api/focus');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        applyFocusAssist(data);
      } catch (e) {
        if (cancelled) return;
        setFocusAssist((current) => ({
          ...current,
          status: 'error',
          error: e.message,
        }));
      }
    }

    loadFocus();
    const id = setInterval(loadFocus, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const releaseAttention = () => {
      if (!isWindowBackgrounded()) {
        window.saraNative?.attention?.(false);
      }
    };

    window.addEventListener('focus', releaseAttention);
    document.addEventListener('visibilitychange', releaseAttention);
    return () => {
      window.removeEventListener('focus', releaseAttention);
      document.removeEventListener('visibilitychange', releaseAttention);
    };
  }, []);

  useEffect(() => {
    if (!actionFeedback) return undefined;
    const id = setTimeout(() => setActionFeedback(null), 2600);
    return () => clearTimeout(id);
  }, [actionFeedback]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/neuro-auth');
        const data = await res.json();
        if (cancelled) return;
        setNeuroAuth({
          status: res.ok ? 'ready' : 'error',
          configured: Boolean(data.configured),
          source: data.source || 'none',
          detail: data.detail || null,
        });
      } catch (e) {
        if (cancelled) return;
        setNeuroAuth({ status: 'error', configured: false, source: 'none', detail: e.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live clock lives in shared state, not in any screen, so "current time" stays a
  // representation of shared state like everything else on a view.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/chat');
        const data = await res.json();
        if (cancelled) return;
        setChatBridge({
          status: res.ok ? 'available' : 'unavailable',
          available: res.ok && data.available !== false,
          detail: data.detail || data.reason || null,
          chatPath: data.chatPath || null,
        });
      } catch (e) {
        if (cancelled) return;
        setChatBridge({ status: 'error', available: false, detail: e.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the conversation from shared state once the model is available. This keeps the
  // opening read grounded in the same authoritative model every other screen consumes.
  useEffect(() => {
    if (!model) return;
    setChatMessages((current) => (current.length > 0 ? current : deriveOpeningMessages(model)));
  }, [model]);

  async function sendChat(message) {
    const trimmed = String(message || '').trim();
    if (!trimmed) return false;

    const placeholderId = `sara-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setChatError(null);
    setChatStatus('sending');
    setChatMessages((current) => [
      ...current,
      createMessage('user', trimmed),
      createMessage('sara', '', { id: placeholderId, pending: true }),
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const problem = await res.json();
          detail = problem.detail || problem.reason || detail;
        } catch {
          // keep the HTTP fallback
        }
        throw Object.assign(new Error(detail), { status: res.status });
      }

      if (contentType.includes('text/event-stream') && res.body) {
        setChatStatus('streaming');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let rest = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(rest, decoder.decode(value, { stream: true }));
          rest = parsed.rest;
          if (parsed.deltas.length > 0) {
            const deltaText = parsed.deltas.join('');
            setChatMessages((current) =>
              current.map((entry) =>
                entry.id === placeholderId ? { ...entry, text: `${entry.text}${deltaText}` } : entry
              )
            );
          }
        }

        const tail = decoder.decode();
        if (tail || rest) {
          const parsed = parseSseChunk(rest, `${tail}\n\n`);
          if (parsed.deltas.length > 0) {
            const deltaText = parsed.deltas.join('');
            setChatMessages((current) =>
              current.map((entry) =>
                entry.id === placeholderId ? { ...entry, text: `${entry.text}${deltaText}` } : entry
              )
            );
          }
        }
      } else if (contentType.includes('application/json')) {
        const body = await res.json();
        const text = body.reply || body.message || body.content || body.text || '';
        setChatMessages((current) =>
          current.map((entry) => (entry.id === placeholderId ? { ...entry, text, pending: false } : entry))
        );
      } else {
        const text = await res.text();
        setChatMessages((current) =>
          current.map((entry) => (entry.id === placeholderId ? { ...entry, text, pending: false } : entry))
        );
      }

      setChatMessages((current) =>
        current.map((entry) =>
          entry.id === placeholderId && !entry.text
            ? { ...entry, text: 'SARA answered, but the upstream stream carried no readable text.', pending: false }
            : entry.id === placeholderId
              ? { ...entry, pending: false }
              : entry
        )
      );
      setChatStatus('idle');
      return true;
    } catch (e) {
      const nextStatus = e.status === 503 ? 'unavailable' : 'error';
      setChatStatus(nextStatus);
      setChatError(e.message);
      setChatMessages((current) =>
        current.map((entry) =>
          entry.id === placeholderId
            ? {
                ...entry,
                pending: false,
                text:
                  nextStatus === 'unavailable'
                    ? `NEURO chat is not configured yet — ${e.message}`
                    : `SARA could not reach the NEURO chat upstream — ${e.message}`,
                error: true,
              }
            : entry
        )
      );
      return false;
    }
  }

  async function captureNote(content, title = '') {
    const trimmed = String(content || '').trim();
    if (!trimmed) return { ok: false, error: 'Note content is required.' };

    const res = await fetch('/api/capture/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, content: trimmed }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }

    try {
      const state = await fetch('/api/state');
      if (state.ok) applyIncomingModel(await state.json());
    } catch {
      // keep the successful capture result even if the follow-up refresh fails
    }
    return { ok: true, data: body };
  }

  async function captureTodo(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: 'Todo text is required.' };

    const res = await fetch('/api/capture/todo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }

    try {
      const state = await fetch('/api/state');
      if (state.ok) applyIncomingModel(await state.json());
    } catch {
      // keep the successful capture result even if the follow-up refresh fails
    }
    return { ok: true, data: body };
  }

  async function setNeuroPin(pin) {
    const trimmed = String(pin || '').trim();
    if (!trimmed) return { ok: false, error: 'PIN is required.' };
    const res = await fetch('/api/neuro-auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: trimmed }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };

    setNeuroAuth({ status: 'ready', configured: true, source: body.source || 'session', detail: null });
    try {
      const state = await fetch('/api/state');
      if (state.ok) applyIncomingModel(await state.json());
    } catch {
      // leave existing model in place if refresh fails
    }
    return { ok: true };
  }

  async function refreshModel() {
    try {
      const state = await fetch('/api/state');
      if (state.ok) applyIncomingModel(await state.json());
    } catch {
      // keep current state if refresh fails
    }
    await refreshFocusAssist();
  }

  async function approveTodoCandidate(actionId) {
    const res = await fetch(`/api/actions/${actionId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    await refreshModel();
    return { ok: true, data: body };
  }

  async function rejectTodoCandidate(actionId) {
    const res = await fetch(`/api/actions/${actionId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    await refreshModel();
    return { ok: true, data: body };
  }

  async function runQuickAction(actionId, payload = {}) {
    const action = String(actionId || '').trim();
    if (!action) return { ok: false, error: 'action is required' };

    if (action === 'capture') {
      setCurrentView(normalizeViewId('capture'));
      setActionFeedback('Capture ready');
      return { ok: true };
    }
    if (action === 'open-queue') {
      setCurrentView(normalizeViewId('executive-dashboard'));
      setActionFeedback('Queue opened');
      return { ok: true };
    }
    if (action === 'start-focus') {
      return openFocusAction(payload.action || focusAssist.nextAction);
    }
    if (action === 'daily-brief') {
      setCurrentView(normalizeViewId('standup'));
      setActionFeedback('Standup opened');
      return { ok: true };
    }
    if (action === 'defer-focus') {
      const res = await fetch('/api/actions/focus/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId: payload.itemId,
          itemType: payload.itemType || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = body.error || `HTTP ${res.status}`;
        setActionFeedback(error);
        return { ok: false, error };
      }
      await refreshModel();
      setActionFeedback('Focus deferred');
      return { ok: true };
    }
    if (action === 'done-focus') {
      const res = await fetch('/api/actions/focus/done', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionType: 'manual',
          detail: payload.detail || 'Completed focus item',
          itemId: payload.itemId || null,
          itemType: payload.itemType || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = body.error || `HTTP ${res.status}`;
        setActionFeedback(error);
        return { ok: false, error };
      }
      if (payload.itemId && !body.dismissed) {
        await fetch('/api/actions/focus/dismiss', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            itemId: payload.itemId,
            itemType: payload.itemType || null,
          }),
        }).catch(() => {});
      }
      await refreshModel();
      setActionFeedback('Focus retired');
      return { ok: true };
    }

    const error = `Unknown action: ${action}`;
    setActionFeedback(error);
    return { ok: false, error };
  }

  const value = {
    status,
    error,
    model,
    now,
    presentation: model?.presentation || SHARED_PRESENTATION,
    currentView,
    setCurrentView: (viewId) => setCurrentView(normalizeViewId(viewId)),
    chatMessages,
    chatStatus,
    chatError,
    chatBridge,
    neuroAuth,
    focusAssist,
    actionFeedback,
    interruptionNotice,
    dismissInterruptionNotice: () => setInterruptionNotice(null),
    openFocusAction,
    sendChat,
    captureNote,
    captureTodo,
    approveTodoCandidate,
    rejectTodoCandidate,
    setNeuroPin,
    runQuickAction,
  };

  return <SaraStateContext.Provider value={value}>{children}</SaraStateContext.Provider>;
}

// Read-only accessor. Throwing here keeps the discipline honest: a screen can only
// get its data by being mounted inside the shared-state provider.
export function useSaraState() {
  const ctx = useContext(SaraStateContext);
  if (!ctx) throw new Error('useSaraState must be used within a SaraStateProvider');
  return ctx;
}
