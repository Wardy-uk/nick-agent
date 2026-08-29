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
const { VOICE_COMPACT } = require('./sara-voice');
// The briefing is delivered through Nurtur's tenant — see _collectFocusItems.
const { mayLeaveTheBuilding } = require('../../shared/task-domain.cjs');

const BRIEF_KEY = 'last_brief';
const ALERT_SEEN_KEY = 'alert_seen_ids';
// One-shot: set the first time the widened escalation query runs (#94).
const ESCALATION_WIDE_ALERT_KEY = 'escalation_alert_wide_seeded';

// ── Source collectors ────────────────────────────────────────────────────────

async function _collectFocusItems() {
  try {
    const engine = require('./decision-engine');
    const result = await engine.evaluate();
    const items = result.items || [];

    // ⚠ THE BRIEFING LEAVES THE BUILDING. It is delivered by Graph Mail and
    // Teams — both Nurtur's tenant, both on Nurtur's retention policy — so a
    // personal task in it puts Nick's private life in his employer's mail
    // system, permanently, where he cannot take it back.
    //
    // A todo item's TITLE is the task's own text, so this is not hypothetical
    // once personal tasks exist. Filtered HERE, at the outbound boundary,
    // rather than in decision-engine: the Surface, Focus and the phone should
    // all show personal work, and only the paths that send ask this question.
    // Same rule that makes action-presenter the single arbiter of what counts
    // as outbound.
    //
    // ⚠ Known limit, stated rather than papered over: this drops the ITEM, and
    // the counts inside a summary item ("· 3 other overdue") are still computed
    // over every domain. A number is a much smaller disclosure than a task's
    // wording, but it is not zero, and scoping the counts needs a domain-aware
    // `evaluate()` — deliberately not done here, because that call is shared
    // with the two surfaces that must keep seeing everything.
    const held = items.filter((i) => !mayLeaveTheBuilding({ domain: i.meta?.domain }));
    if (held.length) {
      console.log(`[Briefing] ${held.length} personal item(s) held back from an outbound brief`);
    }
    return items.filter((i) => mayLeaveTheBuilding({ domain: i.meta?.domain }));
  } catch (e) {
    console.warn('[Briefing] Could not collect focus items:', e.message);
    return [];
  }
}

// email-triage exposes getTriageByCategory(), not getTriagedEmails() — the old
// name never existed, so the typeof guard always failed and every brief since
// this was written has silently claimed an empty inbox.
async function _collectEmailSummary() {
  try {
    const emailTriage = require('./email-triage');
    const triage = emailTriage.getTriageByCategory();
    const urgent = triage.urgent || [];
    // Count the CATEGORY buckets only. urgent/reply are lanes and overlap them,
    // so summing all six would double-count every actionable email.
    const total = ['action', 'fyi', 'delegate', 'ignore']
      .reduce((n, cat) => n + (triage[cat] || []).length, 0);
    return { total, urgent: urgent.length, items: urgent.slice(0, 3) };
  } catch (e) {
    console.warn('[Briefing] Email summary failed:', e.message);
    return { total: 0, urgent: 0, items: [] };
  }
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
 * How much Nick has to give today, for the MORNING brief only.
 *
 * This is the one place health earns a place in something that arrives rather
 * than waiting to be found: the brief already goes out, so a line on it costs no
 * new interruption. Nudge volume is the budget that argues against everything
 * else, and a separate health push would spend it.
 *
 * ⚠ Deliberately NOT fed to the model. `_aiSynthesis` writes the spoken line,
 * and a model handed "HRV is down" will produce advice — "take it easy today" —
 * which is a recommendation drawn from three numbers by something that cannot
 * tell exercise from illness. The sentence is composed once in `health-daily`
 * and travels verbatim, the same rule that keeps the Surface, the widget and the
 * notification from phrasing one fact three ways.
 *
 * Never throws and never blocks: a brief that fails because a watch did not sync
 * is a worse outcome than a brief with no health line on it.
 */
async function _collectReadiness(label) {
  if (label !== 'morning') return null;
  try {
    const { readiness, sentence } = require('./health-daily').today();
    if (!readiness.known) return null;
    return { state: readiness.state, score: readiness.score, sentence, partial: readiness.partial };
  } catch (e) {
    console.warn('[Briefing] Readiness unavailable:', e.message);
    return null;
  }
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

    const itemsList = topItems.map((i, n) => {
      let line = `${n + 1}. [${i.urgency}] ${i.title}${i.reason ? ` (${i.reason})` : ''}`;
      // Give the model the actual tickets, not just "3 unseen escalations"
      if (i.meta?.escalations?.length) {
        line += i.meta.escalations
          .map(e => `\n   - ${e.key}: ${e.summary}`)
          .join('');
      }
      return line;
    }).join('\n');

    const extras = [];
    if (emailSummary.urgent > 0) extras.push(`${emailSummary.urgent} urgent emails`);
    if (teamsData && !teamsData.unavailable && teamsData.mentions?.length) {
      extras.push(`${teamsData.mentions.length} Teams @mentions`);
    }

    const prompt = `${VOICE_COMPACT}

Write a 2-sentence brief (40 words max) telling Nick what to focus on right now. Lead with the thing that matters, not a summary of the list. Don't start with "Nick".

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

  const [focusItems, emailSummary, teamsData, readiness] = await Promise.all([
    _collectFocusItems(),
    _collectEmailSummary(),
    _collectTeams(),
    _collectReadiness(label),
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
    // Carried on the brief whatever it says, so the Focus view can render it for
    // free. Whether it INTERRUPTS is a separate decision, taken below.
    readiness,
  };

  // Store for Focus view
  db.setState(BRIEF_KEY, JSON.stringify(brief));
  console.log(`[Briefing] Built in ${Date.now() - t0}ms — doNow:${brief.doNow.length} doNext:${brief.doNext.length}`);

  // Push notification
  const pushTitle = brief.doNow.length
    ? `${brief.doNow.length} thing${brief.doNow.length > 1 ? 's' : ''} need you`
    : 'SARA Brief';
  // ⚠ Only when it is NEWS. "About normal today" is true, cheap to compute and
  // worth having on the screen — and appended to a push every single morning it
  // is padding, which is how the line above it stops being read. So the brief
  // always carries it and the notification only mentions a day that is actually
  // off his own baseline.
  const pushBody = readiness && readiness.state !== 'normal'
    ? `${synthesis}\n${readiness.sentence}`
    : synthesis;
  try {
    await webpush.sendToAll(pushTitle, pushBody, { type: 'brief', ts: brief.ts });
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
 * Check for new escalations. Fires a push if new ones found since last check.
 *
 * #94 — this had the same narrow query as `jira.syncEscalations`: the request
 * type arm only, so an escalation the team moved into the tier never alerted.
 * It is the LOUDER of the two paths, and the one worth being careful with: it
 * pushes once PER ticket, and `escalation_alert` is in webpush's
 * ALWAYS_DELIVER, which bypasses quiet hours and the hourly cap. Eleven of the
 * seventeen were absent from the seen list, so widening this without the
 * backfill below is eleven notifications about months-old tickets, at whatever
 * hour the deploy happens to land. They are new to NEURO, not to Nick.
 */
async function checkEscalationAlerts() {
  try {
    const jira = require('./jira');

    // Fetch current escalations from Jira — both arms.
    const issues = await jira.fetchActiveEscalations();
    const allEscalations = issues.map(i => ({ key: i.key, summary: i.summary || i.key }));

    const seenRaw = (() => { try { return JSON.parse(db.getState(ALERT_SEEN_KEY) || '{}'); } catch { return {}; } })();
    const seen = seenRaw.escalations || [];
    const newOnes = allEscalations.filter(t => !seen.includes(t.key));

    // Stamped on the FIRST widened run whatever it finds. Gating the stamp on
    // "found something to backfill" would leave the flag unset on a quiet run,
    // and then swallow the next genuinely new escalation instead.
    const backfilling = !db.getState(ESCALATION_WIDE_ALERT_KEY);
    if (backfilling) db.setState(ESCALATION_WIDE_ALERT_KEY, new Date().toISOString());

    if (backfilling && newOnes.length > 0) {
      console.log(`[Briefing] Escalation alerts widened to both arms — recording ${newOnes.length} `
        + `pre-existing escalation(s) as already alerted rather than pushing about them.`);
      db.setState(ALERT_SEEN_KEY, JSON.stringify({
        ...seenRaw,
        escalations: [...seen, ...newOnes.map(t => t.key)].slice(-200),
      }));
      return;
    }

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
