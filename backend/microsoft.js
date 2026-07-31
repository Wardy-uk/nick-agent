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

const GRAPH_SCOPES = ['Calendars.Read', 'Mail.Read', 'Tasks.Read', 'User.Read'];

// Additional scopes to add Monday via device code re-consent:
//   'Mail.Send'               — enables brief emails
//   'Chat.Read'               — enables Teams DM + mention alerts
//   'ChannelMessage.Read.All' — enables Teams channel message alerts
// To activate: add to GRAPH_SCOPES above, then call /api/microsoft/device-code on the Pi.

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
function graphFetch(urlPath, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.microsoft.com/v1.0${urlPath}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Bearer ${token}` }
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
      const data = await graphFetch(
        `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=50&$orderby=start/dateTime&$select=subject,start,end,location,isAllDay,showAs,isCancelled,attendees,organizer`,
        token
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

// Fetch To-Do tasks for a specific list
async function fetchTodoTasks(listId) {
  if (!listId) return null;
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await graphFetch(`/me/todo/lists/${listId}/tasks?$top=100&$filter=status ne 'completed'`, token);
      if (data && data.value) return data.value;
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

module.exports = {
  isConfigured,
  isAuthenticated,
  isBridgeConfigured,
  getMailAccessStatus,
  getAccessToken,
  startDeviceCodeFlow,
  fetchCalendarEvents,
  fetchRecentEmails,
  fetchEmailById,
  fetchTodoLists,
  fetchTodoTasks,
  fetchPlannerTasks,
  createTodoTask,
  updateTodoTask,
  updatePlannerTask,
  graphFetch
};
