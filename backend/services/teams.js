'use strict';

/**
 * Teams service — pulls @mentions and urgent DMs via Microsoft Graph.
 *
 * Requires Chat.Read + ChannelMessage.Read scopes (add Monday via device code flow).
 * Until those scopes are consented, every call returns { unavailable: true }.
 */

const microsoft = require('./microsoft');

const GRAPH = 'https://graph.microsoft.com/v1.0';

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

module.exports = { getRecentActivity, getNewMentions };
