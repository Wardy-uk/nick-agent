'use strict';

/**
 * Chat Context v2 — bounded, cached context builder for API-quality chat.
 *
 * Provides rich context without the performance collapse of the original
 * buildContextBlock. Uses working memory cache + bounded vault retrieval.
 *
 * Token budget approach:
 *   - API mode (OpenAI): ~2000 token context budget
 *   - Local mode (Ollama): ~500 token context budget
 */

const db = require('../db/database');

// ── Context cache (avoids rebuilding if inputs unchanged) ──
let _ctxCache = { hash: null, data: null, at: 0 };
const CTX_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/**
 * Build bounded chat context.
 *
 * @param {string} userMessage - current user message (for vault retrieval)
 * @param {object} options
 * @param {string} options.mode - 'api' (rich) or 'local' (thin)
 * @param {string} options.intent - query intent hint
 * @returns {{ systemContext: string, tokenEstimate: number }}
 */
// A bare greeting is not a status request. Without this, "Hello there" pulled the queue
// counts, every active task, the 90-day plan and a vault similarity search on the word
// "hello" — so a hello came back as a status readout. The whole message must be the
// greeting: "morning, what's at risk?" is a real question and keeps the full context.
const GREETING_RE = /^\s*(hi+|hey+|hello|hiya|yo|sup|howdy|alright|morning|afternoon|evening|good\s+(morning|afternoon|evening|day))(\s+(there|sara|mate))?[\s!.,?]*$/i;

async function buildChatContext(userMessage, options = {}) {
  const mode = options.mode || 'api';
  const isApi = mode === 'api';
  const t0 = Date.now();

  if (GREETING_RE.test(userMessage || '')) {
    console.log('[ChatContextV2] Greeting — skipping status context');
    return {
      systemContext: 'Nick opened with a greeting and nothing else. No status was gathered '
        + 'for this turn: do not state queue counts, task counts or plan progress, and do '
        + 'not invent them. Answer in one short line and let him say what he wants.',
      tokenEstimate: 45,
      greeting: true,
    };
  }

  // ── Working memory (already cached, fast) ──
  let wm = null;
  try { wm = await require('./working-memory').getContext(); } catch {}

  const parts = [];

  // Queue summary removed 27 Aug 2026 with the Jira queue cache — see
  // db/database.js.

  // ── 2. Today status ──
  const statusParts = [];
  if (wm?.standupDone === false) statusParts.push('Standup pending');
  if (wm?.eodDone === false && wm?.timeContext?.hour >= 16) statusParts.push('EOD not done');
  if (wm?.unseenEscalations > 0) statusParts.push(`${wm.unseenEscalations} unseen escalations`);
  if (statusParts.length > 0) parts.push(`Today: ${statusParts.join(', ')}.`);

  // ── 3. Daily note summary (if exists, first 300 chars) ──
  if (isApi) {
    try {
      const vaultCache = require('./vault-cache');
      const daily = vaultCache.getDailyNote();
      if (daily) {
        // Extract just the Focus/Carry sections
        const lines = daily.split('\n');
        const keyLines = [];
        let capture = false;
        for (const line of lines) {
          if (line.startsWith('## Focus') || line.startsWith('## Carry') || line.startsWith('## Standup')) {
            capture = true; continue;
          }
          if (line.startsWith('## ') && capture) { capture = false; continue; }
          if (capture && line.trim()) keyLines.push(line.trim());
        }
        if (keyLines.length > 0) {
          parts.push(`Today's focus:\n${keyLines.slice(0, 5).join('\n')}`);
        }
      }
    } catch {}
  }

  // ── 4. Vault retrieval (API mode only, bounded) ──
  if (isApi && userMessage.length > 3) {
    try {
      const retrieval = require('./retrieval');
      const results = await retrieval.search(userMessage, { maxResults: 3 });
      if (results.length > 0) {
        const snippets = results.map(r =>
          `[${r.name}]: ${(r.excerpts?.[0] || '').substring(0, 150)}`
        );
        parts.push(`Relevant vault notes:\n${snippets.join('\n')}`);
      }
    } catch {}
  }

  // ── 5. Active todos (hierarchical, bounded) ──
  if (wm?.todos?.active?.length > 0) {
    const all = wm.todos.active;
    const fmt = t => `- ${t.text}${t.due_date ? ` (due: ${t.due_date})` : ''}`;

    const planTasks = all.filter(t => (t.source || '').includes('Daily') && t.priority === 'high');
    const vaultTasks = all.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('master') || (src.includes('daily') && t.priority !== 'high');
    });
    const msTasks = all.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('ms ') || src.includes('planner') || src.includes('todo');
    });

    let todoBlock = `Active tasks (${all.length} total):`;
    if (planTasks.length > 0) todoBlock += `\nFocus today:\n${planTasks.slice(0, 6).map(fmt).join('\n')}`;
    if (vaultTasks.length > 0) todoBlock += `\nVault tasks:\n${vaultTasks.slice(0, isApi ? 8 : 4).map(fmt).join('\n')}`;
    if (msTasks.length > 0) todoBlock += `\nMS Planner/ToDo:\n${msTasks.slice(0, isApi ? 6 : 3).map(fmt).join('\n')}`;
    parts.push(todoBlock);
  }

  // ── 6. 90-day plan (if available) ──
  if (wm?.ninetyDayPlan) {
    const plan = wm.ninetyDayPlan;
    let planBlock = `90-Day Plan: Day ${plan.currentDay}/90, ${plan.totalDone}/${plan.totalTasks} done.`;
    if (plan.overdueTasks?.length > 0) {
      planBlock += ` ${plan.overdueTasks.length} overdue:`;
      planBlock += plan.overdueTasks.slice(0, 5).map(t => `\n- Day ${t.day}: ${t.text}`).join('');
    }
    if (plan.todayTasks?.length > 0) {
      planBlock += `\nToday's plan tasks:`;
      planBlock += plan.todayTasks.map(t => `\n- [${t.status === 'x' ? 'x' : ' '}] ${t.text}`).join('');
    }
    parts.push(planBlock);
  }

  // ── 7. Active observations (compact) ──
  if (isApi && wm?.observations?.length > 0) {
    const recent = wm.observations.slice(-3).map(o => o.message);
    parts.push(`Recent observations: ${recent.join('; ')}`);
  }

  // ── 8. Calendar (next 2 hours, compact) ──
  if (isApi && wm?.calendar?.length > 0) {
    const now = new Date();
    const soon = wm.calendar
      .filter(e => !e.is_all_day && new Date(e.start_time) > now &&
                   new Date(e.start_time) < new Date(now.getTime() + 2 * 60 * 60 * 1000))
      .slice(0, 2);
    if (soon.length > 0) {
      parts.push(`Upcoming: ${soon.map(e => `${e.subject} at ${new Date(e.start_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`).join(', ')}`);
    }
  }

  const contextBlock = parts.join('\n\n');
  const tokenEstimate = Math.round(contextBlock.length / 4); // rough estimate

  const sources = [];
  if (wm?.todos?.active?.length > 0) sources.push(`todos:${wm.todos.active.length}`);
  if (wm?.ninetyDayPlan) sources.push(`plan:day${wm.ninetyDayPlan.currentDay}`);
  else sources.push('plan:MISSING');
  console.log(`[ChatContextV2] Built in ${Date.now() - t0}ms, ~${tokenEstimate} tokens (${mode}), sources: ${sources.join(', ')}`);

  return { systemContext: contextBlock, tokenEstimate };
}

/**
 * Get policy parameters based on provider mode.
 */
function getChatPolicy(mode) {
  if (mode === 'api') {
    return {
      maxTokens: 1024,
      maxHistory: 10,
      temperature: 0.7,
      contextBudget: 2000,
    };
  }
  // Local/fallback
  return {
    maxTokens: 384,
    maxHistory: 5,
    temperature: 0.7,
    contextBudget: 500,
  };
}

module.exports = { buildChatContext, getChatPolicy };
