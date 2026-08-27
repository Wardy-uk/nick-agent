const express = require('express');
const router = express.Router();
const obsidianService = require('../services/obsidian');
const nudges = require('../services/nudges');
const accountability = require('../services/standup-accountability');
const { VOICE_COMPACT } = require('../services/sara-voice');

// ── Standup pre-warm cache ──────────────────────────────────────────────
// Pre-generates the Phase 1 Ollama response before the user opens the standup,
// so the first message appears instantly instead of waiting 60-130s for cold-start.
const standupCache = {
  date: null,        // YYYY-MM-DD this cache is valid for
  systemPrompt: null,
  phase1Response: null,
  warming: false,
};

// Build the full standup context (same logic as the interactive handler)
async function buildStandupContext() {
  const today = new Date();
  const todayStr = obsidianService.todayDateString();
  const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
  const isMonday = today.getDay() === 1;

  let carryOvers = [];
  try {
    const prev = obsidianService.readPreviousDailyNote();
    if (prev) {
      const lines = prev.content.split('\n');
      let inFocus = false;
      for (const line of lines) {
        if (line.startsWith('## Focus Today') || line.startsWith('## Carry')) { inFocus = true; continue; }
        if (line.startsWith('## ') && inFocus) break;
        if (inFocus && (line.match(/^\s*-\s+\[\s\]/) || line.match(/^\s*-\s+\[>\]/))) {
          const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
          if (text) carryOvers.push(text);
        }
      }
    }
  } catch {}

  let queueContext = '';
  try {
    const db = require('../db/database');
    const queue = db.getQueueSummary();
    // `fresh`, not `total > 0`. The cache has had no writer since 3 Jul and was
    // still handing out that morning's twelve tickets seven weeks later — so the
    // standup opened by telling Nick the state of a queue nobody had looked at.
    // Saying nothing about the queue is correct; saying something false is not.
    if (queue.fresh && queue.total > 0) {
      queueContext = `Queue: ${queue.total} open tickets, ${queue.at_risk_count} at risk, ${queue.open_p1s} P1s.`;
      if (queue.at_risk_tickets.length > 0) {
        queueContext += ` At risk: ${queue.at_risk_tickets.slice(0, 3).map(t => t.ticket_key + ' ' + t.summary).join('; ')}.`;
      }
    }
  } catch {}

  let planContext = '';
  try {
    const plan = obsidianService.parseNinetyDayPlan();
    if (plan) {
      planContext = `90-day plan: Day ${plan.currentDay} of ${plan.totalDays}. ${plan.totalDone}/${plan.totalTasks} tasks done.`;
      if (plan.todayTasks.length > 0) planContext += ` Today's tasks: ${plan.todayTasks.map(t => t.text).join('; ')}.`;
      if (plan.overdueTasks.length > 0) planContext += ` ${plan.overdueTasks.length} overdue tasks.`;
    }
  } catch {}

  let calendarContext = '';
  try {
    const events = await obsidianService.fetchCalendarEvents(todayStr, todayStr);
    if (events && events.length > 0) {
      const upcoming = events.filter(e => e.showAs !== 'cancelled');
      if (upcoming.length > 0) {
        calendarContext = `Today's calendar: ${upcoming.map(e => {
          const time = e.start ? e.start.substring(11, 16) : '';
          return time ? `${time} ${e.subject}` : e.subject;
        }).join(', ')}.`;
      }
    }
  } catch {}

  let mustDoContext = '';
  let mustDoItems = [];
  try {
    mustDoItems = obsidianService.parseVaultMustDos();
    if (mustDoItems.length > 0) {
      // Limit prompt to top 5 must-dos to avoid blowing context window on small models
      const topMustDos = mustDoItems.slice(0, 5);
      mustDoContext = `MUST DO (${mustDoItems.length} non-negotiable items, top ${topMustDos.length}): ${topMustDos.map(m => m.text).join('; ')}${mustDoItems.length > 5 ? ` (+${mustDoItems.length - 5} more)` : ''}.`;
    }
  } catch {}

  const systemPrompt = `You are NEURO running Nick's morning standup ritual. Nick is Head of Technical Support at Nurtur Limited.

Your job: guide Nick through a focused standup in 3-4 short exchanges, then write his daily note.

TODAY: ${dow} ${todayStr}${isMonday ? ' (Monday — ask about the week ahead, not just today)' : ''}

CONTEXT:
${mustDoContext || ''}
${queueContext || 'Queue data unavailable.'}
${planContext || ''}
${calendarContext || ''}
${carryOvers.length > 0 ? `Carry-overs from yesterday: ${carryOvers.join('; ')}` : 'No carry-overs.'}

STANDUP FLOW — follow this exactly:

Phase 1 (start): ${mustDoItems.length > 0 ? `Say "You have ${mustDoItems.length} must-dos today." Do NOT list them — they're shown separately in the UI. Give a brief morning context (2-3 lines max — queue status, at-risk, plan).` : 'Give a brief, sharp morning brief (2-3 lines max — queue status, any at-risk, one key thing from the plan).'} Then ask ONE question: "What's your main focus today?"

Phase 2 (after focus answer): Ask: "Any blockers or things that need escalating?"

Phase 3 (after blockers answer): ${isMonday ? 'Ask: "How are you going into the week — anything to flag energy or capacity-wise?"' : 'Ask: "Anything else before I write this up?"'}

Phase 4 (finalise): Say "Writing your daily note now..." then output the daily note in this EXACT format between the markers:

===DAILY_NOTE_START===
---
type: daily
date: ${todayStr}
---
# Daily Note — ${dow} ${todayStr}
${mustDoItems.length > 0 ? `
## Must Do Today
[${mustDoItems.length} items — already tracked in vault, do NOT list them here]
` : ''}
## Focus Today
[checkbox list of focus items Nick mentioned, each as: - [ ] item text — do NOT include any Must Do items here]

## Carry-Overs
${carryOvers.length > 0 ? carryOvers.map(c => `- [ ] ${c}`).join('\n') : '- None'}

## Blockers
[blockers Nick mentioned, or: - None]

## Queue Watch
${queueContext || '- No queue data'}

## Notes
[any other notes from the conversation]
===DAILY_NOTE_END===

Then end with one short line — something brief and human. No fluff.

RULES:
- One question at a time. Never ask two things in one message.
- Keep your messages short — 3 lines max except the daily note.
- Don't repeat what Nick just said back to him.
- Don't add unnecessary affirmations ("Great!", "Perfect!").
- The daily note markers must appear EXACTLY as shown — the app parses them.
- After writing the daily note, do not ask any more questions.`;

  return { systemPrompt, todayStr, carryOvers, mustDoItems };
}

// Pre-warm: build context + fire Phase 1 to Ollama, cache the result
async function preWarmStandup() {
  const todayStr = obsidianService.todayDateString();
  if (standupCache.date === todayStr && standupCache.phase1Response) {
    console.log('[Standup] Pre-warm skipped — already cached for today');
    return;
  }
  if (standupCache.warming) {
    console.log('[Standup] Pre-warm already in progress');
    return;
  }

  standupCache.warming = true;
  console.log('[Standup] Pre-warming standup for', todayStr);

  try {
    const { systemPrompt } = await buildStandupContext();
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Start my standup.' }
    ];

    const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
        messages: ollamaMessages,
        stream: false,
        options: { temperature: 0.7, num_ctx: 2048, num_predict: 512 }
      }),
      signal: AbortSignal.timeout(300000) // 5 min — no rush, this is background
    });

    if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);
    const data = await ollamaRes.json();
    const response = data.message?.content || '';

    if (response.trim().length > 10) {
      standupCache.date = todayStr;
      standupCache.systemPrompt = systemPrompt;
      standupCache.phase1Response = response;
      console.log(`[Standup] Pre-warm complete — ${response.length} chars cached`);
    } else {
      console.warn('[Standup] Pre-warm got empty response from Ollama');
    }
  } catch (err) {
    console.error('[Standup] Pre-warm failed:', err.message);
  } finally {
    standupCache.warming = false;
  }
}

// ── EOD pre-warm cache ──────────────────────────────────────────────────
const eodCache = {
  date: null,
  systemPrompt: null,
  phase1Response: null,
  warming: false,
};

async function buildEodContext() {
  const today = new Date();
  const todayStr = obsidianService.todayDateString();
  const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
  const isFriday = today.getDay() === 5;

  let focusItems = [];
  let carryOvers = [];
  const dailyNote = obsidianService.readTodayDailyNote();
  if (dailyNote) {
    const lines = dailyNote.split('\n');
    let inFocus = false, inCarry = false;
    for (const line of lines) {
      if (line.startsWith('## Focus Today')) { inFocus = true; inCarry = false; continue; }
      if (line.startsWith('## Carry')) { inCarry = true; inFocus = false; continue; }
      if (line.startsWith('## ')) { inFocus = false; inCarry = false; continue; }
      if (inFocus && line.match(/^\s*-\s+\[.\]/)) {
        const done = !!line.match(/^\s*-\s+\[x\]/i);
        const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
        if (text) focusItems.push({ text, done });
      }
      if (inCarry && line.match(/^\s*-\s+\[.\]/)) {
        const done = !!line.match(/^\s*-\s+\[x\]/i);
        const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
        if (text) carryOvers.push({ text, done });
      }
    }
  }

  let statsContext = '';
  try {
    const activity = require('../services/activity');
    const db = require('../db/database');
    const summary = activity.buildDailySummary(todayStr);
    const allTodos = db.getAllTodos();
    const completedToday = allTodos.filter(t => t.done && t.completed_at && t.completed_at.startsWith(todayStr)).length;
    let doNextCompleted = 0;
    try { const doNextAll = db.getAllDoNext(); doNextCompleted = doNextAll.filter(t => t.done && t.completed_at && t.completed_at.startsWith(todayStr)).length; } catch {}
    let meetingsAttended = 0;
    try {
      const calEvents = db.getCalendarEvents(todayStr + 'T00:00:00', todayStr + 'T23:59:59');
      const now = new Date();
      meetingsAttended = calEvents.filter(e => e.show_as !== 'cancelled' && !e.is_all_day && new Date(e.end_time) < now).length;
    } catch {}
    const parts = [];
    if (completedToday > 0) parts.push(`${completedToday} todos completed`);
    if (doNextCompleted > 0) parts.push(`${doNextCompleted} do-next tasks done`);
    if (meetingsAttended > 0) parts.push(`${meetingsAttended} meetings attended`);
    if ((summary.escalations_raised || 0) > 0) parts.push(`${summary.escalations_raised} escalations raised`);
    if ((summary.escalations_resolved || 0) > 0) parts.push(`${summary.escalations_resolved} escalations resolved`);
    if ((summary.captures_count || 0) > 0) parts.push(`${summary.captures_count} captures`);
    if (parts.length > 0) statsContext = `Activity today: ${parts.join(', ')}.`;
  } catch {}

  let queueContext = '';
  try {
    const db = require('../db/database');
    const queue = db.getQueueSummary();
    if (queue.fresh && queue.total > 0) {
      queueContext = `Queue at EOD: ${queue.total} open tickets, ${queue.at_risk_count} at risk, ${queue.open_p1s} P1s.`;
    }
  } catch {}

  const focusSummary = focusItems.length > 0
    ? `Morning focus items: ${focusItems.map(f => `${f.done ? '✓' : '○'} ${f.text}`).join('; ')}`
    : 'No morning standup found today.';
  const carrySummary = carryOvers.length > 0
    ? `Carry-overs: ${carryOvers.map(c => `${c.done ? '✓' : '○'} ${c.text}`).join('; ')}`
    : '';

  const systemPrompt = `You are NEURO running Nick's end-of-day reflection. Nick is Head of Technical Support at Nurtur Limited.

Your job: guide Nick through a quick EOD reflection in 3-4 short exchanges, then write the EOD section to his daily note.

TODAY: ${dow} ${todayStr}${isFriday ? ' (Friday — wrap up the week, not just the day)' : ''}

CONTEXT:
${focusSummary}
${carrySummary}
${statsContext || 'No activity data available.'}
${queueContext || ''}

EOD FLOW — follow this exactly:

Phase 1 (start): Give a brief end-of-day summary (2-3 lines — what was planned vs what got done based on focus items). Then ask ONE question: "What was your biggest win today?"

Phase 2 (after win): Ask: "Anything that didn't go to plan or got in the way?"

Phase 3 (after blockers): ${isFriday ? 'Ask: "It\'s Friday — how are you heading into the weekend? Anything lingering?"' : 'Ask: "How are you feeling — energy levels, stress, anything to note?"'}

Phase 4 (finalise): Say "Writing your EOD now..." then output the EOD section in this EXACT format between the markers:

===EOD_NOTE_START===

## EOD — ${todayStr}

**Win:** [main win Nick mentioned]

**Didn't go to plan:** [what didn't go well, or: Nothing flagged]

**Feeling:** [how Nick is feeling]

**Focus check:** [brief summary — e.g. "2/3 focus items done, carry-over cleared"]

${queueContext ? `**Queue:** ${queueContext}` : ''}
===EOD_NOTE_END===

RULES:
- One question at a time. Never ask two things in one message.
- Keep your messages short — 3 lines max except the EOD note.
- Don't repeat what Nick just said back to him.
- Don't add unnecessary affirmations ("Great!", "Perfect!").
- The EOD markers must appear EXACTLY as shown — the app parses them.
- After writing the EOD note, say something brief to sign off. No more questions.
- This is a wind-down ritual, not a planning session. Keep it light.`;

  return { systemPrompt, todayStr };
}

async function preWarmEod() {
  const todayStr = obsidianService.todayDateString();
  if (eodCache.date === todayStr && eodCache.phase1Response) {
    console.log('[EOD] Pre-warm skipped — already cached for today');
    return;
  }
  if (eodCache.warming) {
    console.log('[EOD] Pre-warm already in progress');
    return;
  }

  eodCache.warming = true;
  console.log('[EOD] Pre-warming EOD for', todayStr);

  try {
    const { systemPrompt } = await buildEodContext();
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Start my EOD.' }
    ];

    const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
        messages: ollamaMessages,
        stream: false,
        options: { temperature: 0.7, num_ctx: 2048, num_predict: 512 }
      }),
      signal: AbortSignal.timeout(300000)
    });

    if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);
    const data = await ollamaRes.json();
    const response = data.message?.content || '';

    if (response.trim().length > 10) {
      eodCache.date = todayStr;
      eodCache.systemPrompt = systemPrompt;
      eodCache.phase1Response = response;
      console.log(`[EOD] Pre-warm complete — ${response.length} chars cached`);
    } else {
      console.warn('[EOD] Pre-warm got empty response from Ollama');
    }
  } catch (err) {
    console.error('[EOD] Pre-warm failed:', err.message);
  } finally {
    eodCache.warming = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6A: Deterministic guided flow — AI generates questions, code asks them
// ═══════════════════════════════════════════════════════════════════════════

// ── Question cache ──
const questionCache = {
  standup: { date: null, briefing: null, questions: null, warming: false },
  eod: { date: null, briefing: null, questions: null, warming: false },
};

// These are what Nick actually reads when every provider is down, so they are
// SARA's words too — one question each, no stacking, no form-speak.
const STANDUP_FALLBACK_QUESTIONS = [
  "What has to be true by tonight?",
  "What's in the way?",
  "Anything else before I write this up?"
];

const EOD_FALLBACK_QUESTIONS = [
  "What actually got done today?",
  "What didn't go to plan?",
  "How are you doing?"
];

/**
 * Generate standup questions + briefing from context via AI.
 * Returns { briefing, questions } or null.
 */
async function generateStandupQuestions() {
  const ctx = await buildStandupContext();
  const today = new Date();
  const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
  const isMonday = today.getDay() === 1;

  let acc = null;
  try { acc = accountability.buildAccountability(); } catch {}
  const stale = (acc?.openCommitments || []).filter(c => c.daysCarried >= 3);

  const prompt = `${VOICE_COMPACT}

Write Nick's morning standup: a short briefing in your own voice, then 3 questions.

Context:
${ctx.mustDoItems?.length ? `Must-dos: ${ctx.mustDoItems.length} non-negotiable items` : 'No must-dos'}
${ctx.systemPrompt.match(/Queue:.*?\./)?.[0] || 'No queue data'}
${ctx.systemPrompt.match(/90-day plan:.*?\./)?.[0] || ''}
${ctx.systemPrompt.match(/Today's calendar:.*?\./)?.[0] || 'No meetings'}
${acc?.yesterday ? `Yesterday (${acc.yesterday.date}): committed to ${acc.yesterday.committed}, completed ${acc.yesterday.done}.${acc.yesterday.eodDone ? '' : ' No EOD logged.'}${acc.yesterday.unresolved ? ` Flagged as not going to plan: ${acc.yesterday.unresolved}` : ''}` : 'No previous daily note found.'}
${acc?.openCommitments?.length ? `Still open: ${acc.openCommitments.slice(0, 5).map(c => `${c.text} (day ${c.daysCarried})`).join('; ')}` : 'Nothing carried over.'}
${stale.length ? `ROLLING 3+ DAYS: ${stale.map(c => c.text).join('; ')}` : ''}
${acc?.overdueMustDos?.length ? `Overdue must-dos: ${acc.overdueMustDos.slice(0, 3).map(m => `${m.text} (${m.daysLate}d late)`).join('; ')}` : ''}
${acc?.skippedDays?.length >= 2 ? `Standup skipped on ${acc.skippedDays.length} recent weekdays.` : ''}
Day: ${dow}${isMonday ? ' (Monday)' : ''}

Name what has slipped — don't soften it, and don't pad it with praise. Talk to him, not about him.

Output EXACTLY this format, nothing else:
BRIEFING: [2-3 sentences — lead with what slipped or is still open, then queue/calendar. Blunt, and in your voice.]
Q1: [${stale.length ? `a direct question challenging why "${stale[0].text}" is still open after ${stale[0].daysCarried} days` : 'a question about his main focus today'}]
Q2: [second question — about blockers or escalations]
Q3: [third question — ${isMonday ? 'about the week ahead' : 'anything else, or how he is doing'}]`;

  // Routed, not hand-rolled. This used to call Ollama directly before ever
  // consulting ai-routing, which quietly defeated the policy: standup_questions
  // is in LATENCY_SENSITIVE_TASKS precisely so it goes to OpenRouter first, and
  // a 1.5b local model cannot hold a voice however the prompt is written. The
  // router still falls back to Ollama, so a Pi with no internet keeps working.
  try {
    const aiRouting = require('../services/ai-routing');
    const result = await aiRouting.runTask('standup_questions', { prompt, maxTokens: 300, temperature: 0.6 });
    if (result?.text) return _parseQuestionResponse(result.text);
  } catch (e) {
    console.warn('[Standup] Question generation failed:', e.message);
  }

  return null;
}

/**
 * Generate EOD questions + briefing from context via AI.
 */
async function generateEodQuestions() {
  const ctx = await buildEodContext();
  const today = new Date();
  const dow = today.toLocaleDateString('en-GB', { weekday: 'long' });
  const isFriday = today.getDay() === 5;

  // Extract focus summary from the system prompt
  const focusMatch = ctx.systemPrompt.match(/Morning focus items:.*?\./)?.[0] || 'No morning standup found';
  const statsMatch = ctx.systemPrompt.match(/Activity today:.*?\./)?.[0] || '';
  const queueMatch = ctx.systemPrompt.match(/Queue at EOD:.*?\./)?.[0] || '';

  const prompt = `${VOICE_COMPACT}

Close Nick's day: a short end-of-day summary in your own voice, then 3 questions. He is tired — be shorter than you would be in the morning.

Context:
${focusMatch}
${statsMatch}
${queueMatch}
Day: ${dow}${isFriday ? ' (Friday)' : ''}

Output EXACTLY this format, nothing else:
BRIEFING: [2-3 sentences — what was planned, what actually happened, queue state. Acknowledge what went right without ceremony.]
Q1: [first question — what went well today]
Q2: [second question — what didn't go to plan]
Q3: [third question — ${isFriday ? 'about heading into the weekend' : 'about energy or how he is doing'}]`;

  // Routed rather than hand-rolled — same reason as the morning path above.
  try {
    const aiRouting = require('../services/ai-routing');
    const result = await aiRouting.runTask('eod_questions', { prompt, maxTokens: 300, temperature: 0.6 });
    if (result?.text) return _parseQuestionResponse(result.text);
  } catch (e) {
    console.warn('[EOD] Question generation failed:', e.message);
  }

  return null;
}

function _parseQuestionResponse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let briefing = '';
  const questions = [];

  for (const line of lines) {
    if (line.startsWith('BRIEFING:')) {
      briefing = line.replace('BRIEFING:', '').trim();
    } else if (/^Q\d:/.test(line)) {
      questions.push(line.replace(/^Q\d:\s*/, '').trim());
    }
  }

  if (questions.length >= 2) {
    return { briefing: briefing || null, questions: questions.slice(0, 3) };
  }
  return null;
}

// Pre-warm questions (called by scheduler)
async function preWarmStandupQuestions() {
  const todayStr = obsidianService.todayDateString();
  const cache = questionCache.standup;
  if (cache.date === todayStr && cache.questions) return;
  if (cache.warming) return;
  cache.warming = true;
  try {
    const result = await generateStandupQuestions();
    if (result) {
      cache.date = todayStr;
      cache.briefing = result.briefing;
      cache.questions = result.questions;
      console.log(`[Standup] Questions pre-warmed: ${result.questions.length} questions`);
    }
  } catch (e) {
    console.error('[Standup] Question pre-warm failed:', e.message);
  } finally { cache.warming = false; }
}

async function preWarmEodQuestions() {
  const todayStr = obsidianService.todayDateString();
  const cache = questionCache.eod;
  if (cache.date === todayStr && cache.questions) return;
  if (cache.warming) return;
  cache.warming = true;
  try {
    const result = await generateEodQuestions();
    if (result) {
      cache.date = todayStr;
      cache.briefing = result.briefing;
      cache.questions = result.questions;
      console.log(`[EOD] Questions pre-warmed: ${result.questions.length} questions`);
    }
  } catch (e) {
    console.error('[EOD] Question pre-warm failed:', e.message);
  } finally { cache.warming = false; }
}

// GET /api/standup/accountability — deterministic "what you said vs what you did"
router.get('/accountability', (req, res) => {
  try {
    res.json(accountability.buildAccountability());
  } catch (e) {
    console.error('[Standup] Accountability error:', e);
    res.json({ headline: null, yesterday: null, openCommitments: [], staleCount: 0, skippedDays: [], overdueMustDos: [], queue: null, plan: null });
  }
});

// GET /api/standup/questions — get pre-generated standup questions
router.get('/questions', async (req, res) => {
  const todayStr = obsidianService.todayDateString();
  const cache = questionCache.standup;

  // Try cached first
  if (cache.date === todayStr && cache.questions) {
    return res.json({ briefing: cache.briefing, questions: cache.questions, source: 'cached' });
  }

  // Generate on-demand if not cached
  try {
    const result = await generateStandupQuestions();
    if (result) {
      cache.date = todayStr;
      cache.briefing = result.briefing;
      cache.questions = result.questions;
      return res.json({ ...result, source: 'generated' });
    }
  } catch {}

  // Deterministic fallback — build briefing + a pointed first question from context
  let briefing = '';
  let questions = STANDUP_FALLBACK_QUESTIONS;
  try {
    const ctx = await buildStandupContext();
    const acc = accountability.buildAccountability();
    const queue = ctx.systemPrompt.match(/Queue:.*?\./)?.[0] || '';
    const mustDos = ctx.mustDoItems?.length || 0;
    const parts = [];
    if (acc.headline) parts.push(acc.headline);
    if (acc.yesterday) parts.push(`Yesterday: ${acc.yesterday.done}/${acc.yesterday.committed} done${acc.yesterday.eodDone ? '' : ', no EOD logged'}.`);
    if (mustDos > 0) parts.push(`${mustDos} must-dos today.`);
    if (queue) parts.push(queue);
    briefing = parts.join(' ');

    const stale = acc.openCommitments.filter(c => c.daysCarried >= 3);
    if (stale.length > 0) {
      questions = [
        `"${stale[0].text}" is on day ${stale[0].daysCarried}. What's actually blocking it — and is it happening today?`,
        ...STANDUP_FALLBACK_QUESTIONS.slice(1),
      ];
    }
  } catch {}

  res.json({ briefing: briefing || 'Good morning.', questions, source: 'fallback' });
});

// GET /api/standup/eod/questions — get pre-generated EOD questions
router.get('/eod/questions', async (req, res) => {
  const todayStr = obsidianService.todayDateString();
  const cache = questionCache.eod;

  if (cache.date === todayStr && cache.questions) {
    return res.json({ briefing: cache.briefing, questions: cache.questions, source: 'cached' });
  }

  try {
    const result = await generateEodQuestions();
    if (result) {
      cache.date = todayStr;
      cache.briefing = result.briefing;
      cache.questions = result.questions;
      return res.json({ ...result, source: 'generated' });
    }
  } catch {}

  res.json({ briefing: 'Time to wrap up.', questions: EOD_FALLBACK_QUESTIONS, source: 'fallback' });
});

// POST /api/standup/submit-guided — assemble daily note from guided answers
router.post('/submit-guided', (req, res) => {
  try {
    const { answers, questions, commitments } = req.body;
    if (!answers || !Array.isArray(answers) || answers.length < 2) {
      return res.status(400).json({ error: 'At least 2 answers required' });
    }

    const todayStr = obsidianService.todayDateString();
    const d = new Date();
    const dow = d.toLocaleDateString('en-GB', { weekday: 'long' });
    const dayNum = d.getDate();
    const monthName = d.toLocaleDateString('en-GB', { month: 'long' });
    const year = d.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const weekStr = `${year}-W${String(weekNum).padStart(2, '0')}`;

    // Parse answers
    const focus = answers[0] || '';
    const blockers = answers[1] || 'None';
    const extra = answers[2] || '';

    // Build focus items from first answer
    const focusLines = focus.split(/[,;\n]/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => `- [ ] ${l} #focus`);
    if (focusLines.length === 0) focusLines.push(`- [ ] ${focus} #focus`);

    // Must-dos
    let mustDoSection = '';
    try {
      const mustDoItems = obsidianService.parseVaultMustDos();
      if (mustDoItems.length > 0) {
        mustDoSection = `## Must Do Today\n${mustDoItems.map(m => `- [ ] ${m.text} #mustdo`).join('\n')}\n\n`;
      }
    } catch {}

    // Carry-overs — driven by the decisions Nick made in the accountability card.
    // Committed items are promoted into Focus Today with their age; dropped items
    // are recorded explicitly so they stop silently rolling forward.
    let carrySection = '- None';
    let droppedSection = '';
    const decided = Array.isArray(commitments) ? commitments : [];
    if (decided.length > 0) {
      const promoted = decided.filter(c => c.decision === 'today');
      const dropped = decided.filter(c => c.decision === 'drop');
      const held = decided.filter(c => c.decision !== 'today' && c.decision !== 'drop');

      for (const c of promoted) {
        focusLines.push(`- [ ] ${c.text} #focus #carried-${c.daysCarried || 1}d`);
      }
      if (held.length > 0) {
        carrySection = held.map(c => `- [ ] ${c.text} #carried-${c.daysCarried || 1}d`).join('\n');
      }
      if (dropped.length > 0) {
        droppedSection = `\n## Dropped\n${dropped.map(c => `- ~~${c.text}~~ (dropped after ${c.daysCarried || 1} days)`).join('\n')}\n`;
      }
    } else {
      try {
        const acc = accountability.buildAccountability();
        if (acc.openCommitments.length > 0) {
          carrySection = acc.openCommitments
            .map(c => `- [ ] ${c.text} #carried-${c.daysCarried}d`)
            .join('\n');
        }
      } catch {}
    }

    // Queue
    let queueLine = '- No queue data';
    try {
      const db = require('../db/database');
      const queue = db.getQueueSummary();
      // This one goes into the daily note, so a wrong figure is written to the
      // vault and read back as history.
      if (queue.fresh && queue.total > 0) {
        queueLine = `- ${queue.total} open tickets, ${queue.at_risk_count} at risk, ${queue.open_p1s} P1s`;
      }
    } catch {}

    const content = `---
type: daily
date: ${todayStr}
week: ${weekStr}
---
# Daily Note — ${dow} ${dayNum} ${monthName} ${year}

${mustDoSection}## Focus Today
${focusLines.join('\n')}

## Carry-Overs
${carrySection}
${droppedSection}
## Blockers
- ${blockers === 'None' || !blockers.trim() ? 'None' : blockers}

## Queue Watch
${queueLine}

## Notes
${extra && extra.trim() ? `- ${extra}` : '- None'}
`;

    obsidianService.writeTodayDailyNote(content);
    nudges.markStandupDone();
    try { require('../services/activity').trackVaultWrite('daily'); } catch {}
    try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}

    res.json({ ok: true, message: 'Daily note written' });
  } catch (e) {
    console.error('[Standup] Submit guided failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/standup/eod/submit-guided — assemble EOD section from guided answers
router.post('/eod/submit-guided', (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers) || answers.length < 2) {
      return res.status(400).json({ error: 'At least 2 answers required' });
    }

    const todayStr = obsidianService.todayDateString();
    const win = answers[0] || 'Nothing specific';
    const didntGo = answers[1] || 'Nothing flagged';
    const feeling = answers[2] || '';

    // Queue context
    let queueLine = '';
    try {
      const db = require('../db/database');
      const queue = db.getQueueSummary();
      if (queue.fresh && queue.total > 0) queueLine = `\n**Queue:** ${queue.total} open, ${queue.at_risk_count} at risk`;
    } catch {}

    const eodContent = `\n## EOD — ${todayStr}\n\n**Win:** ${win}\n\n**Didn't go to plan:** ${didntGo}\n\n**Feeling:** ${feeling || 'Not noted'}${queueLine}\n`;

    obsidianService.appendToDailyNote(eodContent);
    nudges.markEodDone();
    try { require('../services/activity').trackVaultWrite('daily'); } catch {}

    res.json({ ok: true, message: 'EOD written to daily note' });
  } catch (e) {
    console.error('[EOD] Submit guided failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Export for scheduler
router.preWarmStandup = preWarmStandup;
router.preWarmEod = preWarmEod;
router.preWarmStandupQuestions = preWarmStandupQuestions;
router.preWarmEodQuestions = preWarmEodQuestions;

// GET /api/standup
router.get('/', (req, res) => {
  const content = obsidianService.readStandup();
  res.json({ content });
});

// POST /api/standup
router.post('/', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.writeStandup(content);
  res.json({ success: true, path: filePath });
});

// POST /api/standup/save-to-daily — saves standup to today's daily note
router.post('/save-to-daily', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const header = `\n## Standup — ${obsidianService.todayDateString()}\n`;
  const filePath = obsidianService.appendToDailyNote(header + content);
  nudges.markStandupDone();
  try { require('../services/activity').trackVaultWrite('daily'); } catch {}
  try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
  res.json({ success: true, path: filePath });
});

// GET /api/standup/ritual-state — checks if standup is done today from vault
router.get('/ritual-state', (req, res) => {
  const dailyNote = obsidianService.readTodayDailyNote();

  let standupDoneToday = false;

  if (dailyNote) {
    // Check for populated Focus Today section
    if (dailyNote.includes('## Focus Today')) {
      const lines = dailyNote.split('\n');
      let inFocus = false;
      for (const line of lines) {
        if (line.startsWith('## Focus Today')) { inFocus = true; continue; }
        if (line.startsWith('## ') && inFocus) break;
        if (inFocus && line.match(/^\s*-\s+\[.\]/)) { standupDoneToday = true; break; }
      }
    }
    // Also accept explicit Standup section
    if (dailyNote.includes('## Standup')) standupDoneToday = true;
  }

  res.json({
    lastRun: null,
    lastRitual: null,
    standupDoneToday
  });
});

// GET /api/standup/carry-forward — incomplete items from yesterday's Focus Today
router.get('/carry-forward', (req, res) => {
  try {
    const prev = obsidianService.readPreviousDailyNote();
    if (!prev) return res.json({ date: null, items: [] });

    const lines = prev.content.split('\n');
    let inFocus = false;
    const items = [];
    for (const line of lines) {
      if (line.startsWith('## Focus Today') || line.startsWith('## Carry')) {
        inFocus = true;
        continue;
      }
      if (line.startsWith('## ') && inFocus) { inFocus = false; continue; }
      if (inFocus && line.match(/^\s*-\s+\[\s\]/) || inFocus && line.match(/^\s*-\s+\[>\]/)) {
        const text = line.replace(/^\s*-\s+\[.\]\s*/, '').replace(/#\w+/g, '').trim();
        if (text) items.push(text);
      }
    }
    res.json({ date: prev.date, items });
  } catch (e) {
    console.error('[Standup] Carry-forward error:', e);
    res.json({ date: null, items: [] });
  }
});

// POST /api/standup/backup — creates a lightweight Ritual 5 daily note
router.post('/backup', (req, res) => {
  try {
    const { focusItems } = req.body;
    if (!focusItems || !Array.isArray(focusItems) || focusItems.length === 0) {
      return res.status(400).json({ error: 'focusItems array required (max 3)' });
    }

    const items = focusItems.slice(0, 3);
    let mustDoItems = [];
    try { mustDoItems = obsidianService.parseVaultMustDos(); } catch {}
    const today = obsidianService.todayDateString();
    const d = new Date();
    const dayName = d.toLocaleDateString('en-GB', { weekday: 'long' });
    const dayNum = d.getDate();
    const monthName = d.toLocaleDateString('en-GB', { month: 'long' });
    const year = d.getFullYear();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    const jan1 = new Date(year, 0, 1);
    const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const weekStr = `${year}-W${String(weekNum).padStart(2, '0')}`;

    const framing = isWeekend
      ? `${dayName}. Light day.`
      : `Missed the standup — catching up via NEURO backup.`;

    const focusSection = items.map(item => `- [ ] ${item} #accepted`).join('\n');

    let carrySection = '';
    const prev = obsidianService.readPreviousDailyNote();
    if (prev) {
      const lines = prev.content.split('\n');
      let inCarry = false;
      const carries = [];
      for (const line of lines) {
        if (line.startsWith('## Carry') || line.startsWith('## Focus Today')) {
          inCarry = true;
          continue;
        }
        if (line.startsWith('## ') && inCarry) break;
        if (inCarry && line.match(/^\s*-\s+\[\s\]/)) {
          carries.push(line.trim());
        }
      }
      if (carries.length > 0) {
        carrySection = carries.join('\n');
      }
    }

    const mustDoSection = mustDoItems.length > 0
      ? `## Must Do Today\n${mustDoItems.map(m => `- [ ] ${m.text} #mustdo`).join('\n')}\n\n`
      : '';

    const content = `---
type: daily
date: ${today}
week: ${weekStr}
---
# Daily Note — ${isWeekend ? 'Weekend' : 'Backup'} — ${dayName} ${dayNum} ${monthName} ${year}

> ${framing}

${mustDoSection}## Focus Today
${focusSection}

## Carry-Overs
${carrySection || '- None'}

## On the Radar
-

## Notes / Ideas
-
`;

    const filePath = obsidianService.writeTodayDailyNote(content);
    nudges.markStandupDone();
    try { require('../services/activity').trackVaultWrite('daily'); } catch {}
    try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
    console.log(`[Standup] Backup ritual saved to ${filePath}`);
    res.json({ success: true, path: filePath });
  } catch (e) {
    console.error('[Standup] Backup error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/standup/eod — save end-of-day reflection to daily note
router.post('/eod', (req, res) => {
  const { win, didntGo, feeling } = req.body;
  if (!win && !didntGo && !feeling) return res.status(400).json({ error: 'At least one field required' });
  const lines = [
    `\n## EOD — ${obsidianService.todayDateString()}`,
    win ? `\n**Win:** ${win}` : '',
    didntGo ? `\n**Didn't go to plan:** ${didntGo}` : '',
    feeling ? `\n**Feeling:** ${feeling}` : '',
    ''
  ].filter(l => l !== '');
  const filePath = obsidianService.appendToDailyNote(lines.join('\n'));
  nudges.markEodDone();
  try {
    const db = require('../db/database');
    const queue = db.getQueueSummary();
    // A "snapshot" of a cache nobody has refreshed is not a measurement — it
    // writes the same frozen numbers into the trend every single day and makes
    // a dead queue look like a perfectly stable one.
    if (queue.fresh) {
      require('../services/activity').trackQueueSnapshot(
        queue.at_risk_count || 0, queue.total || 0, queue.open_p1s || 0);
    }
  } catch {}
  res.json({ success: true, path: filePath });
});

// GET /api/standup/ritual-history?days=7 — recent standups, EODs, and journals
router.get('/ritual-history', (req, res) => {
  const days = parseInt(req.query.days || '7', 10);
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const fs = require('fs');
  const pathMod = require('path');
  const dailyDir = pathMod.join(vaultPath, 'Daily');
  const reflectionsDir = pathMod.join(vaultPath, 'Reflections');
  const entries = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const entry = { date: dateStr, day: dayName, standup: null, eod: null, journal: null };

    // Check daily note for standup + EOD
    const dailyFile = pathMod.join(dailyDir, `${dateStr}.md`);
    if (fs.existsSync(dailyFile)) {
      const content = fs.readFileSync(dailyFile, 'utf-8');

      // Standup / Focus Today
      const focusMatch = content.match(/## (?:Focus Today|Standup)[^\n]*\n([\s\S]*?)(?=\n##|$)/);
      if (focusMatch) {
        const lines = focusMatch[1].trim().split('\n').filter(l => l.trim()).slice(0, 5);
        entry.standup = lines.join('\n');
      }

      // EOD
      const eodMatch = content.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
      if (eodMatch) {
        entry.eod = eodMatch[1].trim();
      }
    }

    // Check journal
    const journalFile = pathMod.join(reflectionsDir, `${dateStr}-journal.md`);
    if (fs.existsSync(journalFile)) {
      const jContent = fs.readFileSync(journalFile, 'utf-8');
      const body = jContent.replace(/^---[\s\S]*?---\n*/, '').trim();
      entry.journal = body.substring(0, 500);
    }

    if (entry.standup || entry.eod || entry.journal) {
      entries.push(entry);
    }
  }

  res.json({ entries });
});

// POST /api/standup/weekly-review — manually trigger weekly review generation
router.post('/weekly-review', (req, res) => {
  try {
    const result = obsidianService.generateWeeklyReview();
    if (!result) return res.status(500).json({ error: 'Vault not configured' });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/standup/daily-stats — today's productivity stats for EOD
router.get('/daily-stats', (req, res) => {
  try {
    const activity = require('../services/activity');
    const db = require('../db/database');
    const summary = activity.buildDailySummary(obsidianService.todayDateString());

    // Todos completed today
    const allTodos = db.getAllTodos();
    const todayStr = obsidianService.todayDateString();
    const completedToday = allTodos.filter(t =>
      t.done && t.completed_at && t.completed_at.startsWith(todayStr)
    ).length;

    // Do-next tasks completed today
    let doNextCompleted = 0;
    try {
      const doNextAll = db.getAllDoNext();
      doNextCompleted = doNextAll.filter(t =>
        t.done && t.completed_at && t.completed_at.startsWith(todayStr)
      ).length;
    } catch {}

    // Meetings attended (inferred from vault writes of type meeting-note)
    const meetingNotes = (summary.vault_write_types || {})['meeting-note'] || 0;
    const dailyWrites = (summary.vault_write_types || {})['daily'] || 0;

    // Calendar events today (count those that have passed)
    let meetingsAttended = 0;
    try {
      const calEvents = db.getCalendarEvents(todayStr + 'T00:00:00', todayStr + 'T23:59:59');
      const now = new Date();
      meetingsAttended = calEvents.filter(e =>
        e.show_as !== 'cancelled' && !e.is_all_day && new Date(e.end_time) < now
      ).length;
    } catch {}

    res.json({
      date: todayStr,
      todosCompleted: completedToday,
      doNextCompleted,
      captures: summary.captures_count || 0,
      captureTypes: summary.capture_types || {},
      chatMessages: summary.chat_count || 0,
      vaultWrites: summary.vault_writes || 0,
      meetingNotesWritten: meetingNotes,
      meetingsAttended,
      escalationsRaised: summary.escalations_raised || 0,
      escalationsResolved: summary.escalations_resolved || 0,
      importsRouted: summary.imports_routed || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/standup/today-status — live standup/EOD status from vault
router.get('/today-status', (req, res) => {
  const dailyNote = obsidianService.readTodayDailyNote();
  const dateStr = obsidianService.todayDateString();
  let eodDone = false, standupDone = false, eodContent = null;
  if (dailyNote) {
    standupDone = dailyNote.includes('## Standup') || dailyNote.includes('## Focus Today');
    const eodMatch = dailyNote.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
    if (eodMatch) { eodDone = true; eodContent = eodMatch[1].trim(); }
  }
  try {
    const db = require('../db/database');
    if (db.getState(`standup_done_${dateStr}`)) standupDone = true;
    if (db.getState(`eod_done_${dateStr}`)) eodDone = true;
  } catch {}
  res.json({ date: dateStr, standupDone, eodDone, eodContent });
});

// GET /api/standup/eod-history?days=14 — EOD entries from daily notes
router.get('/eod-history', (req, res) => {
  const days = parseInt(req.query.days || '14', 10);
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const dailyDir = require('path').join(vaultPath, 'Daily');
  const fs = require('fs');
  const pathMod = require('path');
  if (!fs.existsSync(dailyDir)) return res.json({ entries: [] });
  const entries = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const filePath = pathMod.join(dailyDir, `${dateStr}.md`);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const eodMatch = content.match(/## EOD[^\n]*\n([\s\S]*?)(?=\n##|$)/);
    if (!eodMatch) continue;
    const eodText = eodMatch[1].trim();
    if (!eodText) continue;
    const winMatch = eodText.match(/\*\*Win:\*\*\s*(.+)/);
    const didntGoMatch = eodText.match(/\*\*Didn't go to plan:\*\*\s*(.+)/);
    const feelingMatch = eodText.match(/\*\*Feeling:\*\*\s*(.+)/);
    entries.push({
      date: dateStr,
      win: winMatch ? winMatch[1].trim() : null,
      didntGo: didntGoMatch ? didntGoMatch[1].trim() : null,
      feeling: feelingMatch ? feelingMatch[1].trim() : null,
    });
  }
  res.json({ entries });
});

// GET /api/standup/must-dos — open #mustdo tasks from vault
router.get('/must-dos', (req, res) => {
  try {
    const mustDos = obsidianService.parseVaultMustDos();
    res.json({ items: mustDos });
  } catch (e) {
    console.error('[Standup] Must-dos error:', e);
    res.json({ items: [] });
  }
});

// POST /api/standup/pre-warm — manually trigger standup pre-warm
router.post('/pre-warm', async (req, res) => {
  try {
    preWarmStandup(); // fire and forget
    res.json({ ok: true, message: 'Pre-warm started' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/standup/pre-warm-status — check if caches are ready
router.get('/pre-warm-status', (req, res) => {
  const todayStr = obsidianService.todayDateString();
  res.json({
    standup: {
      cached: standupCache.date === todayStr && !!standupCache.phase1Response,
      warming: standupCache.warming,
      responseLength: standupCache.phase1Response?.length || 0
    },
    eod: {
      cached: eodCache.date === todayStr && !!eodCache.phase1Response,
      warming: eodCache.warming,
      responseLength: eodCache.phase1Response?.length || 0
    }
  });
});

// POST /api/standup/eod/pre-warm — manually trigger EOD pre-warm
router.post('/eod/pre-warm', async (req, res) => {
  try {
    preWarmEod();
    res.json({ ok: true, message: 'EOD pre-warm started' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/standup/interactive — Claude-guided standup session
router.post('/interactive', async (req, res) => {
  const { messages = [], phase = 'start' } = req.body;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let closed = false;
  res.on('close', () => { closed = true; });
  const safeSend = (data) => { if (!closed) try { res.write(data); } catch {} };
  const safeEnd = () => { if (!closed) try { res.end(); } catch {} };

  try {
    // Phase 3: Anthropic removed. Cloud fallback uses AI routing layer.
    const aiRouting = require('../services/ai-routing');

    const todayStr = obsidianService.todayDateString();

    // Build message history
    const claudeMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // If starting, add the trigger
    if (phase === 'start' || claudeMessages.length === 0) {
      claudeMessages.push({ role: 'user', content: 'Start my standup.' });
    }

    let fullResponse = '';
    let usedOllama = false;

    // ── Phase 1 cache hit — serve pre-warmed response instantly ──
    if ((phase === 'start' || claudeMessages.length === 1) &&
        standupCache.date === todayStr && standupCache.phase1Response) {
      console.log('[Standup] Serving pre-warmed Phase 1 response');
      fullResponse = standupCache.phase1Response;
      usedOllama = true;
      // Stream the cached response in chunks for natural feel
      const words = fullResponse.split(' ');
      const chunkSize = 3;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
        safeSend(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
      }
    }

    // ── Live Ollama/Claude call (cache miss or follow-up phases) ──
    // Build context (used by both Ollama and Claude fallback)
    const ctx = !usedOllama ? await buildStandupContext() : null;
    const systemPrompt = usedOllama && standupCache.systemPrompt ? standupCache.systemPrompt : ctx?.systemPrompt;

    if (!usedOllama) {
      try {
        const ollamaMessages = [
          { role: 'system', content: systemPrompt },
          ...claudeMessages
        ];

        const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
            messages: ollamaMessages,
            stream: true,
            options: { temperature: 0.7, num_ctx: 4096, num_predict: 1024 }
          }),
          signal: AbortSignal.timeout(180000) // 3 min — Pi 5 can be slow on cold start
        });

        if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);

        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n').filter(l => l.trim())) {
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                fullResponse += data.message.content;
                safeSend(`data: ${JSON.stringify({ type: 'text', content: data.message.content })}\n\n`);
              }
            } catch {}
          }
        }

        // Only mark as used if we got a meaningful response
        if (fullResponse.trim().length > 10) {
          usedOllama = true;
          console.log('[Standup] Response via Ollama');
        } else {
          console.warn('[Standup] Ollama returned empty/short response, falling back to Claude');
          fullResponse = '';
        }
      } catch (ollamaErr) {
        console.warn('[Standup] Ollama failed, falling back to Claude:', ollamaErr.message);
        fullResponse = '';
      }
    }

    // Cloud fallback — streaming via AI routing (Phase 3)
    if (!usedOllama && systemPrompt) {
      try {
        const result = await aiRouting.runStreamingChat(systemPrompt, claudeMessages, res, {
          taskType: 'standup_interactive',
          maxTokens: 1024,
          contextWindow: 4096,
        });
        fullResponse = result.text || '';
        console.log(`[Standup] Fallback response via ${result.provider}`);
      } catch (fallbackErr) {
        console.error('[Standup] Cloud fallback failed:', fallbackErr.message);
        safeSend(`data: ${JSON.stringify({ type: 'error', content: 'AI unavailable — try again later' })}\n\n`);
      }
    }

    // Check if daily note is present in the response
    const noteMatch = fullResponse.match(/===DAILY_NOTE_START===\n([\s\S]*?)\n===DAILY_NOTE_END===/);
    if (noteMatch) {
      try {
        const noteContent = noteMatch[1].trim();
        obsidianService.writeTodayDailyNote(noteContent);
        nudges.markStandupDone();
        console.log(`[Standup] Interactive standup complete — daily note written (via ${usedOllama ? 'Ollama' : 'Claude'})`);
        try { require('../services/activity').trackStandupDone(new Date().getHours(), true); } catch {}
        try { require('../services/activity').trackVaultWrite('daily'); } catch {}
        safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: true })}\n\n`);
      } catch (e) {
        console.error('[Standup] Failed to write daily note:', e.message);
        safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: false, noteError: e.message })}\n\n`);
      }
    } else {
      safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: false })}\n\n`);
    }

    safeEnd();
  } catch (err) {
    console.error('[Standup] Interactive error:', err.message);
    safeSend(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    safeEnd();
  }
});

// POST /api/standup/eod/interactive — AI-guided EOD reflection
router.post('/eod/interactive', async (req, res) => {
  const { messages = [], phase = 'start' } = req.body;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let closed = false;
  res.on('close', () => { closed = true; });
  const safeSend = (data) => { if (!closed) try { res.write(data); } catch {} };
  const safeEnd = () => { if (!closed) try { res.end(); } catch {} };

  try {
    // Phase 3: Anthropic removed. Cloud fallback uses AI routing layer.
    const aiRoutingEod = require('../services/ai-routing');
    const todayStr = obsidianService.todayDateString();

    const claudeMessages = messages.map(m => ({ role: m.role, content: m.content }));
    if (phase === 'start' || claudeMessages.length === 0) {
      claudeMessages.push({ role: 'user', content: 'Start my EOD.' });
    }

    let fullResponse = '';
    let usedOllama = false;

    // ── Phase 1 cache hit — serve pre-warmed EOD response instantly ──
    if ((phase === 'start' || claudeMessages.length === 1) &&
        eodCache.date === todayStr && eodCache.phase1Response) {
      console.log('[EOD] Serving pre-warmed Phase 1 response');
      fullResponse = eodCache.phase1Response;
      usedOllama = true;
      const words = fullResponse.split(' ');
      const chunkSize = 3;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
        safeSend(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
      }
    }

    // ── Live Ollama/Claude call (cache miss or follow-up phases) ──
    const ctx = !usedOllama ? await buildEodContext() : null;
    const systemPrompt = usedOllama && eodCache.systemPrompt ? eodCache.systemPrompt : ctx?.systemPrompt;

    if (!usedOllama) {
      try {
        const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...claudeMessages];
        const ollamaRes = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
            messages: ollamaMessages,
            stream: true,
            options: { temperature: 0.7, num_ctx: 4096, num_predict: 1024 }
          }),
          signal: AbortSignal.timeout(180000)
        });
        if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);
        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n').filter(l => l.trim())) {
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                fullResponse += data.message.content;
                safeSend(`data: ${JSON.stringify({ type: 'text', content: data.message.content })}\n\n`);
              }
            } catch {}
          }
        }
        if (fullResponse.trim().length > 10) {
          usedOllama = true;
          console.log('[EOD] Response via Ollama');
        } else {
          console.warn('[EOD] Ollama returned empty/short response, falling back to Claude');
          fullResponse = '';
        }
      } catch (ollamaErr) {
        console.warn('[EOD] Ollama failed, falling back to Claude:', ollamaErr.message);
        fullResponse = '';
      }
    }

    // Cloud fallback — streaming via AI routing (Phase 3)
    if (!usedOllama && systemPrompt) {
      try {
        const result = await aiRoutingEod.runStreamingChat(systemPrompt, claudeMessages, res, {
          taskType: 'eod_interactive',
          maxTokens: 1024,
          contextWindow: 4096,
        });
        fullResponse = result.text || '';
        console.log(`[EOD] Fallback response via ${result.provider}`);
      } catch (fallbackErr) {
        console.error('[EOD] Cloud fallback failed:', fallbackErr.message);
        safeSend(`data: ${JSON.stringify({ type: 'error', content: 'AI unavailable — try again later' })}\n\n`);
      }
    }

    // Check for EOD note in response
    const noteMatch = fullResponse.match(/===EOD_NOTE_START===\n([\s\S]*?)\n===EOD_NOTE_END===/);
    if (noteMatch) {
      try {
        const noteContent = noteMatch[1].trim();
        obsidianService.appendToDailyNote('\n' + noteContent);
        nudges.markEodDone();
        console.log(`[EOD] Interactive EOD complete — note appended (via ${usedOllama ? 'Ollama' : 'Claude'})`);
        try {
          const db = require('../db/database');
          const queue = db.getQueueSummary();
          if (queue.fresh) {
            require('../services/activity').trackQueueSnapshot(queue.at_risk_count || 0, queue.total || 0, queue.open_p1s || 0);
          }
        } catch {}
        try { require('../services/activity').trackEodDone(); } catch {}
        safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: true })}\n\n`);
      } catch (e) {
        console.error('[EOD] Failed to write EOD note:', e.message);
        safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: false, noteError: e.message })}\n\n`);
      }
    } else {
      safeSend(`data: ${JSON.stringify({ type: 'done', noteSaved: false })}\n\n`);
    }

    safeEnd();
  } catch (err) {
    console.error('[EOD] Interactive error:', err.message);
    safeSend(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    safeEnd();
  }
});

module.exports = router;
