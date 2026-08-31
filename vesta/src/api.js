/**
 * VESTA's client. Talks to /api/v — NEURO's one public mount.
 *
 * ⚠ THIS CLIENT ENFORCES NOTHING. Every rule that matters lives on the server:
 * the calendar is redacted in `services/vesta.js` before a subject is anywhere
 * near a response, scopes are re-checked on every route, and a private
 * catalogue answers 404. `scopes` below is used to decide what to RENDER, which
 * is a convenience for her, never a boundary. If you ever find yourself
 * filtering something here for safety, the safety belongs upstream.
 */

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};

// Dev: '' → relative, Vite proxies. Prod: the Pi's public Funnel address.
export const API_BASE = ENV.VITE_API_URL || '';
export const BUILD_LABEL = ENV.VITE_BUILD_LABEL || 'dev';

const TOKEN_KEY = 'vesta_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/**
 * A failed call, with the server's own words kept.
 *
 * ⚠ The message matters here more than usual. Five wrong PINs lock the account
 * for fifteen minutes and the API says so in a sentence meant to be read — a
 * client that flattened every failure to "Sign-in failed" would leave her
 * retrying a locked account with no idea why.
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    // 401 on anything but sign-in means the session is gone, not that she got
    // something wrong.
    this.expired = status === 401;
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // ⚠ Distinct from every server-sent failure, and it has to be: "the Pi is
    // unreachable" and "the fridge is empty" must never read alike.
    throw new ApiError("I can't reach home right now. Try again in a moment.", 0);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new ApiError(json.error || 'Something went wrong.', res.status);
  }
  return json;
}

export const login = (username, pin) =>
  call('/login', { method: 'POST', body: { username, pin } });

export const home = (token) => call('/home', { token });

/** One day of his diary, for the date picker. Redacted server-side like /home. */
export const calendarDay = (token, date) =>
  call(`/calendar?date=${encodeURIComponent(date)}`, { token });

export const addTask = (token, text, assignee = null) =>
  call('/tasks', { method: 'POST', body: { text, assignee }, token });

export const addItem = (token, slug, section, name) =>
  call(`/catalogue/${encodeURIComponent(slug)}/add`, {
    method: 'POST', body: { section, name }, token,
  });

/**
 * A photograph in, a PROPOSED list out. Writes nothing — everything it suggests
 * still goes through `addItem` after she has agreed to it.
 */
export const scanPhoto = (token, slug, image, mediaType) =>
  call(`/catalogue/${encodeURIComponent(slug)}/scan`, {
    method: 'POST', body: { image, mediaType }, token,
  });

export const useItem = (token, slug, section, name) =>
  call(`/catalogue/${encodeURIComponent(slug)}/used`, {
    method: 'POST', body: { section, name }, token,
  });
