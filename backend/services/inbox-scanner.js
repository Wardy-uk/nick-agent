const microsoft = require('./microsoft');
const db = require('../db/database');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_TRIAGE_MODEL || 'qwen2.5:3b';

let lastScanTime = null;
let scanInProgress = false;

const SCAN_INTERVAL = 10 * 60 * 1000; // 10 minutes

const TRIAGE_PROMPT = `You are Nick's inbox triage assistant. Nick is Head of Technical Support at Nurtur Limited. He manages 15 direct reports across 2nd Line Support, 1st Line Customer Care, and Digital Design.

Review these emails and identify items that need Nick's attention. For each flagged item, provide:
- urgency: "high" (needs response today), "medium" (this week), "low" (FYI/can wait)
- category: one of "action-required", "decision-needed", "escalation", "fyi", "follow-up", "meeting-prep"
- summary: 1 sentence — what it is and what Nick needs to do
- reason: why this needs attention

IMPORTANT rules:
- Skip newsletters, automated notifications, marketing emails, system alerts from Jira/n8n/Grafana
- Skip calendar invites that are just acceptances/declines
- Flag anything from Chris Middleton (Nick's manager/SDM) as at least medium urgency
- Flag anything mentioning SLA breach, complaint, escalation, or P1/critical as high
- Flag anything from direct reports that looks like a blocker or needs a decision
- Flag flagged/high-importance emails
- Be concise. Nick has ADHD — surface the signal, hide the noise.

Respond with a JSON array only. No markdown, no explanation. Empty array [] if nothing needs attention.
Each item: { "emailId": "...", "subject": "...", "from": "...", "urgency": "high|medium|low", "category": "...", "summary": "...", "reason": "..." }`;

async function triageWithOllama(emailSummary) {
  const prompt = `You are Nick's inbox triage assistant. Nick is Head of Technical Support at Nurtur.
He manages 15 direct reports. Review these emails and identify items needing attention.

RULES:
- Skip newsletters, automated notifications, Jira/n8n/Grafana alerts, calendar acceptances
- Flag anything from Chris Middleton as at least medium urgency
- Flag SLA breach, complaint, escalation, P1/critical as high urgency
- Flag direct reports needing a decision as medium
- urgency: "high", "medium", or "low"
- category: "action-required", "decision-needed", "escalation", "fyi", "follow-up"

Respond with ONLY a JSON array. Empty array [] if nothing needs attention.
Format: [{"emailId":"...","subject":"...","from":"...","urgency":"high|medium|low","category":"...","summary":"one sentence","reason":"why"}]

Emails:
${JSON.stringify(emailSummary, null, 2)}`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 512 }
    }),
    signal: AbortSignal.timeout(30000) // 30s — fail fast, let AI routing handle fallback to Pi 4
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const text = data.response || '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON in Ollama response');
  return JSON.parse(jsonMatch[0]);
}

async function scanInbox() {
  if (scanInProgress) return;

  scanInProgress = true;
  console.log('[InboxScanner] Starting scan...');

  try {
    const authenticated = await microsoft.isAuthenticated();
    const bridgeAvailable = microsoft.isBridgeConfigured();
    if (!authenticated && !bridgeAvailable) {
      console.log('[InboxScanner] Microsoft not authenticated and no bridge — skipping');
      return;
    }

    // Fetch last 12 hours of email
    const emails = await microsoft.fetchRecentEmails(12, 40);
    if (!emails || emails.length === 0) {
      console.log('[InboxScanner] No recent emails');
      lastScanTime = new Date().toISOString();
      return;
    }

    // Filter to unread + flagged + high importance only to reduce noise
    const candidates = emails.filter(e =>
      !e.isRead || e.isFlagged || e.importance === 'high'
    );

    if (candidates.length === 0) {
      console.log('[InboxScanner] No unread/flagged/important emails');
      lastScanTime = new Date().toISOString();
      return;
    }

    // Build email summary for Claude
    const emailSummary = candidates.map(e => ({
      id: e.id,
      subject: e.subject,
      from: `${e.from} <${e.fromEmail}>`,
      received: e.received,
      isRead: e.isRead,
      importance: e.importance,
      isFlagged: e.isFlagged,
      preview: e.preview
    }));

    let parsed = [];
    // Route through AI provider (sends to Pi 4 worker, falls back to local)
    // DO NOT call Ollama directly — it blocks Pi 5 for interactive use
    try {
      const aiProvider = require('./ai-provider');
      const result = await aiProvider.triageEmails(
        `${TRIAGE_PROMPT}\n\nHere are ${candidates.length} emails from the last 12 hours:\n\n${JSON.stringify(emailSummary, null, 2)}`
      );
      if (result.text) {
        const jsonMatch = result.text.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');
        console.log(`[InboxScanner] Triaged via ${result.provider}`);
      }
    } catch (aiErr) {
      console.error('[InboxScanner] AI triage failed:', aiErr.message);
    }

    try {
      // Enrich with email metadata and persist to DB
      for (const item of parsed) {
        const email = candidates.find(e => e.id === item.emailId);
        const enriched = {
          ...item,
          received: email?.received || null,
          isRead: email?.isRead || false,
          fromEmail: email?.fromEmail || '',
          hasAttachments: email?.hasAttachments || false
        };
        db.upsertInboxItem(enriched);
      }

      console.log(`[InboxScanner] Flagged ${parsed.length} items from ${candidates.length} candidates`);
    } catch (parseErr) {
      console.error('[InboxScanner] Failed to parse Claude response:', parseErr.message);
      console.error('[InboxScanner] Raw response:', text.substring(0, 200));
    }

    lastScanTime = new Date().toISOString();

    // Raise/refresh/clear the urgent-email nudge off the freshly triaged set
    try {
      require('./nudges').triggerUrgentEmailNudge();
    } catch (e) {
      console.warn('[InboxScanner] Failed to sync urgent email nudge:', e.message);
    }

    // Cleanup dismissed items older than 7 days
    db.cleanupOldDismissed(7);
  } catch (err) {
    console.error('[InboxScanner] Scan error:', err.message);
  } finally {
    scanInProgress = false;
  }
}

function getFlaggedItems() {
  const items = db.getActiveInboxItems().map(row => ({
    emailId: row.email_id,
    subject: row.subject,
    from: row.from_name,
    fromEmail: row.from_email,
    urgency: row.urgency,
    category: row.category,
    summary: row.summary,
    reason: row.reason,
    received: row.received,
    isRead: !!row.is_read,
    hasAttachments: !!row.has_attachments
  }));
  return {
    items,
    lastScan: lastScanTime,
    scanning: scanInProgress
  };
}

function dismissItem(emailId) {
  db.dismissInboxItem(emailId);
  console.log(`[InboxScanner] Dismissed item: ${emailId}`);
  // Dismissing the last urgent item should silence the banner immediately
  try { require('./nudges').triggerUrgentEmailNudge(); } catch {}
}

function start() {
  // Initial scan after 30 seconds (let server finish booting)
  setTimeout(() => scanInbox(), 30 * 1000);
  // Then every 10 minutes
  setInterval(() => scanInbox(), SCAN_INTERVAL);
  console.log('[InboxScanner] Scheduled — scans every 10 minutes');
}

module.exports = {
  scanInbox,
  getFlaggedItems,
  dismissItem,
  start
};
