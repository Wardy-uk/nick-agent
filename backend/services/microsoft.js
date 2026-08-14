const msal = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');
const https = require('https');

// NOVA bridge — fallback when MSAL not authenticated
async function novaBridgeFetch(bridgePath, params = {}) {
  const baseUrl = process.env.NOVA_BRIDGE_URL;
  const secret = process.env.NOVA_BRIDGE_SECRET;
  if (!baseUrl || !secret) return null;

  try {
    const url = new URL(`/api/neuro-bridge${bridgePath}`, baseUrl);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const res = await fetch(url.toString(), {
      headers: { 'x-neuro-bridge-secret': secret },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.warn(`[Bridge] ${bridgePath} returned ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.ok ? json.data : null;
  } catch (e) {
    console.warn(`[Bridge] ${bridgePath} failed:`, e.message);
    return null;
  }
}

function isBridgeConfigured() {
  return !!(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

// Use the same client ID as @softeria/ms-365-mcp-server (NOVA's Graph integration)
// This is a public multi-tenant app with Graph permissions pre-consented
// Token cache shared with NOVA so auth carries across both tools
const NOVA_DATA_DIR = path.join('C:', 'Users', 'NickW', 'Claude', 'windows automation', 'daypilot', 'data');
const CACHE_PATH = process.env.MS_TOKEN_CACHE_PATH ||
  path.join(NOVA_DATA_DIR, '.ms365-token-cache.json');

// @softeria/ms-365-mcp-server's built-in public client ID (Graph permissions pre-granted)
const CLIENT_ID = process.env.MS_CLIENT_ID || '084a3e9f-a9f4-43f7-89f9-d229cf97853e';
const TENANT_ID = process.env.MS_TENANT_ID || 'db0f7383-5d7f-4a39-9841-02fbcd1444bd';

// Tasks.ReadWrite (was Tasks.Read) so completions can be pushed back to To Do
// and Planner. Deliberately not asking for Group.ReadWrite.All — it needs admin
// consent and would fail the whole grant; add it only if Planner writes 403.
//
// Calendars.ReadWrite (was Calendars.Read) so events can be created from NEURO.
// Mail.ReadWrite (was Mail.Read) so inbox items can be marked read on dismiss —
// it is a superset of Mail.Read, so nothing on the read path changes.
// People.Read resolves "abdi" to an address off the org's people graph.
// All three are delegated and user-consentable: no admin approval, so the
// device-code flow still completes on its own.
const GRAPH_SCOPES = [
  'Calendars.ReadWrite', 'Mail.ReadWrite', 'Mail.Send', 'Tasks.ReadWrite',
  'User.Read', 'Chat.Read', 'People.Read'
];

// Adding a scope here requires re-consent: call /api/microsoft/device-code on the
// Pi and follow the URL. Until that happens the cached token lacks the new scope
// and anything depending on it degrades gracefully (see email-sender.js, teams.js).
//
// NOT included: 'ChannelMessage.Read.All' (Teams *channel* message alerts). As a
// delegated scope it needs tenant admin consent — requesting it makes the whole
// device-code flow fail, taking Calendar/Mail down with it. Chat.Read alone still
// covers Teams DMs and @mentions in chats.

// Nick's wall-clock timezone. Both directions hang off this: Graph is asked to
// ANSWER in it (Prefer header on calendarView) and to READ writes in it, so no
// code here ever does an offset conversion by hand.
const EVENT_TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';

let msalClient = null;
let graphTokenCache = { accessToken: null, expiresOn: 0 };
let lastTokenError = null;

function isConfigured() {
  // Always configured — we use the MCP server's public client ID
  // Token cache may or may not exist yet (created on first auth)
  return true;
}

function getClient() {
  if (msalClient) return msalClient;

  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      try {
        if (fs.existsSync(CACHE_PATH)) {
          ctx.tokenCache.deserialize(fs.readFileSync(CACHE_PATH, 'utf-8'));
        }
      } catch (e) {
        console.error('[Microsoft] Cache read error:', e.message);
      }
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        try {
          const dir = path.dirname(CACHE_PATH);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(CACHE_PATH, ctx.tokenCache.serialize());
        } catch (e) {
          console.error('[Microsoft] Cache write error:', e.message);
        }
      }
    }
  };

  msalClient = new msal.PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`
    },
    cache: { cachePlugin }
  });

  return msalClient;
}

async function isAuthenticated() {
  try {
    const client = getClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    return accounts.length > 0;
  } catch {
    return false;
  }
}

// Try silent token acquisition using NOVA's cached refresh token
async function getAccessToken() {
  // Return cached token if still valid (5 min buffer)
  if (graphTokenCache.accessToken && Date.now() < graphTokenCache.expiresOn - 5 * 60 * 1000) {
    lastTokenError = null;
    return graphTokenCache.accessToken;
  }

  try {
    const client = getClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      console.warn('[Microsoft] No cached accounts found in NOVA token cache');
      return null;
    }

    const result = await client.acquireTokenSilent({
      scopes: GRAPH_SCOPES,
      account: accounts[0]
    });

    graphTokenCache = {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn.getTime()
    };

    lastTokenError = null;
    console.log('[Microsoft] Graph token acquired silently for', accounts[0].username);
    return result.accessToken;
  } catch (err) {
    // If silent fails, the app registration may lack Graph permissions
    // or the refresh token has expired — need device code flow
    lastTokenError = err?.message || String(err);
    console.warn('[Microsoft] Silent token acquisition failed:', err.message);
    return null;
  }
}

function getMailAccessStatus() {
  return {
    bridgeConfigured: isBridgeConfigured(),
    degraded: Boolean(lastTokenError),
    lastTokenError
  };
}

// Fallback: device code flow for Graph permissions (one-time)
let deviceCodePending = false;
let deviceCodeInfo = null;

async function startDeviceCodeFlow() {
  if (deviceCodePending) return deviceCodeInfo;

  const client = getClient();
  deviceCodePending = true;

  return new Promise((resolve, reject) => {
    client.acquireTokenByDeviceCode({
      scopes: GRAPH_SCOPES,
      deviceCodeCallback: (response) => {
        deviceCodeInfo = {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message
        };
        console.log('[Microsoft] Device code:', response.message);
        resolve(deviceCodeInfo);
      }
    }).then(result => {
      graphTokenCache = {
        accessToken: result.accessToken,
        expiresOn: result.expiresOn.getTime()
      };
      deviceCodePending = false;
      deviceCodeInfo = null;
      console.log('[Microsoft] Device code auth complete for', result.account.username);
    }).catch(err => {
      deviceCodePending = false;
      deviceCodeInfo = null;
      console.error('[Microsoft] Device code auth failed:', err.message);
    });
  });
}

// Graph API fetch helper
function graphFetch(urlPath, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.microsoft.com/v1.0${urlPath}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Bearer ${token}`, ...extraHeaders }
    };
    const req = https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) { resolve(null); return; }
        if (res.statusCode >= 400) { reject(new Error(`Graph API ${res.statusCode}: ${data.substring(0, 200)}`)); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Graph API timeout')); });
  });
}

// Fetch calendar events for a date range (YYYY-MM-DD strings)
async function fetchCalendarEvents(startDate, endDate) {
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const start = `${startDate}T00:00:00`;
      const end = `${endDate}T23:59:59`;
      // Without this Prefer header Graph answers in UTC, so every BST event came
      // back an hour early — the frontend slices the time out of the string and
      // does no conversion. It also makes Graph read the day window below as
      // local, which is what "events on the 14th" is supposed to mean.
      const data = await graphFetch(
        `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=50&$orderby=start/dateTime&$select=subject,start,end,location,isAllDay,showAs,isCancelled,attendees,organizer`,
        token,
        { Prefer: `outlook.timezone="${EVENT_TIMEZONE}"` }
      );
      if (data && data.value) {
        return data.value.map(event => {
          const startDt = event.start.dateTime;
          const endDt = event.end.dateTime;
          const date = startDt.split('T')[0];
          const startTime = startDt.split('T')[1]?.substring(0, 5);

          return {
            id: `graph-${date}-${startTime}-${(event.subject || '').substring(0, 20)}`,
            date,
            start: startDt,
            end: endDt,
            subject: event.subject || '(No subject)',
            location: event.location?.displayName || null,
            isAllDay: event.isAllDay,
            showAs: event.isCancelled ? 'cancelled' : (event.showAs || 'busy'),
            attendees: (event.attendees || []).map(a => ({
              name: a.emailAddress?.name || '',
              email: a.emailAddress?.address || '',
              status: a.status?.response || 'none',
            })),
            organizer: event.organizer?.emailAddress?.name || null,
          };
        });
      }
    } catch (err) {
      console.error('[Microsoft] Calendar fetch error:', err.message);
    }
  }

  // Priority 2 — NOVA bridge (when MSAL not authenticated)
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/calendar', { start: startDate, end: endDate });
      if (bridgeData) {
        // Bridge returns Graph API format — map to NEURO format
        const events = Array.isArray(bridgeData) ? bridgeData :
          (bridgeData.value || []);
        if (events.length > 0) {
          console.log(`[Calendar] Bridge returned ${events.length} events`);
          return events.map(e => ({
            id: e.id,
            subject: e.subject,
            start: e.start?.dateTime || e.start,
            end: e.end?.dateTime || e.end,
            location: e.location?.displayName || null,
            isAllDay: e.isAllDay || false,
            organizer: e.organizer?.emailAddress?.name || null,
            showAs: e.showAs || 'busy'
          }));
        }
      }
    } catch (e) {
      console.warn('[Calendar] Bridge failed:', e.message);
    }
  }

  return null;
}

// Fetch recent emails — unread + recent (last N hours)
async function fetchRecentEmails(hoursBack = 24, maxResults = 50) {
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
      const filter = `receivedDateTime ge ${since}`;
      const select = 'id,subject,from,receivedDateTime,isRead,importance,flag,bodyPreview,hasAttachments';
      const data = await graphFetch(
        `/me/mailFolders/Inbox/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=${select}`,
        token
      );
      if (data && data.value) {
        return data.value.map(msg => ({
          id: msg.id,
          subject: msg.subject || '(No subject)',
          from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
          fromEmail: msg.from?.emailAddress?.address || '',
          received: msg.receivedDateTime,
          isRead: msg.isRead,
          importance: msg.importance,
          isFlagged: msg.flag?.flagStatus === 'flagged',
          preview: (msg.bodyPreview || '').substring(0, 300),
          hasAttachments: msg.hasAttachments
        }));
      }
    } catch (err) {
      console.error('[Microsoft] Email fetch error:', err.message);
    }
  }

  // Priority 2 — NOVA bridge fallback
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/mail', {
        count: maxResults || 40,
        unreadOnly: false
      });
      if (bridgeData) {
        const messages = Array.isArray(bridgeData) ? bridgeData :
          (bridgeData.value || []);
        return messages.map(m => ({
          id: m.id,
          subject: m.subject,
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '',
          fromEmail: m.from?.emailAddress?.address || '',
          received: m.receivedDateTime,
          isRead: m.isRead,
          importance: m.importance,
          isFlagged: m.flag?.flagStatus === 'flagged',
          preview: m.bodyPreview || '',
          hasAttachments: m.hasAttachments || false
        }));
      }
    } catch (e) {
      console.warn('[Mail] Bridge failed:', e.message);
    }
  }

  return null;
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Who we're signed in as — so reply-all doesn't cc Nick back to himself.
async function getSignedInAddress() {
  try {
    const accounts = await getClient().getTokenCache().getAllAccounts();
    return accounts[0]?.username || null;
  } catch {
    return null;
  }
}

function mapAddresses(list) {
  return (list || [])
    .map((item) => ({
      name: item.emailAddress?.name || item.emailAddress?.address || '',
      email: item.emailAddress?.address || '',
    }))
    .filter((r) => r.email);
}

async function fetchEmailById(emailId) {
  if (!emailId) return null;

  const token = await getAccessToken();
  if (token) {
    try {
      const select = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,flag,bodyPreview,body,hasAttachments,webLink';
      const msg = await graphFetch(`/me/messages/${encodeURIComponent(emailId)}?$select=${select}`, token);
      if (msg?.id) {
        return {
          id: msg.id,
          subject: msg.subject || '(No subject)',
          from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
          fromEmail: msg.from?.emailAddress?.address || '',
          to: (msg.toRecipients || []).map((item) => item.emailAddress?.name || item.emailAddress?.address).filter(Boolean),
          cc: (msg.ccRecipients || []).map((item) => item.emailAddress?.name || item.emailAddress?.address).filter(Boolean),
          // Names alone can't be replied to — keep the addresses for the composer.
          recipients: {
            to: mapAddresses(msg.toRecipients),
            cc: mapAddresses(msg.ccRecipients),
          },
          received: msg.receivedDateTime,
          isRead: msg.isRead,
          importance: msg.importance,
          isFlagged: msg.flag?.flagStatus === 'flagged',
          preview: msg.bodyPreview || '',
          body: htmlToText(msg.body?.content || msg.bodyPreview || ''),
          hasAttachments: msg.hasAttachments,
          webLink: msg.webLink || null,
        };
      }
    } catch (err) {
      console.error('[Microsoft] Email detail fetch error:', err.message);
    }
  }

  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch(`/mail/${encodeURIComponent(emailId)}`);
      if (bridgeData?.id) {
        return {
          id: bridgeData.id,
          subject: bridgeData.subject || '(No subject)',
          from: bridgeData.from?.emailAddress?.name || bridgeData.from?.emailAddress?.address || 'Unknown',
          fromEmail: bridgeData.from?.emailAddress?.address || '',
          to: (bridgeData.toRecipients || []).map((item) => item.emailAddress?.name || item.emailAddress?.address).filter(Boolean),
          cc: (bridgeData.ccRecipients || []).map((item) => item.emailAddress?.name || item.emailAddress?.address).filter(Boolean),
          received: bridgeData.receivedDateTime,
          isRead: bridgeData.isRead,
          importance: bridgeData.importance,
          isFlagged: bridgeData.flag?.flagStatus === 'flagged',
          preview: bridgeData.bodyPreview || '',
          body: htmlToText(bridgeData.body?.content || bridgeData.bodyPreview || ''),
          hasAttachments: Boolean(bridgeData.hasAttachments),
          webLink: bridgeData.webLink || null,
        };
      }
    } catch (e) {
      console.warn('[Mail] Bridge detail failed:', e.message);
    }
  }

  return null;
}

// Fetch To-Do task lists
async function fetchTodoLists() {
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await graphFetch('/me/todo/lists', token);
      if (data && data.value) return data.value;
    } catch (err) {
      console.error('[Microsoft] ToDo lists fetch error:', err.message);
    }
  }
  // Priority 2 — NOVA bridge
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/todo/lists');
      if (bridgeData) return bridgeData.value || bridgeData || [];
    } catch (e) { console.warn('[ToDo] Bridge lists failed:', e.message); }
  }
  return null;
}

// The vault only records a bare <!--id:...--> for Microsoft tasks, so completing
// a To-Do needs its list back. Every sync pass fills this in; a cold start falls
// back to searching the lists.
const _todoListByTask = new Map();

// Fetch To-Do tasks for a specific list
async function fetchTodoTasks(listId) {
  if (!listId) return null;
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await graphFetch(`/me/todo/lists/${listId}/tasks?$top=100&$filter=status ne 'completed'`, token);
      if (data && data.value) {
        data.value.forEach(t => { if (t.id) _todoListByTask.set(t.id, listId); });
        return data.value;
      }
    } catch (err) {
      console.error('[Microsoft] ToDo tasks fetch error:', err.message);
    }
  }
  // Priority 2 — NOVA bridge
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/todo/tasks', { listId });
      if (bridgeData) return bridgeData.value || bridgeData || [];
    } catch (e) { console.warn('[ToDo] Bridge tasks failed:', e.message); }
  }
  return null;
}

// Fetch Planner tasks assigned to me
async function fetchPlannerTasks() {
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await graphFetch('/me/planner/tasks?$top=200', token);
      if (data && data.value) return data.value;
    } catch (err) {
      console.error('[Microsoft] Planner fetch error:', err.message);
    }
  }
  // Priority 2 — NOVA bridge
  if (isBridgeConfigured()) {
    try {
      const bridgeData = await novaBridgeFetch('/planner/tasks');
      if (bridgeData) return bridgeData.value || bridgeData || [];
    } catch (e) { console.warn('[Planner] Bridge failed:', e.message); }
  }
  return null;
}

// Create a To-Do task via bridge
async function createTodoTask(listId, title, body) {
  if (isBridgeConfigured()) {
    const baseUrl = process.env.NOVA_BRIDGE_URL;
    const secret = process.env.NOVA_BRIDGE_SECRET;
    try {
      const res = await fetch(`${baseUrl}/api/neuro-bridge/todo/tasks`, {
        method: 'POST',
        headers: { 'x-neuro-bridge-secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoTaskListId: listId, title, body: body || '' }),
        signal: AbortSignal.timeout(10000)
      });
      const json = await res.json();
      return json.ok ? json.data : null;
    } catch (e) { console.warn('[ToDo] Create failed:', e.message); }
  }
  return null;
}

// Update a To-Do task via bridge (e.g. mark complete)
async function updateTodoTask(taskId, listId, updates) {
  if (isBridgeConfigured()) {
    const baseUrl = process.env.NOVA_BRIDGE_URL;
    const secret = process.env.NOVA_BRIDGE_SECRET;
    try {
      const res = await fetch(`${baseUrl}/api/neuro-bridge/todo/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'x-neuro-bridge-secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoTaskListId: listId, ...updates }),
        signal: AbortSignal.timeout(10000)
      });
      const json = await res.json();
      return json.ok ? json.data : null;
    } catch (e) { console.warn('[ToDo] Update failed:', e.message); }
  }
  return null;
}

// Update a Planner task via bridge
async function updatePlannerTask(taskId, updates) {
  if (isBridgeConfigured()) {
    const baseUrl = process.env.NOVA_BRIDGE_URL;
    const secret = process.env.NOVA_BRIDGE_SECRET;
    try {
      const res = await fetch(`${baseUrl}/api/neuro-bridge/planner/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'x-neuro-bridge-secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(10000)
      });
      const json = await res.json();
      return json.ok ? json.data : null;
    } catch (e) { console.warn('[Planner] Update failed:', e.message); }
  }
  return null;
}

// graphFetch is GET-only (https.get), so writes go through this.
async function graphWrite(urlPath, method, body, token, extraHeaders = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) return { ok: false, status: 401, reason: 'auth' };
  if (res.status === 403) return { ok: false, status: 403, reason: 'scope' };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, reason: `http_${res.status}`, detail: detail.slice(0, 300) };
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 204 No Content */ }
  return { ok: true, status: res.status, data };
}

// Which To-Do list holds this task? Cache first, then walk the lists.
async function _resolveTodoList(taskId, token) {
  if (_todoListByTask.has(taskId)) return _todoListByTask.get(taskId);
  const lists = await fetchTodoLists();
  if (!Array.isArray(lists)) return null;
  for (const list of lists) {
    try {
      const task = await graphFetch(`/me/todo/lists/${list.id}/tasks/${encodeURIComponent(taskId)}`, token);
      if (task?.id) {
        _todoListByTask.set(taskId, list.id);
        return list.id;
      }
    } catch { /* 404 in this list — keep looking */ }
  }
  return null;
}

async function completeTodoTask(taskId, listId = null) {
  const token = await getAccessToken();
  if (!token) return { completed: false, reason: 'auth' };

  const resolved = listId || await _resolveTodoList(taskId, token);
  if (!resolved) return { completed: false, reason: 'list_not_found' };

  const result = await graphWrite(
    `/me/todo/lists/${resolved}/tasks/${encodeURIComponent(taskId)}`,
    'PATCH',
    { status: 'completed' },
    token
  );
  if (!result.ok) {
    console.warn(`[ToDo] Complete failed for ${taskId}: ${result.reason} ${result.detail || ''}`);
    return { completed: false, reason: result.reason };
  }
  console.log(`[ToDo] Completed ${taskId}`);
  return { completed: true, kind: 'todo' };
}

// Planner PATCHes are optimistically concurrent — Graph rejects them without a
// matching If-Match etag, so read the task first.
async function completePlannerTask(taskId) {
  const token = await getAccessToken();
  if (!token) return { completed: false, reason: 'auth' };

  let etag = null;
  try {
    const task = await graphFetch(`/planner/tasks/${encodeURIComponent(taskId)}`, token);
    etag = task?.['@odata.etag'] || null;
  } catch (e) {
    console.warn(`[Planner] Could not read ${taskId}: ${e.message}`);
  }
  if (!etag) return { completed: false, reason: 'not_found' };

  const result = await graphWrite(
    `/planner/tasks/${encodeURIComponent(taskId)}`,
    'PATCH',
    { percentComplete: 100 },
    token,
    { 'If-Match': etag }
  );
  if (!result.ok) {
    console.warn(`[Planner] Complete failed for ${taskId}: ${result.reason} ${result.detail || ''}`);
    return { completed: false, reason: result.reason };
  }
  console.log(`[Planner] Completed ${taskId}`);
  return { completed: true, kind: 'planner' };
}

// Complete by id, using the vault's section label as a hint. Without one, try
// Planner then To-Do.
async function completeMicrosoftTask(taskId, source = null, listId = null) {
  if (!taskId) return { completed: false, reason: 'no_task_id' };

  if (/planner/i.test(source || '')) return completePlannerTask(taskId);
  if (/todo|to-do/i.test(source || '')) return completeTodoTask(taskId, listId);

  const planner = await completePlannerTask(taskId);
  if (planner.completed) return planner;
  return completeTodoTask(taskId, listId);
}

// Reply to a message via Graph. Needs Mail.Send — degrades with a reason
// instead of throwing so the UI can tell Nick what to fix.
//
// The /reply action addresses the message itself and can only ever ADD
// recipients, so when the composer hands us an explicit list we go the long way
// round: createReply gives a draft (with the quoted original), we overwrite its
// recipients and prepend the reply text, then send it.
async function sendEmailReply(emailId, bodyText, { replyAll = false, to = null, cc = null } = {}) {
  const text = String(bodyText || '').trim();
  if (!emailId) return { sent: false, reason: 'no_email_id' };
  if (!text) return { sent: false, reason: 'empty_body' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.warn('[Mail] Reply auth failed:', e.message);
    return { sent: false, reason: 'auth' };
  }
  if (!token) return { sent: false, reason: 'auth' };

  const html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  if (Array.isArray(to)) {
    return _sendReplyWithRecipients(emailId, html, to, cc || [], token);
  }

  const action = replyAll ? 'replyAll' : 'reply';
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(emailId)}/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: html }),
        signal: AbortSignal.timeout(30000)
      }
    );
    if (res.status === 403) {
      console.log('[Mail] Reply blocked — Mail.Send scope not granted');
      return { sent: false, reason: 'scope' };
    }
    if (res.status === 202 || res.ok) {
      console.log(`[Mail] Reply sent for ${emailId}`);
      return { sent: true };
    }
    const detail = await res.text().catch(() => '');
    console.error(`[Mail] Reply failed ${res.status}:`, detail.slice(0, 300));
    return { sent: false, reason: `http_${res.status}` };
  } catch (e) {
    console.error('[Mail] Reply error:', e.message);
    return { sent: false, reason: 'error', error: e.message };
  }
}

function toGraphRecipients(list) {
  return (list || [])
    .map((r) => (typeof r === 'string' ? r : r.email))
    .map((address) => String(address || '').trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// createReply → set recipients + body → send. Three calls, but it's the only
// way to drop a recipient the original thread had.
async function _sendReplyWithRecipients(emailId, html, to, cc, token) {
  const toList = toGraphRecipients(to);
  if (!toList.length) return { sent: false, reason: 'no_recipients' };

  const draft = await graphWrite(
    `/me/messages/${encodeURIComponent(emailId)}/createReply`,
    'POST',
    {},
    token
  );
  if (!draft.ok || !draft.data?.id) {
    console.error('[Mail] createReply failed:', draft.reason, draft.detail || '');
    return { sent: false, reason: draft.reason || 'createreply_failed' };
  }

  const draftId = draft.data.id;
  // Keep the quoted original the draft already carries, above it our text.
  const quoted = draft.data.body?.content || '';
  const patched = await graphWrite(
    `/me/messages/${encodeURIComponent(draftId)}`,
    'PATCH',
    {
      toRecipients: toList,
      ccRecipients: toGraphRecipients(cc),
      body: { contentType: 'HTML', content: `<div>${html}</div>${quoted}` },
    },
    token
  );
  if (!patched.ok) {
    console.error('[Mail] Draft PATCH failed:', patched.reason, patched.detail || '');
    return { sent: false, reason: patched.reason };
  }

  const sent = await graphWrite(
    `/me/messages/${encodeURIComponent(draftId)}/send`,
    'POST',
    undefined,
    token
  );
  if (!sent.ok) {
    console.error('[Mail] Draft send failed:', sent.reason, sent.detail || '');
    return { sent: false, reason: sent.reason };
  }

  console.log(`[Mail] Reply sent for ${emailId} to ${toList.length} recipient(s)`);
  return { sent: true };
}

// Create an event on the default calendar. Needs Calendars.ReadWrite — degrades
// with a reason instead of throwing so the UI can tell Nick what to fix.
//
// start/end are naive local strings ('2026-08-15T14:00:00'), NOT ISO instants.
// Sending attendees makes Graph email the invite, so this is only ever called
// behind an explicit confirm.
async function createCalendarEvent({
  subject, start, end, attendees = [], location = null,
  body = null, isAllDay = false, isOnline = false,
} = {}) {
  if (!subject || !String(subject).trim()) return { created: false, reason: 'no_subject' };
  if (!start || !end) return { created: false, reason: 'no_times' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.warn('[Calendar] Create auth failed:', e.message);
    return { created: false, reason: 'auth' };
  }
  if (!token) return { created: false, reason: 'auth' };

  const payload = {
    subject: String(subject).trim(),
    start: { dateTime: start, timeZone: EVENT_TIMEZONE },
    end: { dateTime: end, timeZone: EVENT_TIMEZONE },
    isAllDay: Boolean(isAllDay),
    attendees: toGraphRecipients(attendees).map((r) => ({ ...r, type: 'required' })),
  };
  if (location) payload.location = { displayName: String(location) };
  if (body) payload.body = { contentType: 'text', content: String(body) };
  if (isOnline) {
    payload.isOnlineMeeting = true;
    payload.onlineMeetingProvider = 'teamsForBusiness';
  }

  const result = await graphWrite('/me/events', 'POST', payload, token);
  if (!result.ok) {
    console.warn(`[Calendar] Create failed: ${result.reason} ${result.detail || ''}`);
    return { created: false, reason: result.reason, detail: result.detail };
  }

  const ev = result.data || {};
  console.log(`[Calendar] Created "${payload.subject}" at ${start} (${payload.attendees.length} attendee(s))`);
  return {
    created: true,
    event: {
      id: ev.id || null,
      subject: ev.subject || payload.subject,
      start: ev.start?.dateTime || start,
      end: ev.end?.dateTime || end,
      webLink: ev.webLink || null,
      onlineMeetingUrl: ev.onlineMeeting?.joinUrl || null,
    },
  };
}

/**
 * Fetch one calendar event in full. The calendar cache stores no body, and
 * adding a column would collide with work in flight — but agenda checks run
 * over a handful of upcoming meetings, so fetching fresh detail is cheap and
 * avoids reasoning about a stale cache anyway.
 */
async function fetchEventById(eventId) {
  if (!eventId) return null;
  let token;
  try { token = await getAccessToken(); } catch { return null; }
  if (!token) return null;

  const select = 'id,subject,bodyPreview,body,start,end,location,attendees,organizer,isOrganizer,isCancelled,type,seriesMasterId,responseStatus,webLink,onlineMeeting';
  try {
    const data = await graphFetch(`/me/events/${encodeURIComponent(eventId)}?$select=${select}`, token);
    if (!data || !data.id) return null;
    return {
      id: data.id,
      subject: data.subject || '',
      bodyPreview: data.bodyPreview || '',
      bodyHtml: data.body?.content || '',
      start: data.start?.dateTime || null,
      end: data.end?.dateTime || null,
      location: data.location?.displayName || null,
      organizer: data.organizer?.emailAddress || null,
      isOrganizer: Boolean(data.isOrganizer),
      isCancelled: Boolean(data.isCancelled),
      // 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
      type: data.type || 'singleInstance',
      responseStatus: data.responseStatus?.response || null,
      attendees: (data.attendees || []).map(a => ({
        name: a.emailAddress?.name || '',
        email: a.emailAddress?.address || '',
        type: a.type || 'required',
      })),
      webLink: data.webLink || null,
      isOnline: Boolean(data.onlineMeeting),
    };
  } catch (e) {
    console.warn('[Calendar] Event fetch failed:', e.message);
    return null;
  }
}

/**
 * Respond to a meeting invitation.
 *
 * `proposedNewTime` turns a decline or tentative into a counter-proposal, which
 * is the useful form: "no, but here" moves the meeting instead of bouncing it
 * back to the organiser to solve.
 */
async function respondToEvent(eventId, response, { comment = '', proposedNewTime = null, sendResponse = true } = {}) {
  const verb = { accept: 'accept', decline: 'decline', tentative: 'tentativelyAccept' }[response];
  if (!eventId) return { ok: false, reason: 'no_event_id' };
  if (!verb) return { ok: false, reason: 'bad_response' };
  // Graph only accepts a counter-proposal on decline/tentative, never accept.
  if (proposedNewTime && response === 'accept') return { ok: false, reason: 'cannot_propose_on_accept' };

  let token;
  try { token = await getAccessToken(); } catch { return { ok: false, reason: 'auth' }; }
  if (!token) return { ok: false, reason: 'auth' };

  const payload = { comment: String(comment || ''), sendResponse: Boolean(sendResponse) };
  if (proposedNewTime?.start && proposedNewTime?.end) {
    payload.proposedNewTime = {
      start: { dateTime: proposedNewTime.start, timeZone: EVENT_TIMEZONE },
      end: { dateTime: proposedNewTime.end, timeZone: EVENT_TIMEZONE },
    };
  }

  const result = await graphWrite(`/me/events/${encodeURIComponent(eventId)}/${verb}`, 'POST', payload, token);
  if (!result.ok) {
    console.warn(`[Calendar] ${verb} failed: ${result.reason} ${result.detail || ''}`);
    return { ok: false, reason: result.reason, detail: result.detail };
  }
  console.log(`[Calendar] ${verb} sent for ${eventId}${payload.proposedNewTime ? ' with a counter-proposal' : ''}`);
  return { ok: true, response, proposed: Boolean(payload.proposedNewTime) };
}

// Mark a message read in Outlook. Needs Mail.ReadWrite.
async function markEmailRead(emailId) {
  if (!emailId) return { marked: false, reason: 'no_email_id' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { marked: false, reason: 'auth' };
  }
  if (!token) return { marked: false, reason: 'auth' };

  const result = await graphWrite(
    `/me/messages/${encodeURIComponent(emailId)}`,
    'PATCH',
    { isRead: true },
    token
  );
  if (!result.ok) {
    console.warn(`[Mail] Mark-read failed for ${emailId}: ${result.reason} ${result.detail || ''}`);
    return { marked: false, reason: result.reason };
  }
  return { marked: true };
}

// Search the org people graph for a name. Needs People.Read; returns [] rather
// than throwing so callers can fall back to locally-harvested addresses.
async function searchPeople(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];

  let token;
  try {
    token = await getAccessToken();
  } catch { return []; }
  if (!token) return [];

  try {
    const data = await graphFetch(
      `/me/people?$search=${encodeURIComponent(`"${q}"`)}&$top=${limit}&$select=displayName,scoredEmailAddresses,personType`,
      token
    );
    return (data?.value || [])
      .map((p) => ({
        name: p.displayName || '',
        email: p.scoredEmailAddresses?.[0]?.address || '',
        source: 'graph',
      }))
      .filter((p) => p.email);
  } catch (e) {
    console.warn('[People] Search failed:', e.message);
    return [];
  }
}

module.exports = {
  isConfigured,
  isAuthenticated,
  isBridgeConfigured,
  getMailAccessStatus,
  getAccessToken,
  startDeviceCodeFlow,
  fetchCalendarEvents,
  createCalendarEvent,
  fetchEventById,
  respondToEvent,
  fetchRecentEmails,
  fetchEmailById,
  sendEmailReply,
  markEmailRead,
  searchPeople,
  EVENT_TIMEZONE,
  getSignedInAddress,
  fetchTodoLists,
  fetchTodoTasks,
  fetchPlannerTasks,
  createTodoTask,
  updateTodoTask,
  updatePlannerTask,
  completeTodoTask,
  completePlannerTask,
  completeMicrosoftTask,
  graphFetch,
  graphWrite
};
