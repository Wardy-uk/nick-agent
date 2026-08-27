'use strict';

const db = require('../db/database');

// ── Event logging ──────────────────────────────────────────────────────────

function trackTabOpen(tabName) {
  db.logActivity('tab_open', { tab: tabName });
}

function trackStandupDone(hour, withNote = false) {
  db.logActivity('standup_done', { hour, withNote });
}

function trackNudgeSnooze(nudgeType) {
  db.logActivity('nudge_snoozed', { type: nudgeType });
}

function trackCapture(captureType) {
  db.logActivity('capture', { type: captureType });
}

function trackChatMessage(messageText) {
  // Extract keywords only — do not store message content
  const topics = extractTopics(messageText);
  if (topics.length > 0) {
    db.logActivity('chat_message', { topics });
  }
}

function trackEodDone() {
  db.logActivity('eod_done', {});
}

function trackNudgeDismiss(nudgeType) {
  db.logActivity('nudge_dismissed', { type: nudgeType });
}

// Extract meaningful topic keywords from a chat message
// Mirrors extractSearchTerms in claude.js — same stop word list
function extractTopics(message) {
  const STOP_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'did', 'do', 'does', 'can', 'could', 'would', 'should', 'have', 'has',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'my', 'me', 'i', 'you', 'we', 'it', 'this', 'that', 'about',
    'tell', 'show', 'find', 'get', 'give', 'help', 'please', 'need', 'want',
    'know', 'think', 'look', 'see', 'any', 'some', 'all', 'from', 'into',
    'just', 'then', 'than', 'they', 'them', 'been', 'will', 'more', 'also',
    'neuro', 'nick', 'today', 'week', 'day', 'time', 'work', 'make', 'like'
  ]);

  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 5);
}

// trackQueueSnapshot removed 27 Aug 2026 with the Jira queue cache — see
// db/database.js. The `queue_snapshot` rollup case went with it: checked against
// the live DB first, and activity_log held **zero** such rows across 9,035
// entries since 18 June. Both writers sat on EOD *completion* paths, and
// `eod_done` has fired twice in that log's whole life — so there was no history
// to keep, and nothing to prune.
function trackPlanTaskToggled(taskDay, taskText, done) {
  if (done) db.logActivity('plan_task_done', { day: taskDay, text: taskText?.substring(0, 80) });
}

function trackOneTwoOneDone(personName) {
  db.logActivity('one_two_one_done', { person: personName });
}

function trackImportsSweep(routed, flagged, errors) {
  db.logActivity('imports_sweep', { routed, flagged, errors });
}

function trackVaultWrite(noteType) {
  db.logActivity('vault_write', { type: noteType || 'note' });
}

function trackEscalationRaised(ticketKey) {
  db.logActivity('escalation_raised', { key: ticketKey });
}

function trackEscalationResolved(ticketKey) {
  db.logActivity('escalation_resolved', { key: ticketKey });
}

// ── Nightly rollup ─────────────────────────────────────────────────────────

// Build daily summary from activity log for a given date
function buildDailySummary(dateKey) {
  const events = db.getActivityForDate(dateKey);

  const summary = {
    date: dateKey,
    standup_done: false,
    standup_hour: null,
    standup_with_note: false,
    standup_snooze_count: 0,
    todo_snooze_count: 0,
    nudge_dismiss_count: 0,
    eod_done: false,
    captures_count: 0,
    capture_types: {},
    chat_count: 0,
    chat_topics: [],
    tabs_opened: {},
    queue_eod_at_risk: null,
    queue_eod_total: null,
    queue_eod_p1s: null,
    plan_tasks_done: 0,
    one_two_ones: [],
    imports_routed: 0,
    imports_flagged: 0,
    vault_writes: 0,
    vault_write_types: {},
    escalations_raised: 0,
    escalations_resolved: 0,
  };

  const topicFreq = {};

  for (const event of events) {
    let data = {};
    try { data = JSON.parse(event.event_data || '{}'); } catch {}

    switch (event.event_type) {
      case 'standup_done':
        summary.standup_done = true;
        summary.standup_hour = data.hour || event.hour;
        summary.standup_with_note = data.withNote || false;
        break;
      case 'nudge_snoozed':
        if (data.type === 'standup') summary.standup_snooze_count++;
        else if (data.type === 'todo') summary.todo_snooze_count++;
        break;
      case 'nudge_dismissed':
        summary.nudge_dismiss_count++;
        break;
      case 'capture':
        summary.captures_count++;
        { const ct = data.type || 'note'; summary.capture_types[ct] = (summary.capture_types[ct] || 0) + 1; }
        break;
      case 'chat_message':
        summary.chat_count++;
        for (const topic of (data.topics || [])) {
          topicFreq[topic] = (topicFreq[topic] || 0) + 1;
        }
        break;
      case 'eod_done':
        summary.eod_done = true;
        break;
      case 'tab_open':
        if (data.tab) {
          summary.tabs_opened[data.tab] = (summary.tabs_opened[data.tab] || 0) + 1;
        }
        break;
      case 'plan_task_done':
        summary.plan_tasks_done = (summary.plan_tasks_done || 0) + 1;
        break;
      case 'one_two_one_done':
        if (data.person && !summary.one_two_ones.includes(data.person))
          summary.one_two_ones.push(data.person);
        break;
      case 'imports_sweep':
        summary.imports_routed = (summary.imports_routed || 0) + (data.routed || 0);
        summary.imports_flagged = (summary.imports_flagged || 0) + (data.flagged || 0);
        break;
      case 'vault_write':
        summary.vault_writes = (summary.vault_writes || 0) + 1;
        { const vt = data.type || 'note'; summary.vault_write_types[vt] = (summary.vault_write_types[vt] || 0) + 1; }
        break;
      case 'escalation_raised':
        summary.escalations_raised = (summary.escalations_raised || 0) + 1;
        break;
      case 'escalation_resolved':
        summary.escalations_resolved = (summary.escalations_resolved || 0) + 1;
        break;
    }
  }

  // Top 5 topics by frequency
  summary.chat_topics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);

  return summary;
}

// Run the nightly rollup — builds summary for yesterday
function runNightlyRollup() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateKey = yesterday.toISOString().split('T')[0];

  console.log(`[Activity] Running nightly rollup for ${dateKey}`);
  const summary = buildDailySummary(dateKey);
  db.saveDailySummary(dateKey, summary);
  console.log(`[Activity] Summary saved: standup=${summary.standup_done}, snoozes=${summary.standup_snooze_count + summary.todo_snooze_count}, chats=${summary.chat_count}`);
  return summary;
}

// Get a human-readable patterns block for Claude context injection
function getPatternsContextBlock(daysBack = 7) {
  const summaries = db.getDailySummaries(daysBack);
  if (summaries.length === 0) return null;

  // Also include today's live activity (not yet summarised)
  const todayKey = new Date().toISOString().split('T')[0];
  const todayLive = buildDailySummary(todayKey);

  const lines = [];

  // Today's live summary first
  const todayParts = [];
  if (todayLive.standup_done) {
    todayParts.push(`standup done at ${todayLive.standup_hour}:00`);
  } else {
    todayParts.push('standup NOT done');
  }
  if (todayLive.standup_snooze_count > 0) todayParts.push(`standup snoozed ${todayLive.standup_snooze_count}x`);
  if (todayLive.todo_snooze_count > 0) todayParts.push(`todo snoozed ${todayLive.todo_snooze_count}x`);
  if (todayLive.nudge_dismiss_count > 0) todayParts.push(`${todayLive.nudge_dismiss_count} dismissed`);
  if (todayLive.captures_count > 0) todayParts.push(`${todayLive.captures_count} capture${todayLive.captures_count !== 1 ? 's' : ''}`);
  if (todayLive.chat_count > 0) todayParts.push(`${todayLive.chat_count} chat messages`);
  if (todayLive.eod_done) todayParts.push('EOD done');
  if (Object.keys(todayLive.tabs_opened).length > 0) {
    const tabs = Object.entries(todayLive.tabs_opened)
      .sort((a, b) => b[1] - a[1])
      .map(([tab, count]) => `${tab}(${count})`)
      .join(', ');
    todayParts.push(`tabs: ${tabs}`);
  }
  lines.push(`Today (${todayKey}): ${todayParts.join(', ') || 'no activity logged yet'}`);

  // Past days
  for (const row of summaries.slice(0, 6)) {
    if (row.date_key === todayKey) continue; // already covered above
    const parts = [];
    if (row.standup_done) {
      parts.push(`standup ${row.standup_hour !== null ? row.standup_hour + ':00' : 'done'}`);
    } else {
      parts.push('standup SKIPPED');
    }
    if ((row.standup_snooze_count || 0) > 0) parts.push(`snoozed standup ${row.standup_snooze_count}x`);
    if ((row.todo_snooze_count || 0) > 0) parts.push(`snoozed todos ${row.todo_snooze_count}x`);
    if ((row.captures_count || 0) > 0) parts.push(`${row.captures_count} captures`);
    if ((row.chat_count || 0) > 0) parts.push(`${row.chat_count} chats`);
    if (row.eod_done) parts.push('EOD ✓');

    let topicsStr = '';
    try {
      const topics = JSON.parse(row.chat_topics || '[]');
      if (topics.length > 0) topicsStr = ` [topics: ${topics.join(', ')}]`;
    } catch {}

    lines.push(`${row.date_key}: ${parts.join(', ')}${topicsStr}`);
  }

  return `## Your Recent Patterns (last ${daysBack} days)\n${lines.join('\n')}`;
}

// ── Pattern detection & suggestions ───────────────────────────────────────

function detectPatterns() {
  const summaries = db.getDailySummaries(14);
  if (summaries.length < 3) return [];

  const suggestions = [];

  // Include today's live data
  const todayKey = new Date().toISOString().split('T')[0];
  const todayLive = buildDailySummary(todayKey);

  // Enrich with vault-based EOD/standup detection (more reliable than DB rollup alone)
  try {
    const obsidian = require('./obsidian');
    const fs = require('fs');
    const path = require('path');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
    const dailyDir = path.join(vaultPath, 'Daily');
    if (fs.existsSync(dailyDir)) {
      // Check today
      const todayFile = path.join(dailyDir, `${todayKey}.md`);
      if (fs.existsSync(todayFile)) {
        const content = fs.readFileSync(todayFile, 'utf-8');
        if (content.includes('## EOD')) todayLive.eod_done = true;
        if (content.includes('## Standup') || content.includes('## Focus Today')) todayLive.standup_done = true;
      }
      // Enrich recent summaries from vault too
      for (const s of summaries) {
        const file = path.join(dailyDir, `${s.date_key}.md`);
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf-8');
          if (content.includes('## EOD')) s.eod_done = 1;
          if (content.includes('## Standup') || content.includes('## Focus Today')) s.standup_done = 1;
        }
      }
    }
  } catch {}

  const allDays = [{ ...todayLive, date_key: todayKey }, ...summaries.filter(s => s.date_key !== todayKey)];

  // Pattern 1: 3+ consecutive late standups (after 10am) → suggest earlier nudge
  const recentWithStandup = allDays.filter(d => d.standup_done).slice(0, 7);
  let consecutiveLate = 0;
  let totalLateHour = 0;
  for (const day of recentWithStandup) {
    const hour = day.standup_hour;
    if (hour !== null && hour >= 10) {
      consecutiveLate++;
      totalLateHour += hour;
    } else {
      break;
    }
  }
  if (consecutiveLate >= 3) {
    const avgHour = Math.round(totalLateHour / consecutiveLate);
    const currentNudgeHour = parseInt(db.getState('standup_nudge_hour') || '9', 10);
    // Only suggest if not already adjusted
    if (currentNudgeHour >= 9) {
      suggestions.push({
        id: 'late_standup',
        type: 'standup_time',
        severity: 'medium',
        title: 'Standup running late',
        description: `Your standup has been after ${avgHour}:00 for ${consecutiveLate} days in a row. Consider an earlier nudge to build momentum.`,
        action: {
          label: 'Move nudge to 08:45',
          endpoint: '/api/activity/suggestions/apply',
          body: { id: 'late_standup', newHour: 8, newMinute: 45 }
        }
      });
    }
  }

  // Pattern 2: High todo snooze count (avg > 2 over last 5 days) → flag avoidance
  const recentDays = allDays.slice(0, 5);
  const totalTodoSnoozes = recentDays.reduce((sum, d) => sum + (d.todo_snooze_count || 0), 0);
  const avgTodoSnoozes = totalTodoSnoozes / Math.max(recentDays.length, 1);
  if (avgTodoSnoozes > 2) {
    suggestions.push({
      id: 'high_todo_snooze',
      type: 'todo_avoidance',
      severity: 'medium',
      title: 'Todo avoidance pattern',
      description: `You've snoozed todo nudges ${totalTodoSnoozes} times in the last ${recentDays.length} days (avg ${avgTodoSnoozes.toFixed(1)}/day). This pattern often means a task feels too big — try breaking the top item into smaller steps.`,
      action: {
        label: 'Open Todos',
        navigate: '/todos'
      }
    });
  }

  // Pattern 3: Standup snooze streak (snoozed 3+ times today)
  if (todayLive.standup_snooze_count >= 3 && !todayLive.standup_done) {
    suggestions.push({
      id: 'standup_snooze_streak',
      type: 'standup_avoidance',
      severity: 'high',
      title: 'Standup snoozed ' + todayLive.standup_snooze_count + ' times today',
      description: "You know the pattern. Three bullet points. Yesterday, today, blockers. It takes less time than reading this suggestion.",
      action: {
        label: 'Do standup now',
        navigate: '/standup'
      }
    });
  }

  // Pattern 4: EOD skipped 3+ days in a row
  const recentEod = allDays.slice(0, 7);
  let consecutiveNoEod = 0;
  for (const day of recentEod) {
    if (!day.eod_done) consecutiveNoEod++;
    else break;
  }
  if (consecutiveNoEod >= 3) {
    suggestions.push({
      id: 'eod_skipped',
      type: 'eod_habit',
      severity: 'low',
      title: 'EOD ritual dropped off',
      description: `No end-of-day reflection for ${consecutiveNoEod} days. The EOD ritual helps Future Nick know what Past Nick was thinking. Two minutes at 5pm.`,
      action: {
        label: 'Do EOD now',
        navigate: '/standup'
      }
    });
  }

  // Pattern 5: Low engagement (no chat messages for 3+ days)
  let consecutiveNoChat = 0;
  for (const day of allDays.slice(0, 7)) {
    if ((day.chat_count || 0) === 0) consecutiveNoChat++;
    else break;
  }
  if (consecutiveNoChat >= 3) {
    suggestions.push({
      id: 'low_engagement',
      type: 'engagement',
      severity: 'low',
      title: 'NEURO underused',
      description: `No chat messages for ${consecutiveNoChat} days. I'm here to help think through problems, prep for meetings, and track decisions. Try asking me something.`,
      action: {
        label: 'Open chat',
        navigate: '/chat'
      }
    });
  }

  return suggestions;
}

// Apply a suggestion action (server-side changes)
function applySuggestion(id, params) {
  if (id === 'late_standup') {
    const hour = params.newHour || 8;
    const minute = params.newMinute || 45;
    db.setState('standup_nudge_hour', String(hour));
    db.setState('standup_nudge_minute', String(minute));
    console.log(`[Activity] Standup nudge time changed to ${hour}:${String(minute).padStart(2, '0')}`);
    return { success: true, message: `Standup nudge moved to ${hour}:${String(minute).padStart(2, '0')}` };
  }
  return { success: false, message: 'Unknown suggestion' };
}

module.exports = {
  trackTabOpen,
  trackStandupDone,
  trackNudgeSnooze,
  trackNudgeDismiss,
  trackCapture,
  trackChatMessage,
  trackEodDone,
  trackPlanTaskToggled,
  trackOneTwoOneDone,
  trackImportsSweep,
  trackVaultWrite,
  trackEscalationRaised,
  trackEscalationResolved,
  buildDailySummary,
  runNightlyRollup,
  getPatternsContextBlock,
  detectPatterns,
  applySuggestion
};
