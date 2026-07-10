// API client for SARA mobile. Talks to the NEURO brain.
//   Dev:  API_BASE = '' → calls are relative, Vite proxies /api → NEURO backend.
//   Prod: API_BASE = VITE_API_URL → the NEURO backend's Tailscale Serve HTTPS URL.
// Auth matches the NEURO/machine convention: PIN header on every /api call,
// vault API key on /api/vault* routes.
export const API_BASE = import.meta.env.VITE_API_URL || '';

const VAULT_API_KEY = import.meta.env.VITE_VAULT_API_KEY || '';
const PIN_KEY = 'neuro_pin';

export function getPin() {
  try { return localStorage.getItem(PIN_KEY) || ''; }
  catch { return ''; }
}

export function setPin(pin) {
  try { localStorage.setItem(PIN_KEY, pin); }
  catch {}
}

export function clearPin() {
  try { localStorage.removeItem(PIN_KEY); }
  catch {}
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Fetch wrapper — attaches PIN auth (+ vault key for vault routes) and parses JSON.
// Throws on non-2xx so views can show a clear error instead of rendering bad data.
export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  const pin = getPin();
  if (pin) headers['X-Neuro-Pin'] = pin;
  if (path.startsWith('/api/vault') && VAULT_API_KEY) headers['X-Api-Key'] = VAULT_API_KEY;

  const res = await fetch(apiUrl(path), { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Streaming chat over the brain's SSE endpoint (POST /api/chat). Parses the
// `data: {...}` event stream and fans out to callbacks. Falls back is the caller's
// job — if this throws, call /api/chat/sync instead.
export async function chatStream(body, { onMode, onChunk, onDone, onError, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const pin = getPin();
  if (pin) headers['X-Neuro-Pin'] = pin;

  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop(); // keep the trailing partial frame
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'mode') onMode?.(evt.mode);
      else if (evt.type === 'chunk') onChunk?.(evt.content);
      else if (evt.type === 'done') onDone?.(evt.provider);
      else if (evt.type === 'error') onError?.(evt.content);
    }
  }
}
