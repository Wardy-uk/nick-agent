const msal = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');
const https = require('https');

// NOVA bridge — fallback when MSAL not authenticated.
//
// "Configured" means a URL and a secret are set. It says NOTHING about whether
// NOVA serves the path being asked for, and measured on 16 Aug 2026 most of
// them are not: of the paths NEURO calls as its Priority-2 fallback, only
// /mail, /calendar, /ticket/:key, /escalations, /flagged and /status exist.
// /mail/{id}, /todo/lists, /todo/tasks and /planner/tasks are absent, so the
// request falls past NOVA's bridge router into its app auth and answers 401.
//
// The quieter failure is the one that matters: a path that DOES exist answers
// **HTTP 200 with the failure nested in `data`** — an expired msgraph token
// reads `{ok:true, data:{error:"Failed to acquire token…"}}`. That used to be
// handed straight back, every caller read `.id` off it, got undefined and
// returned null — so a dead bridge was indistinguishable from an empty mailbox
// and nothing logged a word.
//
// Nothing below BLOCKS a call: if NOVA gains a route, the next success clears
// the entry by itself. This only records what actually happened.
const _bridgeHealth = new Map();

// /mail/<graph id> and /ticket/NT-123 would otherwise mint a map entry per
// message and per ticket.
function _bridgeKey(bridgePath) {
  const clean = String(bridgePath).split('?')[0];
  const m = clean.match(/^\/(mail|ticket)\/.+$/);
  return m ? `/${m[1]}/:id` : clean;
}

function _noteBridge(bridgePath, state, detail) {
  _bridgeHealth.set(_bridgeKey(bridgePath), {
    state,
    detail: detail || null,
    at: new Date().toISOString(),
  });
}

function _nestedBridgeError(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return typeof data.error === 'string' && data.error ? data.error : null;
}

function getBridgeHealth() {
  return {
    configured: isBridgeConfigured(),
    // Nothing is known about a path until it has been tried once — "not probed"
    // is a third state, and reporting it as healthy is the bug this fixes.
    paths: Object.fromEntries(_bridgeHealth),
  };
}

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
      // 401/404 means the request never reached the bridge router — NOVA does
      // not implement this path, which is a different thing from a bad call.
      const unsupported = res.status === 401 || res.status === 404;
      console.warn(`[Bridge] ${bridgePath} returned ${res.status}${unsupported ? ' — NOVA does not implement this path' : ''}`);
      _noteBridge(bridgePath, unsupported ? 'unsupported' : 'error', `HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (!json.ok) {
      console.warn(`[Bridge] ${bridgePath} reported failure:`, json.error || 'unknown');
      _noteBridge(bridgePath, 'error', json.error || 'bridge reported failure');
      return null;
    }
    const nested = _nestedBridgeError(json.data);
    if (nested) {
      console.warn(`[Bridge] ${bridgePath} answered 200 with an error payload:`, nested);
      _noteBridge(bridgePath, 'error', nested);
      return null;
    }
    _noteBridge(bridgePath, 'ok');
    return json.data;
  } catch (e) {
    console.warn(`[Bridge] ${bridgePath} failed:`, e.message);
    _noteBridge(bridgePath, 'error', e.message);
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

/**
 * A token for scopes OUTSIDE `GRAPH_SCOPES`, acquired on its own.
 *
 * This exists so an optional capability can ask for its scope without that
 * scope becoming a precondition for everything else. Widening `GRAPH_SCOPES`
 * would be the obvious move and it is a trap: `getAccessToken()` passes the
 * whole list to `acquireTokenSilent`, so one unconsented addition makes the
 * silent call throw and returns null for Calendar, Mail, Tasks and briefings
 * alike. That is how "add Teams" turns into "Microsoft is down".
 *
 * Deliberately touches neither `graphTokenCache` nor `lastTokenError` — a
 * failure here is a fact about one optional feature, not about Microsoft
 * access, and must not show up in `getMailAccessStatus()`.
 *
 * Returns `{ token }` on success or `{ token: null, reason }` where reason is
 * `'auth'` (nobody signed in), `'consent'` (scope not granted yet — the normal,
 * expected state until an admin approves) or `'error'`.
 *
 * Because MSAL will silently pick up a scope the moment consent lands, a
 * capability built on this lights up on approval alone, with no code change and
 * no re-auth. That is the Q8 requirement, met by construction.
 */
async function getScopedToken(scopes) {
  try {
    const client = getClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return { token: null, reason: 'auth' };

    const result = await client.acquireTokenSilent({ scopes, account: accounts[0] });
    return { token: result.accessToken };
  } catch (err) {
    const msg = err?.message || String(err);
    // MSAL signals "the user/admin has not consented to this" by demanding
    // interaction. That is not an error worth logging every five minutes.
    const needsConsent = err?.errorCode === 'interaction_required'
      || err?.errorCode === 'consent_required'
      || /interaction_required|consent_required|AADSTS65001/i.test(msg);
    return { token: null, reason: needsConsent ? 'consent' : 'error', error: msg };
  }
}

function getMailAccessStatus() {
  const bridge = getBridgeHealth();
  const mailPath = bridge.paths['/mail/:id'] || null;
  return {
    bridgeConfigured: bridge.configured,
    // `bridgeConfigured` was the whole story here, and it is not the same claim
    // as "the fallback works" — the mail-detail path is not implemented on NOVA
    // at all, so a degraded Graph used to fall through to a silent null.
    bridgeMailDetail: mailPath ? mailPath.state : 'unprobed',
    bridgeMailDetailError: mailPath ? mailPath.detail : null,
    degraded: Boolean(lastTokenError),
    lastTokenError
  };
}

// Fallback: device code flow for Graph permissions (one-time)
//
// A device code EXPIRES — Microsoft issues them with a ~15 minute life. Nothing
// here used to record when one was issued, so `deviceCodePending` handed back
// the cached code forever: after an admin-approval wait, asking for a fresh code
// returned the long-dead one twice over and the only way out was restarting the
// backend. That is exactly the moment Nick is locked out of Graph, so the one
// path back in must not be the one that is stuck.
//
// The reset paths below are correct as far as they go (both `.then` and `.catch`
// clear the pending flag); the gap was purely that an in-flight code was assumed
// to still be good. Expiry is a pure function of issue time, so it lives in a
// testable helper rather than being inlined — a real flow cannot be exercised in
// a test without asking Microsoft for a code nobody will type in.
let deviceCodePending = false;
let deviceCodeInfo = null;

// Microsoft's default is 15 minutes. Treated as a FLOOR, not a guess: the
// response carries its own `expiresIn` and we prefer it when present, because a
// tenant is free to shorten the life and a code we believe in for longer than
// the issuer does is the same bug again.
const DEVICE_CODE_DEFAULT_TTL_MS = 15 * 60 * 1000;

// A 30s margin: a code that expires while Nick is mid-way through typing it is
// indistinguishable to him from the wedge this fixes.
const DEVICE_CODE_EXPIRY_MARGIN_MS = 30 * 1000;

/**
 * Is a cached device code still worth handing back?
 *
 * Returns false for a missing code as well as an expired one — a pending flow
 * that has not yet reached its callback has nothing to show, and returning
 * `null` from the route reads as "no code" rather than as a stale one.
 */
function isDeviceCodeUsable(info, now = Date.now()) {
  if (!info || !info.userCode || !info.issuedAt) return false;
  const ttl = Number(info.expiresInMs) > 0 ? Number(info.expiresInMs) : DEVICE_CODE_DEFAULT_TTL_MS;
  return (now - info.issuedAt) < (ttl - DEVICE_CODE_EXPIRY_MARGIN_MS);
}

async function startDeviceCodeFlow() {
  // Only reuse an in-flight code while it is still alive. An expired one is
  // dropped and a fresh flow started, rather than being returned to a user who
  // has no way of telling it is dead.
  if (deviceCodePending) {
    if (isDeviceCodeUsable(deviceCodeInfo)) return deviceCodeInfo;
    console.warn('[Microsoft] Cached device code has expired — starting a fresh flow');
    deviceCodePending = false;
    deviceCodeInfo = null;
  }

  const client = getClient();
  deviceCodePending = true;

  return new Promise((resolve, reject) => {
    client.acquireTokenByDeviceCode({
      scopes: GRAPH_SCOPES,
      deviceCodeCallback: (response) => {
        const expiresInMs = Number(response.expiresIn) > 0
          ? Number(response.expiresIn) * 1000
          : DEVICE_CODE_DEFAULT_TTL_MS;
        deviceCodeInfo = {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message,
          // Stamped so the caller can show a deadline instead of a code with no
          // stated shelf life — the reason the stale one went unnoticed twice.
          issuedAt: Date.now(),
          expiresInMs,
          expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
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

// Graph API fetch helper — GET only (built on https.get). Writes go via graphWrite.
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

// Graph pages every collection. `graphFetch` returns one page and nothing here
// ever followed `@odata.nextLink`, so a busy range was cut off with no error and
// no signal: 17–26 Aug returned exactly 50 events and showed 8 of the 12 booked
// 1-2-1s. That matters most where it is least visible — `one-to-one-booking`
// reads a 21-day window, so past roughly nine days its clash detection could not
// see meetings and its 2-a-day cap could not count 1-2-1s, while it went on
// sending REAL invites to real people.
//
// Raising $top just moves the cliff. This follows the links instead, with a page
// cap so a runaway query is bounded — and a bound that is HIT is logged, because
// a silent cap is the bug being fixed.
async function graphFetchAll(urlPath, token, extraHeaders = {}, maxPages = 20) {
  const items = [];
  let page = await graphFetch(urlPath, token, extraHeaders);
  // graphFetch answers null on 401. Callers read that as "Graph is unavailable"
  // and fall through to the NOVA bridge — so it must stay null here rather than
  // becoming an empty collection, which would read as "you have no meetings".
  if (!page) return null;
  let pages = 0;
  while (page && Array.isArray(page.value)) {
    items.push(...page.value);
    pages++;
    const next = page['@odata.nextLink'];
    if (!next) return { value: items, pages, truncated: false };
    if (pages >= maxPages) {
      console.warn(`[Microsoft] graphFetchAll hit the ${maxPages}-page cap on ${urlPath.split('?')[0]} — ${items.length} items, more available`);
      return { value: items, pages, truncated: true };
    }
    // nextLink is absolute; graphFetch prefixes the v1.0 root, so strip it.
    const rel = next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '');
    page = await graphFetch(rel, token, extraHeaders);
  }
  // Fell out mid-collection: a later page came back null (401) or malformed.
  // Say so rather than handing back a short list that looks complete.
  console.warn(`[Microsoft] graphFetchAll stopped after ${pages} page(s) on ${urlPath.split('?')[0]} — a follow-on page failed; ${items.length} items may be incomplete`);
  return { value: items, pages, truncated: true };
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
      // Paged — see graphFetchAll. $top is the PAGE size now, not the answer.
      const data = await graphFetchAll(
        `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=100&$orderby=start/dateTime&$select=id,subject,start,end,location,isAllDay,showAs,isCancelled,attendees,organizer,isOrganizer,responseStatus,type,seriesMasterId`,
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
            // Graph's real event id, so anything downstream can actually address
            // the event (/me/events/{id} for detail, decline, propose). This used
            // to be a synthesised date-time-subject string, which read fine but
            // could not be used to DO anything with the meeting.
            id: event.id || `graph-${date}-${startTime}-${(event.subject || '').substring(0, 20)}`,
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
            organizerEmail: event.organizer?.emailAddress?.address || null,
            // Whether Nick CREATED or ACCEPTED this, which is a different
            // question from whether it is in his diary — a not-yet-answered
            // invite sits in calendarView exactly like an accepted one.
            // 'organizer' | 'accepted' | 'tentativelyAccepted' | 'declined' |
            // 'notResponded' | 'none'. The NOVA bridge branch below cannot
            // supply either, so both stay null there and callers must treat
            // null as "unknown", never as a no.
            isOrganizer: typeof event.isOrganizer === 'boolean' ? event.isOrganizer : null,
            responseStatus: event.responseStatus?.response || null,
            // 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
            type: event.type || null,
            seriesMasterId: event.seriesMasterId || null,
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

  // Priority 2 — NOVA bridge. NOT IMPLEMENTED on NOVA (verified live 16 Aug
  // 2026): there is a `/mail` list route but no `/mail/{id}`, so this answers
  // 401 and returns null. Left in place because the shape is right the day NOVA
  // adds the route — but do not read it as working redundancy. `recipients` is
  // deliberately mapped here too, so the branch is correct if it ever fires.
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
          // Names alone can't be replied to — same as the Graph branch above.
          // This is #65's fix; it is correct, it is simply not reachable yet.
          recipients: {
            to: mapAddresses(bridgeData.toRecipients),
            cc: mapAddresses(bridgeData.ccRecipients),
          },
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
  // Priority 2 — NOVA bridge. NOT IMPLEMENTED on NOVA (verified live 16 Aug
  // 2026) — answers 401 and returns null. Not working redundancy.
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
//
// That cache lived only in memory until #71, which made the cold-start walk the
// NORMAL path rather than the exception: the backend restarts several times a
// day (deploys, not crashes), so the first completion after each restart hit
// Graph once per list before it could PATCH anything. Persisted to agent_state,
// the walk costs once per task instead of once per restart.
const TODO_LIST_CACHE_KEY = 'ms_todo_list_by_task';
let _todoListByTask = null;

// Lazy require: database.js is loaded by the server bootstrap, and microsoft.js
// is pulled in from several services — resolving it at module load would fix an
// import order this file has never had to care about.
function _todoListCache() {
  if (_todoListByTask) return _todoListByTask;
  _todoListByTask = new Map();
  try {
    const raw = require('../db/database').getState(TODO_LIST_CACHE_KEY);
    if (raw) {
      for (const [taskId, listId] of Object.entries(JSON.parse(raw))) {
        if (taskId && listId) _todoListByTask.set(taskId, listId);
      }
    }
  } catch (e) {
    console.warn('[ToDo] list cache load failed:', e.message);
  }
  return _todoListByTask;
}

function _saveTodoListCache() {
  try {
    // setState stores a primitive — stringify, never hand it the object.
    require('../db/database').setState(
      TODO_LIST_CACHE_KEY,
      JSON.stringify(Object.fromEntries(_todoListCache()))
    );
  } catch (e) {
    console.warn('[ToDo] list cache save failed:', e.message);
  }
}

/**
 * Re-key an entire list rather than appending to it. A task that has been
 * completed or deleted must fall OUT of the map, or a persisted cache grows
 * without bound and — worse — never self-corrects, which the in-memory one got
 * for free by dying every restart. Size stays at "tasks currently open".
 */
function _rekeyTodoList(cache, listId, taskIds) {
  const current = new Set(taskIds);
  let changed = false;
  for (const [taskId, cachedList] of cache) {
    if (cachedList === listId && !current.has(taskId)) { cache.delete(taskId); changed = true; }
  }
  for (const taskId of current) {
    if (cache.get(taskId) !== listId) { cache.set(taskId, listId); changed = true; }
  }
  return changed;
}

function _rememberTodoList(listId, taskIds) {
  if (_rekeyTodoList(_todoListCache(), listId, taskIds)) _saveTodoListCache();
}

function _forgetTodoList(taskId) {
  const cache = _todoListCache();
  if (cache.delete(taskId)) _saveTodoListCache();
}

// Fetch To-Do tasks for a specific list
async function fetchTodoTasks(listId) {
  if (!listId) return null;
  // Priority 1 — MSAL/Graph direct
  const token = await getAccessToken();
  if (token) {
    try {
      const data = await graphFetchAll(`/me/todo/lists/${listId}/tasks?$top=100&$filter=status ne 'completed'`, token);
      if (data && data.value) {
        _rememberTodoList(listId, data.value.map(t => t.id).filter(Boolean));
        return data.value;
      }
    } catch (err) {
      console.error('[Microsoft] ToDo tasks fetch error:', err.message);
    }
  }
  // Priority 2 — NOVA bridge. NOT IMPLEMENTED on NOVA (verified live 16 Aug
  // 2026) — answers 401 and returns null. Note this also means the persisted
  // task→list cache (#71) is only ever filled by the Graph path above.
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
      // 275 Planner tasks were readable against a $top of 200 — the same silent
      // truncation as the calendar, one endpoint over.
      const data = await graphFetchAll('/me/planner/tasks?$top=200', token);
      if (data && data.value) return data.value;
    } catch (err) {
      console.error('[Microsoft] Planner fetch error:', err.message);
    }
  }
  // Priority 2 — NOVA bridge. NOT IMPLEMENTED on NOVA (verified live 16 Aug
  // 2026) — answers 401 and returns null. Not working redundancy.
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
async function _resolveTodoList(taskId, token, { skipCache = false } = {}) {
  const cache = _todoListCache();
  if (!skipCache && cache.has(taskId)) return cache.get(taskId);
  const lists = await fetchTodoLists();
  if (!Array.isArray(lists)) return null;
  for (const list of lists) {
    try {
      const task = await graphFetch(`/me/todo/lists/${list.id}/tasks/${encodeURIComponent(taskId)}`, token);
      if (task?.id) {
        cache.set(taskId, list.id);
        _saveTodoListCache();
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

  const patch = (list) => graphWrite(
    `/me/todo/lists/${list}/tasks/${encodeURIComponent(taskId)}`,
    'PATCH',
    { status: 'completed' },
    token
  );

  let result = await patch(resolved);
  // A cached list survives restarts now, so it can also be WRONG across them —
  // move a task between lists and the stored mapping points at nothing. That
  // used to self-heal on the next deploy; now it has to say so. One re-walk.
  if (!result.ok && result.status === 404 && !listId) {
    console.warn(`[ToDo] Cached list ${resolved} no longer holds ${taskId} — re-resolving`);
    _forgetTodoList(taskId);
    const rewalked = await _resolveTodoList(taskId, token, { skipCache: true });
    if (!rewalked) return { completed: false, reason: 'list_not_found' };
    result = await patch(rewalked);
  }
  if (!result.ok) {
    console.warn(`[ToDo] Complete failed for ${taskId}: ${result.reason} ${result.detail || ''}`);
    return { completed: false, reason: result.reason };
  }
  console.log(`[ToDo] Completed ${taskId}`);
  return { completed: true, kind: 'todo' };
}

// Planner PATCHes are optimistically concurrent — Graph rejects them without a
// matching If-Match etag, so read the task first.
/**
 * Set a Planner task's progress. Planner has exactly three states and they are
 * expressed as one number: 0 not started, 50 in progress, 100 complete.
 *
 * Generalised out of `completePlannerTask` so "started" and "done" travel the
 * same path — the etag read, the If-Match write and the failure reasons are
 * identical, and a second copy would drift on the half that matters (Planner
 * rejects a PATCH without a fresh etag, so the read is not optional).
 */
async function setPlannerPercent(taskId, percent) {
  const token = await getAccessToken();
  if (!token) return { ok: false, reason: 'auth' };

  let etag = null;
  try {
    const task = await graphFetch(`/planner/tasks/${encodeURIComponent(taskId)}`, token);
    etag = task?.['@odata.etag'] || null;
  } catch (e) {
    console.warn(`[Planner] Could not read ${taskId}: ${e.message}`);
  }
  if (!etag) return { ok: false, reason: 'not_found' };

  const result = await graphWrite(
    `/planner/tasks/${encodeURIComponent(taskId)}`,
    'PATCH',
    { percentComplete: percent },
    token,
    { 'If-Match': etag }
  );
  if (!result.ok) {
    console.warn(`[Planner] percentComplete=${percent} failed for ${taskId}: ${result.reason} ${result.detail || ''}`);
    return { ok: false, reason: result.reason };
  }
  console.log(`[Planner] ${taskId} → ${percent}%`);
  return { ok: true, kind: 'planner' };
}

async function completePlannerTask(taskId) {
  const r = await setPlannerPercent(taskId, 100);
  return r.ok ? { completed: true, kind: 'planner' } : { completed: false, reason: r.reason };
}

/**
 * Mark a Microsoft-owned task started, or put it back to not started.
 *
 * ⚠ This WRITES to a shared Planner board, so Nick's team can see it. That is
 * the point rather than a side effect — a task he has actually started reading
 * as "not started" to everyone else is the thing worth fixing — but it is why
 * this is not silently inferred from anything. It happens only on his click.
 *
 * To Do has its own vocabulary (`status: inProgress|notStarted`) and no etag
 * requirement, so the two are not merged into one call.
 */
async function setMicrosoftTaskProgress(taskId, started, source = null, listId = null) {
  if (!taskId) return { ok: false, reason: 'no_task_id' };

  if (/planner/i.test(source || '')) return setPlannerPercent(taskId, started ? 50 : 0);

  if (/todo|to-do/i.test(source || '')) {
    const token = await getAccessToken();
    if (!token) return { ok: false, reason: 'auth' };
    // Same resolver completion uses — the persisted task→list cache with a
    // one-off walk on a miss. A second lookup path here would heal differently.
    const list = listId || await _resolveTodoList(taskId, token);
    if (!list) return { ok: false, reason: 'list_not_found' };
    const result = await graphWrite(
      `/me/todo/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(taskId)}`,
      'PATCH',
      { status: started ? 'inProgress' : 'notStarted' },
      token
    );
    return result.ok ? { ok: true, kind: 'todo' } : { ok: false, reason: result.reason };
  }

  // Unknown source: try Planner, fall back to To Do. Same order and the same
  // reasoning as completeMicrosoftTask — a wrong hint sends it to the wrong API.
  const planner = await setPlannerPercent(taskId, started ? 50 : 0);
  if (planner.ok) return planner;
  return setMicrosoftTaskProgress(taskId, started, 'todo', listId);
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

// Move an existing event. PATCH, deliberately — never cancel-and-recreate. Graph
// mails attendees an UPDATE ("this meeting has moved"), where a cancellation
// followed by a fresh invite reads to the other person as the meeting being
// dropped, and loses the thread, the body and anything attached to it.
//
// Same naive local wall-clock + timezone-name contract as createCalendarEvent:
// no code here converts offsets by hand.
async function updateCalendarEvent(eventId, { start, end, subject, body } = {}) {
  if (!eventId) return { updated: false, reason: 'no_event_id' };

  const payload = {};
  if (start) payload.start = { dateTime: start, timeZone: EVENT_TIMEZONE };
  if (end) payload.end = { dateTime: end, timeZone: EVENT_TIMEZONE };
  if (subject) payload.subject = String(subject).trim();
  // Body edits exist for NEURO's own focus blocks, whose body lists the tasks
  // in the window — take one out and the invite in Outlook still names it.
  // Never used on a meeting with other people: Graph mails them an update.
  if (body != null) payload.body = { contentType: 'text', content: String(body) };
  if (!Object.keys(payload).length) return { updated: false, reason: 'nothing_to_change' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.warn('[Calendar] Update auth failed:', e.message);
    return { updated: false, reason: 'auth' };
  }
  if (!token) return { updated: false, reason: 'auth' };

  const result = await graphWrite(`/me/events/${encodeURIComponent(eventId)}`, 'PATCH', payload, token);
  if (!result.ok) {
    console.warn(`[Calendar] Update failed for ${eventId}: ${result.reason} ${result.detail || ''}`);
    return { updated: false, reason: result.reason, detail: result.detail || null };
  }

  const ev = result.data || {};
  console.log(`[Calendar] Moved "${ev.subject || subject || eventId}" to ${start || '(unchanged)'}`);
  return {
    updated: true,
    event: {
      id: ev.id || eventId,
      subject: ev.subject || subject || null,
      start: ev.start?.dateTime || start || null,
      end: ev.end?.dateTime || end || null,
      webLink: ev.webLink || null,
    },
  };
}

/**
 * Delete a calendar event. Graph mails a cancellation to any attendee, so this
 * is only safe on events NEURO created for Nick alone — never on a meeting with
 * other people in it, where updateCalendarEvent is the right tool.
 */
async function deleteCalendarEvent(eventId) {
  if (!eventId) return { deleted: false, reason: 'no_event_id' };
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { deleted: false, reason: 'auth', detail: e.message };
  }
  if (!token) return { deleted: false, reason: 'auth' };

  const result = await graphWrite(`/me/events/${encodeURIComponent(eventId)}`, 'DELETE', undefined, token);
  if (!result.ok) {
    // A 404 means it is already gone, which is the outcome the caller wanted.
    if (result.status === 404) return { deleted: true, alreadyGone: true };
    return { deleted: false, reason: result.reason, detail: result.detail || null };
  }
  return { deleted: true };
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
  getScopedToken,
  startDeviceCodeFlow,
  isDeviceCodeUsable,
  fetchCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
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
  setPlannerPercent,
  setMicrosoftTaskProgress,
  graphFetch,
  graphWrite,
  // pure, exported for the tests — the map surgery is the part worth pinning
  _rekeyTodoList,
  getBridgeHealth,
  _nestedBridgeError,
  _bridgeKey
};
