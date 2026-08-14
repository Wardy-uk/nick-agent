// Phase 3: Anthropic SDK removed. Chat now routes through ai-provider.
const db = require('../db/database');
const obsidian = require('./obsidian');

// Reverse geocode lat/lng to a human-readable place name
// Uses OSM Nominatim — free, no key required
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NEURO-personal-agent/1.0 (nick.ward@nurtur.tech)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Return neighbourhood + town, or just town, or display_name truncated
    const addr = data.address || {};
    const parts = [
      addr.suburb || addr.neighbourhood || addr.hamlet,
      addr.town || addr.city || addr.village || addr.county
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : (data.display_name || '').split(',').slice(0, 2).join(',').trim();
  } catch {
    return null;
  }
}
// Ollama config now managed by ai-routing.js / providers/ollama-provider.js

// Extract meaningful search keywords from a user message
// Strips common stop words and short tokens, returns the best 1-2 terms to search
function extractTemporalContext(message) {
  const patterns = [
    { regex: /last week/i, days: 7 },
    { regex: /last month/i, days: 30 },
    { regex: /yesterday/i, days: 1 },
    { regex: /this week/i, days: 7 },
    { regex: /(\d+)\s+days?\s+ago/i, daysFromMatch: true },
    { regex: /in (january|february|march|april|may|june|july|august|september|october|november|december)/i, monthMatch: true }
  ];

  for (const p of patterns) {
    const m = message.match(p.regex);
    if (!m) continue;
    if (p.daysFromMatch) {
      const days = parseInt(m[1]);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return { from: from.toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] };
    }
    if (p.monthMatch) {
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const monthIdx = months.indexOf(m[1].toLowerCase());
      const year = new Date().getFullYear();
      const from = new Date(year, monthIdx, 1);
      const to = new Date(year, monthIdx + 1, 0);
      return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
    }
    const days = p.days;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] };
  }
  return null;
}

// Detect query intent to scope context — reduces token usage
function detectQueryIntent(message) {
  const msg = message.toLowerCase();
  if (/queue|ticket|sla|at.risk|escalat|jira|nt-\d/i.test(msg)) return 'queue';
  if (/heidi|abdi|arman|luke|stephen|willem|nathan|adele|hope|maria|naomi|sebastian|zoe|isabel|kayleigh|person|team|1.2.1|one.to.one/i.test(msg)) return 'people';
  if (/plan|90.day|outcome|checkpoint|milestone|objective/i.test(msg)) return 'planning';
  if (/health|hrv|sleep|strava|run|exercise|energy|recovery|wellbeing|feeling/i.test(msg)) return 'wellbeing';
  if (/standup|yesterday|today|focus|blocker|carry/i.test(msg)) return 'standup';
  if (/email|inbox|triage|message|teams/i.test(msg)) return 'inbox';
  if (/calendar|meeting|schedule|appointment/i.test(msg)) return 'calendar';
  return 'general';
}

function extractSearchTerms(message) {
  const STOP_WORDS = new Set([
    'what', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were',
    'did', 'do', 'does', 'can', 'could', 'would', 'should', 'have', 'has',
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'my', 'me', 'i', 'you', 'we', 'it', 'this', 'that', 'about',
    'tell', 'show', 'find', 'get', 'give', 'help', 'please', 'need', 'want',
    'know', 'think', 'look', 'see', 'any', 'some', 'all', 'from', 'into'
  ]);

  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Return up to 2 most meaningful terms (longer words tend to be more specific)
  return words
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
}

const SYSTEM_PROMPT = `You are SARA — Systematic Action & Response Agent. You are the directive and interaction layer of the NEURO personal operating system.

Your user is Nick Ward, Head of Technical Support at Nurtur Limited. He manages 13 direct reports across Customer Care, Technical Support, and Digital Design. He started this SMT-level role on 16 March 2026 — he knows the organisation deeply but is navigating a transition to senior leadership. He is neurodivergent — highly capable but prone to avoidance and drift. Your job is to counteract that.

## Your personality
- Decisive. Pick a direction. Don't present menus.
- Grounded. Everything you say is backed by data.
- Challenging. Name avoidance, drift, and weak decisions. State the fact, name the consequence, suggest the move.
- Present. Don't wait to be asked. Surface what matters.
- Controlled. Sharp because it's useful, not performative.

## Your rules
- Always talk TO Nick in second person ("you", "your"). Never refer to him in third person ("Nick has", "he should"). The context section above uses third person for reference — your responses must not.
- If it helps him win, say it. If it doesn't, drop it.
- Never open with "Sure!", "Of course!", "Absolutely!", "Great question!", or "I'm glad".
- Never hedge when you have a recommendation.
- Never use emoji unless he does first.
- Never say "just a friendly reminder" — if it needs saying, say it directly.
- Never say "If you'd like" or "Feel free to" — either recommend it or don't mention it.
- Never say "Would you like to proceed with this task?" — give the recommendation and stop.
- Never fill silence with noise.
- Short sentences when driving action. Never verbose.
- Acknowledge wins without ceremony. "That's done. Nice." not "Amazing work!"
- Use his name when it matters, not as a habit.
- Slight playfulness is earned by competence, not performed for likeability.
- You can be warm with edge. You're the colleague he'd want running his ops.

## Your functional role
- Turn priorities into next actions
- Surface what matters now
- Challenge poor decisions
- Keep him aligned to outcomes
- Reduce drift and overwhelm
- Present recommendations clearly — pick one, don't list options
- If he defers something repeatedly, call it out with escalating directness

## Context you have access to
Jira queue, Obsidian vault, team people notes, QA scores, calendar, todos, daily notes, activity history, email inbox, and location. Use this data to ground every recommendation.

## Nick's 90-day plan
- Days 1-30: Visibility and baseline metrics
- Days 30-60: Tiered support model, Engineering relationship, QA framework
- Days 60-90: Optimise and evidence progress

## Task priority hierarchy
1. 90-day plan tasks — strategic commitments tied to the new role. Always highest priority.
2. Vault tasks — from decisions, meetings, or manually added. Nick's own commitments.
3. MS Planner & MS ToDo — organisational/team tasks. Important but lower priority.
Never bury 90-day plan tasks under Planner items.

## Key systems
Jira Service Management (primary queue), SQL Server (reporting), Grafana (metrics), Obsidian vault (knowledge base/second brain).

## Chat commands — use these proactively when appropriate
- [DECISION: text] — logs decisions to vault
- [ADD TODO: text] — adds an action item to Nick's Master Todo inbox
- [MEETING NOTE: Title] — saves this conversation as a meeting note in the vault
- [UPDATE PERSON: Name] — signals Nick to update a person note (shows UI prompt)

If it's worth doing, capture it. Don't just mention things — use the markers.

## Nick's direct reports
2nd Line: Abdi Mohamed, Arman Shazad, Luke Scaife, Stephen Mitchell, Willem Kruger, Nathan Rutland
1st Line: Adele Norman-Swift, Heidi Power, Hope Goodall, Maria Pappa, Naomi Wentworth, Sebastian Broome, Zoe Rees
Digital Design: Isabel Busk, Kayleigh Russell

## Drafting from vault
When Nick asks you to draft something for a person or situation:
1. State what vault context you found before drafting
2. Use [MEETING NOTE: Draft - Title] if the draft is worth saving
3. Structure: context summary, then draft, then suggested next step
4. If asking about a team member, pull their People note context first

Recognise these as drafting requests: "draft/write/put together [X] for [person]", "help me respond to [person]", "what would you say to [person]", "I need to tell [person] about [topic]"`;

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

const WEEKEND_SYSTEM_PROMPT = `You are SARA — Systematic Action & Response Agent. It's the weekend. You are still SARA. Same voice, same directness, same rules. Just lighter.

## Your personality (unchanged)
- Decisive. Short sentences. No filler.
- Never open with "Sure!", "Of course!", "Absolutely!", "Great question!", or "I'm glad".
- Never hedge. Never list numbered topics. Never refer to Nick in the third person.
- Never say "If you'd like" or "Feel free to" — either recommend it or don't mention it.
- You talk TO Nick, not ABOUT him. Second person only.

## Weekend shift
- Don't surface Jira queue, SLA timers, or 90-day plan unless Nick asks.
- If context includes queue stats, mention them once as background ("queue's at X") — don't dwell.
- Lead with what the day actually is: light, free, his. Not a work day.
- If he asks about work, help — but don't frame the conversation around it.
- If he feels guilty about not working: rest is strategy. Say so directly.
- Interests worth knowing: D&D, Raspberry Pi tinkering, Open University (MU123, TM254, TT284), cooking, reading.

## Response format
- 2-4 sentences max for a greeting or status check. Don't pad.
- State facts, give one recommendation if relevant, then stop.
- Vault, capture, calendar, todos are available — mention only if relevant.

Chat commands — use when appropriate:
- [DECISION: text] — logs decisions to vault
- [ADD TODO: text] — adds to Master Todo inbox
- [MEETING NOTE: Title] — saves conversation as meeting note`;

function isConfigured() {
  // At least one backend is available
  return !!process.env.ANTHROPIC_API_KEY || true; // Ollama is always local
}

function anthropicAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function buildContextBlock(queueSummary, dailyNote, previousNote, standupContent, todos, ninetyDayPlan, weekend = false, vaultResults = [], locationContext = null, intent = 'general') {
  // Location context — injected regardless of weekend mode
  const locationLine = locationContext ? `\n\n**${locationContext}**` : '';

  if (weekend) {
    // Weekend mode — skip queue and 90-day plan, keep daily note and todos only
    const parts = [];
    if (dailyNote) parts.push(`## Today's Note\n${dailyNote}`);
    else if (previousNote) parts.push(`## Previous Note (${previousNote.date})\n${previousNote.content}`);
    if (todos && todos.active && todos.active.length > 0) {
      const personal = todos.active.filter(t => {
        const src = (t.source || '').toLowerCase();
        return !src.includes('ms ') && !src.includes('planner');
      });
      if (personal.length > 0) {
        parts.push(`## Personal Todos\n` + personal.slice(0, 8).map(t => `- ${t.text}`).join('\n'));
      }
    }
    if (vaultResults && vaultResults.length > 0) {
      parts.push(`## Relevant Vault Notes\n` +
        vaultResults.map(r => `### ${r.name}\n${r.excerpts.join('\n...\n')}`).join('\n\n')
      );
    }
    return (parts.join('\n\n---\n\n') || '(Weekend — no work context loaded)') + locationLine;
  }

  const parts = [];
  const diagnostics = [];

  // Queue — only for queue/general/standup intent
  if (['queue', 'general', 'standup'].includes(intent) && queueSummary && queueSummary.total > 0) {
    parts.push(`## Current Queue Status
- Total open tickets: ${queueSummary.total}
- At-risk (SLA < 2h): ${queueSummary.at_risk_count}
- Open P1/Critical: ${queueSummary.open_p1s}

${queueSummary.at_risk_tickets.length > 0 ? '### At-Risk Tickets\n' + queueSummary.at_risk_tickets.slice(0, 5).map(t =>
  `- ${t.ticket_key}: ${t.summary} (${t.sla_remaining_minutes ? Math.round(t.sla_remaining_minutes) + ' min remaining' : 'SLA unknown'}, assigned: ${t.assignee})`
).join('\n') : ''}`);
    diagnostics.push('queue: yes');
  } else if (['queue', 'general', 'standup'].includes(intent)) {
    parts.push('## Queue Status\nNo Jira data available yet.');
    diagnostics.push('queue: empty');
  } else {
    diagnostics.push('queue: skipped (intent: ' + intent + ')');
  }

  // Behavioural patterns from activity log
  try {
    const activity = require('./activity');
    const patternsBlock = activity.getPatternsContextBlock(7);
    if (patternsBlock) {
      parts.push(patternsBlock);
      diagnostics.push('patterns: ok');
    }
  } catch (e) {
    diagnostics.push('patterns: error');
  }

  // Daily note (today or previous as fallback)
  if (dailyNote) {
    parts.push(`## Today's Daily Note\n${dailyNote}`);
    diagnostics.push('daily: today');
  } else if (previousNote) {
    parts.push(`## Previous Daily Note (${previousNote.date})\n${previousNote.content}`);
    diagnostics.push(`daily: fallback ${previousNote.date}`);
  } else {
    diagnostics.push('daily: none');
  }

  if (standupContent) {
    parts.push(`## Standup Template\n${standupContent}`);
    diagnostics.push('standup: yes');
  } else {
    diagnostics.push('standup: none');
  }

  // Meeting prep — only for calendar/people/standup/general
  if (['calendar', 'people', 'standup', 'general'].includes(intent)) try {
    const meetingPrep = obsidian.getMeetingPrepContext(3);
    if (meetingPrep.length > 0) {
      let prepBlock = `## Upcoming Meetings (next 3 hours)`;
      for (const meeting of meetingPrep) {
        prepBlock += `\n### ${meeting.time} — ${meeting.subject}`;
        for (const person of meeting.people) {
          prepBlock += `\n**${person.name}** (${person.role})`;
          if (person.lastMeeting) prepBlock += ` — last 1-2-1: ${person.lastMeeting}`;
          if (person.notes) prepBlock += `\n${person.notes}`;
        }
      }
      parts.push(prepBlock);
      diagnostics.push(`meetingPrep: ${meetingPrep.length}`);
    }
  } catch (e) {
    diagnostics.push('meetingPrep: error');
  } else { diagnostics.push('meetingPrep: skipped'); }

  // Recent decisions from decision log
  try {
    const recentDecisions = obsidian.getRecentDecisions(14);
    if (recentDecisions.length > 0) {
      parts.push(`## Recent Decisions (last 14 days)\n` + recentDecisions.map(d => `- ${d.date}: ${d.text}`).join('\n'));
      diagnostics.push(`decisions: ${recentDecisions.length}`);
    }
  } catch (e) { diagnostics.push('decisions: error'); }

  // Todos from vault — grouped by hierarchy: 90-day plan > vault tasks > MS Planner/ToDo
  if (todos && todos.active && todos.active.length > 0) {
    const formatTask = t => `- ${t.text}${t.due_date ? ` (due: ${t.due_date})` : ''}`;

    // Split by source hierarchy
    const planTasks = todos.active.filter(t => (t.source || '').includes('Daily') && t.priority === 'high');
    const vaultTasks = todos.active.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('master') || (src.includes('daily') && t.priority !== 'high');
    });
    const msTasks = todos.active.filter(t => {
      const src = (t.source || '').toLowerCase();
      return src.includes('ms ') || src.includes('planner') || src.includes('todo');
    });

    let todoBlock = `## Active Tasks (${todos.active.length} total — hierarchy: 90-day plan → vault → MS Planner/ToDo)`;

    if (planTasks.length > 0) {
      todoBlock += `\n### Focus Today (from daily note)\n` + planTasks.slice(0, 8).map(formatTask).join('\n');
    }
    if (vaultTasks.length > 0) {
      todoBlock += `\n### Vault Tasks\n` + vaultTasks.slice(0, 10).map(formatTask).join('\n');
    }
    if (msTasks.length > 0) {
      todoBlock += `\n### MS Planner / ToDo\n` + msTasks.slice(0, 8).map(formatTask).join('\n');
    }

    parts.push(todoBlock);
    diagnostics.push(`todos: ${todos.active.length} (plan:${planTasks.length} vault:${vaultTasks.length} ms:${msTasks.length})`);
  } else {
    diagnostics.push('todos: none');
  }

  // 90-day plan — only for planning/standup/general
  if (['planning', 'standup', 'general'].includes(intent) && ninetyDayPlan) {
    let planBlock = `## 90-Day Plan — Day ${ninetyDayPlan.currentDay} of 90`;
    planBlock += `\n- Progress: ${ninetyDayPlan.totalDone}/${ninetyDayPlan.totalTasks} tasks complete`;
    planBlock += `\n- Next checkpoint: ${ninetyDayPlan.nextCheckpoint.label} (${ninetyDayPlan.daysToCheckpoint} working days away)`;
    if (ninetyDayPlan.overdueTasks.length > 0) {
      planBlock += `\n- Overdue: ${ninetyDayPlan.overdueTasks.length} tasks`;
      planBlock += '\n' + ninetyDayPlan.overdueTasks.slice(0, 5).map(t =>
        `  - Day ${t.day}: ${t.text}`
      ).join('\n');
    }
    if (ninetyDayPlan.todayTasks.length > 0) {
      planBlock += `\n### Today's 90-Day Tasks`;
      planBlock += '\n' + ninetyDayPlan.todayTasks.map(t =>
        `- [${t.status === 'x' ? 'x' : ' '}] ${t.text}`
      ).join('\n');
    }
    parts.push(planBlock);
    diagnostics.push(`90day: day ${ninetyDayPlan.currentDay}`);
  } else if (['planning', 'standup', 'general'].includes(intent)) {
    diagnostics.push('90day: none');
  } else {
    diagnostics.push('90day: skipped');
  }

  if (['inbox', 'general'].includes(intent)) try {
    const scanner = require('./inbox-scanner');
    const inbox = scanner.getFlaggedItems();
    if (inbox.items.length > 0) {
      const highItems = inbox.items.filter(i => i.urgency === 'high');
      const medItems = inbox.items.filter(i => i.urgency === 'medium');
      let inboxBlock = `## Inbox Triage (${inbox.items.length} flagged)`;
      if (highItems.length > 0) {
        inboxBlock += `\n### Urgent (${highItems.length}):\n` +
          highItems.map(i => `- **${i.from}**: ${i.subject} — ${i.summary}`).join('\n');
      }
      if (medItems.length > 0) {
        inboxBlock += `\n### This Week (${medItems.length}):\n` +
          medItems.map(i => `- **${i.from}**: ${i.subject} — ${i.summary}`).join('\n');
      }
      parts.push(inboxBlock);
      diagnostics.push(`inbox: ${inbox.items.length}`);
    } else {
      diagnostics.push('inbox: empty');
    }
  } catch (e) {
    diagnostics.push('inbox: unavailable');
  } else { diagnostics.push('inbox: skipped'); }

  if (['people', 'general'].includes(intent)) try {
    const upcoming121s = obsidian.getUpcoming121s(3);
    if (upcoming121s.length > 0) {
      const lines = upcoming121s.map(u =>
        `- ${u.name}: ${u.overdue ? '⚠️ OVERDUE (was ' + u.dueDate + ')' : 'due ' + u.dueDate + ' (' + u.daysUntil + ' day' + (u.daysUntil !== 1 ? 's' : '') + ')'}`
      );
      parts.push(`## Upcoming 1-2-1s\n${lines.join('\n')}`);
      diagnostics.push(`121s: ${upcoming121s.length}`);
    }
  } catch (e) { diagnostics.push('121s: error'); } else { diagnostics.push('121s: skipped'); }

  if (['wellbeing', 'general'].includes(intent) && locationContext) {
    parts.push(`## Location\n${locationContext}`);
    diagnostics.push('location: yes');
  }

  // Strava — only for wellbeing intent
  if (intent === 'wellbeing') try {
    const stravaService = require('./strava');
    if (stravaService.isConfigured() && stravaService.isAuthenticated()) {
      const activityCtx = await stravaService.getActivityContext();
      if (activityCtx) {
        parts.push(`## Today's Activity\n${activityCtx}`);
        diagnostics.push('strava: yes');
      } else {
        diagnostics.push('strava: no activity today');
      }
    }
  } catch (e) {
    diagnostics.push('strava: error');
  } else { diagnostics.push('strava: skipped'); }

  // Apple Health — only for wellbeing intent
  if (intent === 'wellbeing') try {
    const healthService = require('./health');
    const healthBlock = healthService.getHealthContextBlock();
    if (healthBlock) {
      parts.push(healthBlock);
      diagnostics.push('health: yes');
    }
  } catch (e) {
    diagnostics.push('health: error');
  } else { diagnostics.push('health: skipped'); }

  // OwnTracks — only for wellbeing/general
  if (['wellbeing', 'general'].includes(intent)) try {
    const locationService = require('./location');
    if (locationService.isConfigured()) {
      const locationBlock = await locationService.getLocationContextBlock();
      if (locationBlock) {
        parts.push(locationBlock);
        diagnostics.push('location: yes');
      }
    }
  } catch (e) {
    diagnostics.push('location: error');
  } else { diagnostics.push('owntracks: skipped'); }

  // Home Assistant — phone/presence/environment, for wellbeing/general
  if (['wellbeing', 'general'].includes(intent)) try {
    const haService = require('./ha');
    if (haService.isConfigured()) {
      const haBlock = await haService.getHaContextBlock();
      if (haBlock) {
        parts.push(haBlock);
        diagnostics.push('ha: yes');
      }
    }
  } catch (e) {
    diagnostics.push('ha: error');
  } else { diagnostics.push('ha: skipped'); }

  // Vault search results
  if (vaultResults && vaultResults.length > 0) {
    const vaultBlock = `## Relevant Vault Notes\n` +
      vaultResults.map(r =>
        `### ${r.name} (${r.path})\n${r.excerpts.join('\n...\n')}`
      ).join('\n\n');
    parts.push(vaultBlock);
    diagnostics.push(`vault: ${vaultResults.length} notes`);

    // Related notes — for each vault search result, find 1-2 related notes not already in results
    try {
      const seenPaths = new Set(vaultResults.map(r => r.path));
      const relatedAll = [];
      for (const result of vaultResults.slice(0, 2)) {
        const body = result.excerpts?.[0] || '';
        if (body.length < 20) continue;
        const related = await obsidian.searchVaultSemantic(body, 3);
        for (const r of (related || [])) {
          if (!seenPaths.has(r.path)) {
            seenPaths.add(r.path);
            relatedAll.push(r);
          }
        }
      }
      if (relatedAll.length > 0) {
        parts.push('## Related Vault Notes (connected context)\n' +
          relatedAll.slice(0, 3).map(r =>
            `### ${r.name}\n${r.excerpts?.[0]?.substring(0, 200) || ''}`
          ).join('\n\n')
        );
        diagnostics.push(`related: ${relatedAll.length}`);
      }
    } catch (e) {
      diagnostics.push('related: error');
    }
  }

  console.log('[Context] Sources:', diagnostics.join(', '));
  return parts.join('\n\n---\n\n');
}

// ── Post-response processing (shared by both backends) ──

// NOTE: does NOT save the assistant message — both callers already did, and
// saving here too put every reply in the history twice, which then fed back in
// as duplicated context on the next turn.
function handleResponse(conversationId, fullResponse) {
  const decisionRegex = /\[DECISION\]\s*(.*?)(?:\n|$)/g;
  let match;
  while ((match = decisionRegex.exec(fullResponse)) !== null) {
    db.saveDecision(conversationId, match[1].trim());
    try {
      obsidian.appendDecision(match[1].trim());
    } catch (e) {
      console.error('[AI] Failed to write decision to vault:', e.message);
    }
  }

  // [ADD TODO: text] — add to Master Todo inbox
  const todoRegex = /\[ADD TODO:\s*(.+?)\]/g;
  while ((match = todoRegex.exec(fullResponse)) !== null) {
    try {
      obsidian.addTodoFromChat(match[1].trim());
      console.log('[Chat] Auto-added todo:', match[1].trim());
    } catch (e) {
      console.error('[Chat] Failed to add todo:', e.message);
    }
  }

  // [MEETING NOTE: title] — save meeting note
  const meetingRegex = /\[MEETING NOTE:\s*(.+?)\]/g;
  while ((match = meetingRegex.exec(fullResponse)) !== null) {
    try {
      const title = match[1].trim();
      // Get last few messages as summary
      const history = db.getConversationHistory(conversationId, 6);
      const summary = history
        .filter(m => m.role === 'user')
        .map(m => `- ${m.content.substring(0, 120)}`)
        .join('\n');
      obsidian.saveMeetingNoteFromChat(title, summary);
      console.log('[Chat] Meeting note saved:', title);
      try { require('./activity').trackVaultWrite('meeting-note'); } catch {}
    } catch (e) {
      console.error('[Chat] Failed to save meeting note:', e.message);
    }
  }

  // [UPDATE PERSON: Name] — trigger person note update via IMP-04's endpoint
  // This is handled client-side — the marker is detected in ChatPanel and a
  // confirmation dialog is shown. Backend just logs it.
  const personRegex = /\[UPDATE PERSON:\s*(.+?)\]/g;
  while ((match = personRegex.exec(fullResponse)) !== null) {
    console.log('[Chat] Person update requested for:', match[1].trim());
    // Client-side handler in ChatPanel.jsx will detect this and show UI
  }
}

// ── Streaming via AI routing layer (Phase 3) ──
// ═══════════════════════════════════════════════════════
// Chat v2 — API-primary, Ollama fallback, proper routing
// ═══════════════════════════════════════════════════════

const { buildChatContext, getChatPolicy } = require('./chat-context-v2');

/**
 * Determine chat mode based on AI routing config.
 * Returns 'api' if OpenAI is available, 'local' otherwise.
 */
function _getChatMode() {
  const aiRouting = require('./ai-routing');
  const status = aiRouting.getStatus();
  if (status.openrouter?.enabled && status.openrouter?.configured && !status.openrouter?.throttled) {
    if (status.mode === 'hybrid' || status.mode === 'critical-only') return 'api';
  }
  return 'local';
}

/**
 * Tool use needs a provider that supports it. Anthropic is Tier 1 in ai-routing
 * and its SDK is already a dependency; OpenAI/OpenRouter/Ollama fall back to the
 * text-only path rather than pretending to have hands.
 */
function _toolsAvailable() {
  if (process.env.CHAT_TOOLS_ENABLED === 'false') return false;
  // ai-routing owns the choice: it honours AI_MODE and the daily call/token
  // budgets (a tools turn can be several API calls) and follows the same
  // OpenRouter-first preference as everything else. Null means no provider can
  // call tools, so chat runs as plain conversation.
  return Boolean(require('./ai-routing').getToolProvider('chat_sync'));
}

// Appended when tools are live. The bracket markers stay in the base prompt for
// the text-only providers, but with tools available they'd double-write — the
// model would call create_task AND emit [ADD TODO:], and handleResponse would
// add it a second time.
const TOOL_PROMPT = `

## Tools
You have tools. Use them rather than guessing or describing what you would do.
- Never state a queue figure, task, calendar entry or vault fact from memory — read it with a tool first.
- Never invent a task id. Call get_tasks before complete_task.
- When Nick commits to something, call create_task. Do NOT use the [ADD TODO: ...] marker while you have tools — it would create the task twice.
- draft_email_reply and schedule_focus_block only QUEUE work for approval. They send and book nothing. Say so plainly: tell him it's waiting for his approval, don't imply it's done.
- Act, then report in one or two sentences. Don't narrate each tool call.`;

/**
 * Build the system prompt with context.
 */
async function _buildChatPrompt(userMessage, mode, withTools = false) {
  const weekend = isWeekend();
  const basePrompt = weekend ? WEEKEND_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const { systemContext } = await buildChatContext(userMessage, { mode });
  return `${basePrompt}${withTools ? TOOL_PROMPT : ''}\n\n---\nCONTEXT:\n${systemContext}`;
}

/**
 * Run the tool-enabled turn. Returns null if tools aren't available or the loop
 * produced nothing, so callers can fall through to the normal path.
 */
async function _runWithTools(systemPrompt, messages, mode) {
  const chatTools = require('./chat-tools');
  const picked = require('./ai-routing').getToolProvider('chat_sync');
  if (!picked) return null;
  const policy = getChatPolicy(mode);

  const t0 = Date.now();
  const result = await picked.provider.chatWithTools(
    systemPrompt,
    messages,
    chatTools.toolDefinitions(),
    (name, input) => chatTools.execute(name, input),
    { maxTokens: policy.maxTokens, maxRounds: 5 }
  );

  try { require('./ai-routing').recordUsage(result.usage); } catch {}

  const ran = (result.toolCalls || []).map(c => c.name).join(', ');
  console.log(`[Chat] Tools via ${picked.name}: ${result.toolCalls?.length || 0} call(s)${ran ? ` (${ran})` : ''} in ${Date.now() - t0}ms`);
  return result.text ? result : null;
}

/**
 * Streaming chat — API-primary, Ollama fallback.
 * Uses SSE for OpenAI (works through most proxies), sync fallback for Ollama.
 */
async function streamChat(conversationId, userMessage, res, location = null) {
  db.saveMessage(conversationId, 'user', userMessage);
  try { require('./activity').trackChatMessage(userMessage); } catch {}

  const chatMode = _getChatMode();
  const policy = getChatPolicy(chatMode);
  const t0 = Date.now();
  // Build context and prompt using Chat Context v2. Built once and reused by
  // whichever path runs — the context block does vault retrieval, so building it
  // twice per turn is the expensive mistake here.
  const useTools = _toolsAvailable();
  const systemPrompt = await _buildChatPrompt(userMessage, chatMode, useTools);
  const history = db.getConversationHistory(conversationId, policy.maxHistory);

  const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

  console.log(`[Chat] Mode: ${chatMode}, context: ${Date.now() - t0}ms, ${messages.length} msgs`);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
  res.flushHeaders();

  // Send mode indicator to frontend
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ type: 'mode', mode: chatMode })}\n\n`);
  }

  // Tool-enabled turn first. Tools can't stream (the loop has to see each full
  // response before it can run anything), so the reply arrives as one chunk —
  // which for a two-sentence SARA answer is barely different from streaming it.
  if (useTools) {
    try {
      const toolResult = await _runWithTools(systemPrompt, messages, chatMode);
      if (toolResult) {
        for (const call of toolResult.toolCalls || []) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'tool', name: call.name })}\n\n`);
          }
        }
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'text', content: toolResult.text })}\n\n`);
        }
        db.saveMessage(conversationId, 'assistant', toolResult.text);
        handleResponse(conversationId, toolResult.text);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'done', provider: 'anthropic', tools: (toolResult.toolCalls || []).length })}\n\n`);
          res.end();
        }
        return;
      }
    } catch (e) {
      // Tool loop failed — fall through to the plain streaming path rather than
      // losing the turn. Nick still gets an answer, just without hands.
      console.warn('[Chat] Tool loop failed, falling back to plain chat:', e.message);
    }
  }

  // Route through AI provider (API-primary: OpenAI first, Ollama fallback)
  const aiProvider = require('./ai-provider');

  try {
    const result = await aiProvider.streamChat(systemPrompt, messages, res, {
      taskType: 'chat_stream',
      maxTokens: policy.maxTokens,
      contextWindow: 4096,
      temperature: policy.temperature,
    });

    const fullResponse = result.text || '';
    if (result.provider !== 'none') {
      console.log(`[Chat] Response via ${result.provider}${result.fallback ? ' (fallback)' : ''} in ${Date.now() - t0}ms`);
    }

    db.saveMessage(conversationId, 'assistant', fullResponse);
    handleResponse(conversationId, fullResponse);

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'done', provider: result.provider })}\n\n`);
      res.end();
    }
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
      res.end();
    }
  }
}

/**
 * Non-streaming chat — returns full response as JSON.
 * Fallback for environments that don't support SSE (Tailscale Funnel).
 */
async function syncChat(conversationId, userMessage, location = null) {
  const t0 = Date.now();
  db.saveMessage(conversationId, 'user', userMessage);
  try { require('./activity').trackChatMessage(userMessage); } catch {}

  const chatMode = _getChatMode();
  const policy = getChatPolicy(chatMode);

  const useTools = _toolsAvailable();
  const systemPrompt = await _buildChatPrompt(userMessage, chatMode, useTools);
  const history = db.getConversationHistory(conversationId, policy.maxHistory);
  const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

  console.log(`[Chat/Sync] Mode: ${chatMode}, context: ${Date.now() - t0}ms, ${messages.length} msgs`);

  if (useTools) {
    try {
      const toolResult = await _runWithTools(systemPrompt, messages, chatMode);
      if (toolResult) {
        db.saveMessage(conversationId, 'assistant', toolResult.text);
        handleResponse(conversationId, toolResult.text);
        return {
          conversationId,
          message: toolResult.text,
          provider: 'anthropic',
          mode: chatMode,
          tools: (toolResult.toolCalls || []).map(c => c.name),
        };
      }
    } catch (e) {
      console.warn('[Chat/Sync] Tool loop failed, falling back to plain chat:', e.message);
    }
  }

  // Route through AI provider (respects all routing/cost controls)
  const aiRouting = require('./ai-routing');
  const result = await aiRouting.runTask('chat_sync', {
    systemPrompt,
    messages,
    maxTokens: policy.maxTokens,
    temperature: policy.temperature,
  }, { timeout: chatMode === 'api' ? 30000 : 25000 });

  const fullResponse = result.text || '*[AI unavailable — try again later]*';
  console.log(`[Chat/Sync] Response via ${result.provider} in ${Date.now() - t0}ms (${fullResponse.length} chars)`);

  db.saveMessage(conversationId, 'assistant', fullResponse);
  handleResponse(conversationId, fullResponse);

  return {
    conversationId,
    message: fullResponse,
    provider: result.provider,
    mode: chatMode,
  };
}

module.exports = {
  isConfigured,
  streamChat,
  syncChat,
};
