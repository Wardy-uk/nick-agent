'use strict';

/**
 * Teams service — reads @mentions and urgent DMs, and sends DMs as Nick.
 *
 * READ uses `Chat.Read`, which is in `GRAPH_SCOPES` and consented.
 *
 * SEND uses `ChatMessage.Send`, which is NOT and needs tenant admin approval.
 * It is acquired separately via `microsoft.getScopedToken` rather than being
 * added to `GRAPH_SCOPES`, because `getAccessToken()` passes that whole list to
 * `acquireTokenSilent` — one unconsented entry there makes the silent call throw
 * and takes Calendar, Mail and Tasks down with it. Verified live on the Pi 15
 * Aug: `ChatMessage.Send` returns AADSTS65001 (`consent`) while the main token
 * and `getMailAccessStatus()` are untouched, and an already-consented scope
 * (`Mail.Send`) comes back GRANTED silently. So this lights up on approval alone
 * — no code change, no re-auth (Q8).
 *
 * Everything here FAILS SOFT and returns a reason. Teams is an upgrade on email,
 * never a precondition for it (Q9): no caller may block or throw on it.
 */

const microsoft = require('./microsoft');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// The one scope that needs admin approval. Named once so the status endpoint and
// the sender cannot disagree about what is being waited on.
const SEND_SCOPE = 'ChatMessage.Send';

// Kill switch. Absent = enabled, because the real gate is consent — an unset env
// var must not be a second, invisible reason for silence.
// Default TRUE — a kill switch, not an opt-in.
const sendEnabled = () => require('./feature-flags').isEnabled('teams_dm');

async function _graphGet(path, token) {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Teams scope not granted (${res.status})`);
    err.scopeError = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Graph ${path} → ${res.status}`);
  return res.json();
}

/**
 * Fetch recent chats and find messages where Nick is @mentioned or it's a DM.
 * Returns { mentions, unreadDMs, ts } or { unavailable: true } if scope missing.
 */
async function getRecentActivity(hoursBack = 4) {
  let token;
  try {
    token = await microsoft.getAccessToken();
  } catch (e) {
    console.warn('[Teams] Could not get access token:', e.message);
    return { unavailable: true, reason: 'auth' };
  }
  if (!token) return { unavailable: true, reason: 'auth' };

  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  try {
    // Fetch last 20 chats (1:1 DMs and group chats)
    const chatsData = await _graphGet(`/me/chats?$top=20&$orderby=lastMessagePreview/createdDateTime desc`, token);
    const chats = chatsData.value || [];

    const mentions = [];
    const unreadDMs = [];

    for (const chat of chats.slice(0, 10)) {
      // Get recent messages from this chat
      let msgs;
      try {
        const msgsData = await _graphGet(
          `/me/chats/${chat.id}/messages?$top=10&$filter=lastModifiedDateTime ge ${since}`,
          token
        );
        msgs = msgsData.value || [];
      } catch (e) {
        if (e.scopeError) throw e; // bubble up scope errors
        continue;
      }

      for (const msg of msgs) {
        if (!msg.body?.content || msg.deletedDateTime) continue;
        const isFromMe = msg.from?.user?.displayName?.toLowerCase().includes('nick ward');
        if (isFromMe) continue;

        const hasMention = (msg.mentions || []).some(m =>
          m.mentioned?.user?.displayName?.toLowerCase().includes('nick ward')
        );

        if (hasMention) {
          mentions.push({
            id: msg.id,
            chatId: chat.id,
            chatType: chat.chatType,
            from: msg.from?.user?.displayName || 'Unknown',
            preview: _stripHtml(msg.body.content).slice(0, 200),
            ts: msg.lastModifiedDateTime,
          });
        } else if (chat.chatType === 'oneOnOne' && msg.importance === 'high') {
          unreadDMs.push({
            id: msg.id,
            chatId: chat.id,
            from: msg.from?.user?.displayName || 'Unknown',
            preview: _stripHtml(msg.body.content).slice(0, 200),
            ts: msg.lastModifiedDateTime,
          });
        }
      }
    }

    return { mentions, unreadDMs, ts: new Date().toISOString() };
  } catch (e) {
    if (e.scopeError) {
      console.log('[Teams] Scope not yet granted — awaiting Monday re-consent');
      return { unavailable: true, reason: 'scope' };
    }
    console.error('[Teams] Error fetching activity:', e.message);
    return { unavailable: true, reason: 'error', error: e.message };
  }
}

/**
 * Lightweight mention check for alert purposes (last 15 minutes).
 * Returns array of new mention objects, or [] if unavailable.
 */
async function getNewMentions(sinceMinutes = 15) {
  const result = await getRecentActivity(sinceMinutes / 60);
  if (result.unavailable) return [];
  return result.mentions || [];
}

function _stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ sending */

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Find the existing 1:1 chat with someone, by address.
 *
 * Deliberately does NOT create one. Creating a chat needs `Chat.ReadWrite`,
 * which is also unconsented — requesting a second scope would double the
 * approval Teams is waiting on for a case email already covers. If there is no
 * existing chat, the caller falls back to email, which is the Q9 order anyway.
 *
 * Uses `Chat.Read`, which is already granted, so this half works today.
 */
async function _findOneOnOneChat(email, token) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;

  const data = await _graphGet('/me/chats?$expand=members&$top=50', token);
  for (const chat of data.value || []) {
    if (chat.chatType !== 'oneOnOne') continue;
    const addresses = (chat.members || [])
      .map(m => String(m.email || m.userPrincipalName || '').toLowerCase())
      .filter(Boolean);
    if (addresses.includes(target)) return chat.id;
  }
  return null;
}

/**
 * Send a Teams DM as Nick.
 *
 * Mirrors `email-sender.sendMail`'s shape — `{ sent, reason }` — so a caller can
 * try one and fall back to the other without special-casing either. Never
 * throws: a delivery upgrade that can take down the thing it was upgrading is
 * worse than no upgrade.
 *
 * reason: 'disabled' | 'auth' | 'consent' | 'no-chat' | 'error'
 */
async function sendDm({ email, text }) {
  if (!sendEnabled()) return { sent: false, reason: 'disabled' };
  if (!email || !String(text || '').trim()) {
    return { sent: false, reason: 'error', error: 'sendDm needs an address and a body' };
  }

  const { token, reason, error } = await microsoft.getScopedToken([SEND_SCOPE]);
  if (!token) return { sent: false, reason, error };

  try {
    const chatId = await _findOneOnOneChat(email, token);
    if (!chatId) return { sent: false, reason: 'no-chat' };

    // Teams renders HTML; the body is plain text with real newlines, so convert
    // rather than posting it raw and losing every line break.
    const html = _escapeHtml(text).replace(/\r?\n/g, '<br>');

    const res = await fetch(`${GRAPH}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { contentType: 'html', content: html } }),
    });

    if (res.status === 401 || res.status === 403) {
      return { sent: false, reason: 'consent', error: `Graph ${res.status}` };
    }
    if (!res.ok) {
      return { sent: false, reason: 'error', error: `Graph ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }

    const body = await res.json().catch(() => ({}));
    return { sent: true, chatId, messageId: body.id || null };
  } catch (e) {
    return { sent: false, reason: 'error', error: e.message };
  }
}

/**
 * Can Teams DMs be sent right now, and if not, what is it waiting on?
 *
 * Exists because "an unset webhook or an unconsented scope is a normal, silent
 * state" (Q8) — and a silent state nobody can inspect is how NOVA's Teams path
 * sat dead for months while looking built. This makes the waiting visible.
 */
async function getSendStatus() {
  if (!sendEnabled()) {
    return { available: false, reason: 'disabled', detail: 'Teams DM is switched off (Settings)' };
  }
  const { token, reason, error } = await microsoft.getScopedToken([SEND_SCOPE]);
  if (token) return { available: true, scope: SEND_SCOPE };

  const detail = {
    consent: `${SEND_SCOPE} not granted yet — raise it in the tenant's Admin consent requests queue. Nothing else is needed: it starts working the moment approval lands.`,
    auth: 'Not signed in to Microsoft — run the device code flow.',
  }[reason] || error || 'Unavailable';

  return { available: false, reason, scope: SEND_SCOPE, detail };
}

module.exports = { getRecentActivity, getNewMentions, sendDm, getSendStatus, SEND_SCOPE };
