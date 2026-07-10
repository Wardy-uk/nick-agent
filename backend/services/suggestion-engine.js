'use strict';

/**
 * Suggestion Engine — execution-first action suggestions from Focus items.
 *
 * Philosophy: "Do it" not "plan to do it".
 * Suggestions navigate the user to real actions, not task creation.
 *
 * Action types:
 *   - open_ticket  → navigate to Jira ticket
 *   - open_task    → navigate to top overdue task in TodoPanel
 *   - open_email   → navigate to inbox
 *   - open_standup → navigate to standup
 *   - draft_reply  → (future: open draft composer)
 *
 * Each suggestion returns a navigation target so the frontend
 * can immediately move the user to the right place.
 */

const db = require('../db/database');

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
    // Meeting imminent → open calendar
    match: (item) => item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 15,
    generate: (item) => ({
      type: 'open_task',
      confidence: 0.8,
      reason: `"${item.title}" starts in ${item.meta.minutesAway} min — prep now`,
      payload: {
        navigate: 'meeting-prep',
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
  if (!focusItems || focusItems.length === 0) return [];

  const suggestions = [];
  // Only deduplicate against PENDING actions (not executed/rejected).
  // Navigation actions (open_ticket, open_task, etc.) are repeatable —
  // the user should always have a "Do it" option available.
  const pendingActions = db.getPendingSaraActions();
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
 * Persist suggestions to the database.
 */
function persistSuggestions(suggestions) {
  const created = [];
  for (const s of suggestions) {
    const id = db.createSaraAction(s.type, s.payload, s.confidence, s.reason, s.focusItemId);
    created.push({ ...s, id, status: 'pending' });
  }
  return created;
}

/**
 * Execute an approved action.
 * For navigation actions: returns the target so the frontend can navigate.
 * For vault actions: performs the write then returns confirmation.
 */
function executeAction(action) {
  const payload = action.payload;

  switch (action.type) {
    case 'open_ticket':
    case 'open_task':
    case 'open_email':
    case 'open_standup': {
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

    case 'draft_reply': {
      // Future: open a draft composer
      return {
        ok: true,
        detail: 'Draft reply prepared',
        navigate: 'inbox',
      };
    }

    case 'capture_todo': {
      const obsidian = require('./obsidian');
      obsidian.addTodoToMasterList(payload.text, {
        priority: payload.metadata?.priority || payload.priority || 'normal',
        mustdo: payload.metadata?.moscow === 'must',
        metadata: payload.metadata || null,
        sourcePath: payload.sourcePath || null,
        origin: payload.origin || 'candidate',
        trigger: 'sara-action-capture-todo',
      });
      return {
        ok: true,
        detail: `Added to Master Todo: ${payload.text}`,
        navigate: 'todos',
      };
    }

    default:
      return { ok: false, detail: `Unknown action type: ${action.type}` };
  }
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
};
