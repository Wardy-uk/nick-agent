'use strict';

/**
 * Chat tools — the bridge that lets SARA *do* things during a conversation.
 *
 * Until now chat was read-only RAG: context in, prose out. "Mark that done",
 * "book me an hour for it", "reply to Chris" were all impossible by construction,
 * because the model had no way to reach the services that already do those jobs.
 *
 * Three tiers, and the tier is the safety model:
 *
 *   read     — no side effects at all. Always allowed.
 *   write    — reversible and internal (task store, daily note). Runs immediately;
 *              Nick can undo it in the UI in one tap.
 *   queued   — leaves the building (email, calendar invites). NEVER executed here.
 *              These queue a pending sara_action and return its id, so the send
 *              happens only after an explicit approval through /api/actions.
 *
 * Tool calling needs a provider that supports it. Anthropic is Tier 1 in
 * ai-routing and the SDK is already a dependency; OpenAI/OpenRouter/Ollama fall
 * back to the old text-only path rather than pretending. See claude.js.
 */

const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// ── Tool definitions (Anthropic tool-use schema) ─────────────────────────────

const TOOLS = [
  {
    name: 'get_queue',
    tier: 'read',
    description: 'Get the current Jira queue: total open tickets, how many are at SLA risk, open P1s, and the at-risk tickets themselves. Use when Nick asks about the queue, tickets, SLA or workload.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_tasks',
    tier: 'read',
    description: 'List Nick\'s open tasks from the NEURO task store. Use before completing a task so you have its real id, and whenever he asks what is on his list.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['open', 'overdue', 'today', 'must'],
          description: 'Which slice to return. Defaults to open.',
        },
        limit: { type: 'integer', description: 'Max tasks to return (default 20, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'get_calendar',
    tier: 'read',
    description: 'Get calendar events for a date range. Use for "what does my day look like", meeting questions, or to find a free slot before booking one.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD. Defaults to today.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD. Defaults to the day after `from`.' },
      },
      required: [],
    },
  },
  {
    name: 'search_vault',
    tier: 'read',
    description: 'Search the Obsidian vault (meeting notes, people notes, decisions, knowledge base) by meaning and keyword. Use before answering anything about past meetings, people, or prior decisions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'integer', description: 'Max notes to return (default 5, max 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    tier: 'read',
    description: 'Read a vault note in full by its path, as returned by search_vault. Use when a search excerpt is not enough.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "Meetings/2026/08/Standup.md".' } },
      required: ['path'],
    },
  },
  {
    name: 'create_task',
    tier: 'write',
    description: 'Add a task to the NEURO task store (the source of truth for tasks). Use whenever Nick commits to doing something in conversation — do not just mention it, capture it.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The action, phrased as something to do.' },
        moscow: { type: 'string', enum: ['must', 'should', 'could', 'wont'], description: 'MoSCoW classification if it is clear from context.' },
        due_date: { type: 'string', description: 'Due date, YYYY-MM-DD.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'complete_task',
    tier: 'write',
    description: 'Mark a task done. Call get_tasks first to get the id — never guess one. If the task came from Microsoft it is also completed there.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'integer', description: 'The task id from get_tasks.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'append_daily_note',
    tier: 'write',
    description: 'Append a line to today\'s daily note in the vault. Use for observations, decisions, or anything worth a record. Append-only — it cannot overwrite.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Markdown line(s) to append.' } },
      required: ['text'],
    },
  },
  {
    name: 'capture_feature',
    tier: 'write',
    description: 'Add an idea, gap or improvement for NEURO, SARA or NOVA to the feature tracker in the vault. Use whenever Nick says something should be built, fixed or changed about the system itself — that belongs in the backlog, NOT in his task list. Not for ordinary work: use create_task for that.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The idea in one line, as a thing to build or fix.' },
        notes: { type: 'string', description: 'Why it matters, what it would change, anything he said about it. Write it so it still makes sense in a month.' },
        system: { type: 'string', enum: ['NEURO', 'SARA', 'NOVA', 'Both'], description: 'Which system it belongs to. Defaults to NEURO.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'draft_email_reply',
    tier: 'queued',
    description: 'Queue a reply to an email for Nick\'s approval. This does NOT send: it drafts the reply and puts it in the approval queue. Tell Nick it is waiting for him to approve. Use email ids from get_urgent_emails.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'The email id from get_urgent_emails.' },
        body: { type: 'string', description: 'The reply body. Omit to have it drafted automatically at approval time.' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'get_urgent_emails',
    tier: 'read',
    description: 'Get emails triaged as needing action or a reply, with their ids. Use before draft_email_reply.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'schedule_focus_block',
    tier: 'queued',
    description: 'Queue a calendar booking for Nick\'s approval. This does NOT book: it puts the booking in the approval queue. Use when he wants time protected for a piece of work.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What the block is for.' },
        start: { type: 'string', description: 'Local start time, "YYYY-MM-DDTHH:mm". Omit for the next half hour.' },
        minutes: { type: 'integer', description: 'Length in minutes (default 60).' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'create_meeting',
    tier: 'queued',
    description: 'Queue a meeting WITH OTHER PEOPLE for Nick\'s approval. This does NOT book or invite anyone. Use this instead of schedule_focus_block whenever anyone other than Nick is involved. Give attendees as plain names ("abdi", "Luke Scaife") — addresses are looked up here, so never invent an email.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Meeting title.' },
        start: { type: 'string', description: 'Local start time, "YYYY-MM-DDTHH:mm".' },
        minutes: { type: 'integer', description: 'Length in minutes (default 30).' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names or email addresses of everyone to invite, excluding Nick. He is the organiser and is added automatically.',
        },
        location: { type: 'string', description: 'Optional location.' },
        online: { type: 'boolean', description: 'True to make it a Teams meeting.' },
        agenda: { type: 'string', description: 'Optional agenda for the invite body.' },
      },
      required: ['subject', 'start', 'attendees'],
    },
  },
  {
    name: 'escalate_ticket',
    tier: 'queued',
    description: 'Queue an escalation of a Jira support ticket for Nick\'s approval. This does NOT escalate: it puts the escalation in the approval queue. Use when a ticket needs to jump the queue for a business reason — a renewal at risk, a customer blocked, an external deadline — NOT when the agent is technically stuck (that is the support team\'s own SOP). On approval NOVA raises the priority, tightens the due date and posts an INTERNAL comment; the customer never sees the reason.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_key: { type: 'string', description: 'Jira key, e.g. "NT-28061".' },
        reason_code: {
          type: 'string',
          description: 'Why it must jump the queue. One of: commercial (renewal, upsell, contract), customer_impact (blocking their operation), reputational (complaint risk), deadline (external date), exec_ask (SLT or AM request), customer_request (the customer asked), sla_risk (internal SLA clock), security. Pick the closest — do not invent a code.',
        },
        needed_by: { type: 'string', description: 'Optional date it is needed by, "YYYY-MM-DD". Only ever brings a due date forward, never pushes one out.' },
        notes: { type: 'string', description: 'The context in Nick\'s words — who asked and why. Goes in the internal comment, so the assignee reads it.' },
      },
      required: ['ticket_key', 'reason_code'],
    },
  },
];

/** Anthropic wants name/description/input_schema only — `tier` is ours. */
function toolDefinitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Run one tool call. Never throws — a failed tool returns an error string for the
 * model to read and recover from, which is far more useful than killing the turn.
 */
async function execute(name, input = {}) {
  try {
    const handler = HANDLERS[name];
    if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
    const result = await handler(input || {});
    console.log(`[ChatTools] ${name} → ${result.ok === false ? `error: ${result.error}` : 'ok'}`);
    return result;
  } catch (e) {
    console.warn(`[ChatTools] ${name} threw:`, e.message);
    return { ok: false, error: e.message };
  }
}

const HANDLERS = {
  get_queue() {
    const q = db.getQueueSummary();
    return {
      ok: true,
      total: q.total,
      at_risk_count: q.at_risk_count,
      open_p1s: q.open_p1s,
      at_risk_tickets: (q.at_risk_tickets || []).slice(0, 10).map(t => ({
        key: t.ticket_key,
        summary: t.summary,
        assignee: t.assignee,
        sla_minutes_remaining: t.sla_remaining_minutes == null ? null : Math.round(t.sla_remaining_minutes),
      })),
    };
  },

  get_tasks({ filter = 'open', limit = 20 }) {
    const taskStore = require('./task-store');
    const today = new Date().toISOString().split('T')[0];
    let tasks = taskStore.activeTodos();

    if (filter === 'overdue') tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] < today);
    else if (filter === 'today') tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] === today);
    else if (filter === 'must') tasks = tasks.filter(t => t.moscow === 'must');

    const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return {
      ok: true,
      filter,
      total: tasks.length,
      tasks: tasks.slice(0, capped).map(t => ({
        // id is what complete_task needs — always give it back.
        id: t.task_id,
        text: t.text,
        moscow: t.moscow,
        due_date: t.due_date,
        source: t.taskSource,
      })),
    };
  },

  get_calendar({ from, to }) {
    const start = from || new Date().toISOString().split('T')[0];
    const end = to || new Date(new Date(start).getTime() + 86400000).toISOString().split('T')[0];
    const events = db.getCalendarEvents(start, end);
    return {
      ok: true,
      from: start,
      to: end,
      events: events.slice(0, 40).map(e => ({
        subject: e.subject,
        start: e.start_time,
        end: e.end_time,
        location: e.location,
        all_day: Boolean(e.is_all_day),
      })),
    };
  },

  async search_vault({ query, limit = 5 }) {
    if (!query || !String(query).trim()) return { ok: false, error: 'query is required' };
    const results = await require('./retrieval').search(String(query), {
      maxResults: Math.min(Math.max(Number(limit) || 5, 1), 10),
    });
    return {
      ok: true,
      results: (results || []).map(r => ({
        name: r.name,
        path: r.path,
        excerpt: (r.excerpts?.[0] || '').slice(0, 400),
      })),
    };
  },

  read_note({ path: notePath }) {
    if (!notePath) return { ok: false, error: 'path is required' };
    if (!VAULT_PATH) return { ok: false, error: 'Vault path not configured' };

    const path = require('path');
    const fs = require('fs');
    // Resolve and confirm it is still inside the vault — a model-supplied path is
    // untrusted input, and "../../.env" is a perfectly plausible hallucination.
    const root = path.resolve(VAULT_PATH);
    const full = path.resolve(root, String(notePath));
    if (full !== root && !full.startsWith(root + path.sep)) {
      return { ok: false, error: 'Path is outside the vault' };
    }
    if (!full.toLowerCase().endsWith('.md')) return { ok: false, error: 'Only .md notes can be read' };
    if (!fs.existsSync(full)) return { ok: false, error: `Note not found: ${notePath}` };

    const content = fs.readFileSync(full, 'utf-8');
    return {
      ok: true,
      path: notePath,
      truncated: content.length > 8000,
      content: content.slice(0, 8000),
    };
  },

  create_task({ text, moscow, due_date }) {
    if (!text || !String(text).trim()) return { ok: false, error: 'text is required' };
    const taskStore = require('./task-store');
    const { id, created, task } = taskStore.createTask({
      text: String(text).trim(),
      moscow: moscow || null,
      due_date: due_date || null,
      source: 'chat',
    });
    return {
      ok: true,
      task_id: id,
      created,
      text: task.text,
      note: created ? 'Task created.' : 'A task with this text already existed — folded into it rather than duplicating.',
    };
  },

  async complete_task({ task_id }) {
    if (!task_id) return { ok: false, error: 'task_id is required — call get_tasks first' };
    const taskStore = require('./task-store');
    const existing = taskStore.getTask(task_id);
    if (!existing) return { ok: false, error: `No task with id ${task_id}` };

    taskStore.setStatus(task_id, 'done');
    const out = { ok: true, task_id, text: existing.text, completed: true };

    // Microsoft-owned tasks have to be completed there too, or the next sync
    // brings them straight back.
    if (existing.ms_id) {
      const result = await require('./microsoft').completeMicrosoftTask(existing.ms_id, existing.source || null);
      out.microsoft = result.completed ? 'completed' : `failed (${result.reason})`;
    }
    return out;
  },

  capture_feature({ title, notes, system }) {
    const result = require('./feature-tracker').captureFeature({
      title,
      notes,
      system,
      source: 'chat',
    });
    if (!result.ok) return result;
    return {
      ok: true,
      number: result.number,
      system: result.system,
      note: `Added to the NEURO Feature Tracker as #${result.number}, unranked. Tell Nick the number.`,
    };
  },

  append_daily_note({ text }) {
    if (!text || !String(text).trim()) return { ok: false, error: 'text is required' };
    require('./obsidian').appendToDailyNote(`${String(text).trim()}\n`);
    return { ok: true, appended: true };
  },

  get_urgent_emails() {
    const triage = require('./email-triage').getTriageByCategory();
    // urgent and reply are lanes, not categories — the same email is often in both.
    const seen = new Set();
    const items = [...(triage.urgent || []), ...(triage.reply || [])].filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    return {
      ok: true,
      emails: items.slice(0, 10).map(e => ({
        email_id: e.id,
        from: e.from,
        subject: e.subject,
        reason: e.reason,
        preview: (e.preview || '').slice(0, 200),
      })),
    };
  },

  draft_email_reply({ email_id, body }) {
    if (!email_id) return { ok: false, error: 'email_id is required — call get_urgent_emails first' };
    const id = require('./suggestion-engine').queueAction(
      'draft_reply',
      { emailId: email_id, body: body || null },
      body ? 'Reply drafted in chat — approve to send' : 'Draft a reply (from chat)',
      0.9
    );
    return {
      ok: true,
      queued_action_id: id,
      sent: false,
      note: 'Queued for approval. Nothing has been sent — Nick approves it in the actions queue, reads the draft, then approves the send.',
    };
  },

  // Queued, not write: this reaches into NOVA, changes a real ticket and puts a
  // comment in front of the assignee. Reversible in principle, awkward in practice.
  escalate_ticket({ ticket_key, reason_code, needed_by, notes }) {
    const key = String(ticket_key || '').trim().toUpperCase();
    if (!key) return { ok: false, error: 'ticket_key is required' };
    if (!reason_code) return { ok: false, error: 'reason_code is required' };
    if (needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(needed_by)) {
      return { ok: false, error: 'needed_by must be YYYY-MM-DD' };
    }
    if (!require('./nova-client').isConfigured()) {
      return { ok: false, error: 'NOVA is not configured here, so escalations cannot be raised from chat.' };
    }
    const id = require('./suggestion-engine').queueAction(
      'escalate_ticket',
      { ticketKey: key, reasonCode: String(reason_code), neededBy: needed_by || null, notes: notes || null },
      `Escalate ${key} — ${reason_code}${needed_by ? `, needed by ${needed_by}` : ''}`,
      0.85
    );
    return {
      ok: true,
      queued_action_id: id,
      escalated: false,
      note: `Queued for approval. ${key} is unchanged — no comment, no priority change — until Nick approves it.`,
    };
  },

  schedule_focus_block({ subject, start, minutes }) {
    if (!subject || !String(subject).trim()) return { ok: false, error: 'subject is required' };
    const id = require('./suggestion-engine').queueAction(
      'schedule_focus_block',
      { subject: String(subject).trim(), start: start || null, minutes: Number(minutes) || 60 },
      `Book "${String(subject).trim()}"${start ? ` at ${start}` : ''}`,
      0.85
    );
    return {
      ok: true,
      queued_action_id: id,
      booked: false,
      note: 'Queued for approval. Nothing is in the calendar until Nick approves it.',
    };
  },

  // Reuses the schedule_focus_block action type deliberately — its executor
  // already passes payload.attendees through to createCalendarEvent, so the only
  // thing missing was resolving names to addresses. The reason string is what
  // the approval card shows, so it carries the meeting wording.
  async create_meeting({ subject, start, minutes, attendees, location, online, agenda }) {
    const title = String(subject || '').trim();
    if (!title) return { ok: false, error: 'subject is required' };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(start || ''))) {
      return { ok: false, error: 'start must be a local time like "2026-08-17T14:00"' };
    }
    const names = (Array.isArray(attendees) ? attendees : []).map(a => String(a || '').trim()).filter(Boolean);
    if (!names.length) return { ok: false, error: 'attendees is empty — use schedule_focus_block for solo time' };

    // Never guess an address: hand ambiguity back so the model can ask Nick
    // rather than inviting the wrong Chris.
    const resolved = await require('./contact-directory').resolveNames(names);
    const missing = resolved.filter(r => r.status !== 'resolved');
    if (missing.length) {
      return {
        ok: false,
        error: 'Could not resolve every attendee — nothing queued.',
        unresolved: missing.map(m => ({
          name: m.query,
          problem: m.status,
          candidates: (m.candidates || []).map(c => `${c.name} <${c.email}>`),
        })),
        hint: 'Ask Nick which person is meant, or for the email address, then call create_meeting again.',
      };
    }

    const invitees = resolved.map(r => ({ name: r.name, email: r.email }));
    const mins = Number(minutes) > 0 ? Number(minutes) : 30;
    const id = require('./suggestion-engine').queueAction(
      'schedule_focus_block',
      {
        subject: title,
        start,
        minutes: mins,
        attendees: invitees,
        location: location || null,
        body: agenda || null,
        isOnline: Boolean(online),
      },
      `Meeting "${title}" with ${invitees.map(i => i.name).join(', ')} at ${start.replace('T', ' ')}`,
      0.85
    );

    return {
      ok: true,
      queued_action_id: id,
      booked: false,
      invited: invitees,
      note: `Queued for approval. Nothing is booked and NO invites have gone out — ${invitees.length} ${invitees.length === 1 ? 'person' : 'people'} will be invited only once Nick approves it.`,
    };
  },
};

module.exports = { TOOLS, toolDefinitions, execute };
