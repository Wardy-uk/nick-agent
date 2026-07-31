const express = require('express');
const router = express.Router();
const emailTriage = require('../services/email-triage');
const microsoft = require('../services/microsoft');
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
    const triage = emailTriage.getTriageByCategory();
    const all = [...triage.urgent, ...triage.reply, ...triage.delegate, ...triage.fyi, ...triage.ignore];
    const triageItem = all.find((item) => item.id === emailId) || null;
    const message = await microsoft.fetchEmailById(emailId);

    if (!message && !triageItem) {
      return res.status(404).json({ ok: false, error: 'Email not found' });
    }

    const merged = {
      ...(triageItem || {}),
      ...(message || {}),
      id: emailId,
    };

    res.json({
      ok: true,
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
      },
    });
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

// POST /api/email/triage/dismiss/:emailId — dismiss an email from triage
router.post('/triage/dismiss/:emailId', (req, res) => {
  try {
    emailTriage.dismissEmail(decodeURIComponent(req.params.emailId));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
    const stmt = db.getDb().prepare('DELETE FROM inbox_items');
    stmt.step();
    stmt.free();
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
