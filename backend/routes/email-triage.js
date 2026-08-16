const express = require('express');
const router = express.Router();
const emailTriage = require('../services/email-triage');
const microsoft = require('../services/microsoft');
const aiRouting = require('../services/ai-routing');
const { evaluateEmail } = require('../services/email-priority');

function trimText(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function buildFallbackSummary(message, triageItem) {
  const subject = message?.subject || triageItem?.subject || 'Email';
  const preview = trimText(message?.preview || triageItem?.preview || message?.body || '', 240);
  const reason = triageItem?.reason || evaluateEmail({ ...message, preview }).reasons?.join(' · ') || '';
  return trimText(`${subject}. ${reason ? `${reason}. ` : ''}${preview}`, 320);
}

function buildFallbackSuggestedReply(message, triageItem) {
  const firstName = String(message?.from || triageItem?.from || 'there').split(' ')[0].replace(/[^A-Za-z'-]/g, '') || 'there';
  const reason = triageItem?.reason || '';
  if (/urgent|escalation|complaint|outage|legal|sla|customer distress/i.test(reason)) {
    return `Hi ${firstName},\n\nI’ve seen this and I’m picking it up now. I’ll review the detail and come back with the next step shortly.\n\nNick`;
  }
  if (/needs decision|reply requested|direct report|leadership sender/i.test(reason)) {
    return `Hi ${firstName},\n\nThanks — I’ve seen this. I’m reviewing it now and will come back to you with a clear answer shortly.\n\nNick`;
  }
  return `Hi ${firstName},\n\nThanks for this. I’ve seen it and I’ll come back to you shortly.\n\nNick`;
}

// Reply goes to the sender; reply-all adds everyone else on the thread, minus
// Nick himself. The composer shows both so nothing is sent blind.
//
// `threadKnown` is the honest half. Only the LIVE Graph message carries a
// `recipients` block — the 290 cached triage entries hold `fromEmail` but no
// participants at all. So when Graph is degraded, Reply still works and
// reply-all quietly comes back EMPTY, which the composer rendered as "no other
// participants" rather than "I could not find out". A one-to-one email and an
// unreachable thread looked identical, and the difference is who gets left off
// a reply. Say which one it is.
async function buildReplyDefaults(merged) {
  const sender = merged.fromEmail
    ? [{ name: merged.from || merged.fromEmail, email: merged.fromEmail }]
    : [];
  const me = (await microsoft.getSignedInAddress() || '').toLowerCase();
  const others = [
    ...(merged.recipients?.to || []),
    ...(merged.recipients?.cc || []),
  ].filter((r) => {
    const email = (r.email || '').toLowerCase();
    return email && email !== me && email !== (merged.fromEmail || '').toLowerCase();
  });

  // Dedupe — the same person often appears on both to and cc.
  const seen = new Set();
  const replyAllCc = others.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { to: sender, cc: [], replyAllCc, threadKnown: Boolean(merged.recipients) };
}

// Merge the cached triage entry with the live Graph message. Returns null when
// the email exists in neither.
async function loadEmail(emailId) {
  const triage = emailTriage.getTriageByCategory();
  const all = [...triage.urgent, ...triage.reply, ...triage.delegate, ...triage.fyi, ...triage.ignore];
  const triageItem = all.find((item) => item.id === emailId) || null;
  const message = await microsoft.fetchEmailById(emailId);
  if (!message && !triageItem) return null;
  // `live` false means this is the cached triage record only — Graph (and the
  // bridge behind it) could not be reached. The record still renders; what it
  // cannot carry is the thread.
  return { triageItem, live: Boolean(message), merged: { ...(triageItem || {}), ...(message || {}), id: emailId } };
}

// GET /api/email/triage — get classified inbox
router.get('/triage', async (req, res) => {
  try {
    const data = emailTriage.getTriageByCategory();
    const mail = microsoft.getMailAccessStatus();
    const empty = !data.urgent.length && !data.reply.length && !data.action.length && !data.fyi.length && !data.delegate.length && !data.ignore.length;
    const available = !(empty && mail.degraded);
    res.json({
      ok: true,
      available,
      detail: available ? null : (mail.lastTokenError || 'Mail access is degraded.'),
      ...data
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/email/triage/:emailId — fetch email detail, summary, and suggested reply
router.get('/triage/:emailId', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem, live } = loaded;
    const mail = microsoft.getMailAccessStatus();

    res.json({
      ok: true,
      live,
      // Why it is degraded, in the order the user can act on: Graph's own token
      // error first, then the bridge that was supposed to cover for it.
      detail: live ? null : (
        mail.lastTokenError
        || (mail.bridgeMailDetail === 'unsupported'
          ? 'Live fetch failed and the NOVA bridge does not serve message detail.'
          : mail.bridgeMailDetailError)
        || 'Live fetch failed — showing the cached copy.'
      ),
      email: {
        id: merged.id,
        subject: merged.subject || 'Email',
        from: merged.from || merged.fromEmail || 'Unknown sender',
        fromEmail: merged.fromEmail || '',
        to: merged.to || [],
        cc: merged.cc || [],
        received: merged.received || null,
        isRead: Boolean(merged.isRead),
        importance: merged.importance || 'normal',
        reason: merged.reason || '',
        webLink: merged.webLink || null,
        summary: buildFallbackSummary(merged, triageItem),
        suggestedReply: buildFallbackSuggestedReply(merged, triageItem),
        preview: merged.preview || '',
        body: merged.body || merged.preview || '',
        replyDefaults: await buildReplyDefaults(merged),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/:emailId/summary — AI summary, falls back to the
// deterministic one when AI is off or unreachable
router.post('/triage/:emailId/summary', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem } = loaded;

    const prompt = `Summarise this email for a busy Head of Technical Support. Give 2-3 short bullet points: what it is about, what (if anything) is being asked of him, and any deadline. No preamble, no sign-off.

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body || merged.preview || '', 4000)}`;

    let text = '';
    let provider = 'fallback';
    try {
      const result = await aiRouting.runTask('email_summary', { prompt, maxTokens: 250 });
      if (result?.text?.trim()) {
        text = result.text.trim();
        provider = result.provider;
      }
    } catch (e) {
      console.warn('[EmailTriage] Summary AI failed:', e.message);
    }

    res.json({ ok: true, summary: text || buildFallbackSummary(merged, triageItem), provider });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/:emailId/draft — AI-drafted reply, falls back to the
// canned suggestion
router.post('/triage/:emailId/draft', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const loaded = await loadEmail(emailId);
    if (!loaded) return res.status(404).json({ ok: false, error: 'Email not found' });
    const { merged, triageItem } = loaded;
    const steer = trimText(req.body?.instruction || '', 400);

    const prompt = `Draft a reply to this email as Nick Ward, Head of Technical Support at Nurtur. Be direct, warm and concise — British English, no corporate padding. Sign off "Nick". Output only the reply body, no subject line and no commentary.${steer ? `\n\nNick's steer for this reply: ${steer}` : ''}

From: ${merged.from || 'Unknown'}
Subject: ${merged.subject || '(no subject)'}

${trimText(merged.body || merged.preview || '', 4000)}`;

    let text = '';
    let provider = 'fallback';
    try {
      const result = await aiRouting.runTask('email_draft', { prompt, maxTokens: 500 });
      if (result?.text?.trim()) {
        text = result.text.trim();
        provider = result.provider;
      }
    } catch (e) {
      console.warn('[EmailTriage] Draft AI failed:', e.message);
    }

    res.json({ ok: true, draft: text || buildFallbackSuggestedReply(merged, triageItem), provider });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/:emailId/reply — send the reply via Graph
router.post('/triage/:emailId/reply', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'Reply body is empty' });

    const to = Array.isArray(req.body?.to) ? req.body.to : null;
    if (to && to.length === 0) {
      return res.status(400).json({ ok: false, error: 'Add at least one recipient' });
    }

    const result = await microsoft.sendEmailReply(emailId, body, {
      replyAll: Boolean(req.body?.replyAll),
      to,
      cc: Array.isArray(req.body?.cc) ? req.body.cc : null,
    });

    if (!result.sent) {
      const messages = {
        auth: 'Not signed in to Microsoft — reconnect in settings.',
        scope: 'Mail.Send permission not granted — re-consent to Microsoft.',
        no_recipients: 'Add at least one recipient.',
      };
      return res.status(502).json({
        ok: false,
        error: messages[result.reason] || `Send failed (${result.reason})`,
      });
    }

    // Replied means handled — take it out of triage so it doesn't come back.
    // Recorded as 'replied' rather than 'done': it is the strongest possible
    // signal that triage was RIGHT to surface this one, and lumping it in with a
    // manual dismiss would throw that away (#70).
    emailTriage.dismissEmail(emailId, 'replied');
    res.json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/run — trigger a fresh triage cycle
router.post('/triage/run', async (req, res) => {
  try {
    const result = await emailTriage.runTriage();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/email/triage/dismiss/:emailId — dismiss an email from triage.
// Body { markRead: true } also marks it read in Outlook, so clearing it here
// clears it everywhere. The dismiss always lands even if the Graph write does
// not — a missing Mail.ReadWrite scope shouldn't strand the item in triage.
router.post('/triage/dismiss/:emailId', async (req, res) => {
  try {
    const emailId = decodeURIComponent(req.params.emailId);
    let markedRead = null;
    let readError = null;

    if (req.body?.markRead) {
      const result = await microsoft.markEmailRead(emailId);
      markedRead = result.marked;
      if (!result.marked) {
        readError = result.reason === 'scope'
          ? 'Dismissed here, but Outlook still shows it unread — Mail.ReadWrite not granted yet.'
          : result.reason === 'auth'
            ? 'Dismissed here, but not signed in to Microsoft so it is still unread in Outlook.'
            : `Dismissed here, but marking it read in Outlook failed (${result.reason}).`;
      }
    }

    // #70 — the reason is the whole point of having two buttons.
    emailTriage.dismissEmail(emailId, req.body?.reason);
    res.json({ ok: true, markedRead, readError });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/email/triage/feedback — how the classifier is scoring against Nick's
// verdict (#70). Only counts emails he has actually judged; one still sitting in
// triage is not evidence, and counting it would make the score improve purely
// because he hasn't got to it.
router.get('/triage/feedback', (req, res) => {
  try {
    res.json(emailTriage.getDismissFeedback());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/triage/clear — clear all cached triage data and re-scan
router.post('/triage/clear', async (req, res) => {
  try {
    emailTriage.clearDismissed();
    const db = require('../db/database');
    db.setState('email_triage', '[]');
    db.clearStaleInboxItems();
    // Also clear inbox scanner items
    db.getDb().prepare('DELETE FROM inbox_items').run();
    db.setState('email_triage_time', '0');
    console.log('[EmailTriage] All triage data cleared');
    // Run fresh scan
    const result = await emailTriage.runTriage();
    res.json({ ok: true, cleared: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
