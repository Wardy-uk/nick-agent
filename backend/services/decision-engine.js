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
const { rankTasks } = require('./task-scoring');

// ── Tier thresholds ──
const TIER_1_MIN = 80;
const TIER_2_MIN = 50;

// ── Hard limits ──
const FOCUS_DEFAULT = 5;
const FOCUS_MAX = 7;

// ── Item suppression (per-ID, 30 min window) ──
const _suppressed = new Map();
const SUPPRESS_WINDOW_MS = 30 * 60 * 1000;
const NOVA_SNOOZE_MS = 60 * 60 * 1000;
const SUPPRESSION_STATE_KEY = 'focus_item_suppressions';

// ── Category suppression (entire types hidden temporarily) ──
// { [type]: { until: timestamp, reason: string } }
//
// Persisted, like per-item suppression. These were in-memory only, so every
// backend restart handed back a clean slate — and the backend restarts several
// times a day (32 on 14 Aug alone, mostly concurrent deploys). The effect was
// that "you have dismissed four todos, stop showing me todos for 45 minutes"
// survived until the next deploy and then forgot, which reads as the system
// ignoring you. Learned quiet has to outlive the process that learned it.
const _categorySuppression = new Map();
const CATEGORY_STATE_KEY = 'focus_category_suppressions';

// ── Dismiss tracking: per-type with timestamps ──
// { [type]: [timestamp, timestamp, ...] }
// Persisted for the same reason: this is the evidence category suppression is
// derived from, so losing it loses the ability to notice the pattern at all.
const _typeDismissHistory = new Map();
const DISMISS_STATE_KEY = 'focus_dismiss_history';

let _suppressionStateLoaded = false;
let _behaviourStateLoaded = false;

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
    const list = (ctx.unseenEscalationList || []).slice(0, 5).map(e => ({
      ...e,
      ageDays: e.created ? Math.floor((Date.now() - new Date(e.created).getTime()) / 86400000) : null,
    }));
    const single = list.length === 1 ? list[0] : null;

    items.push({
      type: 'escalation',
      id: 'escalations-unseen',
      // A bare count doesn't tell Nick what to act on. One escalation names
      // itself; several list underneath.
      title: single
        ? `${single.key} — ${single.summary}`
        : `${ctx.unseenEscalations} unseen escalation${ctx.unseenEscalations > 1 ? 's' : ''}`,
      reason: single
        ? `Escalation with no reply from you${single.ageDays != null ? ` — raised ${_ageLabel(single.ageDays)}` : ''}`
        : 'Escalations with no reply from you',
      score: 95,
      urgency: 'critical',
      source: 'jira',
      actionHint: 'Open Queue → Escalations',
      meta: {
        escalations: list,
        ticket_key: single?.key || null,
        url: single?.url || null,
        overflow: Math.max(0, ctx.unseenEscalations - list.length),
      },
      _unsuppressable: true, // overrides cannot suppress this
    });
  }
  return items;
}

function _ageLabel(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

// NOVA flagged tickets ("Nick, look at this"). NOVA's risk scorer already did
// the hard judgement of what's concerning; here we just surface the worst few
// into Focus so they land top of the pile. Capped at 3 so they never flood.
function collectNovaFlags(ctx) {
  const items = [];
  if (ctx.timeContext?.isWeekend) return items;
  let flags = [];
  try { flags = db.getActiveNovaFlags(); } catch { return items; }

  for (const f of flags.slice(0, 3)) {
    const risk = Number(f.risk_score) || 0;
    const isLegal = f.category === 'legal';
    // Map risk (typically 60–100) onto a Focus score that clears Tier 1 when severe.
    const score = Math.max(55, Math.min(97, risk));
    items.push({
      type: 'nova_flag',
      id: `nova-${f.ticket_key}`,
      title: `${f.ticket_key} — ${f.why || 'flagged for review'}`,
      reason: isLegal ? 'NOVA: legal/formal — needs your eyes' : 'NOVA flagged this for your attention',
      score,
      urgency: risk >= 80 || isLegal ? 'critical' : risk >= 70 ? 'high' : 'medium',
      source: 'nova',
      actionHint: 'Open NOVA → Look at this',
      meta: { ticketKey: f.ticket_key, category: f.category, riskScore: risk, summary: f.summary, assignee: f.assignee },
      _unsuppressable: isLegal, // legal/formal complaints can't be dismissed away
      _userSuppressable: true, // explicit snooze/hide is still allowed
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

// A 90-day plan that has run past its end date with items still open is not a
// backlog of tasks — it's one decision you haven't made. Raise it once, as that
// decision, rather than letting ~73 dead deliverables flood the queue and train
// you to ignore the overdue count.
function collectPlanClosure(ctx) {
  const items = [];
  const p = ctx.planSummary;
  if (!p || !p.over || !p.unfinished) return items;

  const daysOver = p.currentDay - p.totalDays;
  items.push({
    type: 'plan_closure',
    id: 'plan-closure',
    title: `90-Day Plan finished — ${p.unfinished} item${p.unfinished === 1 ? '' : 's'} still open`,
    reason: `Day ${p.currentDay} of a ${p.totalDays}-day plan (${daysOver} days over). Close it out, or roll what still matters into Master Todo.`,
    score: 58,
    urgency: 'medium',
    source: '90-day plan',
    actionHint: 'Review plan → close or roll forward',
    meta: { unfinished: p.unfinished, currentDay: p.currentDay, totalDays: p.totalDays, daysOver },
  });
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
  const overdueTasks = [];
  const dueTodayTasks = [];
  // Undated work used to vanish entirely: no due_date meant `continue`, so a
  // high-priority task with no date was worth exactly nothing to the engine.
  let undatedHighCount = 0;
  let topUndatedHigh = null;

  for (const todo of ctx.todos.active) {
    if (!todo.due_date) {
      if ((todo.priority || '').toLowerCase() === 'high') {
        undatedHighCount++;
        if (!topUndatedHigh) topUndatedHigh = { text: todo.text, source: todo.source };
      }
      continue;
    }
    const dueStr = todo.due_date.split('T')[0];

    if (dueStr < todayStr) overdueTasks.push(todo);
    else if (dueStr === todayStr) dueTodayTasks.push(todo);
  }

  overdueCount = overdueTasks.length;
  dueTodayCount = dueTodayTasks.length;

  // Pick the representative task with the real scorer rather than a flat
  // constant. Every overdue task used to score an identical 65, so "Top:" was
  // decided by iteration order — which surfaced the single oldest item in the
  // vault (a Planner task four years overdue) as the headline. task-scoring
  // already models what we want: ancient items get no urgency bonus at all and
  // stale Planner/ToDo entries are actively buried, so what floats up is
  // something worth doing rather than something worth ignoring.
  const _pick = (tasks) => {
    if (!tasks.length) return null;
    const top = rankTasks(tasks, todayStr)[0];
    const source = (top.source || '').toLowerCase();
    return {
      text: top.text,
      dueStr: top.due_date ? top.due_date.split('T')[0] : null,
      isPlanTask: source.includes('plan') || source.includes('90'),
      source: top.source,
      why: top._scoreReason || null,
    };
  };

  topOverdue = _pick(overdueTasks);
  topDueToday = _pick(dueTodayTasks);

  if (overdueCount > 0 && topOverdue) {
    items.push({
      type: 'todo',
      id: overdueCount === 1 ? 'todo-overdue-top' : 'todo-overdue-summary',
      // Lead with the task, not the pile. "101 overdue tasks" is a threat
      // display — it restates the anxiety instead of giving somewhere to start.
      title: topOverdue.text,
      reason: overdueCount === 1
        ? (topOverdue.why || `Overdue (due ${topOverdue.dueStr})`)
        : `${topOverdue.why || `Overdue (due ${topOverdue.dueStr})`} · ${overdueCount - 1} other overdue`,
      score: topOverdue.isPlanTask ? 85 : 65,
      urgency: topOverdue.isPlanTask ? 'high' : 'medium',
      source: topOverdue.source || 'vault',
      actionHint: overdueCount === 1 ? 'Complete or reschedule' : 'Start here, then review the rest',
      // Carried so an OUTBOUND surface can tell whether this may leave the
      // building. The title IS the task's own text, so a personal task reaching
      // the briefing puts Nick's private life into Nurtur's mail system. It is
      // not filtered HERE on purpose — the Surface and Focus should show
      // personal work; only the outbound paths ask.
      meta: { dueDate: topOverdue.dueStr, overdueCount, domain: topOverdue.domain || null },
    });
  }

  if (dueTodayCount > 0 && topDueToday) {
    items.push({
      type: 'todo',
      id: dueTodayCount === 1 ? 'todo-today-top' : 'todo-today-summary',
      title: topDueToday.text,
      reason: dueTodayCount === 1
        ? (topDueToday.why || 'Due today')
        : `${topDueToday.why || 'Due today'} · ${dueTodayCount - 1} other due today`,
      score: topDueToday.isPlanTask ? 68 : 45,
      urgency: topDueToday.isPlanTask ? 'medium' : 'low',
      source: topDueToday.source || 'vault',
      actionHint: dueTodayCount === 1 ? 'Do today' : 'Start here, then review the rest',
      meta: { dueDate: topDueToday.dueStr, dueTodayCount, domain: topDueToday.domain || null },
    });
  }

  // Scored just into Tier 2 — high-priority undated work deserves to be seen,
  // but never above something with a real date on it.
  if (undatedHighCount > 0 && topUndatedHigh) {
    items.push({
      type: 'todo',
      id: 'todo-undated-high',
      title: undatedHighCount === 1
        ? topUndatedHigh.text
        : `${undatedHighCount} high-priority tasks with no date`,
      reason: undatedHighCount === 1
        ? 'High priority, no due date'
        : `Top: ${topUndatedHigh.text.substring(0, 60)}`,
      score: 52,
      urgency: 'medium',
      source: topUndatedHigh.source || 'vault',
      actionHint: 'Give these a date or drop them',
      meta: { undatedHighCount, domain: topUndatedHigh.domain || null },
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
        // Carry the top email's identity so the suggestion engine can offer to
        // draft a reply to *that* email rather than just opening the inbox.
        meta: {
          count: actionEmails.length,
          emailId: topEmail.id || null,
          subject: topEmail.subject || null,
          from: topEmail.from || null,
        },
      });
    }

    // Also check for DELEGATE emails (lower priority)
    const delegateEmails = triage?.delegate || [];
    if (delegateEmails.length > 0 && actionEmails.length === 0) {
      items.push({
        type: 'email',
        id: 'email-delegate',
        title: `${delegateEmails.length} email${delegateEmails.length > 1 ? 's' : ''} to delegate`,
        reason: 'These are answerable by someone else',
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

// A nudge type is a slug, not a sentence. Interpolating it raw produced cards
// reading "121 reminder" and "Complete journal" — SARA naming her own internals
// at Nick rather than naming the thing he has to do.
const NUDGE_LABELS = {
  standup: { title: 'Do your standup', hint: 'Open Standup' },
  eod: { title: 'End-of-day not done', hint: 'Open EOD' },
  journal: { title: 'Journal not written', hint: 'Open Journal' },
  todo: { title: 'Overdue tasks waiting', hint: 'Pick one' },
  email: { title: 'Emails need answering', hint: 'Open Inbox' },
  escalation: { title: 'Escalations unanswered', hint: 'Open Focus' },
  '121': { title: '1-2-1s need booking', hint: 'Open Team' },
  plan_milestone: { title: '90-day plan milestone due', hint: 'Open Plan' },
};

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
      title: NUDGE_LABELS[nudge.type]?.title || 'Something is waiting on you',
      reason: isStandup && standupCritical ? '2 minutes — do it before anything else' : nudge.message,
      score: standupCritical ? 93 : score,
      urgency: standupCritical ? 'critical' : (nagCount >= 4 ? 'high' : nagCount >= 2 ? 'medium' : 'low'),
      source: 'neuro',
      actionHint: NUDGE_LABELS[nudge.type]?.hint || 'Open NEURO',
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
  _loadBehaviourState();
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000; // 60 min lookback for dismiss history
  let changed = false;

  // Email: dismissed ≥3 in 60 min → suppress emails for 60 min
  const emailDismisses = _getRecentDismisses('email', WINDOW_MS);
  if (emailDismisses >= 3 && !_isCategorySuppressed('email')) {
    _categorySuppression.set('email', {
      until: now + 60 * 60 * 1000,
      reason: `Dismissed ${emailDismisses} emails in 60 min`,
    });
    console.log(`[DecisionEngine] Category suppressed: email (${emailDismisses} dismissals)`);
    changed = true;
  }

  // Todo: dismissed ≥4 → suppress todos for 45 min
  const todoDismisses = _getRecentDismisses('todo', WINDOW_MS);
  if (todoDismisses >= 4 && !_isCategorySuppressed('todo')) {
    _categorySuppression.set('todo', {
      until: now + 45 * 60 * 1000,
      reason: `Dismissed ${todoDismisses} todos in 60 min`,
    });
    console.log(`[DecisionEngine] Category suppressed: todo (${todoDismisses} dismissals)`);
    changed = true;
  }

  if (changed) _persistBehaviourState();
}

function _isCategorySuppressed(type) {
  _loadBehaviourState();
  const entry = _categorySuppression.get(type);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    _categorySuppression.delete(type);
    _persistBehaviourState();
    return false;
  }
  return true;
}

// ── Behaviour state persistence ──────────────────────────────────────────────
// Both maps ride in one KV row: they are written together on every dismiss and
// read together on every evaluate, so splitting them would double the I/O for
// no benefit. Expired entries are dropped on load rather than stored forever.

function _loadBehaviourState() {
  if (_behaviourStateLoaded) return;
  _behaviourStateLoaded = true;
  try {
    const parsed = JSON.parse(db.getState(CATEGORY_STATE_KEY) || '{}');
    const now = Date.now();
    for (const [type, entry] of Object.entries(parsed)) {
      if (entry?.until > now) _categorySuppression.set(type, entry);
    }
  } catch (e) {
    console.warn('[DecisionEngine] Failed to load category suppressions:', e.message);
  }
  try {
    const parsed = JSON.parse(db.getState(DISMISS_STATE_KEY) || '{}');
    // Same 2h horizon _trackDismiss prunes to — anything older cannot influence
    // a decision, so there is no point carrying it across a restart.
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [type, stamps] of Object.entries(parsed)) {
      const fresh = (Array.isArray(stamps) ? stamps : []).filter(t => t > cutoff);
      if (fresh.length) _typeDismissHistory.set(type, fresh);
    }
  } catch (e) {
    console.warn('[DecisionEngine] Failed to load dismiss history:', e.message);
  }
}

function _persistBehaviourState() {
  try {
    const cats = {};
    const now = Date.now();
    for (const [type, entry] of _categorySuppression) {
      if (entry?.until > now) cats[type] = entry;
    }
    db.setState(CATEGORY_STATE_KEY, JSON.stringify(cats));

    const dismisses = {};
    for (const [type, stamps] of _typeDismissHistory) {
      if (stamps.length) dismisses[type] = stamps;
    }
    db.setState(DISMISS_STATE_KEY, JSON.stringify(dismisses));
  } catch (e) {
    console.warn('[DecisionEngine] Failed to persist behaviour state:', e.message);
  }
}

// NEVER suppress these types regardless of category suppression
const UNSUPPRESSABLE_TYPES = new Set(['escalation']);


// ═══════════════════════════════════════════════════════
// Dismiss Tracking (timed, for category suppression)
// ═══════════════════════════════════════════════════════

function _trackDismiss(type) {
  if (!type) return;
  _loadBehaviourState();
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
  _persistBehaviourState();
}

function _getRecentDismisses(type, windowMs) {
  _loadBehaviourState();
  const history = _typeDismissHistory.get(type);
  if (!history) return 0;
  const cutoff = Date.now() - windowMs;
  return history.filter(t => t > cutoff).length;
}

function _getTypeDismissCountToday(type) {
  _loadBehaviourState();
  const history = _typeDismissHistory.get(type);
  if (!history) return 0;
  const todayStart = new Date(new Date().toDateString()).getTime();
  return history.filter(t => t >= todayStart).length;
}


// ═══════════════════════════════════════════════════════
// Item Suppression
// ═══════════════════════════════════════════════════════

function isSuppressed(itemId) {
  _loadPersistedSuppressions();
  const entry = _suppressed.get(itemId);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    _suppressed.delete(itemId);
    _persistSuppressions();
    return false;
  }
  return true;
}

function suppressItem(itemId, reason, options = {}) {
  if (!itemId) return null;
  _loadPersistedSuppressions();
  const until = options.until || (Date.now() + (options.durationMs || SUPPRESS_WINDOW_MS));
  const entry = {
    suppressedAt: Date.now(),
    until,
    reason: reason || 'suppressed',
  };
  _suppressed.set(itemId, entry);
  _persistSuppressions();
  return entry;
}

function clearExpiredSuppressions() {
  _loadPersistedSuppressions();
  const now = Date.now();
  let changed = false;
  for (const [id, entry] of _suppressed) {
    if (now > entry.until) {
      _suppressed.delete(id);
      changed = true;
    }
  }
  if (changed) _persistSuppressions();
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
    ...collectNovaFlags(ctx),
    ...collectMeetings(ctx),
    ...collectOverdueTodos(ctx),
    ...collectPlanClosure(ctx),
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
    if ((!item._unsuppressable || item._userSuppressable) && isSuppressed(item.id)) continue;

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

function snooze(itemId, itemType, durationMs = NOVA_SNOOZE_MS) {
  suppressItem(itemId, 'user-snoozed', { durationMs });
  if (itemType) {
    _trackDismiss(itemType);
  }
}

function hideForToday(itemId, itemType) {
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  suppressItem(itemId, 'user-hidden-today', { until: tomorrow.getTime() });
  if (itemType) {
    _trackDismiss(itemType);
  }
}

function getSuppressionFingerprint() {
  _loadPersistedSuppressions();
  clearExpiredSuppressions();
  return [..._suppressed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => `${id}:${entry.until}`)
    .join('|');
}

function _loadPersistedSuppressions() {
  if (_suppressionStateLoaded) return;
  _suppressionStateLoaded = true;
  try {
    const raw = db.getState(SUPPRESSION_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const now = Date.now();
    for (const [itemId, entry] of Object.entries(parsed || {})) {
      if (!entry || !entry.until || entry.until <= now) continue;
      _suppressed.set(itemId, entry);
    }
  } catch (e) {
    console.warn('[DecisionEngine] Failed to load suppressions:', e.message);
  }
}

function _persistSuppressions() {
  try {
    const serializable = {};
    const now = Date.now();
    for (const [itemId, entry] of _suppressed) {
      if (!entry || !entry.until || entry.until <= now) continue;
      serializable[itemId] = entry;
    }
    db.setState(SUPPRESSION_STATE_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.warn('[DecisionEngine] Failed to persist suppressions:', e.message);
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
  snooze,
  hideForToday,
  getSuppressionFingerprint,
  FOCUS_DEFAULT,
  FOCUS_MAX,
};
