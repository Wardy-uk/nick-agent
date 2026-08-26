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

    // Raise/refresh/clear the urgent-email banner off the set just stored.
    // The retired scanner used to own this; the nudge now fires from the same
    // pass that produces the list it describes. Never allowed to fail triage.
    try {
      require('./nudges').triggerUrgentEmailNudge();
    } catch (e) {
      console.warn('[EmailTriage] Failed to sync urgent email nudge:', e.message);
    }

    const urgentCount = classified.filter(e => e.lane === 'urgent').length;
    const replyCount = classified.filter(e => e.lane === 'reply').length;
    console.log(`[EmailTriage] Classified ${classified.length} emails, ${urgentCount} urgent, ${replyCount} need reply`);

    // Meeting invites arrive as email, so triage is the earliest point we know
    // one landed. Sync the calendar here rather than waiting for the next timer
    // — sync reports which events are new and checks those for a missing agenda,
    // so the ask reaches the organiser while they are still thinking about the
    // meeting they just sent. Awaited but never allowed to fail the triage:
    // classifying the inbox is the job, this is a passenger.
    try {
      await require('./calendar-sync').sync({ days: 14 });
    } catch (e) {
      console.warn('[EmailTriage] Calendar sync after triage failed:', e.message);
    }

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

// The ONE definition of "someone is waiting on Nick today" (26 Aug 2026).
//
// This used to live in nudges.js, computed against a SECOND, independent scan:
// `inbox-scanner.js` writing the `inbox_items` table. Nothing reconciled the
// two. Dismissing in the panel writes here and never wrote there, no frontend
// ever called the scanner's dismiss route, and the 24-hour purge was reachable
// only from a manual endpoint — so that table was a write-only pile going back
// twelve days, and the push notification counted it. Measured the morning it
// was found: SARA said **37 urgent emails**, the panel showed 3, and all 114
// rows in the table had `dismissed = 0`. Two scanners were also paying the AI
// to classify the same mailbox on two different schedules.
//
// So the scanner is retired and this is the only store. The nudge, the chat
// context and the panel now read one blob through one predicate: the count
// that interrupts Nick and the list he opens cannot describe different mail.
function getUrgentEmails() {
  return getStoredTriage().filter(e => !e.dismissed && e.lane === 'urgent');
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Everything triage is still holding, worst first — the chat and SARA context
 * feed. Replaces `inbox-scanner.getFlaggedItems()` and keeps its shape so the
 * consumers did not have to learn a second vocabulary.
 *
 * `lastRun` is null when triage has never run, and is NOT the same claim as an
 * empty list: "we have not looked" must stay distinguishable from "your inbox
 * is clear", which is the whole lesson of the pile this replaces.
 */
function getFlaggedItems() {
  const items = getStoredTriage()
    .filter(e => !e.dismissed && e.lane !== 'ignore')
    .map(e => ({
      emailId: e.id,
      subject: e.subject,
      from: e.from,
      fromEmail: e.fromEmail,
      urgency: e.urgency,
      category: e.category,
      // The blob carries no model-written summary — the deterministic reason
      // and the preview are what we actually have. Stating the preview as a
      // summary would be inventing one.
      summary: (e.preview || '').slice(0, 160),
      reason: e.reason,
      received: e.received,
      isRead: !!e.isRead,
      hasAttachments: !!e.hasAttachments,
    }))
    .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3));

  const lastRun = db.getState('email_triage_time');
  return {
    items,
    lastScan: lastRun ? new Date(Number(lastRun)).toISOString() : null,
  };
}

// #70 — why it was dismissed, not just that it was.
//
// "Done" and "Not relevant" called the identical endpoint, so the distinction
// was painted on. Every "not relevant" is Nick telling triage its ranking was
// wrong, and that was discarded on the spot — the only feedback this classifier
// will ever get for free. Two buttons that do the same thing quietly teach him
// they mean nothing.
const DISMISS_REASONS = new Set(['done', 'not-relevant', 'replied', 'unspecified']);

function dismissEmail(emailId, reason = 'unspecified') {
  const clean = DISMISS_REASONS.has(reason) ? reason : 'unspecified';
  const all = getStoredTriage();
  const updated = all.map(e =>
    e.id === emailId
      ? { ...e, dismissed: true, dismissedAt: new Date().toISOString(), dismissReason: clean }
      : e
  );
  db.setState('email_triage', JSON.stringify(updated));
  if (clean === 'not-relevant') {
    // Logged loudly on purpose: it is a misclassification report, and until
    // something consumes it the log is the only place it exists.
    const item = all.find(e => e.id === emailId);
    console.log(`[Triage] Misranked — "${(item?.subject || emailId).slice(0, 80)}" `
      + `was ${item?.urgency || '?'}/${item?.category || '?'} and Nick says not relevant`);
  }

  // Clearing the last urgent email should silence the banner on the spot, not
  // at the next triage run. Actioning mail and watching the count stay put is
  // exactly the bug this whole change exists to fix.
  try { require('./nudges').triggerUrgentEmailNudge(); } catch {}
}

/**
 * How the classifier is doing, by its own output, against Nick's verdict.
 *
 * Deliberately counts only what he has actually judged: an email still sitting
 * in triage is not evidence either way, and folding it in would make the score
 * improve simply because he has not got to it yet.
 */
function getDismissFeedback() {
  const judged = getStoredTriage().filter(e => e.dismissed && e.dismissReason && e.dismissReason !== 'unspecified');
  const byCategory = {};
  let notRelevant = 0;

  for (const e of judged) {
    const key = `${e.urgency || 'none'}/${e.category || 'none'}`;
    byCategory[key] = byCategory[key] || { judged: 0, notRelevant: 0 };
    byCategory[key].judged++;
    if (e.dismissReason === 'not-relevant') {
      byCategory[key].notRelevant++;
      notRelevant++;
    }
  }

  return {
    judged: judged.length,
    notRelevant,
    // Null rather than 0 when nothing has been judged — an untested classifier
    // is not a perfect one.
    misrankRate: judged.length ? Math.round((notRelevant / judged.length) * 100) : null,
    byCategory,
  };
}

function clearDismissed() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  db.setState('email_triage', JSON.stringify(all));
}

module.exports = {
  runTriage,
  getTriageByCategory,
  getUrgentEmails,
  getFlaggedItems,
  // Read-only accessor. The reply route needs the cached subject/sender to
  // record a sent reply (#69) without paying for a live Graph fetch — and a
  // fetch that can fail must not be on the path of bookkeeping for mail that
  // has already left.
  getStoredTriage,
  dismissEmail,
  getDismissFeedback,
  clearDismissed,
  TRIAGE_CACHE_TTL
};
