'use strict';

/**
 * Decision Engine — Phase 2.6: Decisive Behaviour Layer
 *
 * Hard priority overrides, category suppression, time-of-day mode,
 * email scoring, confidence boosting. Deterministic. No LLM.
 *
 * Override chain: collect → score → behaviour modify → OVERRIDE → suppress → limit → primary
 * Overrides mutate tier + ordering AFTER scoring. They are non-negotiable.
 */

const db = require('../db/database');
const workingMemory = require('./working-memory');

// ── Tier thresholds ──
const TIER_1_MIN = 80;
const TIER_2_MIN = 50;

// ── Hard limits ──
const FOCUS_DEFAULT = 5;
const FOCUS_MAX = 7;

// ── Item suppression (per-ID, 30 min window) ──
const _suppressed = new Map();
const SUPPRESS_WINDOW_MS = 30 * 60 * 1000;

// ── Category suppression (entire types hidden temporarily) ──
// { [type]: { until: timestamp, reason: string } }
const _categorySuppression = new Map();

// ── Dismiss tracking: per-type with timestamps ──
// { [type]: [timestamp, timestamp, ...] }
const _typeDismissHistory = new Map();

// ── Confidence gap ──
const CONFIDENCE_GAP = 15;


// ═══════════════════════════════════════════════════════
// Time-of-Day Mode
// ═══════════════════════════════════════════════════════

function _getMode(ctx) {
  const hour = ctx.timeContext?.hour ?? new Date().getHours();
  const isWeekend = ctx.timeContext?.isWeekend;
  if (isWeekend) return 'weekend';
  if (hour < 11) return 'morning';
  if (hour < 16) return 'midday';
  return 'lateday';
}

function _timeOfDayModifier(item, mode) {
  switch (mode) {
    case 'morning':
      // Boost planning, standup, high-level tasks
      if (item.type === 'nudge' && item.meta?.type === 'standup') return +5;
      if (item.type === 'todo') return +3;
      if (item.type === 'email') return -2;
      return 0;
    case 'midday':
      // Boost execution: escalations, urgent emails
      if (item.type === 'escalation') return +4;
      if (item.type === 'email') return +3;
      if (item.type === 'nudge' && item.meta?.type === 'standup') return -3;
      return 0;
    case 'lateday':
      // Boost cleanup, follow-ups, low-effort
      if (item.type === 'nudge' && item.meta?.type === 'eod') return +5;
      if (item.type === 'imports') return +3;
      if (item.type === 'todo') return +2;
      return 0;
    case 'weekend':
      // Suppress work urgency
      if (item.type === 'escalation') return -5;
      if (item.type === 'nudge' && item.meta?.type === 'standup') return -10;
      return 0;
    default:
      return 0;
  }
}


// ═══════════════════════════════════════════════════════
// Email Scoring (deterministic, no LLM)
// ═══════════════════════════════════════════════════════

function _scoreEmail(email) {
  let score = 0;
  const reasons = [];

  // Base by category
  const cat = (email.category || email.urgency || '').toLowerCase();
  if (cat === 'high' || cat === 'action') { score += 40; reasons.push('Needs action'); }
  else if (cat === 'medium' || cat === 'delegate') { score += 25; reasons.push('Consider delegating'); }
  else if (cat === 'fyi' || cat === 'low') { score += 5; }
  else { score += 10; }

  // Unread
  if (!email.isRead) { score += 10; reasons.push('Unread'); }

  // Recency
  if (email.received || email.created_at) {
    const ageMs = Date.now() - new Date(email.received || email.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 4) { score += 6; reasons.push('Recent'); }
    else if (ageHours < 24) { score += 3; }
    else if (ageHours > 72) { score -= 10; reasons.push('Aging'); }
  }

  // Known contact (CACHED People/ index — no directory scan per email)
  const fromName = (email.from || '').split('<')[0].trim();
  if (fromName) {
    try {
      const vaultCache = require('./vault-cache');
      const people = vaultCache.getPeopleIndex();
      const isKnown = people.some(p => fromName.toLowerCase().includes(p.toLowerCase()) ||
                                        p.toLowerCase().includes(fromName.split(' ')[0].toLowerCase()));
      if (isKnown) { score += 8; reasons.push(`From ${fromName.split(' ')[0]}`); }
    } catch {}
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}


// ═══════════════════════════════════════════════════════
// Signal Collectors
// ═══════════════════════════════════════════════════════

function collectEscalations(ctx) {
  const items = [];
  if (ctx.unseenEscalations > 0) {
    items.push({
      type: 'escalation',
      id: 'escalations-unseen',
      title: `${ctx.unseenEscalations} unseen escalation${ctx.unseenEscalations > 1 ? 's' : ''}`,
      reason: 'Escalations need your attention',
      score: 95,
      urgency: 'critical',
      source: 'jira',
      actionHint: 'Open Queue → Escalations',
      _unsuppressable: true, // overrides cannot suppress this
    });
  }
  return items;
}

function collectMeetings(ctx) {
  const items = [];
  if (!ctx.calendar || ctx.calendar.length === 0) return items;

  const now = new Date();
  const twoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  for (const event of ctx.calendar) {
    if (event.is_all_day) continue;
    const start = new Date(event.start_time);
    if (start <= now || start > twoHours) continue;

    const minutesAway = Math.round((start - now) / 60000);
    if (minutesAway > 60) continue;

    const imminent = minutesAway <= 10;
    const soon = minutesAway <= 30;

    items.push({
      type: 'meeting',
      id: `cal-${event.event_id}`,
      title: event.subject,
      reason: minutesAway <= 5 ? 'Starting now' : `In ${minutesAway} min`,
      score: imminent ? 88 : soon ? 72 : 55,
      urgency: imminent ? 'critical' : soon ? 'high' : 'medium',
      source: 'calendar',
      actionHint: imminent ? 'Join / prep now' : 'Coming up',
      meta: { start: event.start_time, end: event.end_time, location: event.location, minutesAway },
      _unsuppressable: imminent, // imminent meetings cannot be suppressed
    });
  }
  return items;
}

function collectOverdueTodos(ctx) {
  const items = [];
  if (!ctx.todos || !ctx.todos.active) return items;

  const todayStr = ctx.dateKey;
  let overdueCount = 0;
  let dueTodayCount = 0;
  let topOverdue = null;
  let topDueToday = null;

  for (const todo of ctx.todos.active) {
    if (!todo.due_date) continue;
    const dueStr = todo.due_date.split('T')[0];
    const isPlanTask = (todo.source || '').toLowerCase().includes('plan') ||
                       (todo.source || '').toLowerCase().includes('90');

    if (dueStr < todayStr) {
      overdueCount++;
      const score = isPlanTask ? 85 : 65;
      if (!topOverdue || score > topOverdue.score) {
        topOverdue = { text: todo.text, dueStr, isPlanTask, score, source: todo.source };
      }
    } else if (dueStr === todayStr) {
      dueTodayCount++;
      const score = isPlanTask ? 68 : 45;
      if (!topDueToday || score > topDueToday.score) {
        topDueToday = { text: todo.text, dueStr, isPlanTask, score, source: todo.source };
      }
    }
  }

  if (overdueCount > 0 && topOverdue) {
    items.push({
      type: 'todo',
      id: overdueCount === 1 ? 'todo-overdue-top' : 'todo-overdue-summary',
      title: overdueCount === 1 ? topOverdue.text : `${overdueCount} overdue task${overdueCount > 1 ? 's' : ''}`,
      reason: overdueCount === 1 ? `Overdue (due ${topOverdue.dueStr})` : `Top: ${topOverdue.text.substring(0, 60)}`,
      score: topOverdue.score,
      urgency: topOverdue.isPlanTask ? 'high' : 'medium',
      source: topOverdue.source || 'vault',
      actionHint: overdueCount === 1 ? 'Complete or reschedule' : 'Review todos',
      meta: { dueDate: topOverdue.dueStr, overdueCount },
    });
  }

  if (dueTodayCount > 0 && topDueToday) {
    items.push({
      type: 'todo',
      id: dueTodayCount === 1 ? 'todo-today-top' : 'todo-today-summary',
      title: dueTodayCount === 1 ? topDueToday.text : `${dueTodayCount} task${dueTodayCount > 1 ? 's' : ''} due today`,
      reason: dueTodayCount === 1 ? 'Due today' : `Top: ${topDueToday.text.substring(0, 60)}`,
      score: topDueToday.score,
      urgency: topDueToday.isPlanTask ? 'medium' : 'low',
      source: topDueToday.source || 'vault',
      actionHint: dueTodayCount === 1 ? 'Do today' : 'Review todos',
      meta: { dueDate: topDueToday.dueStr, dueTodayCount },
    });
  }

  return items;
}

function collectUrgentEmails(ctx) {
  const items = [];
  try {
    // Use email triage (ACTION category) as primary source — more reliable than inbox scanner
    const emailTriage = require('./email-triage');
    const triage = emailTriage.getTriageByCategory();
    const actionEmails = triage?.urgent || [];

    if (actionEmails.length > 0) {
      const topEmail = actionEmails[0];
      const emailScore = _scoreEmail(topEmail);

      items.push({
        type: 'email',
        id: 'email-urgent',
        title: actionEmails.length === 1
          ? topEmail.subject
          : `${actionEmails.length} email${actionEmails.length > 1 ? 's' : ''} need action`,
        reason: emailScore.reasons.length > 0
          ? emailScore.reasons.slice(0, 3).join(' · ')
          : `From ${(topEmail.from || '?').split(' ')[0]}`,
        score: Math.max(65, emailScore.score),
        urgency: 'high',
        source: 'email',
        actionHint: 'Check inbox',
        meta: { count: actionEmails.length },
      });
    }

    // Also check for DELEGATE emails (lower priority)
    const delegateEmails = triage?.delegate || [];
    if (delegateEmails.length > 0 && actionEmails.length === 0) {
      items.push({
        type: 'email',
        id: 'email-delegate',
        title: `${delegateEmails.length} email${delegateEmails.length > 1 ? 's' : ''} to delegate`,
        reason: 'Consider delegating these',
        score: 45,
        urgency: 'medium',
        source: 'email',
        actionHint: 'Review inbox',
        meta: { count: delegateEmails.length },
      });
    }
  } catch {}
  return items;
}

function collectNudges(ctx) {
  const items = [];
  for (const nudge of (ctx.nudges || [])) {
    const isStandup = nudge.type === 'standup';
    const isEod = nudge.type === 'eod';
    const nagCount = nudge.nag_count || 0;

    const score = isStandup ? 72 + Math.min(nagCount * 3, 15) :
                  isEod ? 65 + Math.min(nagCount * 3, 10) :
                  40 + Math.min(nagCount * 2, 10);

    // Standup is non-negotiable before 11am — always shows in focus
    const hour = new Date().getHours();
    const standupCritical = isStandup && hour < 11;

    items.push({
      type: 'nudge',
      id: `nudge-${nudge.id}`,
      title: isStandup ? 'Do your standup' :
             isEod ? 'End-of-day not done' :
             `${nudge.type} reminder`,
      reason: isStandup && standupCritical ? '2 minutes — do it before anything else' : nudge.message,
      score: standupCritical ? 93 : score,
      urgency: standupCritical ? 'critical' : (nagCount >= 4 ? 'high' : nagCount >= 2 ? 'medium' : 'low'),
      source: 'neuro',
      actionHint: isStandup ? 'Open Standup' : isEod ? 'Open EOD' : `Complete ${nudge.type}`,
      meta: { nagCount, type: nudge.type },
      _unsuppressable: standupCritical,
    });
  }
  return items;
}

function collectImports(ctx) {
  const items = [];
  if (ctx.pendingImports > 0) {
    items.push({
      type: 'imports',
      id: 'imports-pending',
      title: `${ctx.pendingImports} file${ctx.pendingImports > 1 ? 's' : ''} awaiting review`,
      reason: 'Unclassified imports in vault',
      score: 35,
      urgency: 'low',
      source: 'imports',
      actionHint: 'Review & route',
    });
  }
  return items;
}


// ═══════════════════════════════════════════════════════
// Behaviour Modifiers
// ═══════════════════════════════════════════════════════

function _behaviourModifier(item, ctx) {
  let mod = 0;
  const observations = ctx.observations || [];

  if (item.type === 'escalation' &&
      observations.some(o => o.type === 'queue_spike')) {
    mod += 5;
  }

  if (item.type === 'nudge' && item.meta?.type === 'standup' &&
      observations.some(o => o.type === 'standup_late')) {
    mod += 6;
  }

  if (item.type === 'nudge' && (ctx.snoozeCount || 0) >= 4) {
    mod -= 3;
  }

  // Soft per-type dismiss penalty (from daily count)
  const typeDismiss = _getTypeDismissCountToday(item.type);
  if (typeDismiss >= 3) mod -= 8;
  else if (typeDismiss >= 2) mod -= 4;

  return mod;
}


// ═══════════════════════════════════════════════════════
// Hard Priority Overrides (Phase 2.6)
// Runs AFTER scoring. Mutates tier + ordering.
// ═══════════════════════════════════════════════════════

function _applyOverrides(items, ctx) {
  const observations = ctx.observations || [];
  const hour = ctx.timeContext?.hour ?? new Date().getHours();

  for (const item of items) {
    // 1. ESCALATION: unseen → always Tier 1, cannot suppress
    if (item.type === 'escalation') {
      item.tier = 1;
      item.score = Math.max(item.score, 97);
      item._override = 'escalation';
      item._unsuppressable = true;
    }

    // 3. MEETING IMMINENT: ≤10 min → force Tier 1, rank above todos
    if (item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 10) {
      item.tier = 1;
      item.score = Math.max(item.score, 94);
      item._override = 'meeting_imminent';
      item._unsuppressable = true;
    }

    // 4. STANDUP FAILURE: late in the morning only. After noon the reminder
    // should fall away instead of repeatedly forcing itself to the front.
    if (item.type === 'nudge' && item.meta?.type === 'standup' &&
        observations.some(o => o.type === 'standup_late') &&
        hour === 11 && new Date().getMinutes() >= 30) {
      item.tier = 1;
      item.score = Math.max(item.score, 98);
      item._override = 'standup_failure';
      item._unsuppressable = true;
    }

    if (item.type === 'nudge' && item.meta?.type === 'standup' && hour >= 12) {
      item.score = -100;
      item._suppressedAfterCutoff = true;
    }

  }

  // Re-sort after overrides
  items.sort((a, b) => b.score - a.score);
  return items;
}


// ═══════════════════════════════════════════════════════
// Category Suppression (Phase 2.6)
// Entire types hidden temporarily based on dismiss patterns.
// ═══════════════════════════════════════════════════════

function _checkCategorySuppression() {
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000; // 60 min lookback for dismiss history

  // Email: dismissed ≥3 in 60 min → suppress emails for 60 min
  const emailDismisses = _getRecentDismisses('email', WINDOW_MS);
  if (emailDismisses >= 3 && !_isCategorySuppressed('email')) {
    _categorySuppression.set('email', {
      until: now + 60 * 60 * 1000,
      reason: `Dismissed ${emailDismisses} emails in 60 min`,
    });
    console.log(`[DecisionEngine] Category suppressed: email (${emailDismisses} dismissals)`);
  }

  // Todo: dismissed ≥4 → suppress todos for 45 min
  const todoDismisses = _getRecentDismisses('todo', WINDOW_MS);
  if (todoDismisses >= 4 && !_isCategorySuppressed('todo')) {
    _categorySuppression.set('todo', {
      until: now + 45 * 60 * 1000,
      reason: `Dismissed ${todoDismisses} todos in 60 min`,
    });
    console.log(`[DecisionEngine] Category suppressed: todo (${todoDismisses} dismissals)`);
  }
}

function _isCategorySuppressed(type) {
  const entry = _categorySuppression.get(type);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    _categorySuppression.delete(type);
    return false;
  }
  return true;
}

// NEVER suppress these types regardless of category suppression
const UNSUPPRESSABLE_TYPES = new Set(['escalation']);


// ═══════════════════════════════════════════════════════
// Dismiss Tracking (timed, for category suppression)
// ═══════════════════════════════════════════════════════

function _trackDismiss(type) {
  if (!type) return;
  const now = Date.now();
  if (!_typeDismissHistory.has(type)) {
    _typeDismissHistory.set(type, []);
  }
  _typeDismissHistory.get(type).push(now);

  // Prune old entries (>2 hours)
  const cutoff = now - 2 * 60 * 60 * 1000;
  _typeDismissHistory.set(type,
    _typeDismissHistory.get(type).filter(t => t > cutoff)
  );
}

function _getRecentDismisses(type, windowMs) {
  const history = _typeDismissHistory.get(type);
  if (!history) return 0;
  const cutoff = Date.now() - windowMs;
  return history.filter(t => t > cutoff).length;
}

function _getTypeDismissCountToday(type) {
  const history = _typeDismissHistory.get(type);
  if (!history) return 0;
  const todayStart = new Date(new Date().toDateString()).getTime();
  return history.filter(t => t >= todayStart).length;
}


// ═══════════════════════════════════════════════════════
// Item Suppression
// ═══════════════════════════════════════════════════════

function isSuppressed(itemId) {
  const entry = _suppressed.get(itemId);
  if (!entry) return false;
  if (Date.now() - entry.suppressedAt > SUPPRESS_WINDOW_MS) {
    _suppressed.delete(itemId);
    return false;
  }
  return true;
}

function suppressItem(itemId, reason) {
  _suppressed.set(itemId, { suppressedAt: Date.now(), reason });
}

function clearExpiredSuppressions() {
  const now = Date.now();
  for (const [id, entry] of _suppressed) {
    if (now - entry.suppressedAt > SUPPRESS_WINDOW_MS) {
      _suppressed.delete(id);
    }
  }
}


// ═══════════════════════════════════════════════════════
// Tier Classification
// ═══════════════════════════════════════════════════════

function classifyTier(score) {
  if (score >= TIER_1_MIN) return 1;
  if (score >= TIER_2_MIN) return 2;
  return 3;
}


// ═══════════════════════════════════════════════════════
// Main Evaluation
// ═══════════════════════════════════════════════════════

async function evaluate(options = {}) {
  const { showAll = false } = options;
  const ctx = await workingMemory.getContext();
  const mode = _getMode(ctx);

  // Check category suppression triggers
  _checkCategorySuppression();

  // Collect all signals
  const allSignals = [
    ...collectEscalations(ctx),
    ...collectMeetings(ctx),
    ...collectOverdueTodos(ctx),
    ...collectUrgentEmails(ctx),
    ...collectNudges(ctx),
    ...collectImports(ctx),
  ];

  // Deduplicate, apply behaviour + time-of-day modifiers
  const seen = new Set();
  const candidates = [];
  for (const item of allSignals) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const behaviourMod = _behaviourModifier(item, ctx);
    const timeMod = _timeOfDayModifier(item, mode);
    const totalMod = behaviourMod + timeMod;
    const adjustedScore = Math.max(0, Math.min(100, item.score + totalMod));

    candidates.push({
      ...item,
      score: adjustedScore,
      _baseScore: item.score,
      _behaviourMod: behaviourMod,
      _timeMod: timeMod,
      tier: classifyTier(adjustedScore),
    });
  }

  // Apply HARD OVERRIDES (mutates tier + ordering)
  _applyOverrides(candidates, ctx);

  const totalCandidates = candidates.length;

  clearExpiredSuppressions();

  if (showAll) {
    return {
      items: candidates,
      totalCandidates,
      returned: candidates.length,
      suppressed: 0,
      tiers: _countTiers(candidates),
      mode,
    };
  }

  // Apply suppression + tier filtering + category suppression
  const focused = [];

  for (const item of candidates) {
    // Category suppression (skip entire types) — but never escalations/unsuppressable
    if (!item._unsuppressable && !UNSUPPRESSABLE_TYPES.has(item.type) &&
        _isCategorySuppressed(item.type)) {
      continue;
    }

    // Tier 3 suppressed (unless override made it unsuppressable)
    if (item.tier === 3 && !item._unsuppressable) continue;

    // Per-item suppression (user dismissed) — but not unsuppressable items
    if (!item._unsuppressable && isSuppressed(item.id)) continue;

    // Low urgency without deadline (unless nudge)
    if (item.urgency === 'low' && !item.meta?.dueDate && item.type !== 'nudge' && !item._unsuppressable) continue;

    focused.push(item);
    if (focused.length >= FOCUS_MAX) break;
  }

  // Apply default limit
  let finalItems;
  if (focused.length <= FOCUS_DEFAULT) {
    finalItems = focused;
  } else {
    const tier1 = focused.filter(i => i.tier === 1);
    const tier2 = focused.filter(i => i.tier === 2);

    if (tier1.length >= FOCUS_MAX) {
      finalItems = tier1.slice(0, FOCUS_MAX);
    } else if (tier1.length >= FOCUS_DEFAULT) {
      finalItems = [...tier1, ...tier2.slice(0, FOCUS_MAX - tier1.length)];
    } else {
      finalItems = [...tier1, ...tier2.slice(0, FOCUS_DEFAULT - tier1.length)];
    }
  }

  // ── Confidence boosting: mark primary item ──
  let primaryItem = null;
  if (finalItems.length >= 2) {
    const gap = finalItems[0].score - finalItems[1].score;
    if (gap >= CONFIDENCE_GAP || finalItems[0]._override) {
      finalItems[0].primary = true;
      primaryItem = {
        id: finalItems[0].id,
        reason: finalItems[0]._override
          ? _overrideReason(finalItems[0]._override)
          : 'Clear priority gap',
        confidence: Math.min(100, 60 + gap),
      };
    }
  } else if (finalItems.length === 1) {
    finalItems[0].primary = true;
    primaryItem = {
      id: finalItems[0].id,
      reason: 'Only active priority',
      confidence: 90,
    };
  }

  const actualSuppressed = totalCandidates - finalItems.length;

  return {
    items: finalItems,
    totalCandidates,
    returned: finalItems.length,
    suppressed: actualSuppressed,
    tiers: _countTiers(candidates),
    mode,
    primaryItem,
  };
}

function _overrideReason(override) {
  switch (override) {
    case 'sla_critical': return 'P1 SLA breaching — act immediately';
    case 'escalation': return 'Unseen escalation — requires attention';
    case 'meeting_imminent': return 'Meeting starting in minutes';
    case 'standup_failure': return 'Standup overdue — do it now';
    case 'crisis_mode': return 'Queue in crisis — tickets take priority';
    default: return 'System override';
  }
}

/**
 * Dismiss an item — suppresses it and tracks type for category suppression.
 */
function dismiss(itemId, itemType) {
  suppressItem(itemId, 'user-dismissed');
  if (itemType) {
    _trackDismiss(itemType);
  }
}

function _countTiers(items) {
  const tiers = { tier1: 0, tier2: 0, tier3: 0 };
  for (const item of items) {
    if (item.tier === 1) tiers.tier1++;
    else if (item.tier === 2) tiers.tier2++;
    else tiers.tier3++;
  }
  return tiers;
}

module.exports = {
  evaluate,
  dismiss,
  FOCUS_DEFAULT,
  FOCUS_MAX,
};
