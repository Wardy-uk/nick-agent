'use strict';

const db = require('../db/database');
const { evaluateEmail } = require('./email-priority');

// CLAUDE_MODEL removed in Phase 3 — AI routing handles provider selection
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_TRIAGE_MODEL || 'qwen2.5:3b';
const TRIAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function classifyWithOllama(emailList) {
  const prompt = `You are classifying emails for Nick Ward, Head of Technical Support.
Classify each email into exactly one category:
- ACTION: Requires Nick to do something or reply
- FYI: Informational only, no action needed
- DELEGATE: Someone else should handle this
- IGNORE: Automated, spam, or irrelevant

Respond with ONLY a JSON array. No markdown, no explanation.
Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Emails:
${emailList}`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 512 }
    }),
    signal: AbortSignal.timeout(30000) // 30s — fail fast to AI routing
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const text = data.response || '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in Ollama response');
  return JSON.parse(jsonMatch[0]);
}

async function classifyEmails(emails) {
  if (!emails || emails.length === 0) return [];

  const emailList = emails.slice(0, 20).map((e, i) =>
    `[${i}] From: ${e.from} <${e.fromEmail}>\nSubject: ${e.subject}\nPreview: ${e.preview?.substring(0, 150) || '(no preview)'}`
  ).join('\n\n');

  let classifications = null;

  // Route through AI provider (Pi 4 worker first, then local fallback)
  // DO NOT call Pi 5 Ollama directly — it blocks interactive use
  try {
    const aiProvider = require('./ai-provider');
    const result = await aiProvider.triageEmails(
      `You are classifying emails for Nick Ward, Head of Technical Support at Nurtur.
Classify each email into exactly one category: ACTION, FYI, DELEGATE, or IGNORE.
Respond with ONLY a JSON array. Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Classify these ${emails.slice(0, 20).length} emails:\n\n${emailList}`
    );
    if (result.text) {
      const clean = result.text.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\[[\s\S]*\]/);
        classifications = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');
        console.log(`[EmailTriage] Classified via ${result.provider} (fallback)`);
      }
  } catch (aiErr) {
    console.error('[EmailTriage] AI classification failed:', aiErr.message);
    classifications = [];
  }

  return emails.map((email, i) => {
    const cls = (classifications || []).find(c => c.index === i);
    const deterministic = evaluateEmail(email);
    const aiCategory = String(cls?.category || 'FYI').toUpperCase();
    let category = aiCategory;
    if (deterministic.category === 'IGNORE') category = 'IGNORE';
    else if (deterministic.category === 'FYI' && aiCategory === 'ACTION') category = 'FYI';
    else if (deterministic.category === 'ACTION' && aiCategory === 'IGNORE') category = 'ACTION';
    else if (deterministic.category === 'DELEGATE' && aiCategory !== 'ACTION') category = 'DELEGATE';
    else if (deterministic.forced) category = deterministic.category;

    const lane =
      category === 'IGNORE' ? 'ignore'
        : category === 'DELEGATE' ? 'delegate'
          : deterministic.lane === 'urgent' ? 'urgent'
            : category === 'ACTION' ? 'reply'
              : deterministic.lane || 'fyi';

    return {
      ...email,
      category,
      lane,
      urgency: deterministic.urgency,
      urgent: lane === 'urgent',
      needsReply: lane === 'reply' || lane === 'urgent',
      reason: deterministic.reasons.length
        ? deterministic.reasons.join(' · ')
        : (cls?.reason || ''),
      aiCategory,
      triaged: true,
      triagedAt: new Date().toISOString()
    };
  });
}

// Run a full triage cycle — fetch, classify, store
async function runTriage() {
  const microsoft = require('./microsoft');
  if (!microsoft.isBridgeConfigured() && !(await microsoft.isAuthenticated())) {
    return { ok: false, reason: 'M365 not connected' };
  }

  try {
    const emails = await microsoft.fetchRecentEmails(24, 40);
    if (!emails || emails.length === 0) {
      db.setState('email_triage', JSON.stringify([]));
      db.setState('email_triage_time', String(Date.now()));
      return {
        ok: true,
        count: 0,
        urgent: 0,
        reply: 0,
        action: 0,
        fyi: 0,
        delegate: 0,
        ignore: 0,
      };
    }

    const classified = await classifyEmails(emails);

    // Store results
    const existing = getStoredTriage();

    // Merge: keep existing dismissed items, add/update new ones
    const updated = [
      ...existing.filter(e => e.dismissed),
      ...classified.map(e => {
        const prev = existing.find(p => p.id === e.id);
        return {
          ...e,
          dismissed: prev?.dismissed || false,
          dismissedAt: prev?.dismissedAt || null
        };
      })
    ];

    db.setState('email_triage', JSON.stringify(updated));
    db.setState('email_triage_time', String(Date.now()));

    const urgentCount = classified.filter(e => e.lane === 'urgent').length;
    const replyCount = classified.filter(e => e.lane === 'reply').length;
    console.log(`[EmailTriage] Classified ${classified.length} emails, ${urgentCount} urgent, ${replyCount} need reply`);
    return {
      ok: true,
      count: classified.length,
      urgent: urgentCount,
      reply: replyCount,
      action: classified.filter(e => e.category === 'ACTION').length,
      fyi: classified.filter(e => e.category === 'FYI').length,
      delegate: classified.filter(e => e.category === 'DELEGATE').length,
      ignore: classified.filter(e => e.category === 'IGNORE').length,
    };
  } catch (e) {
    console.error('[EmailTriage] Failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getStoredTriage() {
  try {
    const raw = db.getState('email_triage');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getTriageByCategory() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  return {
    urgent: all.filter(e => e.lane === 'urgent'),
    reply: all.filter(e => e.lane === 'reply'),
    action: all.filter(e => e.category === 'ACTION'),
    fyi: all.filter(e => e.category === 'FYI'),
    delegate: all.filter(e => e.category === 'DELEGATE'),
    ignore: all.filter(e => e.category === 'IGNORE'),
    lastRun: db.getState('email_triage_time')
  };
}

function dismissEmail(emailId) {
  const all = getStoredTriage();
  const updated = all.map(e =>
    e.id === emailId
      ? { ...e, dismissed: true, dismissedAt: new Date().toISOString() }
      : e
  );
  db.setState('email_triage', JSON.stringify(updated));
}

function clearDismissed() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  db.setState('email_triage', JSON.stringify(all));
}

module.exports = {
  runTriage,
  getTriageByCategory,
  dismissEmail,
  clearDismissed,
  TRIAGE_CACHE_TTL
};
