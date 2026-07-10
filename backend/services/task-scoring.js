'use strict';

/**
 * Task Scoring — deterministic relevance scoring for vault tasks.
 *
 * Phase 2.5: Decision-oriented explanations, stronger anti-stale bias,
 * no-due-date handling improved.
 */

/**
 * Score a single task item.
 * Returns a number 0-100 where higher = more pressing.
 */
function scoreTask(task, todayStr) {
  let score = 0;
  const source = (task.source || '').toLowerCase();
  const priority = task.priority || 'normal';
  const moscow = task.moscow || null;
  const context = task.context || null;
  const dueStr = task.due_date ? task.due_date.split('T')[0] : null;

  // ── 1. Priority base (0-25) ──
  if (priority === 'high') score += 25;
  else if (priority === 'normal') score += 12;
  else score += 4;

  // ── 1b. Strategic triage boost ──
  if (moscow === 'must') score += 20;
  else if (moscow === 'should') score += 10;
  else if (moscow === 'could') score += 2;

  if (context === 'queue') score += 8;
  else if (context === 'meeting-follow-up' || context === 'people') score += 5;
  else if (context === 'admin') score += 2;

  // ── 2. Source quality (0-20) ──
  if (source.includes('90-day plan')) score += 20;
  else if (source.includes('master') && source.includes('now')) score += 18;
  else if (source.includes('daily') && source.includes('focus')) score += 16;
  else if (source.includes('master') && source.includes('soon')) score += 12;
  else if (source.includes('daily')) score += 10;
  else if (source.includes('master') && source.includes('inbox')) score += 8;
  else if (source.includes('master')) score += 8;
  else if (source.includes('ms planner')) score += 5;
  else if (source.includes('ms todo')) score += 5;
  else score += 6;

  // ── 3. Overdue recency (0-30) ──
  if (dueStr && dueStr < todayStr) {
    const daysOverdue = _daysBetween(dueStr, todayStr);

    if (daysOverdue <= 1) score += 30;
    else if (daysOverdue <= 3) score += 26;
    else if (daysOverdue <= 7) score += 20;
    else if (daysOverdue <= 14) score += 14;
    else if (daysOverdue <= 30) score += 8;
    else if (daysOverdue <= 90) score += 3;
    else if (daysOverdue <= 180) score += 1;
    else score += 0; // ancient: no overdue bonus at all
  } else if (dueStr && dueStr === todayStr) {
    score += 28;
  } else if (dueStr) {
    const daysUntil = _daysBetween(todayStr, dueStr);
    if (daysUntil <= 1) score += 22;
    else if (daysUntil <= 3) score += 15;
    else if (daysUntil <= 7) score += 8;
    else score += 2;
  }
  // No due date = no urgency bonus

  // ── 4. Staleness penalty ──
  // MS Planner/ToDo: aggressive decay for ancient items
  if ((source.includes('ms planner') || source.includes('ms todo')) && dueStr) {
    const daysOverdue = dueStr < todayStr ? _daysBetween(dueStr, todayStr) : 0;
    if (daysOverdue > 180 && priority !== 'high') {
      score -= 20; // effectively buried
    } else if (daysOverdue > 90 && priority !== 'high') {
      score -= 15;
    } else if (daysOverdue > 30 && priority !== 'high') {
      score -= 8;
    }
  }

  // All sources: no due date + low priority + not a plan task = penalise
  if (!dueStr && priority !== 'high' && !source.includes('90-day plan') && !source.includes('now')) {
    score -= 5;
  }

  if (moscow === 'must' && !dueStr) score += 4;

  // ── 5. Plan day proximity ──
  if (task.planDay != null) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Score and rank an array of task items.
 * Returns items with `_score` and `_scoreReason` fields, sorted by score descending.
 */
function rankTasks(tasks, todayStr) {
  if (!todayStr) todayStr = new Date().toISOString().split('T')[0];

  return tasks.map(task => {
    const _score = scoreTask(task, todayStr);
    const _scoreReason = _explainScore(task, _score, todayStr);
    return { ...task, _score, _scoreReason };
  }).sort((a, b) => b._score - a._score);
}

/**
 * Decision-oriented explanation — tells the user WHY to act, not HOW the score works.
 */
function _explainScore(task, score, todayStr) {
  const source = (task.source || '').toLowerCase();
  const dueStr = task.due_date ? task.due_date.split('T')[0] : null;
  const priority = task.priority || 'normal';

  // Build a decision-oriented sentence
  const parts = [];

  // Strategic connection
  if (source.includes('90-day plan')) {
    parts.push('Part of your 90-day plan');
  } else if (source.includes('master') && source.includes('now')) {
    parts.push("In your 'Now' priority list");
  } else if (source.includes('daily') && source.includes('focus')) {
    parts.push("Today's focus item");
  }

  // Priority signal
  if (priority === 'high' && !parts.some(p => p.includes('plan'))) {
    parts.push('Marked high priority');
  }

  // Timing signal
  if (dueStr) {
    if (dueStr === todayStr) {
      parts.push('due today');
    } else if (dueStr < todayStr) {
      const days = _daysBetween(dueStr, todayStr);
      if (days <= 3) parts.push(`${days} day${days > 1 ? 's' : ''} overdue`);
      else if (days <= 7) parts.push('overdue this week');
      else if (days <= 14) parts.push('overdue ~2 weeks');
      else if (days <= 30) parts.push('overdue ~1 month');
      else if (days <= 90) parts.push('overdue and aging');
      else parts.push('long-overdue backlog');
    }
  }

  // Stale signal
  if (score < 15) {
    parts.length = 0; // replace everything
    parts.push('Old backlog item — consider closing or rescheduling');
  } else if (score < 25) {
    if (!parts.some(p => p.includes('overdue'))) {
      parts.push('Low relevance — may be stale');
    }
  }

  return parts.join(' · ') || 'Active task';
}

function _daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00');
  const d2 = new Date(dateStr2 + 'T00:00:00');
  return Math.round(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24));
}

module.exports = { scoreTask, rankTasks };
