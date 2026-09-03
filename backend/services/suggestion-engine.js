'use strict';

/**
 * Suggestion Engine — execution-first action suggestions from Focus items.
 *
 * Philosophy: "Do it" not "plan to do it".
 * Suggestions navigate the user to real actions, not task creation.
 *
 * Action types:
 *   - open_ticket       → navigate to Jira ticket
 *   - open_task         → navigate to top overdue task in TodoPanel
 *   - open_email        → navigate to inbox
 *   - open_standup      → navigate to standup
 *   - open_meeting_prep → navigate to meeting prep
 *   - draft_reply       → (future: open draft composer)
 *
 * A navigation action gets its OWN type per destination. The meeting-prep nudge
 * spent months reusing `open_task` with `navigate: 'meeting-prep'` in the
 * payload, and since the presenter keys on the type, every one of them rendered
 * as "Open tasks — jump to your task list": six cards on the approval screen,
 * identical above their reason line, all naming a destination they did not go
 * to. The destination is the entire content of a navigation card.
 *
 * Each suggestion returns a navigation target so the frontend
 * can immediately move the user to the right place.
 */

const db = require('../db/database');
// Only for its `kind` classification — the presenter does not require this file
// back (its test reads the source as text), so there is no cycle here.
const actionPresenter = require('./action-presenter');

const SARA_MODE = process.env.SARA_MODE || 'suggest';
const JIRA_BASE = process.env.JIRA_BASE_URL || '';

// ── Signal type → execution action mapping ──

const SUGGESTION_RULES = [
  {
    // SLA risk tickets → open the top ticket directly
    match: (item) => item.type === 'jira_ticket' && item.urgency === 'critical',
    generate: (item) => {
      const key = item.meta?.keys?.[0] || item.meta?.key;
      return {
        type: 'open_ticket',
        confidence: 0.95,
        reason: key ? `Open ${key} — SLA is breaching` : 'Check the at-risk queue now',
        payload: {
          ticketKey: key,
          url: key && JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : null,
          navigate: 'queue',
        },
      };
    },
  },
  {
    // SLA risk (non-critical) → open queue
    match: (item) => item.type === 'jira_ticket',
    generate: (item) => {
      const count = item.meta?.count || 1;
      return {
        type: 'open_ticket',
        confidence: 0.85,
        reason: `${count} ticket${count > 1 ? 's' : ''} at SLA risk — review queue`,
        payload: {
          navigate: 'queue',
          filter: 'at-risk',
        },
      };
    },
  },
  {
    // Escalation → open escalation queue
    match: (item) => item.type === 'escalation',
    generate: (item) => ({
      type: 'open_ticket',
      confidence: 0.92,
      reason: `${item.title} — respond now`,
      payload: {
        navigate: 'queue',
        filter: 'escalations',
      },
    }),
  },
  {
    // Overdue tasks → open the top overdue task
    match: (item) => item.type === 'todo' && item.id.includes('overdue'),
    generate: (item) => ({
      type: 'open_task',
      confidence: 0.8,
      reason: `Start with your top overdue task`,
      payload: {
        navigate: 'todos',
        filter: 'overdue',
      },
    }),
  },
  {
    // Due today → open today's tasks
    match: (item) => item.type === 'todo' && item.id.includes('today'),
    generate: (item) => ({
      type: 'open_task',
      confidence: 0.7,
      reason: `Tasks due today — start the first one`,
      payload: {
        navigate: 'todos',
        filter: 'today',
      },
    }),
  },
  {
    // A single urgent email we can name → offer to draft the reply rather than
    // just pointing at the inbox. Approving drafts; sending is a second approval.
    match: (item) => item.type === 'email' && !!item.meta?.emailId,
    generate: (item) => ({
      type: 'draft_reply',
      confidence: 0.82,
      reason: `Draft a reply to ${item.meta.from || 'sender'} — "${item.meta.subject || item.title}"`,
      payload: {
        emailId: item.meta.emailId,
        subject: item.meta.subject || null,
        from: item.meta.from || null,
        navigate: 'inbox',
      },
    }),
  },
  {
    // Urgent emails → open inbox
    match: (item) => item.type === 'email',
    generate: (item) => ({
      type: 'open_email',
      confidence: 0.75,
      reason: `${item.meta?.count || 1} urgent email${(item.meta?.count || 1) > 1 ? 's' : ''} — check inbox`,
      payload: {
        navigate: 'inbox',
        filter: 'urgent',
      },
    }),
  },
  {
    // Standup not done → open standup
    match: (item) => item.type === 'nudge' && item.meta?.type === 'standup',
    generate: (item) => ({
      type: 'open_standup',
      confidence: 0.7,
      reason: 'Do your standup — 2 minutes',
      payload: {
        navigate: 'standup',
      },
    }),
  },
  {
    // EOD not done → open standup (EOD tab)
    match: (item) => item.type === 'nudge' && item.meta?.type === 'eod',
    generate: (item) => ({
      type: 'open_standup',
      confidence: 0.65,
      reason: 'Wrap up — do your EOD',
      payload: {
        navigate: 'standup',
      },
    }),
  },
  {
    // Meeting imminent → open meeting prep
    match: (item) => item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 15,
    generate: (item) => ({
      type: 'open_meeting_prep',
      confidence: 0.8,
      reason: `"${item.title}" starts in ${item.meta.minutesAway} min — prep now`,
      payload: {
        navigate: 'meeting-prep',
        title: item.title || null,
        // The START, not minutesAway. A stored relative time is wrong the minute
        // after it is written, and it is what tells the expiry sweep the moment
        // has passed — a prep card for a meeting that began two hours ago can
        // only ever be rejected.
        start: item.meta.start || null,
      },
    }),
  },
];


/**
 * Generate suggestions from Focus shortlist items.
 * Returns 1 primary + optional 1 secondary (max 2).
 * Deduplicates against today's actions.
 */
function generateSuggestions(focusItems) {
  if (SARA_MODE === 'off') return [];

  // Before the dedupe read, not after: a spent shortcut left pending would also
  // block today's fresh one for the same focus item.
  expireStaleNavigation();

  if (!focusItems || focusItems.length === 0) return [];

  const suggestions = [];
  // Only deduplicate against PENDING actions (not executed/rejected).
  // Navigation actions (open_ticket, open_task, etc.) are repeatable —
  // the user should always have a "Do it" option available.
  //
  // The limit is explicit and large because getPendingSaraActions defaults to
  // TEN. Once more than ten actions were pending, the ones being generated fell
  // outside the dedupe window and were re-queued on every /api/focus call —
  // which is hit by every Focus load, every agent loop and every briefing. That
  // compounded to 15,605 pending rows, most of them the same handful repeated.
  const pendingActions = db.getPendingSaraActions(1000);
  const pendingKeys = new Set(
    pendingActions.map(a => `${a.type}:${a.focus_item_id}`)
  );

  for (const item of focusItems) {
    for (const rule of SUGGESTION_RULES) {
      if (!rule.match(item)) continue;

      const suggestion = rule.generate(item);
      if (!suggestion) continue;

      const dedupeKey = `${suggestion.type}:${item.id}`;
      if (pendingKeys.has(dedupeKey)) continue;

      suggestions.push({
        ...suggestion,
        focusItemId: item.id,
        focusItemTitle: item.title,
        autoExecutable: false,
      });

      break;
    }
  }

  // Primary = highest confidence, secondary = next best
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, 2);
}

/**
 * Queue a single action for approval and return its id.
 *
 * This is the front door for anything that wants SARA to *do* something without
 * doing it itself — chat tools especially. Nothing here executes; the action sits
 * pending until it is approved through /api/actions/:id/approve.
 */
function queueAction(type, payload, reason, confidence = 0.9, focusItemId = null) {
  return db.createSaraAction(type, payload || {}, confidence, reason || type, focusItemId);
}

/**
 * Persist suggestions to the database.
 */
function persistSuggestions(suggestions) {
  const created = [];
  // Second guard, at the write rather than the decision. The caller's dedupe
  // depends on reading a complete pending set; this one cannot be defeated by a
  // limit, a race between two /api/focus calls, or a future caller that forgets.
  const existing = new Set(
    db.getPendingSaraActions(1000).map(a => `${a.type}:${a.focus_item_id}`)
  );
  for (const s of suggestions) {
    const key = `${s.type}:${s.focusItemId}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const id = db.createSaraAction(s.type, s.payload, s.confidence, s.reason, s.focusItemId);
    created.push({ ...s, id, status: 'pending' });
  }
  return created;
}

// ── Navigation shortcuts go out of date; nothing was retiring them ───────────
//
// A navigate action is a shortcut to somewhere useful RIGHT NOW. Nothing ever
// aged one out, so the approval screen accumulated them: a meeting-prep card for
// a 09:45 meeting was still asking to be approved at 11:40, and an "open the
// standup" card outlives the day it was raised for. Neither can be acted on any
// more — the only honest thing left to do with either is reject it, which is
// work the screen was creating for itself.
//
// Two rules, and the SECOND is the general one:
//   1. The payload names a moment (a meeting start) and it has passed.
//   2. It was raised on an earlier day. "Now" is the entire premise of a
//      shortcut, so a shortcut does not survive the day it was raised on.
//
// What counts as navigation is `action-presenter`'s call, never a list of type
// names kept here — the same rule that keeps three places agreeing on what
// "leaves the building" means. Writes and outbound are untouched: a drafted
// reply or a queued chase is still worth approving next week.

const NAV_READ_ALL = 100000;

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function parseSqlTimestamp(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day — never toISOString(); the Pi may run in UTC. */
function localDay(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Why this navigation shortcut is spent, or null if it still stands.
 *
 * Pure: takes the action and "now", touches no DB and no clock, so the rule can
 * be pinned without a database or a particular time of day.
 */
function navigationExpiry(action, now = new Date()) {
  if (!action) return null;
  if (actionPresenter.describe(action).kind !== actionPresenter.NAVIGATE) return null;

  const start = parseSqlTimestamp(action.payload?.start) || null;
  if (start && start <= now) return 'the meeting it was prepping for has already started';

  const created = parseSqlTimestamp(action.created_at);
  if (created && localDay(created) !== localDay(now)) return 'a shortcut to "now", raised on an earlier day';

  return null;
}

/**
 * Retire every pending navigation action whose moment has passed.
 *
 * `expired` rather than `rejected`: Nick did not decide anything about these, and
 * the rejection history is a record of what he turned down. Follows the
 * `superseded` status action-candidates already uses for the same reason.
 */
function expireStaleNavigation(now = new Date()) {
  const expired = [];
  try {
    for (const action of db.getPendingSaraActions(NAV_READ_ALL)) {
      const reason = navigationExpiry(action, now);
      if (!reason) continue;
      db.updateSaraActionStatus(action.id, 'expired');
      expired.push({ id: action.id, type: action.type, reason });
    }
  } catch (e) {
    console.warn('[Suggestion] Navigation expiry failed:', e.message);
  }
  if (expired.length) {
    console.log(`[Suggestion] Expired ${expired.length} navigation action(s): ${expired.map(e => `#${e.id} ${e.type}`).join(', ')}`);
  }
  return expired;
}

/**
 * Execute an approved action.
 *
 * Three kinds live here now:
 *   - navigation (open_*)     — the frontend moves; nothing is written
 *   - vault writes            — capture_todo
 *   - real actuators          — draft_reply, reply_email, complete_task,
 *                               schedule_focus_block. These change the outside
 *                               world via Graph, which is why they are async.
 *
 * Outbound email is deliberately two-gated: approving `draft_reply` only writes
 * a draft and queues a `reply_email` action carrying it, so nothing is sent
 * until Nick has approved the actual words.
 */
async function executeAction(action) {
  const payload = action.payload;

  switch (action.type) {
    case 'open_ticket':
    case 'open_task':
    case 'open_email':
    case 'open_standup':
    case 'open_meeting_prep': {
      // Navigation actions — the frontend handles the actual navigation.
      // We just log and return the target.
      return {
        ok: true,
        detail: `Navigate to ${payload.navigate || action.type}`,
        navigate: payload.navigate || null,
        navigateContext: payload.filter ? { fromFocus: true, filter: payload.filter } : { fromFocus: true },
        url: payload.url || null,
      };
    }

    // Gate 1 of 2 for outbound email: draft the words, show them, send nothing.
    // Approving this queues a reply_email action holding the draft.
    case 'draft_reply': {
      const emailId = payload.emailId;
      if (!emailId) return { ok: false, detail: 'draft_reply needs an emailId' };

      let draft = payload.body || '';
      if (!draft) {
        try {
          const microsoft = require('./microsoft');
          const message = await microsoft.fetchEmailById(emailId);
          const prompt = `Draft a reply to this email as Nick Ward, Head of Technical Support at Nurtur. Direct, warm, concise — British English, no corporate padding. Sign off "Nick". Output only the reply body, no subject line and no commentary.

From: ${message?.from || payload.from || 'Unknown'}
Subject: ${message?.subject || payload.subject || '(no subject)'}

${String(message?.body || message?.preview || '').slice(0, 4000)}`;
          const result = await require('./ai-routing').runTask('email_draft', { prompt, maxTokens: 500 });
          draft = (result?.text || '').trim();
        } catch (e) {
          console.warn('[Suggestion] Draft generation failed:', e.message);
        }
      }
      if (!draft) return { ok: false, detail: 'Could not draft a reply — open the composer instead' };

      const replyId = db.createSaraAction(
        'reply_email',
        { emailId, body: draft, subject: payload.subject || null, to: payload.to || null },
        0.9,
        `Send reply to ${payload.from || 'sender'}: "${payload.subject || 'email'}"`,
        action.focus_item_id || null
      );

      return {
        ok: true,
        detail: `Drafted a reply — approve action #${replyId} to send it`,
        draft,
        pendingActionId: replyId,
        navigate: 'inbox',
      };
    }

    // Gate 2: the words have been seen and approved. This one really sends.
    case 'reply_email': {
      if (!payload.emailId) return { ok: false, detail: 'reply_email needs an emailId' };
      if (!payload.body || !String(payload.body).trim()) {
        return { ok: false, detail: 'reply_email has no body — nothing to send' };
      }

      const microsoft = require('./microsoft');
      const result = await microsoft.sendEmailReply(payload.emailId, String(payload.body).trim(), {
        replyAll: Boolean(payload.replyAll),
        to: Array.isArray(payload.to) && payload.to.length ? payload.to : null,
        cc: Array.isArray(payload.cc) && payload.cc.length ? payload.cc : null,
      });

      if (!result.sent) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Mail.Send not granted — re-consent to Microsoft.',
          no_recipients: 'No recipients resolved for that thread.',
        };
        return { ok: false, detail: reasons[result.reason] || `Send failed (${result.reason})` };
      }

      // Replied means handled — clear it from triage so it doesn't come back.
      try { require('./email-triage').dismissEmail(payload.emailId); } catch {}
      return { ok: true, detail: `Reply sent: "${payload.subject || payload.emailId}"`, navigate: 'inbox' };
    }

    // The weekly risk report going to Chris. Gate 2 of 2 — the report was built
    // and the recipient resolved at queue time; this is the approval that
    // actually releases it. Deliberately NOT written in SARA's voice: this mail
    // sends under Nick's name to the manager assessing his PIP, and the same
    // rule holds here as for chase messages and 1-2-1 invites.
    case 'send_weekly_risk_report': {
      const recipients = Array.isArray(payload.to) ? payload.to.filter(r => r?.email) : [];
      if (!recipients.length) return { ok: false, detail: 'No recipient stored — nothing to send to' };
      if (!payload.body || !String(payload.body).trim()) {
        return { ok: false, detail: 'No report body stored — nothing to send' };
      }

      // HTML, converted from the same markdown the vault note holds. As plain
      // text the report's tables arrive as pipe soup and its frontmatter leads
      // the mail — and the test send renders identically, so what Nick checks
      // is what Chris gets.
      const result = await require('./email-sender').sendMail({
        to: recipients,
        subject: payload.subject || `Weekly Risk & Anomaly Summary — w/c ${payload.week}`,
        body: require('./weekly-risk').toEmailHtml(String(payload.body)),
        html: true,
      });

      if (!result.sent) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Mail.Send not granted — re-consent to Microsoft.',
          no_recipients: 'No recipients resolved.',
          empty_body: 'The report body was empty.',
        };
        return { ok: false, detail: reasons[result.reason] || `Send failed (${result.reason})` };
      }

      // Freeze the week. From here the report is a RECORD, not a draft: the
      // screen must show what actually went to Chris rather than a rebuild that
      // would quietly carry different numbers a week later.
      //
      // WARNING: recorded HERE rather than in the route, because the approval
      // can come from the weekly risk panel or from the Actions queue, and a
      // hook on one is a hook the other walks past. Never allowed to fail the
      // send -- the mail has already left.
      try {
        require('./weekly-risk').markSent(payload.week, {
          actionId: action && action.id ? action.id : null,
          recipients,
          subject: payload.subject || null,
          body: String(payload.body),
        });
      } catch (e) {
        console.warn('[SARA] Weekly risk send recorded nowhere:', e.message);
      }

      // Close the log row that tracks the Monday cadence, so the commitment
      // Nick made on 12 Aug is evidenced by the send rather than by memory.
      try {
        const log = require('./management-log');
        const open = log.list({ limit: 500 }).find(r =>
          r.status !== 'done' && /weekly team risk .* report to Chris/i.test(r.summary));
        if (open) log.update(open.id, { status: 'done' });
      } catch { /* bookkeeping must never fail a send that already happened */ }

      return {
        ok: true,
        detail: `Weekly risk report for w/c ${payload.week} sent to ${recipients.map(r => r.email).join(', ')}`,
      };
    }

    // Ticking a task off. NEURO-owned tasks go to the task store; Microsoft-owned
    // ones push over Graph. A Graph refusal is reported, not swallowed — the
    // local state still changes so the task stops nagging either way.
    case 'complete_task': {
      const detail = [];

      if (payload.taskId) {
        const taskStore = require('./task-store');
        const task = taskStore.setStatus(payload.taskId, 'done');
        if (!task) return { ok: false, detail: `Task #${payload.taskId} not found` };
        detail.push(`Completed: ${task.text}`);
      }

      if (payload.filePath && payload.lineNumber != null) {
        try { require('./obsidian').toggleTask(payload.filePath, payload.lineNumber); } catch (e) {
          detail.push(`(vault line not toggled: ${e.message})`);
        }
      }

      if (payload.msId) {
        const microsoft = require('./microsoft');
        const result = await microsoft.completeMicrosoftTask(payload.msId, payload.source || null, payload.listId || null);
        detail.push(result.completed
          ? `pushed to Microsoft (${result.kind || 'graph'})`
          : `Microsoft push failed (${result.reason}) — complete it there manually`);
      }

      if (!detail.length) return { ok: false, detail: 'complete_task needs a taskId or msId' };
      return { ok: true, detail: detail.join(' · '), navigate: 'todos' };
    }

    // Ask someone where a commitment got to. Goes to a direct report, so it is
    // approval-only by design: an automated chase to someone who works for you
    // reads as surveillance, however politely it is worded.
    // Escalate a support ticket in NOVA. NOVA owns every rule here — the comment
    // is internal-only, the due date only tightens, the priority only rises — so
    // this executor deliberately does no judging of its own. It reports back what
    // NOVA actually changed rather than what was asked for, because a due date
    // that was left alone (already tighter) still reads as a success otherwise.
    case 'escalate_ticket': {
      const nova = require('./nova-client');
      if (!nova.isConfigured()) return { ok: false, detail: 'NOVA is not configured — cannot escalate' };
      if (!payload.ticketKey) return { ok: false, detail: 'escalate_ticket needs a ticketKey' };

      let result;
      try {
        result = await nova.escalate({
          ticketKey: payload.ticketKey,
          reasonCode: payload.reasonCode,
          neededBy: payload.neededBy,
          notes: payload.notes,
        });
      } catch (e) {
        return { ok: false, detail: `NOVA refused the escalation: ${e.message}` };
      }

      const changed = [];
      if (result.priority?.changed) changed.push(`priority ${result.priority.from || 'unset'} → ${result.priority.to}`);
      if (result.duedate?.changed) changed.push(`due ${result.duedate.to}`);
      if (result.comment_posted) changed.push('internal comment posted');

      // A partial escalation must not read as a clean one.
      const warned = (result.warnings || []).length
        ? ` — but ${result.warnings.join(' ')}`
        : '';

      return {
        ok: true,
        detail: `Escalated ${result.ticket_key} (${result.reason_label})`
          + (changed.length ? `: ${changed.join(', ')}` : ': logged, nothing on the ticket needed changing')
          + warned,
        navigate: 'queue',
      };
    }

    case 'chase_commitment': {
      const waitingOn = require('./waiting-on');
      const item = waitingOn.list({ status: 'all' }).find(i => i.key === payload.waitingKey);
      if (!item) return { ok: false, detail: 'That waiting-on item no longer exists' };
      if (item.status !== 'open') return { ok: false, detail: `Already ${item.status} — nothing to chase` };

      // The address is normally resolved and stored when the chase is QUEUED, so
      // that the approval screen shows who it is going to. Prefer that over
      // re-resolving here: re-resolving would silently discard a manual override
      // and send to whoever the directory currently guesses, which is precisely
      // the case the override exists for.
      let email = payload.to?.email || null;
      if (!email) {
        // Older queued actions predate the stored address; fall back rather than
        // stranding them.
        const directory = require('./contact-directory');
        let resolved;
        try {
          resolved = await directory.resolveName(item.person);
        } catch (e) {
          return { ok: false, detail: `Could not look up ${item.person}: ${e.message}` };
        }
        // Never guess an address for a message that goes to a real person.
        if (!resolved || resolved.status !== 'resolved' || !resolved.email) {
          return { ok: false, detail: `No confident email for ${item.person} (${resolved?.status || 'unresolved'}) — set one on the chase, or add it to their People note` };
        }
        email = resolved.email;
      }

      const body = payload.body || waitingOn.buildChaseMessage(item);

      // Q9: email is what ships, Teams is a preference layered on top. So the
      // channel is a preference and email is the floor — a Teams DM that cannot
      // be delivered falls back rather than failing, because the point of the
      // chase is that the person is asked, not that Teams was used.
      const channel = payload.channel === 'teams' ? 'teams' : 'email';
      let via = 'email';
      let fellBackFrom = null;

      if (channel === 'teams') {
        const dm = await require('./teams').sendDm({ email, text: body });
        if (dm.sent) {
          via = 'teams';
        } else {
          // Recorded, not swallowed: "it went by email" without saying why is
          // how you fail to notice that Teams has never once worked.
          fellBackFrom = dm.reason;
          console.log(`[Chase] Teams unavailable (${dm.reason}) — falling back to email for ${item.person}`);
        }
      }

      if (via === 'email') {
        const result = await require('./email-sender').sendMail({
          to: [{ name: item.person, email }],
          subject: `Quick one — ${item.text.slice(0, 60)}`,
          body,
        });
        if (!result.sent) {
          const reasons = {
            auth: 'Not signed in to Microsoft — reconnect 365.',
            scope: 'Mail.Send not granted — re-consent to Microsoft.',
          };
          const why = reasons[result.reason] || `Send failed (${result.reason})`;
          return {
            ok: false,
            detail: fellBackFrom ? `${why} (Teams also unavailable: ${fellBackFrom})` : why,
          };
        }
      }

      waitingOn.markChased(item.key);
      // Name the channel AND the address. "Sent" without saying where is not a
      // useful confirmation when both were choosable.
      const where = via === 'teams' ? `Teams DM to ${email}` : email;
      const note = fellBackFrom ? ` — Teams unavailable (${fellBackFrom}), sent by email` : '';
      return {
        ok: true,
        detail: `Asked ${item.person} (${where}) about "${item.text.slice(0, 50)}"${note}`,
        navigate: 'people',
      };
    }

    // Ask the organiser what a meeting is for. An email to a real colleague —
    // often a senior one — so it only ever runs on approval.
    case 'chase_agenda': {
      if (!payload.eventId) return { ok: false, detail: 'chase_agenda needs an eventId' };
      const body = String(payload.body || '').trim();
      if (!body) return { ok: false, detail: 'No chaser text to send' };

      // Graph's emailAddress object is { name, address }; our own helpers use
      // { name, email }. Accept either rather than silently finding neither.
      const organiserEmail = payload.organizer?.email || payload.organizer?.address;
      if (!organiserEmail) return { ok: false, detail: 'No organiser address to send to' };
      const to = [{ name: payload.organizer.name || organiserEmail, email: organiserEmail }];

      const result = await require('./email-sender').sendMail({
        to,
        subject: `Re: ${payload.subject || 'your meeting'}`,
        body,
      });
      if (!result.sent) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Mail.Send not granted — re-consent to Microsoft.',
        };
        return { ok: false, detail: reasons[result.reason] || `Send failed (${result.reason})` };
      }
      return { ok: true, detail: `Asked ${payload.organizer?.name || 'the organiser'} what "${payload.subject}" is for`, navigate: 'calendar' };
    }

    // Decline, or counter-propose a time. "No, but here" moves the meeting
    // rather than bouncing it back for the organiser to solve.
    case 'respond_meeting': {
      if (!payload.eventId) return { ok: false, detail: 'respond_meeting needs an eventId' };
      const microsoft = require('./microsoft');
      const result = await microsoft.respondToEvent(payload.eventId, payload.response || 'decline', {
        comment: payload.comment || '',
        proposedNewTime: payload.proposedNewTime || null,
      });
      if (!result.ok) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Calendars.ReadWrite not granted — re-consent to Microsoft.',
          cannot_propose_on_accept: 'Graph will not take a counter-proposal on an accept.',
        };
        return { ok: false, detail: reasons[result.reason] || `Response failed (${result.reason})` };
      }
      const verb = { decline: 'Declined', accept: 'Accepted', tentative: 'Tentatively accepted' }[payload.response || 'decline'];
      return {
        ok: true,
        detail: `${verb} "${payload.subject || payload.eventId}"${result.proposed ? ' with a new time proposed' : ''}`,
        navigate: 'calendar',
      };
    }

    // Put the work in the diary. Defaults to a 60-minute block starting at the
    // next half hour, because "schedule it" with no time is the common case.
    case 'schedule_focus_block': {
      const microsoft = require('./microsoft');
      const start = payload.start ? new Date(payload.start) : _nextHalfHour();
      if (Number.isNaN(start.getTime())) return { ok: false, detail: `Unparseable start time: ${payload.start}` };
      const minutes = Number(payload.minutes) > 0 ? Number(payload.minutes) : 60;
      const end = payload.end ? new Date(payload.end) : new Date(start.getTime() + minutes * 60000);

      const result = await microsoft.createCalendarEvent({
        subject: payload.subject || 'Focus block',
        start: _graphLocalTime(start),
        end: _graphLocalTime(end),
        body: payload.body || null,
        location: payload.location || null,
        attendees: payload.attendees || [],
        isOnline: Boolean(payload.isOnline),
      });

      if (!result.created) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Calendars.ReadWrite not granted — re-consent to Microsoft.',
        };
        return { ok: false, detail: reasons[result.reason] || `Calendar write failed (${result.reason})` };
      }

      const when = start.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      // Say when invites actually went out — approving this emails real people.
      const invited = (payload.attendees || []).length;
      return {
        ok: true,
        detail: `Booked "${result.event.subject}" ${when} (${minutes} min)`
          + (invited ? ` — invited ${invited} ${invited === 1 ? 'person' : 'people'}` : ''),
        url: result.event.webLink || null,
        navigate: 'calendar',
      };
    }

    // Route 4 — promotion from meetings. Approving a suggestion creates the task in
    // NEURO (the source of truth) with a backlink to the note it came from.
    case 'capture_todo': {
      const taskStore = require('./task-store');
      const { id, created } = taskStore.createTask({
        text: payload.text,
        moscow: payload.metadata?.moscow || null,
        priority: payload.metadata?.priority || null,
        due_date: payload.metadata?.dueDate || payload.dueDate || null,
        // ⚠ The payload's own source wins. This was a hardcoded
        // 'meeting-promotion' from when a note was the only thing that could
        // raise one of these; an email-sourced candidate promoted under that
        // word is a task claiming a provenance it does not have, and
        // `inferOrigin` reads exactly this field to decide whether somebody is
        // waiting on it. The default is unchanged for every existing row.
        source: payload.source || 'meeting-promotion',
        origin_path: payload.sourcePath || null,
        origin_line: payload.sourceLine == null ? null : payload.sourceLine,
      });
      return {
        ok: true,
        detail: `${created ? 'Added task' : 'Folded into existing task'} #${id}: ${payload.text}`,
        navigate: 'todos',
      };
    }

    // Route 5 — a suggestion from VANTAGE that was not urgent enough to be
    // written straight in. Approving it is Nick agreeing it is work; the task
    // carries what VANTAGE claimed, verbatim, so it can still answer why it is
    // here in three weeks' time.
    case 'vantage_suggestion': {
      const taskStore = require('./task-store');
      const { id, created } = taskStore.createTask({
        text: payload.text,
        source: payload.source || 'vantage',
        // Somebody else's system is waiting on it. That is the commitment test,
        // and it is the same answer VANTAGE gives on its direct path — one
        // question, one answer, whichever route it took.
        origin: 'commitment',
        criticality: payload.criticality || null,
        notes: payload.basis ? `${payload.source || 'VANTAGE'}: ${payload.basis}` : null,
        due_date: payload.dueDate || null,
      });
      return {
        ok: true,
        detail: `${created ? 'Added task' : 'Folded into existing task'} #${id}: ${payload.text}`,
        navigate: 'todos',
      };
    }

    default:
      return { ok: false, detail: `Unknown action type: ${action.type}` };
  }
}

function _nextHalfHour() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/**
 * Graph wants a naive local datetime — the timezone travels separately in the
 * payload (EVENT_TIMEZONE), so appending a Z or an offset here would shift the
 * booking. Format the local wall-clock components by hand.
 */
function _graphLocalTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

/**
 * Log an executed action to activity log and daily note.
 */
function logActionExecution(action, result) {
  try {
    db.logActivity('sara_action', {
      actionId: action.id,
      type: action.type,
      status: result.ok ? 'executed' : 'failed',
      detail: result.detail,
    });
  } catch {}

  if (result.ok) {
    try {
      const obsidian = require('./obsidian');
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const line = `- ${time} — ${action.reason || action.type}`;

      const daily = obsidian.readTodayDailyNote() || '';
      if (daily.includes('## SARA Actions')) {
        obsidian.appendToDailyNote(line + '\n');
      } else {
        obsidian.appendToDailyNote(`\n\n## SARA Actions\n${line}\n`);
      }
    } catch {}
  }
}

module.exports = {
  generateSuggestions,
  persistSuggestions,
  executeAction,
  logActionExecution,
  queueAction,
  navigationExpiry,
  expireStaleNavigation,
};
