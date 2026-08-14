'use strict';

/**
 * Standup / EOD as a collaborative session.
 *
 * The old guided flow asked three fixed questions into text boxes and posted the
 * lot at the end. Two things were wrong with it, and they are the two things this
 * replaces:
 *
 *   1. It could not respond. "Ship the QA framework" and "I'll try to look at
 *      QA" got the same silent acceptance, so the ritual recorded intent without
 *      ever testing it. Yesterday's commitments were shown but never chased.
 *   2. Everything lived in browser state until the final POST. One dropped
 *      request — a backend restart mid-session is routine here — and the whole
 *      thing was gone, which is exactly what happened.
 *
 * So: a real conversation, with tools, and the transcript persisted server-side
 * after EVERY turn. Close the tab, restart the Pi, come back — `resume()` picks
 * it up where it stopped. Nothing typed is ever held only in the client.
 *
 * The model can act during the session (close a carried commitment, create a
 * task, set today's focus) rather than producing prose that a human then has to
 * transcribe. The daily note is written by an explicit finish step, not by
 * scraping a ===MARKER=== out of the model's output and hoping it got the
 * format right.
 */

const db = require('../db/database');
const obsidian = require('./obsidian');

const KIND_STANDUP = 'standup';
const KIND_EOD = 'eod';

// Sessions live in the KV store rather than a new table: this is one short-lived
// document per day per kind, and a schema migration on a live DB is a bigger
// risk than the query convenience is worth.
function _key(dateKey, kind) {
  return `standup_session_${kind}_${dateKey}`;
}

function _today() {
  return obsidian.todayDateString();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function load(kind, dateKey = _today()) {
  try {
    const raw = db.getState(_key(dateKey, kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(session) {
  db.setState(_key(session.dateKey, session.kind), JSON.stringify(session));
  return session;
}

function clear(kind, dateKey = _today()) {
  db.setState(_key(dateKey, kind), '');
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Everything the session needs to hold Nick to account, gathered deterministically.
 * The model gets facts; it does not go looking for them mid-conversation, because
 * a standup that takes thirty seconds to think is a standup that gets skipped.
 */
async function buildContext(kind) {
  const ctx = { kind, dateKey: _today() };

  try {
    const { buildAccountability } = require('./standup-accountability');
    ctx.accountability = buildAccountability();
  } catch (e) {
    console.warn('[StandupSession] Accountability failed:', e.message);
    ctx.accountability = null;
  }

  try {
    const wm = await require('./working-memory').getContext();
    ctx.queue = wm.queueSummary || null;
    ctx.escalations = wm.unseenEscalationList || [];
    ctx.calendar = (wm.calendar || [])
      .filter(e => !e.is_all_day)
      .slice(0, 8)
      .map(e => ({ subject: e.subject, start: e.start_time }));
    ctx.plan = wm.ninetyDayPlan
      ? { day: wm.ninetyDayPlan.currentDay, done: wm.ninetyDayPlan.totalDone, total: wm.ninetyDayPlan.totalTasks }
      : null;
  } catch (e) {
    console.warn('[StandupSession] Working memory failed:', e.message);
  }

  try {
    const taskStore = require('./task-store');
    const today = ctx.dateKey;
    ctx.musts = taskStore.activeTodos()
      .filter(t => t.moscow === 'must')
      .slice(0, 8)
      .map(t => ({ id: t.task_id, text: t.text, due: t.due_date, overdue: !!(t.due_date && t.due_date.split('T')[0] < today) }));
  } catch (e) {
    console.warn('[StandupSession] Task load failed:', e.message);
    ctx.musts = [];
  }

  return ctx;
}

function _renderContext(ctx) {
  const parts = [];
  const acc = ctx.accountability;

  if (acc?.yesterday) {
    parts.push(`YESTERDAY (${acc.yesterday.date}): committed to ${(acc.yesterday.focus || []).length} things, ${(acc.yesterday.focus || []).filter(f => f.done).length} done.`);
    for (const f of (acc.yesterday.focus || []).slice(0, 6)) {
      parts.push(`  [${f.done ? 'x' : ' '}] ${f.text}`);
    }
  }

  if (acc?.openCommitments?.length) {
    parts.push(`\nCARRIED (these are the ones to chase — a commitment on day 3+ needs a decision, not another carry):`);
    for (const c of acc.openCommitments.slice(0, 8)) {
      parts.push(`  - "${c.text}" — carried ${c.daysCarried} day${c.daysCarried === 1 ? '' : 's'} [key: ${c.key}]`);
    }
  }

  if (acc?.skippedDays?.length) {
    parts.push(`\nNo standup on: ${acc.skippedDays.join(', ')}.`);
  }

  if (ctx.queue?.total) {
    parts.push(`\nQUEUE: ${ctx.queue.total} open, ${ctx.queue.at_risk_count} at SLA risk, ${ctx.queue.open_p1s} P1.`);
  }
  if (ctx.escalations?.length) {
    parts.push(`ESCALATIONS unanswered: ${ctx.escalations.slice(0, 4).map(e => `${e.key} (${e.summary})`).join('; ')}`);
  }
  if (ctx.calendar?.length) {
    parts.push(`\nTODAY'S CALENDAR: ${ctx.calendar.map(e => `${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${e.subject}`).join(', ')}`);
    parts.push(`(Meeting load is a real constraint — do not let him commit to more than the free time allows.)`);
  }
  if (ctx.musts?.length) {
    parts.push(`\nMUST-DO TASKS: ${ctx.musts.map(m => `#${m.id} ${m.text}${m.overdue ? ' (OVERDUE)' : ''}`).join(' | ')}`);
  }
  if (ctx.plan) {
    parts.push(`\n90-DAY PLAN: day ${ctx.plan.day}, ${ctx.plan.done}/${ctx.plan.total} done.`);
  }

  return parts.join('\n');
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SHARED_VOICE = `You are SARA, running Nick's ritual. Nick Ward, Head of Technical Support at Nurtur, 13 reports, neurodivergent — capable, but his failure mode is avoidance and drift.

Voice: direct, warm, short. British English. No emoji. Never open with "Sure", "Great", "Absolutely". Talk TO him, second person. One question at a time — never stack two questions in one message, he will answer neither.

This is a conversation, not a form. React to what he actually says.`;

const STANDUP_PROMPT = `${SHARED_VOICE}

## Your job this morning
Get him to ONE clear, specific set of commitments for today, and hold him to what he said yesterday.

Run it roughly like this, adapting to his answers:
1. Open with the single most important thing from the context — a carried commitment, an unanswered escalation, a heavy meeting day. Not a greeting and a list.
2. Chase anything carried 3+ days. That is not a task any more, it is a decision. Make him pick: do it today, give it a date, or drop it. "Carry it again" is not on the menu — say so plainly, once, without lecturing. Record the outcome with resolve_commitment.
3. Agree today's focus. Two or three things, not ten. If he names something vague ("look at QA", "catch up on tickets"), push once for what "done" looks like by end of day. Once.
4. Check it fits the calendar. If he has five hours of meetings and three big commitments, say so.
5. When you have the focus, call set_focus, then tell him you're done and he can go.

## Rules
- Challenge vague commitments ONCE, then accept what he gives you and move on. Pushing twice is nagging, and nagging is what makes him close the tab.
- If he says he is struggling, drop the process. Ask what is in the way. The ritual matters less than the answer.
- Never guess a commitment key or task id — use the ones in the context.
- Do not write the daily note yourself. When the focus is agreed, call set_focus; the system writes the note.
- Keep every message under about 60 words.`;

const EOD_PROMPT = `${SHARED_VOICE}

## Your job this evening
Close the day honestly, and make tomorrow easier.

1. Open by reflecting back what actually got done today from the context — do not ask "what did you get done?" when you can already see it. Ask him to confirm or correct it.
2. Ask what did not go to plan. One question.
3. If something slipped that he also committed to yesterday, name it — gently, as a fact. Twice in a row is a pattern worth noticing out loud; do not moralise about it.
4. Ask what tomorrow's first thing should be. Capture it with create_task if it is a real action.
5. Acknowledge the day's wins without ceremony. "That's a good day's work" not "Amazing!".
6. When you have enough, call set_eod_summary and tell him he's done.

## Rules
- He is tired. Be shorter than you are in the morning. Under 50 words a message.
- Do not open new work at 6pm. If he raises something big, park it: capture it and say it is tomorrow's problem.
- Never end without acknowledging something that went right, even on a bad day. Especially on a bad day.`;

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Ritual-specific tools, plus a few borrowed from chat-tools. Deliberately a
 * small set: a standup that starts searching the vault has stopped being a
 * standup. Everything here either records a decision or captures an action.
 */
const SESSION_TOOLS = [
  {
    name: 'resolve_commitment',
    description: 'Record what happens to a commitment carried over from a previous day. Use the exact key from the context. "carry" is only valid for something carried fewer than 3 days.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The commitment key from the context.' },
        decision: { type: 'string', enum: ['today', 'scheduled', 'dropped', 'done', 'carry'], description: 'today = doing it today; scheduled = has a real date now; dropped = not doing it; done = already finished; carry = rolling again.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, required when decision is "scheduled".' },
        note: { type: 'string', description: 'Short reason, in his words where possible.' },
      },
      required: ['key', 'decision'],
    },
  },
  {
    name: 'set_focus',
    description: 'Record the agreed focus for today and finish the standup. Call this once, when the commitments are settled.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two or three specific commitments, in his words. Each should be something you could tell was done or not by end of day.',
        },
        blockers: { type: 'string', description: 'Anything in the way, if he named one.' },
        mood: { type: 'string', description: 'How he sounds, one short phrase. Only if he said something about it.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'set_eod_summary',
    description: 'Record the end-of-day reflection and finish the EOD. Call this once, when you have enough.',
    input_schema: {
      type: 'object',
      properties: {
        done: { type: 'array', items: { type: 'string' }, description: 'What actually got finished.' },
        didnt_go: { type: 'string', description: 'What did not go to plan. Empty string if nothing.' },
        tomorrow_first: { type: 'string', description: "The first thing tomorrow, if he named one." },
        mood: { type: 'string', description: 'How the day felt, one short phrase.' },
      },
      required: ['done'],
    },
  },
  {
    name: 'create_task',
    description: 'Capture a real action that came out of the conversation. Use when he commits to something that is not already on the list.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The action, phrased as something to do.' },
        moscow: { type: 'string', enum: ['must', 'should', 'could'], description: 'How firm the commitment sounded.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD if he gave a date.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a must-do task done when he says he finished it. Use the #id from the context.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
];

function toolDefinitions() {
  return SESSION_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Execute a session tool. Mutates the session's outcome record, which is what
 * the finish step later turns into the daily note — so a dropped connection
 * after this point still leaves the decision recorded.
 */
async function executeTool(session, name, input = {}) {
  const chatTools = require('./chat-tools');

  switch (name) {
    case 'resolve_commitment': {
      if (!input.key) return { ok: false, error: 'key is required' };
      session.outcome.commitments = session.outcome.commitments.filter(c => c.key !== input.key);
      session.outcome.commitments.push({
        key: input.key,
        decision: input.decision,
        due_date: input.due_date || null,
        note: input.note || null,
      });
      // "Scheduled" is only real if it becomes a dated task — otherwise it is a
      // carry wearing a different word, which is the exact failure this replaces.
      if (input.decision === 'scheduled' && input.due_date) {
        try {
          require('./task-store').createTask({
            text: input.note || input.key,
            due_date: input.due_date,
            source: 'standup-session',
          });
        } catch {}
      }
      return { ok: true, recorded: input.decision };
    }

    case 'set_focus': {
      const items = (input.items || []).filter(Boolean);
      if (!items.length) return { ok: false, error: 'items is required' };
      session.outcome.focus = items;
      session.outcome.blockers = input.blockers || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      return { ok: true, focus: items, note: 'Focus recorded. Tell Nick he is done — the system writes the note.' };
    }

    case 'set_eod_summary': {
      session.outcome.done = (input.done || []).filter(Boolean);
      session.outcome.didntGo = input.didnt_go || null;
      session.outcome.tomorrowFirst = input.tomorrow_first || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      if (input.tomorrow_first) {
        try {
          require('./task-store').createTask({ text: input.tomorrow_first, moscow: 'must', source: 'eod-session' });
        } catch {}
      }
      return { ok: true, note: 'Reflection recorded. Tell Nick he is done.' };
    }

    case 'create_task':
    case 'complete_task':
      return chatTools.execute(name, input);

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── Turn loop ────────────────────────────────────────────────────────────────

function _emptySession(kind, ctx) {
  return {
    kind,
    dateKey: ctx.dateKey,
    state: 'active', // active → ready → finished
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    context: ctx,
    outcome: { commitments: [], focus: [], done: [] },
  };
}

/**
 * Run one assistant turn. Returns the session with the reply appended.
 *
 * The session is saved before returning, always — including when the model call
 * fails. A failed turn must never cost Nick what he already typed.
 */
async function _turn(session) {
  const prompt = `${session.kind === KIND_EOD ? EOD_PROMPT : STANDUP_PROMPT}\n\n---\nCONTEXT (${session.dateKey}):\n${_renderContext(session.context)}`;

  let reply = '';
  try {
    const anthropic = require('./providers/anthropic-provider');
    const aiRouting = require('./ai-routing');

    if (anthropic.isConfigured() && aiRouting.isCloudAllowed('standup_interactive')) {
      const result = await anthropic.chatWithTools(
        prompt,
        session.messages,
        toolDefinitions(),
        (name, input) => executeTool(session, name, input),
        { maxTokens: 400, maxRounds: 4 }
      );
      reply = result.text || '';
      try { aiRouting.recordUsage(result.usage); } catch {}
    } else {
      // No tool-capable provider. Still run the conversation — a standup without
      // tools is worth more than no standup — it just cannot record decisions
      // itself, so finish() falls back to reading them out of the transcript.
      const result = await aiRouting.runTask('standup_interactive', {
        systemPrompt: prompt,
        messages: session.messages,
        maxTokens: 400,
      });
      reply = result.text || '';
      session.degraded = true;
    }
  } catch (e) {
    console.error('[StandupSession] Turn failed:', e.message);
    session.lastError = e.message;
    save(session);
    throw e;
  }

  if (!reply.trim()) reply = "I lost my thread there. Say that again?";

  session.messages.push({ role: 'assistant', content: reply });
  session.updatedAt = new Date().toISOString();
  session.lastError = null;
  save(session);
  return session;
}

/** Start a session, or hand back today's if one is already going. */
async function start(kind, { restart = false } = {}) {
  const existing = load(kind);
  if (existing && !restart && existing.state !== 'finished') return existing;

  const ctx = await buildContext(kind);
  const session = _emptySession(kind, ctx);
  session.messages.push({
    role: 'user',
    content: kind === KIND_EOD ? "Let's do my end of day." : "Let's do my standup.",
  });
  save(session);
  return _turn(session);
}

/** Add Nick's reply and run the next turn. */
async function reply(kind, message) {
  const session = load(kind);
  if (!session) throw new Error('No session in progress — start one first');
  if (session.state === 'finished') throw new Error('This session is already finished');

  const text = String(message || '').trim();
  if (!text) throw new Error('message is required');

  // Saved before the model is called, so a failed turn keeps what he typed.
  session.messages.push({ role: 'user', content: text });
  session.updatedAt = new Date().toISOString();
  save(session);

  return _turn(session);
}

/** Resume today's session, if there is one. */
function resume(kind) {
  return load(kind);
}

// ── Finish ───────────────────────────────────────────────────────────────────

function _weekString(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Build the morning daily note. Same section headings as the old guided flow —
 * standup-accountability parses them back tomorrow to work out what was carried,
 * so the format is a contract, not a preference.
 */
function _renderDailyNote(session) {
  const d = new Date();
  const o = session.outcome;
  const acc = session.context.accountability;
  const byKey = new Map((o.commitments || []).map(c => [c.key, c]));

  const focusLines = (o.focus || []).map(text => `- [ ] ${text} #focus`);

  const carried = [];
  const dropped = [];
  for (const c of (acc?.openCommitments || [])) {
    const decision = byKey.get(c.key);
    if (!decision) { carried.push(`- [ ] ${c.text} #carried-${c.daysCarried}d`); continue; }
    if (decision.decision === 'today') focusLines.push(`- [ ] ${c.text} #focus #carried-${c.daysCarried}d`);
    else if (decision.decision === 'dropped') dropped.push(`- ~~${c.text}~~ (dropped after ${c.daysCarried} days)`);
    else if (decision.decision === 'scheduled') dropped.push(`- ${c.text} → scheduled for ${decision.due_date || 'a date'}`);
    else if (decision.decision === 'done') dropped.push(`- ~~${c.text}~~ (already done)`);
    else carried.push(`- [ ] ${c.text} #carried-${c.daysCarried}d`);
  }

  if (!focusLines.length) focusLines.push('- [ ] (no focus agreed) #focus');

  const q = session.context.queue;
  const queueLine = q?.total
    ? `- ${q.total} open tickets, ${q.at_risk_count} at risk, ${q.open_p1s} P1s`
    : '- No queue data';

  return `---
type: daily
date: ${session.dateKey}
week: ${_weekString(d)}
---
# Daily Note — ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}

## Focus Today
${focusLines.join('\n')}

## Carry-Overs
${carried.length ? carried.join('\n') : '- None'}
${dropped.length ? `\n## Decided\n${dropped.join('\n')}\n` : ''}
## Blockers
- ${o.blockers || 'None'}

## Queue Watch
${queueLine}
${o.mood ? `\n## Mood\n- ${o.mood}\n` : ''}`;
}

/** The EOD section, appended to whatever the morning wrote. */
function _renderEodSection(session) {
  const o = session.outcome;
  const lines = ['', '## EOD', ''];
  if (o.done?.length) {
    lines.push('**Done:**');
    for (const item of o.done) lines.push(`- ${item}`);
  }
  lines.push(`**Didn't go to plan:** ${o.didntGo || 'Nothing'}`);
  if (o.tomorrowFirst) lines.push(`**Tomorrow starts with:** ${o.tomorrowFirst}`);
  if (o.mood) lines.push(`**Mood:** ${o.mood}`);
  return lines.join('\n') + '\n';
}

/**
 * Write the ritual out and close the session.
 *
 * Allowed even when state is still 'active': if the model never got round to
 * calling set_focus, Nick should still be able to end the conversation and keep
 * what was agreed. A ritual you cannot exit is worse than one that ends untidily.
 */
function finish(kind) {
  const session = load(kind);
  if (!session) throw new Error('No session to finish');
  if (session.state === 'finished') return { ok: true, alreadyFinished: true, session };

  if (kind === KIND_EOD) {
    const existing = obsidian.readTodayDailyNote() || '';
    if (existing.includes('## EOD')) {
      // Re-running EOD replaces the section rather than stacking a second one.
      obsidian.writeTodayDailyNote(existing.split('## EOD')[0].trimEnd() + '\n' + _renderEodSection(session));
    } else {
      obsidian.appendToDailyNote(_renderEodSection(session));
    }
    try { require('./nudges').markEodDone(); } catch {}
    try { require('./activity').trackEodDone(); } catch {}
  } else {
    obsidian.writeTodayDailyNote(_renderDailyNote(session));
    try { require('./nudges').markStandupDone(); } catch {}
    try { require('./activity').trackStandupDone(new Date().getHours(), true); } catch {}
  }

  try { require('./activity').trackVaultWrite('daily'); } catch {}

  session.state = 'finished';
  session.finishedAt = new Date().toISOString();
  save(session);
  return { ok: true, session };
}

module.exports = {
  KIND_STANDUP,
  KIND_EOD,
  start,
  reply,
  resume,
  finish,
  load,
  _renderDailyNote,
  _renderEodSection,
  save,
  clear,
  buildContext,
  toolDefinitions,
  executeTool,
  _renderContext,
  _emptySession,
};
