// SARA State Engine — v1 (WS1-WP1).
//
// Protected principle: there is ONE SARA and ONE shared state model. This module
// is the single source of truth for runtime state. WS0 returned a placeholder
// literal; WS1 makes this a real engine: it assembles the one shared model from
// named domain inputs, derives SARA's briefing from that model, validates the
// result against the v1 contract, and exposes it over the existing /api path.
//
// Inputs are still seeded (hardcoded) — the engine and the contract are real;
// only the data source is not yet live, and that is surfaced honestly
// (`dataSource: 'seed'` at the root, `source: 'seed'` on every domain). Swapping
// seed.js providers for live readers later changes neither this engine nor the
// contract — that is the seam.
//
// CommonJS only (NEURO backend convention — no ESM).

const { CONTRACT, SCHEMA_VERSION, DOMAINS, DOMAIN_CONTRACTS, validate } = require('./contract');
const seed = require('./seed');
const ha = require('../telemetry/homeAssistant');
const stations = require('./stations');
const neuro = require('../integrations/neuroSnapshot');
const nova = require('../integrations/novaSnapshot');
const { deriveInference } = require('./inference');

const RUNTIME_LABEL = 'WS5-WP2';

// Current location is a situational input (not a domain). The seed reader is the
// honest fallback; WS3 lets the Home Assistant telemetry bridge feed it live when a
// location signal is present. The contract is unchanged — location stays the same
// shape whether it comes from HA or seed (that is the seam).
const LOCATION_PROVIDER = seed.location;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Derive SARA's confidence in the assembled model — real engine work, not a seeded
 * value. Confidence falls out of two honest signals: whether every domain is
 * contract-shaped, and whether inputs are live or still seeded. A malformed domain
 * (the same fault the invalid-model path surfaces) drops confidence to `low`, so
 * confidence and the existing degraded-health behaviour stay consistent.
 */
function deriveConfidence(domains, dataSource) {
  const malformed = DOMAINS.filter((name) => {
    const d = domains[name];
    return !isObject(d) || !DOMAIN_CONTRACTS[name].every((k) => k in d);
  });
  if (malformed.length) {
    const plural = malformed.length === 1 ? 'domain is' : 'domains are';
    return {
      source: 'derived',
      score: 0.3,
      level: 'low',
      rationale: `Model is degraded — ${malformed.join(', ')} ${plural} not contract-shaped.`,
      basis: ['domain-structure-incomplete'],
    };
  }
  if (dataSource !== 'neuro') {
    return {
      source: 'derived',
      score: 0.6,
      level: 'moderate',
      rationale: 'All domains are contract-shaped, but inputs are seeded (hardcoded), not live.',
      basis: ['contract-valid', 'inputs-seeded'],
    };
  }
  return {
    source: 'derived',
    score: 0.9,
    level: 'high',
    rationale: 'All domains are contract-shaped and sourced from live inputs.',
    basis: ['contract-valid', 'inputs-live'],
  };
}

function sourceFor(raw) {
  return raw ? neuro.NEURO_SOURCE : 'seed';
}

function trimText(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function titleFromItem(item, fallback = 'Untitled') {
  return (
    item?.label ||
    item?.title ||
    item?.summary ||
    item?.text ||
    item?.subject ||
    fallback
  );
}

function summariseQueueTicket(ticket) {
  const parts = [ticket.status, ticket.priority].filter(Boolean);
  if (typeof ticket.sla_remaining_minutes === 'number') {
    parts.push(`${ticket.sla_remaining_minutes}m SLA`);
  }
  return parts.join(' · ');
}

function mapQueueTicket(ticket) {
  return {
    key: ticket.ticket_key || ticket.key || ticket.id || 'UNKNOWN',
    summary: titleFromItem(ticket),
    assignee: ticket.assignee || 'Unassigned',
    slaMins: typeof ticket.sla_remaining_minutes === 'number' ? ticket.sla_remaining_minutes : null,
    take: summariseQueueTicket(ticket),
  };
}

function buildQueue(neuroData) {
  const raw = neuroData?.queue;
  if (!raw || !Array.isArray(raw.tickets)) {
    return {
      source: neuroData ? neuro.NEURO_SOURCE : 'seed',
      summary: neuroData
        ? 'Live queue feed is currently unavailable from NEURO.'
        : seed.queue().summary,
      open: 0,
      breaching: 0,
      sections: {
        act_now: [],
        today: [],
        watch: [],
      },
    };
  }

  const allTickets = raw.tickets.map(mapQueueTicket);
  const urgentKeys = new Set((raw.at_risk_tickets || []).map((ticket) => ticket.ticket_key || ticket.key || ticket.id));
  const actNow = allTickets.filter(
    (ticket) =>
      urgentKeys.has(ticket.key) ||
      (typeof ticket.slaMins === 'number' && ticket.slaMins <= 120)
  );
  const today = [];
  const watch = [];
  for (const ticket of allTickets) {
    if (actNow.some((candidate) => candidate.key === ticket.key)) continue;
    if (today.length < 4) today.push(ticket);
    else watch.push(ticket);
  }

  return {
    source: sourceFor(raw),
    summary: `${raw.total || allTickets.length} open, ${raw.at_risk_count || actNow.length} at risk, ${raw.open_p1s || 0} P1s.`,
    open: raw.total || allTickets.length,
    breaching: raw.at_risk_count || actNow.length,
    sections: {
      act_now: actNow,
      today,
      watch,
    },
  };
}

function buildFocus(neuroData) {
  const raw = neuroData?.focus;
  if (!raw) return seed.focus();

  const current = raw.nextAction || raw.primaryItem || raw.items?.[0] || null;
  const title = titleFromItem(current, 'No current action');
  const reason = trimText(
    current?.reason ||
      current?.why ||
      current?.explanation ||
      raw.sara?.summary ||
      raw.sara?.text ||
      raw.sara?.message ||
      raw.context?.summary,
    220
  );

  return {
    source: sourceFor(raw),
    summary: reason || title,
    current: current
      ? {
          id: current.focusItemId || current.id || current.key || current.ticket_key || 'focus-current',
          itemType: current.focusItemType || current.kind || current.type || null,
          title,
          reason,
          timeboxMins:
            current.timeboxMins ??
            current.durationMinutes ??
            current.estimateMinutes ??
            null,
          deferCount: Number(current.deferCount || 0),
        }
      : null,
    deferEscalation: [
      'You moved this once already. Name the real next move.',
      'This has slipped again. Clear ten minutes and finish the first step.',
      'You are avoiding this. Remove the blocker or re-scope it honestly.',
    ],
  };
}

function severityToStatus(severity) {
  if (severity === 'high') return 'slipping';
  if (severity === 'med') return 'watch';
  return 'solid';
}

function buildPeople(neuroData) {
  const raw = neuroData?.team;
  if (!raw || !Array.isArray(raw.perPerson)) return seed.people();

  const members = raw.perPerson.map((person) => {
    const issue = person.issues?.[0] || null;
    const severity = issue?.severity || 'low';
    return {
      name: person.name,
      role: person.team,
      metric: `${person.issues?.length || 0} live issue${person.issues?.length === 1 ? '' : 's'}`,
      status: severityToStatus(severity),
      flag: issue?.title || 'No active issue surfaced.',
    };
  });

  const needAttention = members.filter((member) => member.status !== 'solid').length;
  return {
    source: sourceFor(raw),
    summary:
      raw.filteredCount > 0
        ? `${raw.filteredCount} live team issue${raw.filteredCount === 1 ? '' : 's'} across ${raw.perPerson.length} people.`
        : 'No live team issues surfaced from NEURO.',
    members,
    meta: {
      counts: raw.counts || null,
      filteredCount: raw.filteredCount || members.length,
      severityFilter: raw.severityFilter || null,
      needAttention,
    },
  };
}

function buildVault(neuroData) {
  const capture = neuroData?.capture;
  const context = neuroData?.context;
  if (!capture && !context) return seed.vault();

  const picks = [];
  if (context?.dailyNote?.path || context?.dailyNote?.title || context?.date) {
    picks.push({
      title: context.dailyNote?.title || `Daily note — ${context.date || 'today'}`,
      reason: trimText(context.dailyNote?.summary || context.dailyNote?.path || 'Latest working context from NEURO.'),
      path: context.dailyNote?.path || context.dailyNote?.filePath || context.date || 'daily-note',
    });
  }

  for (const item of capture?.items || []) {
    if (picks.length >= 4) break;
    picks.push({
      title: item.title || item.filename || 'Capture',
      reason: trimText(item.preview || item.relativePath || 'Recent capture surfaced from NEURO.'),
      path: item.relativePath || item.filename || 'capture',
    });
  }

  if (!picks.length) return seed.vault();
  return {
    source: sourceFor(capture || context),
    summary: `${picks.length} live vault item${picks.length === 1 ? '' : 's'} surfaced from NEURO.`,
    picks,
  };
}

function buildPresentation(neuroData, domains) {
  const fallback = {
    source: 'placeholder',
    whatMattersNow: [
      {
        id: 'wmn-fallback-focus',
        title: domains.focus?.current?.title || 'Current focus unavailable',
        detail: domains.focus?.summary || 'SARA is using fallback focus context.',
        tone: 'attention',
      },
    ],
    upNext: [
      {
        id: 'next-fallback',
        time: 'Pending',
        label: domains.focus?.summary || 'No live runway available.',
      },
    ],
    quickActions: [
      { id: 'qa-capture', label: 'Capture', action: 'capture', icon: '✎' },
      { id: 'qa-queue', label: 'Open Queue', action: 'open-queue', icon: '▤' },
      { id: 'qa-focus', label: 'Start Focus', action: 'start-focus', icon: '◎' },
      { id: 'qa-brief', label: 'Daily Brief', action: 'daily-brief', icon: '☼' },
    ],
    standup: {
      source: 'placeholder',
      yesterday: [],
      carryForward: [],
      prompts: [
        'What changed since the last standup?',
        'What will move the queue or the team most today?',
        'What needs a direct follow-up from you?',
      ],
    },
    todos: { source: 'placeholder', items: [], candidates: [], todayLane: [] },
    capture: { source: 'placeholder', shortcuts: [], recent: [] },
  };

  const queue = neuroData?.queue;
  const focus = neuroData?.focus;
  const todos = neuroData?.todos;
  const context = neuroData?.context;
  const capture = neuroData?.capture;
  const email = neuroData?.email;
  const team = neuroData?.team;

  if (!queue && !focus && !todos && !context && !capture && !team && !email) return fallback;

  const whatMattersNow = [];
  for (const ticket of queue?.at_risk_tickets || []) {
    if (whatMattersNow.length >= 3) break;
    whatMattersNow.push({
      id: `wmn-ticket-${ticket.ticket_key || ticket.key || ticket.id}`,
      title: ticket.summary || ticket.ticket_key || 'At-risk ticket',
      detail: summariseQueueTicket(ticket) || 'Live queue issue surfaced from NEURO.',
      tone: 'urgent',
    });
  }
  const personIssue = team?.issues?.[0];
  if (personIssue) {
    whatMattersNow.push({
      id: `wmn-person-${personIssue.person}`,
      title: personIssue.person,
      detail: personIssue.title,
      tone: personIssue.severity === 'high' ? 'attention' : 'watch',
    });
  }
  if (focus?.nextAction || focus?.primaryItem) {
    const current = focus.nextAction || focus.primaryItem;
    whatMattersNow.push({
      id: 'wmn-focus',
      title: titleFromItem(current),
      detail: trimText(current.reason || current.why || focus.sara?.summary || 'Current NEURO priority.'),
      tone: 'attention',
    });
  }
  const urgentEmails = email?.urgent || [];
  if (urgentEmails.length) {
    const topEmail = urgentEmails[0];
    whatMattersNow.push({
      id: `wmn-email-${topEmail.id || 'urgent'}`,
      title: `${urgentEmails.length} urgent email${urgentEmails.length === 1 ? '' : 's'}`,
      detail: trimText(topEmail.subject || topEmail.reason || topEmail.from || 'Urgent inbox item.'),
      tone: 'urgent',
    });
  }

  const upNext = [];
  if (focus?.secondaryAction) {
    upNext.push({
      id: 'upnext-secondary',
      time: 'Next',
      label: titleFromItem(focus.secondaryAction),
    });
  }
  for (const task of context?.ninetyDayPlan?.todayTasks || []) {
    if (upNext.length >= 3) break;
    upNext.push({
      id: `upnext-plan-${task.lineNumber || upNext.length}`,
      time: 'Today',
      label: titleFromItem(task),
    });
  }
  if (!upNext.length && Array.isArray(context?.todos)) {
    for (const task of context.todos.slice(0, 3)) {
      upNext.push({
        id: `upnext-todo-${task.lineNumber || upNext.length}`,
        time: 'Soon',
        label: titleFromItem(task),
      });
    }
  }
  const replyEmails = email?.reply || [];
  if (replyEmails.length && upNext.length < 3) {
    upNext.push({
      id: 'upnext-email-reply',
      time: 'Inbox',
      label: `${replyEmails.length} email${replyEmails.length === 1 ? '' : 's'} need a reply`,
    });
  }

  const standupSections = {
    source: context?.standup ? neuro.NEURO_SOURCE : 'placeholder',
    yesterday: [],
    carryForward: [],
    prompts: [
      'What needs blocking time before lunch?',
      'Who needs a direct follow-up from you today?',
      'What should SARA surface again this afternoon?',
    ],
  };
  const standupText = typeof context?.standup === 'string' ? context.standup : '';
  const bulletMatches = [...standupText.matchAll(/^\s*-\s+\[?[ x>]\]?\s*(.+)$/gm)].map((match) => trimText(match[1], 120));
  standupSections.yesterday = bulletMatches.slice(0, 3);
  standupSections.carryForward = (context?.todos || [])
    .slice(0, 3)
    .map((item) => titleFromItem(item));

  const todoItems = (todos?.todos || [])
    .filter((item) => !item.done)
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      title: item.text,
      state: item.mustdo ? 'must-do' : item.priority || 'open',
      dueDate: item.due_date || null,
      source: item.source || null,
      filePath: item.filePath || null,
      lineNumber: item.lineNumber ?? null,
    }));
  const todoCandidates = (todos?.suggested || []).slice(0, 4).map((item) => ({
    id: item.id,
    title: item.text,
    detail: item.reason || 'Suggested from a note',
    confidence: item.confidence || 0,
    sourcePath: item.sourcePath || null,
  }));
  const todayLane = (todos?.todayLane || []).slice(0, 4).map((item) => ({
    id: item.id,
    title: item.text,
    detail: item.why || 'Must move today',
    moscow: item.moscow || null,
    context: item.context || null,
    dueDate: item.due_date || null,
  }));

  const recentCapture = (capture?.items || []).slice(0, 5).map((item, index) => ({
    id: `capture-recent-${index}`,
    title: item.title || item.filename || 'Capture',
    detail: trimText(item.preview || item.relativePath || 'Recent capture surfaced from NEURO.', 140),
    relativePath: item.relativePath || null,
    modified: item.modified || null,
  }));

  return {
    source: neuro.NEURO_SOURCE,
    whatMattersNow: whatMattersNow.length ? whatMattersNow : fallback.whatMattersNow,
    upNext: upNext.length ? upNext : fallback.upNext,
    quickActions: fallback.quickActions,
    standup: standupSections,
    email: {
      source: email ? neuro.NEURO_SOURCE : 'placeholder',
      available: email ? email.available !== false : false,
      detail: email?.detail || null,
      urgentCount: urgentEmails.length,
      replyCount: replyEmails.length,
      urgent: urgentEmails.slice(0, 5).map((item, index) => ({
        id: item.id || `urgent-${index}`,
        subject: item.subject || 'Urgent email',
        from: item.from || item.fromEmail || 'Unknown sender',
        reason: item.reason || '',
        isRead: Boolean(item.isRead),
      })),
      reply: replyEmails.slice(0, 8).map((item, index) => ({
        id: item.id || `reply-${index}`,
        subject: item.subject || 'Needs reply',
        from: item.from || item.fromEmail || 'Unknown sender',
        reason: item.reason || '',
        isRead: Boolean(item.isRead),
      })),
    },
    todos: {
      source: todoItems.length || todoCandidates.length || todayLane.length ? neuro.NEURO_SOURCE : 'placeholder',
      items: todoItems.length ? todoItems : fallback.todos.items,
      candidates: todoCandidates,
      todayLane,
    },
    capture: {
      source: recentCapture.length ? neuro.NEURO_SOURCE : 'placeholder',
      shortcuts: [
        { id: 'cap-note', label: 'Quick note', detail: 'Writes to NEURO capture inbox.' },
        { id: 'cap-todo', label: 'Todo', detail: 'Creates a real task through NEURO capture.' },
      ],
      recent: recentCapture,
    },
  };
}

// Process start — stable across requests so consumers can read uptime.
const startedAt = new Date().toISOString();

/**
 * Derive SARA's briefing line from the assembled domains. This is real work the
 * engine does over the model — not a hardcoded sentence — so the headline always
 * reflects current domain data. When the providers go live, the briefing follows.
 */
function buildBriefing(domains) {
  const parts = [];
  if (domains.queue.breaching > 0) {
    const n = domains.queue.breaching;
    parts.push(`${n} ${n === 1 ? 'ticket is' : 'tickets are'} breaching SLA.`);
  }
  const slipping = domains.people.members.find((m) => m.status === 'slipping');
  if (slipping) parts.push(`${slipping.name} is slipping — ${slipping.flag}.`);
  if (domains.focus.current) parts.push(`Start with: ${domains.focus.current.title}.`);
  const line = parts.length
    ? parts.join(' ')
    : 'Queue is calm. Pick the highest-leverage thing and start.';
  return { line, derivedFrom: ['queue', 'people', 'focus'] };
}

// Work zones — HA zone names (the iPhone person/device_tracker reports its zone as the
// state) that mean "Nick is at work". Configurable; matched case-insensitively as a
// substring so "Office", "Wilmslow Office", "Nurtur Work" all resolve to 'work'.
const WORK_ZONES = (process.env.SARA_WORK_ZONES || 'work,office')
  .split(',')
  .map((z) => z.trim().toLowerCase())
  .filter(Boolean);

// Map a context label off the HA location zone, so a screen reading location stays
// the same shape it always was. Display/representation only — no decision is taken.
// 'work' (from the iPhone's HA work zone) is what drives Mission Control's Eyes-On mode.
function locationContext(zone) {
  if (zone === 'home') return 'home';
  if (zone === 'not_home') return 'away';
  const z = String(zone || '').toLowerCase();
  if (WORK_ZONES.some((w) => z.includes(w))) return 'work';
  return 'elsewhere';
}

/**
 * Build the situational `location` block — two tiers:
 *   zone    (Tier 1, coarse GPS)     — Home / Work / elsewhere, from the HA telemetry
 *                                       bridge (device_tracker / person), else seed.
 *   station (Tier 2, fine proximity) — at desk / living-room / driving, from whichever
 *                                       TERMINAL currently sees you (stations registry).
 * Top-level `label`/`context`/`source` are preserved for existing consumers: they prefer
 * the live station when one is active (the most specific truth — "you're at the living
 * room screen"), else fall back to the GPS zone, else the seed. HA/station being absent
 * can never break a consumer; it only changes which tier supplies the headline.
 */
function buildLocation(telemetry) {
  const loc = telemetry.available ? telemetry.signals.location : null;

  // Tier 1 — zone (GPS via HA, else seeded fallback).
  let zone;
  if (loc && loc.label) {
    zone = {
      source: ha.TELEMETRY_SOURCE,
      label: loc.label,
      context: locationContext(loc.zone),
      since: telemetry.polledAt,
      entityId: loc.entityId,
    };
  } else {
    const seeded = LOCATION_PROVIDER();
    zone = {
      source: seeded.source || 'seed',
      label: seeded.label,
      context: seeded.context || 'elsewhere',
      since: seeded.since || null,
      telemetry: 'fallback',
    };
  }

  // Tier 2 — station (the active terminal, if any currently sees you).
  const act = stations.active();
  const station = act
    ? {
        name: act.station,
        present: true,
        source: act.source,
        rssi: act.rssi,
        since: act.reportedAt,
      }
    : null;

  // Headline fields: most specific wins. Station (you're physically AT a device) beats
  // the GPS zone. Both feed a human summary.
  const label = station ? station.name : zone.label;
  const source = station ? `terminal:${station.source}` : zone.source;
  const summary = station
    ? `You're at ${station.name}${zone.label ? ` (${zone.label})` : ''}.`
    : `${zone.label}.`;

  return {
    source,
    label,
    context: zone.context,
    since: station ? station.since : zone.since,
    summary,
    zone,
    station,
  };
}

// Shape the cached HA snapshot into the model's telemetry block. Read-only: the engine
// never asks HA to decide anything, it only surfaces what HA reported and how stale it
// is. `ageMs` lets a consumer judge freshness without owning its own clock.
function buildTelemetry(telemetry) {
  return {
    source: telemetry.source,
    available: telemetry.available,
    reason: telemetry.reason || null,
    detail: telemetry.detail || null,
    polledAt: telemetry.polledAt || null,
    ageMs: telemetry.polledAt ? Date.now() - Date.parse(telemetry.polledAt) : null,
    signals: telemetry.signals,
  };
}

function humaniseNovaAction(t) {
  if (t === 'draft_response') return 'AI drafted a reply — approve or edit.';
  if (t === 'escalate') return 'AI wants to escalate — confirm.';
  if (t === 'gather_context') return 'AI needs more context before acting.';
  return 'Needs your review.';
}

/**
 * Shape the cached NOVA snapshot into model.nova with a "needs Nick's eyes on" slant.
 * This is an INTEGRATION block (like model.neuro / model.telemetry), not a contract
 * DOMAIN — so it never affects validation or confidence. The slant is an exception/
 * decision queue: pending AI approvals (escalations + low-confidence first), overdue
 * customers, and queue-health warnings. Healthy/green signals are suppressed to an
 * "all clear" flag rather than surfaced as items. Absent NOVA -> honest available:false.
 */
function buildNova(snapshot) {
  if (!snapshot || !snapshot.available) {
    return {
      source: nova.NOVA_SOURCE,
      available: false,
      reason: snapshot ? snapshot.reason : 'not-configured',
      detail: snapshot ? snapshot.detail : null,
      polledAt: snapshot ? snapshot.polledAt : null,
      eyesOn: { headline: 'NOVA not connected.', items: [], stats: null, allClear: false },
    };
  }

  const ap = snapshot.data?.approvals?.data || {};
  const apItems = ap.items || []; // /api/approvals returns { data: { items: [...] } }
  const breached = snapshot.data?.breached?.data || []; // public SLA breach board (per agent)
  const items = [];

  // Pending AI approvals — each a decision waiting on Nick. Escalations and low-confidence
  // drafts most need a human, so they carry higher priority and sort to the top.
  for (const a of apItems) {
    const escalate = a.action_type === 'escalate';
    const lowConf = typeof a.confidence === 'number' && a.confidence < 0.7;
    items.push({
      id: `approval-${a.decision_id || a.ticket_id}`,
      kind: 'approval',
      priority: escalate ? 3 : lowConf ? 2 : 1,
      title: a.ticket_summary || a.ticket_id || 'Pending approval',
      detail: humaniseNovaAction(a.action_type),
      ticketId: a.ticket_id || null,
      assignee: a.assignee_name || null,
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
      ageMins: a.created_at ? Math.round((Date.now() - Date.parse(a.created_at)) / 60000) : null,
    });
  }

  // Overdue — tickets past the 2h response window, summed across NOVA's SLA breach board.
  const overdue = breached.reduce((s, r) => s + (Number(r.OpenTickets_Over2Hours) || 0), 0);
  const worstOldestDays = breached.reduce((m, r) => Math.max(m, Number(r.OldestTicketDays) || 0), 0);
  if (overdue > 0) {
    items.push({
      id: 'overdue-tickets',
      kind: 'overdue',
      priority: overdue >= 20 ? 3 : 2,
      title: `${overdue} customer${overdue === 1 ? '' : 's'} overdue response`,
      detail: 'Customers are waiting beyond the response target.',
      count: overdue,
    });
  }
  // A standout long-running ticket is worth its own line.
  if (worstOldestDays >= 14) {
    items.push({
      id: 'worst-oldest',
      kind: 'overdue',
      priority: worstOldestDays >= 60 ? 3 : 1,
      title: `Oldest overdue customer: ${worstOldestDays} days`,
      detail: 'A long-running customer wait that may need a push.',
      oldestDays: worstOldestDays,
    });
  }

  // Queue health: pending approvals, and how many are past their decision deadline.
  const pending = apItems.length;
  const timedOut = apItems.filter((a) => a.expires_at && Date.parse(a.expires_at) < Date.now()).length;

  items.sort((x, y) => y.priority - x.priority);

  const allClear = items.length === 0;
  const headlineParts = [];
  if (pending) headlineParts.push(`${pending} approval${pending === 1 ? '' : 's'} waiting`);
  if (overdue) headlineParts.push(`${overdue} overdue`);

  return {
    source: nova.NOVA_SOURCE,
    available: true,
    reason: snapshot.reason || null,
    polledAt: snapshot.polledAt,
    eyesOn: {
      headline: allClear ? 'Nothing needs your eyes right now.' : headlineParts.join(' · '),
      items,
      stats: {
        approvalsPending: pending,
        approvalsTimedOut: timedOut,
        customersOverdue: overdue,
        worstOldestDays,
      },
      allClear,
    },
  };
}

/**
 * Assemble the single shared runtime model from the domain providers, derive the
 * briefing, fold in Home Assistant telemetry, and self-validate against the contract.
 * @returns {object} the assembled model (carries meta.valid / meta.errors)
 */
function buildModel() {
  const neuroSnapshot = neuro.getSnapshot();
  const neuroData = neuroSnapshot.available ? neuroSnapshot.data : null;
  const domains = {
    queue: buildQueue(neuroData),
    focus: buildFocus(neuroData),
    people: buildPeople(neuroData),
    vault: buildVault(neuroData),
  };

  // Read the latest cached HA telemetry snapshot. This is synchronous and never
  // throws — an absent/unreachable HA yields an honest `available: false` snapshot,
  // so model assembly is never blocked or broken by telemetry.
  const telemetry = ha.getTelemetry();

  const seedCount = DOMAINS.filter((name) => domains[name]?.source === 'seed').length;
  const dataSource = seedCount === DOMAINS.length ? 'seed' : seedCount > 0 ? 'mixed' : 'neuro';
  const model = {
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    runtime: RUNTIME_LABEL,
    dataSource,
    generatedAt: new Date().toISOString(),
    startedAt,
    sara: {
      name: 'SARA',
      status: 'online',
      note: 'State Engine contract is live. SARA prefers real NUERO-backed runtime data, falls back honestly when an upstream source is unavailable, and never lets screens own their own truth.',
    },
    location: buildLocation(telemetry),
    telemetry: buildTelemetry(telemetry),
    neuro: {
      source: neuroSnapshot.source,
      available: neuroSnapshot.available,
      reason: neuroSnapshot.reason,
      detail: neuroSnapshot.detail,
      polledAt: neuroSnapshot.polledAt,
      errors: neuroSnapshot.errors,
    },
    nova: buildNova(nova.getSnapshot()),
    confidence: deriveConfidence(domains, dataSource),
    briefing: buildBriefing(domains),
    domains,
  };
  model.presentation = buildPresentation(neuroData, domains);

  // Context inference (WS5-WP1). Derived AFTER the rest of the model is assembled, from
  // the same inputs the model already carries — so inference extends the one shared
  // model rather than owning a parallel state. It is advisory: it recommends a view but
  // never selects one, and telemetry is just one of its inputs (HA stays a bus).
  model.inference = deriveInference({
    domains: model.domains,
    telemetry: model.telemetry,
    location: model.location,
  });

  const { valid, errors } = validate(model);
  model.meta = { valid, errors, domainCount: DOMAINS.length };
  return model;
}

/**
 * Return the current shared state model (assembled fresh, validated, stamped).
 */
function getState() {
  return { ...buildModel(), servedAt: new Date().toISOString() };
}

/**
 * Health view derived from the SAME model, so health and state can never disagree
 * about whether SARA is up or whether the model is contract-valid. Reports
 * `degraded` if the engine produced a model that fails its own contract.
 */
function getHealth() {
  const model = buildModel();
  return {
    status: model.meta.valid ? 'ok' : 'degraded',
    sara: model.sara.status,
    runtime: model.runtime,
    contract: model.contract,
    schemaVersion: model.schemaVersion,
    dataSource: model.dataSource,
    valid: model.meta.valid,
    location: model.location.label,
    locationSource: model.location.source,
    confidence: { level: model.confidence.level, score: model.confidence.score },
    // Same telemetry verdict the state model carries, so health and state can never
    // disagree about whether Home Assistant telemetry is live or unavailable.
    telemetry: {
      source: model.telemetry.source,
      available: model.telemetry.available,
      reason: model.telemetry.reason,
      polledAt: model.telemetry.polledAt,
    },
    neuro: {
      available: model.neuro.available,
      reason: model.neuro.reason,
      polledAt: model.neuro.polledAt,
    },
    // Same inference verdict the state model carries (WS5-WP1) — advisory only. Health
    // reports the inferred activity, the recommended view, and confidence so operators
    // can see what SARA inferred without parsing the full model. It is a read-only echo;
    // health takes no action on it.
    inference: {
      activity: model.inference.activity,
      recommendedView: model.inference.recommendedView,
      advisory: model.inference.advisory,
      confidence: { level: model.inference.confidence.level, score: model.inference.confidence.score },
    },
    startedAt: model.startedAt,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { getState, getHealth, buildModel, RUNTIME_LABEL };
