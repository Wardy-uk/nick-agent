'use strict';

/**
 * AI Provider — unified interface for AI tasks.
 *
 * Phase 3A Activation: Adds Focus enhancement (primary directive,
 * per-item guidance, ignore summary, adaptive tone), drill-down framing,
 * and action suggestions.
 *
 * All calls go through ai-routing.js for Ollama/OpenAI selection + cost control.
 */

const aiRouting = require('./ai-routing');

// ═══════════════════════════════════════════════════════
// Tone Selection (deterministic, no LLM)
// ═══════════════════════════════════════════════════════

/**
 * Select the adaptive tone based on context and observations.
 * Returns: 'calm' | 'focused' | 'assertive' | 'critical'
 */
function getTone(ctx) {
  const observations = ctx.observations || [];
  const snoozeCount = ctx.snoozeCount || 0;
  const dismissCount = ctx.dismissCount || 0;
  const hour = ctx.timeContext?.hour ?? new Date().getHours();

  // CRITICAL: operational urgency
  const hasCrisis = observations.some(o => o.type === 'queue_spike') &&
                    observations.some(o => o.type === 'sla_worsening');
  const hasNewEscalation = observations.some(o => o.type === 'new_escalation');
  if (hasCrisis || hasNewEscalation) return 'critical';

  // ASSERTIVE: avoidance patterns
  const hasSnoozePattern = observations.some(o => o.type === 'snooze_pattern');
  const standupLate = observations.some(o => o.type === 'standup_late');
  if (hasSnoozePattern || standupLate || snoozeCount >= 5 || dismissCount >= 4) return 'assertive';

  // CALM: overwhelm signals (high item count, lots of overdue)
  const todoCount = ctx.todos?.active?.length || 0;
  const overdueCount = (ctx.todos?.active || []).filter(t =>
    t.due_date && t.due_date.split('T')[0] < ctx.dateKey
  ).length;
  if (overdueCount > 50 || todoCount > 200) return 'calm';

  // FOCUSED: normal operating mode
  return 'focused';
}

// SARA's four registers. Written in second person on purpose — these end up in
// a prompt, and "the user is overwhelmed" is how a model starts narrating Nick
// in the third person on a card he is reading himself.
const TONE_INSTRUCTIONS = {
  calm: 'He is overwhelmed. Be grounding. Say what to ignore. Very short. Name one thing to do, not a plan.',
  focused: 'Normal operating mode. Clear and direct. One recommendation per item. No fluff.',
  assertive: 'He is avoiding something. Name the drift as a fact, not a failing, and give him the smallest first move. No escape routes, no lecture.',
  critical: 'Urgency is real. Direct, no padding. Say what has to happen now and cut everything else.',
};


// ═══════════════════════════════════════════════════════
// Focus Enhancement (primary directive + item guidance)
// ═══════════════════════════════════════════════════════

// ── SARA's opening line must be about the day she was actually shown ────────
//
// 7 Sep 2026. Live, at the top of the briefing, spoken aloud: "Avoid the
// meeting. / Stay focused on tasks." — and on the next refresh, "Start the
// meeting now. / Attend / Don't worry about the tasks for today." ⚠ THERE WAS
// NO MEETING. The three items were two todos and an email; the model invented a
// meeting, gave contradictory instructions about it, and told Nick to ignore
// the only real work on the list.
//
// Three causes, and they compounded. `toneGuide.split('.')[0]` kept the FIRST
// SENTENCE of the tone instruction, so `assertive` reached the model as "He is
// avoiding something." with the entire instruction after it — name the drift,
// give the smallest first move, no escape routes — thrown away; the model was
// handed a diagnosis with no direction and echoed "avoid" back. `itemSummary`
// (type + title + REASON) was built and never used, so a 1.5b local model got
// three bare title strings and was asked for a directive. And the only
// validation was `length > 80`.
//
// ⚠ The sting: `assertive` fires BECAUSE avoidance was detected. The one
// register written to counter Nick's stated failure mode was the one telling
// him to skip a meeting and ignore his tasks.
//
// The prompt fix is necessary and is NOT sufficient — a small model asked to
// write a directive can always invent. So the output is CHECKED against the
// items it was given, and a line that drifts is discarded rather than shown.
// Returning null is already the "AI unavailable" path, so the caller falls back
// to `buildDeterministicSara` with no new branch.
//
// ⚠ The asymmetry is deliberate and the check is tuned to it: a false REJECT
// costs a generic-but-true line, a false ACCEPT puts fiction at the top of the
// briefing and speaks it. So it errs towards rejecting.

// The words that assert a SUBJECT. A message may only name a kind of thing that
// is actually in front of it.
//
// ⚠ A word earns a place here ONLY if it identifies ONE kind of thing. "queue"
// and "call" are out because they do not — the deterministic builder's own
// escalation line is "Open escalation queue", and a rule that rejects the
// grounded fallback's wording is not a strict rule, it is a wrong one. Caught
// by the test asserting the two always agree, not by reading.
const TYPE_WORDS = {
  meeting: ['meeting', 'meetings', '1-2-1', '1-1', 'agenda', 'attend', 'attendees'],
  email: ['email', 'emails', 'inbox', 'reply', 'replies', 'mail'],
  escalation: ['escalation', 'escalations', 'escalated'],
  jira_ticket: ['ticket', 'tickets', 'sla'],
  todo: ['task', 'tasks', 'todo', 'todos'],
  nudge: ['standup', 'stand-up', 'eod', 'journal'],
  imports: ['import', 'imports'],
};

// A directive directs. "Avoid the meeting" is not a smaller first move, it is
// permission — which is the one thing SARA must never hand the person whose
// failure mode is avoidance. Checked on `message` and `action` only: the
// `ignore` line's whole job is to say what can wait.
const NON_DIRECTIVES = [
  'avoid', 'avoiding', 'ignore', 'skip', 'skipping', 'cancel', 'postpone',
  'delay', 'dont', 'do not', 'forget', 'no need',
];

// Lowercased, apostrophes dropped, everything else to spaces, padded — so a
// whole-word test and a two-word phrase both work on one string, and "mail"
// cannot match inside "email" (the `entities.js` rule: `includes()` fired
// "Liam" inside "William").
function _norm(text) {
  return ` ${String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9-]+/g, ' ')} `;
}

function _mentions(haystack, word) {
  return haystack.includes(` ${word} `);
}

/**
 * PURE. Is this line about the day it was actually shown?
 *
 * Returns `{ ok, reason }` — the reason is LOGGED, because a silent fallback is
 * indistinguishable from the model being offline, and a model drifting on every
 * pass is something Nick should be able to find out about.
 */
function checkSaraGrounding(line, items) {
  const message = line?.primary?.message || '';
  const action = line?.primary?.action || '';
  const ignore = line?.ignore || '';
  if (!message) return { ok: false, reason: 'no message' };

  const present = new Set((items || []).map(i => i.type));
  const directive = _norm(`${message} ${action}`);

  // 1. The DIRECTIVE may not name a kind of thing that is not there.
  //
  // ⚠ Scoped to message + action, deliberately NOT the `ignore` line, whose
  // whole job is to name a category that can wait — the deterministic builder's
  // own "Lower-priority imports and email can wait" says exactly that about
  // things which are absent, and checking it here would reject the honest
  // phrasing along with the invented one.
  for (const [type, words] of Object.entries(TYPE_WORDS)) {
    if (present.has(type)) continue;
    const hit = words.find(w => _mentions(directive, w));
    if (hit) return { ok: false, reason: `mentions "${hit}" but there is no ${type} in the list` };
  }

  // 2. The directive must direct.
  const escape = NON_DIRECTIVES.find(w => _mentions(directive, w));
  if (escape) return { ok: false, reason: `directive says "${escape}" — that is permission, not a first move` };

  // 3. It may not tell him to ignore the very thing it just told him to do.
  const top = items?.[0]?.type;
  if (top && ignore) {
    const topWords = TYPE_WORDS[top] || [];
    const clash = topWords.find(w => _mentions(_norm(ignore), w));
    if (clash) return { ok: false, reason: `tells him to ignore "${clash}", which is the top item` };
  }

  return { ok: true, reason: null };
}

/**
 * Enhance focus output with AI-generated directive, guidance, and ignore summary.
 *
 * @param {object} params
 * @param {Array} params.items - Decision engine focus items (max 5)
 * @param {object} params.context - Working memory context
 * @param {string} params.tone - Selected tone mode
 * @param {object} params.primaryItem - Primary item metadata from engine (or null)
 * @returns {object} { primary, items, ignore, provider } or null if AI unavailable
 */
async function enhanceFocus({ items, context, tone, primaryItem }) {
  if (!items || items.length === 0) return null;

  const toneGuide = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.focused;

  // Build a compact context summary for the prompt (keep it small)
  const contextLines = [];
  // Queue line removed 27 Aug 2026 with the Jira queue cache — see db/database.js.
  if (context.standupDone === false) contextLines.push('Standup not done yet');
  if (context.snoozeCount > 0) contextLines.push(`${context.snoozeCount} snoozes today`);
  const ctxStr = contextLines.length > 0 ? contextLines.join('. ') + '.' : 'Normal day.';

  // ⚠ Built and never used until now: the model got three bare titles and
  // invented the rest, which is the predictable result of asking for a
  // directive with nothing to base one on. The REASON travels too, and the
  // slice matches the items the message is allowed to talk about.
  const itemSummary = items.slice(0, 3).map((item, i) =>
    `${i + 1}. [${item.type}] "${item.title}" — ${item.reason || 'no reason recorded'}${item._override ? ` (OVERRIDE: ${item._override})` : ''}`
  ).join('\n');

  // Keep prompt minimal — Pi 5 generates at ~3 tok/s, so 100 output tokens = ~30s
  // ⚠ The WHOLE tone instruction, not `toneGuide.split('.')[0]`. Assertive's
  // first sentence is the diagnosis ("He is avoiding something") and everything
  // saying what to DO with it is in the sentences after — truncating it is what
  // produced "Avoid the meeting."
  //
  // The added cost is PROMPT tokens, which the Pi reads far faster than it
  // writes, and nothing waits on this call — it pre-generates for the next one.
  const systemPrompt = `SARA: decisive chief of staff. JSON only. Tone: ${tone}. ${toneGuide}
Write only about the numbered items given. Never mention anything not in that list. Never tell him to avoid, skip or ignore the top item.`;

  const userMessage = `${ctxStr}
Items:
${itemSummary}

Reply JSON: {"primary":{"message":"<10 words>","action":"<5 words>"},"ignore":"<10 words>"}
JSON only:`;

  try {
    const result = await aiRouting.runTask('focus_enhancement', {
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 80,
      temperature: 0.3,
      // 14000 sat INSIDE this task's own latency spread on the Pi — measured
      // 16 Aug: qwen2.5:1.5b p50 13.5s, p95 16.7s — so roughly every other call
      // burned the full 14s, aborted, and then paid OpenRouter for the same
      // answer. Nothing waits on this: enhanceFocus is fire-and-forget
      // pre-generation for the NEXT request and the current one always renders
      // buildDeterministicSara instantly, so the old "must fit the route's 15s
      // timeout" was never true. Sized above p95 to let the local model finish.
    }, { timeout: 25000 });

    if (!result.text || result.provider === 'none') return null;

    // Parse and validate
    const parsed = _parseJSON(result.text);
    if (!parsed || !parsed.primary?.message) return null;

    // Validate — reject garbage
    if (parsed.primary.message.length > 80) return null;

    const line = {
      primary: {
        message: parsed.primary.message.substring(0, 80),
        action: (parsed.primary.action || '').substring(0, 40),
      },
      ignore: (parsed.ignore || '').substring(0, 80),
      provider: result.provider,
      tone,
    };

    // ⚠ The load-bearing half. A line that is not about the day it was shown is
    // DISCARDED, and null is already the "AI unavailable" path — so the caller
    // renders the deterministic line with no new branch. Logged with the
    // reason: a silent fallback is indistinguishable from the model being
    // offline, and a model drifting on every pass is worth knowing about.
    const grounded = checkSaraGrounding(line, items);
    if (!grounded.ok) {
      console.warn(`[AIProvider] Discarded SARA line — ${grounded.reason}: "${line.primary.message}"`);
      return null;
    }

    return line;
  } catch (e) {
    console.warn('[AIProvider] Focus enhancement failed:', e.message);
    return null;
  }
}

function _parseJSON(text) {
  // Try to extract JSON from potentially messy output
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find a JSON object in the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return null;
  }
}


// ═══════════════════════════════════════════════════════
// Deterministic SARA Fallback (Phase 4B)
// Always available, no AI required.
// ═══════════════════════════════════════════════════════

/**
 * Build a SARA block from deterministic decision-engine output.
 * Used when AI is unavailable — ensures SARA block is always present.
 */
function buildDeterministicSara(items, tone) {
  if (!items || items.length === 0) return null;

  const top = items[0];
  const TYPE_MESSAGES = {
    escalation: { message: 'Handle the escalation first.', action: 'Open escalation queue' },
    jira_ticket: { message: 'SLA tickets need attention.', action: 'Review the at-risk queue' },
    meeting: { message: 'Meeting soon — prep now.', action: 'Check agenda and people notes' },
    todo: { message: 'Start with your top overdue task.', action: 'Open and complete the first one' },
    nudge: { message: 'Complete your standup.', action: 'Open standup now' },
    email: { message: 'Urgent emails waiting.', action: 'Check inbox' },
    imports: { message: 'Files need routing.', action: 'Review imports' },
  };

  const fallback = TYPE_MESSAGES[top.type] || { message: 'Start with the top item.', action: 'Review it now' };

  // Override message for specific nudge types
  if (top.type === 'nudge' && top.meta?.type === 'eod') {
    fallback.message = 'Wrap up for the day.';
    fallback.action = 'Complete your EOD';
  }

  // Build ignore summary from lowest-priority categories
  const types = new Set(items.map(i => i.type));
  const ignoreTypes = ['imports', 'email'].filter(t => !types.has(t) || items.findIndex(i => i.type === t) > 2);
  const ignore = ignoreTypes.length > 0
    ? `Lower-priority ${ignoreTypes.join(' and ')} can wait.`
    : items.length <= 2 ? 'Nothing else needs attention right now.' : 'Focus on the top items only.';

  return {
    primary: {
      message: fallback.message,
      action: fallback.action,
    },
    ignore,
    provider: 'deterministic',
    tone,
  };
}


// ═══════════════════════════════════════════════════════
// Other AI functions
// ═══════════════════════════════════════════════════════

async function generateDrilldownFraming(context) {
  const result = await aiRouting.runTask('drilldown_framing', {
    prompt: `Write one short sentence explaining why these items are shown first. Context: ${context}. Be concise and helpful, under 20 words.`,
    maxTokens: 50,
    temperature: 0.3,
  }, { timeout: 4000 });

  const text = (result.text || '').trim();
  if (text.length > 5 && text.length < 150 && !text.includes('{') && !text.includes('```')) {
    return { text, provider: result.provider };
  }
  return { text: '', provider: 'none' };
}

async function streamChat(systemPrompt, messages, res, options = {}) {
  return aiRouting.runStreamingChat(systemPrompt, messages, res, options);
}

async function classifyImport(prompt) {
  return aiRouting.runTask('import_classification', {
    prompt,
    maxTokens: 256,
    temperature: 0.2,
  });
}

async function triageEmails(prompt) {
  return aiRouting.runTask('email_triage', {
    prompt,
    maxTokens: 1024,
    temperature: 0.2,
  });
}

async function processTranscript(systemPrompt, content) {
  return aiRouting.runTask('transcript_processing', {
    systemPrompt,
    messages: [{ role: 'user', content }],
    maxTokens: 1024,
    temperature: 0.3,
  }, { confidence: 0.3 });
}

async function generateJournalPrompts(prompt) {
  return aiRouting.runTask('journal_prompts', {
    prompt,
    maxTokens: 300,
    temperature: 0.7,
  });
}

function getStatus() {
  return aiRouting.getStatus();
}

module.exports = {
  getTone,
  enhanceFocus,
  buildDeterministicSara,
  // Pure, so the grounding rules pin without a model, a DB or a clock.
  checkSaraGrounding,
  generateDrilldownFraming,
  streamChat,
  classifyImport,
  triageEmails,
  processTranscript,
  generateJournalPrompts,
  getStatus,
};
