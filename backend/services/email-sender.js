'use strict';

/**
 * Email sender — sends briefs via Microsoft Graph Mail.Send.
 *
 * Requires Mail.Send scope (add Monday via device code flow).
 * Gracefully degrades: logs and returns { sent: false } if scope missing.
 */

const microsoft = require('./microsoft');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TO_ADDRESS = 'nickw@nurtur.tech';

async function sendBriefEmail(subject, htmlBody) {
  let token;
  try {
    token = await microsoft.getAccessToken();
  } catch (e) {
    console.warn('[EmailSender] Could not get access token:', e.message);
    return { sent: false, reason: 'auth' };
  }
  if (!token) return { sent: false, reason: 'auth' };

  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: TO_ADDRESS } }],
  };

  try {
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (res.status === 403) {
      console.log('[EmailSender] Mail.Send scope not yet granted — awaiting Monday re-consent');
      return { sent: false, reason: 'scope' };
    }
    if (res.status === 202 || res.ok) {
      console.log(`[EmailSender] Brief sent to ${TO_ADDRESS}`);
      return { sent: true };
    }
    const body = await res.text().catch(() => '');
    console.error(`[EmailSender] sendMail failed ${res.status}:`, body.slice(0, 300));
    return { sent: false, reason: `http_${res.status}` };
  } catch (e) {
    console.error('[EmailSender] sendMail error:', e.message);
    return { sent: false, reason: 'error', error: e.message };
  }
}

/**
 * The synthesis comes back from the model as markdown, so dropping it straight
 * into the HTML body rendered literal "**like this**" in the email. Handles the
 * inline subset the model actually emits — bold, italic, code — and escapes
 * first, since this text is model output going into a mail body.
 */
function renderInlineMarkdown(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

/**
 * Item-level detail (currently the escalation tickets behind a count) so the
 * email says which tickets, not just how many. Ticket text is Jira-authored,
 * so it gets escaped.
 */
function _detailList(item) {
  const rows = item.meta?.escalations;
  if (!rows?.length) return '';
  const esc = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lis = rows.map(r => {
    const label = `<strong>${esc(r.key)}</strong> ${esc(r.summary)}`;
    const age = r.ageDays != null ? ` <span style="color:#aaa">(${r.ageDays === 0 ? 'today' : `${r.ageDays}d`})</span>` : '';
    return `<li>${r.url ? `<a href="${esc(r.url)}">${label}</a>` : label}${age}</li>`;
  }).join('');
  const more = item.meta.overflow > 0 ? `<li style="color:#888">+${item.meta.overflow} more</li>` : '';
  return `<ul style="margin:4px 0 0;font-size:13px">${lis}${more}</ul>`;
}

/**
 * Render a brief object into HTML for email.
 */
function briefToHtml(brief) {
  const ts = new Date(brief.ts).toLocaleString('en-GB', {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });

  const sections = [];

  if (brief.doNow?.length) {
    const items = brief.doNow.map(i =>
      `<li><strong>[${i.type}]</strong> ${i.title}${i.reason ? ` <em style="color:#888">— ${i.reason}</em>` : ''}${_detailList(i)}</li>`
    ).join('');
    sections.push(`<h3 style="color:#c0392b">Do now</h3><ul>${items}</ul>`);
  }

  if (brief.doNext?.length) {
    const items = brief.doNext.map(i =>
      `<li><strong>[${i.type}]</strong> ${i.title}${_detailList(i)}</li>`
    ).join('');
    sections.push(`<h3 style="color:#e67e22">Up next</h3><ul>${items}</ul>`);
  }

  if (brief.fyi?.length) {
    const items = brief.fyi.map(i => `<li>${i.title}</li>`).join('');
    sections.push(`<h3 style="color:#27ae60">FYI</h3><ul>${items}</ul>`);
  }

  if (brief.synthesis) {
    sections.push(`<p style="background:#f8f9fa;padding:12px;border-radius:4px;font-style:italic">${renderInlineMarkdown(brief.synthesis)}</p>`);
  }

  const body = sections.length
    ? sections.join('')
    : '<p>Nothing pressing right now.</p>';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h2 style="margin:0 0 4px">SARA Brief</h2>
  <p style="margin:0 0 20px;color:#888;font-size:14px">${ts}</p>
  ${body}
  <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
  <p style="font-size:12px;color:#aaa">Delivered by NEURO · <a href="https://sara.nickward.co.uk">Open SARA</a></p>
</body>
</html>`;
}

/**
 * Send a plain-text email to named recipients.
 *
 * Separate from sendBriefEmail, which always writes to Nick's own address — the
 * brief is a note to self and hardcoding that is a safety feature worth keeping.
 * This one goes to other people, so it takes explicit recipients and refuses
 * without them rather than defaulting anywhere.
 */
async function sendMail({ to, subject, body, cc = null }) {
  const recipients = (Array.isArray(to) ? to : []).filter(r => r?.email);
  if (!recipients.length) return { sent: false, reason: 'no_recipients' };
  if (!String(body || '').trim()) return { sent: false, reason: 'empty_body' };

  let token;
  try {
    token = await microsoft.getAccessToken();
  } catch (e) {
    console.warn('[EmailSender] Could not get access token:', e.message);
    return { sent: false, reason: 'auth' };
  }
  if (!token) return { sent: false, reason: 'auth' };

  const message = {
    subject: subject || '(no subject)',
    // Text, not HTML: these are short human messages, and HTML invites the kind
    // of formatting that makes a one-line question look like a mailshot.
    body: { contentType: 'Text', content: String(body) },
    toRecipients: recipients.map(r => ({ emailAddress: { address: r.email, name: r.name || undefined } })),
  };
  if (Array.isArray(cc) && cc.length) {
    message.ccRecipients = cc.filter(r => r?.email).map(r => ({ emailAddress: { address: r.email } }));
  }

  try {
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (res.status === 403) return { sent: false, reason: 'scope' };
    if (res.status === 202 || res.ok) {
      console.log(`[EmailSender] Sent "${message.subject}" to ${recipients.map(r => r.email).join(', ')}`);
      return { sent: true };
    }
    const detail = await res.text().catch(() => '');
    console.error(`[EmailSender] sendMail failed ${res.status}:`, detail.slice(0, 300));
    return { sent: false, reason: `http_${res.status}` };
  } catch (e) {
    console.error('[EmailSender] sendMail error:', e.message);
    return { sent: false, reason: 'error', error: e.message };
  }
}

module.exports = { sendBriefEmail, sendMail, briefToHtml };
