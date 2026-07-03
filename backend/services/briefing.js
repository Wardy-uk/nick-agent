'use strict';

/**
 * Briefing service — builds and delivers "what must Nick do next" briefs.
 *
 * Scheduled runs: 9am + 1pm Mon-Fri (via scheduler).
 * Alert checks: every 5min for escalations + Teams mentions + meeting in 10min.
 *
 * Delivery: push notification + email + stored in KV for Focus view.
 */

const db = require('../db/database');
const webpush = require('./webpush');
const emailSender = require('./email-sender');
const teams = require('./teams');

const BRIEF_KEY = 'last_brief';
const ALERT_SEEN_KEY = 'alert_seen_ids';

// ── Source collectors ────────────────────────────────────────────────────────

async function _collectFocusItems() {
  try {
    const engine = require('./decision-engine');
    const result = await engine.evaluate();
    return result.items || [];
  } catch (e) {
    console.warn('[Briefing] Could not collect focus items:', e.message);
    return [];
  }
}

async function _collectEmailSummary() {
  try {
    const emailTriage = require('./email-triage');
    if (typeof emailTriage.getTriagedEmails === 'function') {
      const emails = await emailTriage.getTriagedEmails();
      const urgent = (emails || []).filter(e => e.category === 'high' || e.category === 'urgent');
      return { total: (emails || []).length, urgent: urgent.length, items: urgent.slice(0, 3) };
    }
  } catch (e) {
    // email triage not available or API not matching — skip
  }
  return { total: 0, urgent: 0, items: [] };
}

async function _collectTeams() {
  try {
    return await teams.getRecentActivity(4);
  } catch (e) {
    return { unavailable: true };
  }
}

// ── Brief builder ─────────────────────────────────────────────────────────────

/**
 * Bucket focus items into do-now / do-next / fyi by urgency + score.
 */
function _bucketItems(items) {
  const doNow = items.filter(i => i.urgency === 'critical' || i.urgency === 'high').slice(0, 5);
  const doNext = items.filter(i => i.urgency === 'medium').slice(0, 4);
  const fyi = items.filter(i => i.urgency === 'low').slice(0, 3);
  return { doNow, doNext, fyi };
}

/**
 * Build a deterministic brief text (fallback when OpenRouter unavailable).
 */
function _deterministicSynthesis(buckets, emailSummary, teamsData) {
  const lines = [];
  if (buckets.doNow.length) {
    lines.push(`${buckets.doNow.length} thing${buckets.doNow.length > 1 ? 's' : ''} need your attention now.`);
  }
  if (emailSummary.urgent > 0) {
    lines.push(`${emailSummary.urgent} urgent email${emailSummary.urgent > 1 ? 's' : ''} in your inbox.`);
  }
  if (teamsData && !teamsData.unavailable && teamsData.mentions?.length) {
    lines.push(`${teamsData.mentions.length} Teams @mention${teamsData.mentions.length > 1 ? 's' : ''} waiting.`);
  }
  if (!lines.length) lines.push('Nothing urgent right now.');
  return lines.join(' ');
}

/**
 * Try to get an AI synthesis via OpenRouter.
 */
async function _aiSynthesis(buckets, emailSummary, teamsData) {
  try {
    const aiRouting = require('./ai-routing');
    const topItems = [...buckets.doNow, ...buckets.doNext].slice(0, 6);
    if (!topItems.length) return null;

    const itemsList = topItems.map((i, n) =>
      `${n + 1}. [${i.urgency}] ${i.title}${i.reason ? ` (${i.reason})` : ''}`
    ).join('\n');

    const extras = [];
    if (emailSummary.urgent > 0) extras.push(`${emailSummary.urgent} urgent emails`);
    if (teamsData && !teamsData.unavailable && teamsData.mentions?.length) {
      extras.push(`${teamsData.mentions.length} Teams @mentions`);
    }

    const prompt = `You are SARA, Nick's executive AI assistant. Write a punchy 2-sentence brief (max 40 words total) telling Nick what to focus on right now. Be direct, no waffle. Don't start with "Nick".

Items:
${itemsList}
${extras.length ? `\nAlso: ${extras.join(', ')}` : ''}`;

    const result = await aiRouting.runTask('briefing_synthesis', { prompt, maxTokens: 80 });
    return result?.text?.trim() || null;
  } catch (e) {
    console.warn('[Briefing] AI synthesis failed:', e.message);
    return null;
  }
}

// ── Main build + deliver ──────────────────────────────────────────────────────

async function buildAndDeliver(opts = {}) {
  const label = opts.label || 'brief';
  console.log(`[Briefing] Building ${label}...`);
  const t0 = Date.now();

  const [focusItems, emailSummary, teamsData] = await Promise.all([
    _collectFocusItems(),
    _collectEmailSummary(),
    _collectTeams(),
  ]);

  const buckets = _bucketItems(focusItems);

  // Try AI synthesis, fall back to deterministic
  const synthesis = await _aiSynthesis(buckets, emailSummary, teamsData) ||
    _deterministicSynthesis(buckets, emailSummary, teamsData);

  const brief = {
    ts: new Date().toISOString(),
    label,
    synthesis,
    doNow: buckets.doNow,
    doNext: buckets.doNext,
    fyi: buckets.fyi,
    email: emailSummary,
    teams: teamsData?.unavailable ? null : { mentions: teamsData?.mentions?.length || 0, unreadDMs: teamsData?.unreadDMs?.length || 0 },
  };

  // Store for Focus view
  db.setState(BRIEF_KEY, JSON.stringify(brief));
  console.log(`[Briefing] Built in ${Date.now() - t0}ms — doNow:${brief.doNow.length} doNext:${brief.doNext.length}`);

  // Push notification
  const pushTitle = brief.doNow.length
    ? `${brief.doNow.length} thing${brief.doNow.length > 1 ? 's' : ''} need you`
    : 'SARA Brief';
  try {
    await webpush.sendToAll(pushTitle, synthesis, { type: 'brief', ts: brief.ts });
    console.log('[Briefing] Push sent');
  } catch (e) {
    console.error('[Briefing] Push failed:', e.message);
  }

  // Email (gracefully degrades until Mail.Send scope added)
  try {
    const now = new Date();
    const timeLabel = now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const subject = `SARA ${label === 'morning' ? 'Morning' : label === 'midday' ? 'Midday' : ''} Brief — ${timeLabel}`;
    const html = emailSender.briefToHtml(brief);
    const emailResult = await emailSender.sendBriefEmail(subject, html);
    if (!emailResult.sent) {
      console.log(`[Briefing] Email not sent (${emailResult.reason}) — will activate after Monday re-consent`);
    }
  } catch (e) {
    console.error('[Briefing] Email error:', e.message);
  }

  return brief;
}

/**
 * Return the last stored brief (for GET /api/briefing).
 */
function getLastBrief() {
  const raw = db.getState(BRIEF_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Alert checks (run every 5 min) ───────────────────────────────────────────

/**
 * Check for new escalations (request type = Escalation OR label = neuro-escalation).
 * Fires a push if new ones found since last check.
 */
async function checkEscalationAlerts() {
  try {
    const jira = require('./jira');

    // Fetch current escalations from Jira
    const issues = await jira.fetchEscalationTickets();

    // Also check for neuro-escalation label via flagged tickets
    const flagged = jira.getFlaggedTickets ? jira.getFlaggedTickets() : [];
    const labelEscalations = flagged.filter(t =>
      (t.labels || []).includes('neuro-escalation')
    );

    const allEscalations = [
      ...issues.map(i => ({ key: i.key, summary: i.fields?.summary || i.key })),
      ...labelEscalations.map(t => ({ key: t.key, summary: t.summary || t.key })),
    ];

    const seenRaw = (() => { try { return JSON.parse(db.getState(ALERT_SEEN_KEY) || '{}'); } catch { return {}; } })();
    const seen = seenRaw.escalations || [];
    const newOnes = allEscalations.filter(t => !seen.includes(t.key));

    if (newOnes.length > 0) {
      console.log(`[Briefing] ${newOnes.length} new escalation(s) — alerting`);
      for (const ticket of newOnes) {
        await webpush.sendToAll(
          'New escalation',
          `${ticket.key}: ${ticket.summary}`,
          { type: 'escalation_alert', key: ticket.key }
        );
      }
      db.setState(ALERT_SEEN_KEY, JSON.stringify({
        ...seenRaw,
        escalations: [...seen, ...newOnes.map(t => t.key)].slice(-200),
      }));
    }
  } catch (e) {
    console.warn('[Briefing] Escalation alert check failed:', e.message);
  }
}

/**
 * Check for Teams @mentions since last check.
 * Fires a push for each new mention.
 */
async function checkTeamsAlerts() {
  try {
    const mentions = await teams.getNewMentions(10);
    if (!mentions.length) return;

    const seenRaw = (() => { try { return JSON.parse(db.getState(ALERT_SEEN_KEY) || '{}'); } catch { return {}; } })();
    const seen = seenRaw.teamsMentions || [];
    const newOnes = mentions.filter(m => !seen.includes(m.id));
    if (!newOnes.length) return;

    console.log(`[Briefing] ${newOnes.length} new Teams mention(s) — alerting`);
    for (const m of newOnes) {
      await webpush.sendToAll(
        `Teams: ${m.from}`,
        m.preview,
        { type: 'teams_mention', chatId: m.chatId }
      );
    }
    db.setState(ALERT_SEEN_KEY, JSON.stringify({
      ...seenRaw,
      teamsMentions: [...seen, ...newOnes.map(m => m.id)].slice(-200),
    }));
  } catch (e) {
    console.warn('[Briefing] Teams alert check failed:', e.message);
  }
}

/**
 * Check for meetings starting in ~10 minutes.
 * Fires a push if one found and no prep note exists.
 */
async function checkMeetingAlerts() {
  try {
    const workingMemory = require('./working-memory');
    const ctx = await workingMemory.getContext();
    const calendar = ctx.calendar || [];

    const now = Date.now();
    const in10 = now + 10 * 60 * 1000;
    const in15 = now + 15 * 60 * 1000;

    const upcoming = calendar.filter(e => {
      if (e.is_all_day) return false;
      const start = new Date(e.start_time).getTime();
      return start > in10 && start <= in15;
    });

    if (!upcoming.length) return;

    const seenRaw = (() => { try { return JSON.parse(db.getState(ALERT_SEEN_KEY) || '{}'); } catch { return {}; } })();
    const seen = seenRaw.meetingAlerts || [];

    for (const event of upcoming) {
      const id = event.event_id || event.id;
      if (seen.includes(id)) continue;

      console.log(`[Briefing] Meeting alert: ${event.subject} in ~10min`);
      await webpush.sendToAll(
        `📅 Starting in 10 min`,
        event.subject || 'Meeting',
        { type: 'meeting_alert', eventId: id }
      );
      seen.push(id);
    }

    db.setState(ALERT_SEEN_KEY, JSON.stringify({
      ...seenRaw,
      meetingAlerts: seen.slice(-50),
    }));
  } catch (e) {
    console.warn('[Briefing] Meeting alert check failed:', e.message);
  }
}

/**
 * Run all alert checks. Called every 5 min by the scheduler.
 */
async function runAlertChecks() {
  await Promise.allSettled([
    checkEscalationAlerts(),
    checkTeamsAlerts(),
    checkMeetingAlerts(),
  ]);
}

module.exports = { buildAndDeliver, getLastBrief, runAlertChecks };
