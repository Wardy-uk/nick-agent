'use strict';

/**
 * Next-Action Engine — Phase 6A
 *
 * Transforms SARA from "here are suggestions" into:
 *   "Here is the next action" / "I already handled the safe bits" / "Approve me for the rest"
 *
 * Produces exactly:
 *   - primaryAction: the ONE thing to do right now (always present if items exist)
 *   - secondaryAction: optional fallback if primary is skipped
 *   - autoExecuted: list of safe actions SARA already performed this cycle
 *   - canWait: items that are tracked but don't need action now
 *
 * Decision flow:
 *   1. Decision engine evaluates → focus items
 *   2. Next-action engine picks THE action from those items
 *   3. Safe auto-actions execute without approval
 *   4. Everything else → one primary + one secondary
 */

const db = require('../db/database');
const actionSurfaces = require('../../shared/action-surfaces.cjs');

const JIRA_BASE = process.env.JIRA_BASE_URL || '';
const { decorateSurfaceSupport } = actionSurfaces;

// ── Safe auto-actions: things SARA can do without asking ──
// These are write-only, append-only, or read-only operations with no side effects.
const SAFE_AUTO_ACTIONS = {
  // Log meeting prep to daily note when meeting is <15 min away
  meeting_prep_log: {
    match: (item) => item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 15,
    execute: (item) => {
      try {
        const obsidian = require('./obsidian');
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const line = `- ${time} — Meeting prep: "${item.title}" in ${item.meta.minutesAway} min`;
        _appendToDailySection(obsidian, '## SARA Actions', line);
        return { type: 'meeting_prep_log', detail: `Logged prep for "${item.title}"` };
      } catch { return null; }
    },
    cooldown: 30 * 60 * 1000, // Don't re-log same meeting within 30 min
  },

  // Write daily observation summary at EOD
  observation_log: {
    match: (item, ctx) => {
      const hour = new Date().getHours();
      return item.type === 'nudge' && item.meta?.type === 'eod' && hour >= 17 &&
             (ctx.observations || []).length > 0;
    },
    execute: (item, ctx) => {
      try {
        const obsidian = require('./obsidian');
        const obs = (ctx.observations || []).slice(0, 5);
        const lines = obs.map(o => `  - ${o.type}: ${o.detail || ''}`).join('\n');
        const block = `- SARA observed today:\n${lines}`;
        _appendToDailySection(obsidian, '## SARA Actions', block);
        return { type: 'observation_log', detail: `Logged ${obs.length} observations` };
      } catch { return null; }
    },
    cooldown: 4 * 60 * 60 * 1000, // Once per 4h
  },

  // Log outcome when a high-urgency item was handled (action approved)
  outcome_log: {
    match: () => false, // Triggered externally after action approval, not from focus items
    execute: () => null,
    cooldown: 0,
  },
};

// Cooldown tracker: { [actionKey]: lastExecutedAt }
const _autoActionCooldowns = new Map();

function _isOnCooldown(key, cooldownMs) {
  if (!cooldownMs) return false;
  const last = _autoActionCooldowns.get(key);
  if (!last) return false;
  return (Date.now() - last) < cooldownMs;
}

function _markExecuted(key) {
  _autoActionCooldowns.set(key, Date.now());
}


// ── Action mapping: focus item → concrete action ──

function _mapToAction(item) {
  switch (item.type) {
    case 'escalation':
      return {
        type: 'navigate',
        target: 'queue',
        targetContext: { fromFocus: true, filter: 'escalations' },
        label: 'Respond now',
        reason: item.title,
        urgency: 'critical',
        focusItemId: item.id,
        focusItemType: item.type,
      };

    case 'jira_ticket': {
      const key = item.meta?.keys?.[0] || item.meta?.key;
      return {
        type: 'navigate',
        target: 'queue',
        targetContext: { fromFocus: true, filter: 'at-risk' },
        url: key && JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : null,
        label: key ? `Open ${key}` : 'Check queue',
        reason: item.reason,
        urgency: item.urgency || 'high',
        focusItemId: item.id,
        focusItemType: item.type,
      };
    }

    case 'meeting': {
      const mins = item.meta?.minutesAway;
      return {
        type: 'navigate',
        target: 'meeting-prep',
        label: mins <= 5 ? 'Join now' : `Prep — ${mins} min`,
        reason: item.title,
        urgency: mins <= 5 ? 'critical' : 'high',
        focusItemId: item.id,
        focusItemType: item.type,
      };
    }

    case 'todo': {
      const filter = item.id?.includes('overdue') ? 'overdue' : item.id?.includes('today') ? 'today' : 'all';
      return {
        type: 'navigate',
        target: 'todos',
        targetContext: { fromFocus: true, filter },
        label: 'Start top task',
        reason: item.title,
        urgency: item.urgency || 'medium',
        focusItemId: item.id,
        focusItemType: item.type,
      };
    }

    case 'nudge': {
      if (item.meta?.type === 'standup') {
        return {
          type: 'navigate',
          target: 'standup',
          label: 'Do standup',
          reason: '2 minutes — get it done',
          urgency: item.urgency || 'medium',
          focusItemId: item.id,
          focusItemType: item.type,
        };
      }
      if (item.meta?.type === 'eod') {
        return {
          type: 'navigate',
          target: 'standup',
          label: 'Wrap up — EOD',
          reason: 'End-of-day summary',
          urgency: item.urgency || 'low',
          focusItemId: item.id,
          focusItemType: item.type,
        };
      }
      return null;
    }

    case 'email':
      return {
        type: 'navigate',
        target: 'inbox',
        targetContext: { fromFocus: true, filter: 'urgent' },
        label: `${item.meta?.count || 1} email${(item.meta?.count || 1) > 1 ? 's' : ''} need action`,
        reason: item.reason,
        urgency: item.urgency || 'high',
        focusItemId: item.id,
        focusItemType: item.type,
      };

    case 'imports':
      return {
        type: 'navigate',
        target: 'imports',
        label: 'Review imports',
        reason: item.title,
        urgency: 'low',
        focusItemId: item.id,
        focusItemType: item.type,
      };

    default:
      return null;
  }
}

function _withSurfaceSupport(action) {
  if (!action) return action;
  return {
    ...action,
    ...decorateSurfaceSupport(action),
  };
}


// ── Main: compute next actions ──

/**
 * Compute the next action(s) from decision engine output.
 *
 * @param {Array} focusItems - Items from decision engine (already scored + sorted)
 * @param {object} ctx - Working memory context
 * @returns {{ primaryAction, secondaryAction, autoExecuted, canWait }}
 */
function computeNextActions(focusItems, ctx) {
  if (!focusItems || focusItems.length === 0) {
    return { primaryAction: null, secondaryAction: null, autoExecuted: [], canWait: [] };
  }

  // Step 1: Run safe auto-actions
  const autoExecuted = [];
  for (const [key, autoAction] of Object.entries(SAFE_AUTO_ACTIONS)) {
    if (_isOnCooldown(key, autoAction.cooldown)) continue;
    for (const item of focusItems) {
      if (autoAction.match(item, ctx)) {
        const result = autoAction.execute(item, ctx);
        if (result) {
          autoExecuted.push(result);
          _markExecuted(key);
          _logAutoAction(result);
        }
        break; // One execution per auto-action type per cycle
      }
    }
  }

  // Step 2: Map focus items to concrete actions
  const actions = [];
  for (const item of focusItems) {
    const action = _mapToAction(item);
    if (action) {
      actions.push(_withSurfaceSupport({ ...action, score: item.score, tier: item.tier, primary: item.primary }));
    }
  }

  // Step 3: Pick primary (highest score / override-marked) and secondary
  const primaryAction = actions[0] || null;
  const secondaryAction = actions.length > 1 ? actions[1] : null;

  // Step 4: Everything else is "can wait"
  const canWait = actions.slice(2).map(a => ({
    label: a.label,
    reason: a.reason,
    urgency: a.urgency,
    target: a.target,
    focusItemId: a.focusItemId,
    kind: a.kind,
    surfaces: a.surfaces,
  }));

  return { primaryAction, secondaryAction, autoExecuted, canWait };
}


/**
 * Execute a user-approved action.
 * Returns navigation instructions for the frontend.
 */
function executeAction(action) {
  // Log execution
  _logActionExecution(action);

  return {
    ok: true,
    detail: `Navigate to ${action.target}`,
    navigate: action.target || null,
    navigateContext: action.targetContext || { fromFocus: true },
    url: action.url || null,
  };
}

/**
 * Log an outcome after the user completes an action.
 * Called when the user navigates back to Focus after handling something.
 */
function logOutcome(actionType, detail) {
  try {
    const obsidian = require('./obsidian');
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const line = `- ${time} — Completed: ${detail}`;
    _appendToDailySection(obsidian, '## SARA Actions', line);
  } catch {}

  try {
    db.logActivity('sara_outcome', { type: actionType, detail });
  } catch {}
}


// ── Helpers ──

function _appendToDailySection(obsidian, section, content) {
  const daily = obsidian.readTodayDailyNote() || '';
  if (daily.includes(section)) {
    obsidian.appendToDailyNote(content + '\n');
  } else {
    obsidian.appendToDailyNote(`\n\n${section}\n${content}\n`);
  }
}

function _logAutoAction(result) {
  try {
    db.logActivity('sara_auto_action', {
      type: result.type,
      detail: result.detail,
    });
  } catch {}
}

function _logActionExecution(action) {
  try {
    db.logActivity('sara_action', {
      type: action.type,
      target: action.target,
      label: action.label,
      status: 'executed',
    });
  } catch {}

  try {
    const obsidian = require('./obsidian');
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const line = `- ${time} — ${action.label}: ${action.reason}`;
    _appendToDailySection(obsidian, '## SARA Actions', line);
  } catch {}
}


module.exports = {
  computeNextActions,
  executeAction,
  logOutcome,
  SAFE_AUTO_ACTIONS,
};
