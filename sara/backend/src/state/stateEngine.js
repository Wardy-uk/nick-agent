// SARA State Engine — v1 (WS1-WP1).
//
// Protected principle: there is ONE SARA and ONE shared state model, and NEURO is the
// canonical brain behind it. This module assembles that one model from NEURO's data,
// derives SARA's briefing from it, validates the result against the v1 contract, and
// exposes it over /api/state.
//
// ⚠ It used to fall back to `seed.js` — hardcoded, invented content — whenever NEURO
// was unreachable, which made an outage look identical to a working day. It no longer
// does. A domain SARA could not read is rendered `unavailable`: contract-shaped,
// structurally empty, and carrying a sentence saying what could not be seen. Seeded
// content is reachable ONLY under SARA_DEMO_MODE, is stamped `demo` end to end, and is
// refused outright under NODE_ENV=production. See state/provenance.js.
//
// CommonJS only (NEURO backend convention — no ESM).

const { CONTRACT, SCHEMA_VERSION, DOMAINS, DOMAIN_CONTRACTS, validate } = require('./contract');
const seed = require('./seed');
const ha = require('../telemetry/homeAssistant');
const stations = require('./stations');
const neuro = require('../integrations/neuroSnapshot');
const neuroConfig = require('../integrations/neuroConfig');
const nova = require('../integrations/novaSnapshot');
const provenance = require('./provenance');
const { deriveInference } = require('./inference');

const RUNTIME_LABEL = 'WS5-WP2';

// Current location is a situational input (not a domain). Live it comes from the Home
// Assistant telemetry bridge; with no HA signal it is UNKNOWN, not a seeded office.
// The seeded reader survives for demo mode only.
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
  // ⚠ Confidence is capped by PROVENANCE, not just by shape. A model assembled
  // entirely out of "we could not read this" is perfectly contract-shaped, and calling
  // that high confidence is precisely how an outage came to look like a calm day.
  if (dataSource === provenance.SOURCE.DEMO) {
    return {
      source: 'derived',
      score: 0.1,
      level: 'low',
      rationale: 'Demo mode — every domain is invented content, not Nick\'s real state.',
      basis: ['demo-mode'],
    };
  }
  if (dataSource === provenance.SOURCE.UNAVAILABLE) {
    return {
      source: 'derived',
      score: 0.1,
      level: 'low',
      rationale: 'No domain could be read from NEURO. Nothing on screen is current.',
      basis: ['inputs-unavailable'],
    };
  }
  if (dataSource === provenance.SOURCE.STALE) {
    return {
      source: 'derived',
      score: 0.5,
      level: 'moderate',
      rationale: 'Domains are NEURO data, but from an earlier poll — NEURO is not answering now.',
      basis: ['contract-valid', 'inputs-stale'],
    };
  }
  if (dataSource !== provenance.SOURCE.LIVE) {
    return {
      source: 'derived',
      score: 0.6,
      level: 'moderate',
      rationale: 'Some domains are live from NEURO and some could not be read at all.',
      basis: ['contract-valid', 'inputs-partial'],
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

/**
 * The provenance stamp for a domain that DID get data. `stale` is carried through
 * from the snapshot rather than re-derived, so the domain and the connection banner
 * can never disagree about whether what is on screen is current.
 */
function sourceFor(raw, ctx) {
  if (!raw) return provenance.SOURCE.UNAVAILABLE;
  return ctx?.stale ? provenance.SOURCE.STALE : neuro.NEURO_SOURCE;
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

function buildQueue(neuroData, ctx = {}) {
  const raw = neuroData?.queue;

  // No NEURO at all. This used to return `seed.queue()` — two invented breaching
  // tickets, named against real colleagues, on the exact day the feed died.
  if (!neuroData) {
    if (ctx.demoMode) return { ...seed.queue(), source: provenance.SOURCE.DEMO };
    return provenance.unavailableQueue(ctx.detail);
  }

  // NEURO answered but the queue payload is unusable. ⚠ NEURO DELETED its Jira queue
  // feature in July 2026, so this is now the NORMAL path, not an exception — and it
  // must stay `unavailable` rather than a confident zero, because a screen reading
  // "0 breaching" from a feed that no longer exists is the same lie as the seed was.
  if (!raw || !Array.isArray(raw.tickets)) {
    return provenance.unavailableQueue(
      'NEURO served no queue feed. NEURO retired its Jira queue in July 2026 — escalations are tracked live instead.'
    );
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
    source: sourceFor(raw, ctx),
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

function buildFocus(neuroData, ctx = {}) {
  const raw = neuroData?.focus;
  if (!raw) {
    if (ctx.demoMode) return { ...seed.focus(), source: provenance.SOURCE.DEMO };
    return provenance.unavailableFocus(ctx.detail);
  }

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
    source: sourceFor(raw, ctx),
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

function buildPeople(neuroData, ctx = {}) {
  const raw = neuroData?.team;
  if (!raw || !Array.isArray(raw.perPerson)) {
    // ⚠ The seeded people block named four real reports and asserted one of them was
    // "going quiet". Inventing a performance concern about a named colleague is the
    // single worst thing this fallback could do, and it did it on every outage.
    if (ctx.demoMode) return { ...seed.people(), source: provenance.SOURCE.DEMO };
    return provenance.unavailablePeople(ctx.detail);
  }

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
    source: sourceFor(raw, ctx),
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

function buildVault(neuroData, ctx = {}) {
  const capture = neuroData?.capture;
  const context = neuroData?.context;
  if (!capture && !context) {
    if (ctx.demoMode) return { ...seed.vault(), source: provenance.SOURCE.DEMO };
    return provenance.unavailableVault(ctx.detail);
  }

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

  // NEURO answered and there was genuinely nothing to surface. That is a real,
  // different fact from "we could not look", so it says so rather than borrowing the
  // seed's two invented notes.
  if (!picks.length) {
    return {
      source: sourceFor(capture || context, ctx),
      summary: 'NEURO surfaced no vault items worth showing right now.',
      picks: [],
    };
  }
  return {
    source: sourceFor(capture || context, ctx),
    summary: `${picks.length} live vault item${picks.length === 1 ? '' : 's'} surfaced from NEURO.`,
    picks,
  };
}

// Quick Actions are UI AFFORDANCES, not data: four buttons that do real things in
// this app. They are the one part of `presentation` that is legitimately static, and
// they stay available even with NEURO down — Capture in particular, which is the whole
// point of a kiosk you can talk at when the rest is broken.
const QUICK_ACTIONS = [
  { id: 'qa-capture', label: 'Capture', action: 'capture', icon: '✎' },
  { id: 'qa-queue', label: 'Open Queue', action: 'open-queue', icon: '▤' },
  { id: 'qa-focus', label: 'Start Focus', action: 'start-focus', icon: '◎' },
  { id: 'qa-brief', label: 'Daily Brief', action: 'daily-brief', icon: '☼' },
];

const CAPTURE_SHORTCUTS = [
  { id: 'cap-note', label: 'Quick note', detail: 'Writes to NEURO\'s capture inbox.' },
  { id: 'cap-todo', label: 'Todo', detail: 'Creates a real task through NEURO capture.' },
];

function buildPresentation(neuroData, domains, ctx = {}) {
  // The honest empty presentation. ⚠ Every list here is EMPTY and carries a notice.
  // The old version manufactured a "What Matters Now" card and an "Up Next" row out of
  // whatever fallback focus text was lying around, so a dead feed rendered as a
  // populated dashboard. A screen with nothing in it and a reason why is the product.
  const unavailable = {
    source: provenance.SOURCE.UNAVAILABLE,
    available: false,
    notice: ctx.detail || 'SARA could not read anything from NEURO. This is not an all-clear.',
    whatMattersNow: [],
    upNext: [],
    quickActions: QUICK_ACTIONS,
    standup: { source: provenance.SOURCE.UNAVAILABLE, yesterday: [], carryForward: [], prompts: [] },
    email: {
      source: provenance.SOURCE.UNAVAILABLE,
      available: false,
      detail: null,
      urgentCount: null,
      replyCount: null,
      urgent: [],
      reply: [],
    },
    todos: { source: provenance.SOURCE.UNAVAILABLE, items: [], candidates: [], todayLane: [] },
    capture: { source: provenance.SOURCE.UNAVAILABLE, shortcuts: CAPTURE_SHORTCUTS, recent: [] },
  };

  const queue = neuroData?.queue;
  const focus = neuroData?.focus;
  const todos = neuroData?.todos;
  const context = neuroData?.context;
  const capture = neuroData?.capture;
  const email = neuroData?.email;
  const team = neuroData?.team;

  if (!queue && !focus && !todos && !context && !capture && !team && !email) {
    if (ctx.demoMode) return { ...unavailable, source: provenance.SOURCE.DEMO, available: false, notice: 'DEMO DATA — invented content.' };
    return unavailable;
  }

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

  // The prompts are SARA's own questions, not data about Nick, so they stand whatever
  // NEURO says. `source` still tells the truth about the yesterday/carry-forward lists
  // underneath them.
  const standupSections = {
    source: context?.standup ? sourceFor(context, ctx) : provenance.SOURCE.UNAVAILABLE,
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
    source: sourceFor(neuroData, ctx),
    available: true,
    // ⚠ An empty live list stays EMPTY. It used to fall back to the manufactured
    // card above, so "NEURO says nothing is pressing" and "SARA has no idea" rendered
    // as the same populated row — the exact conflation this whole pass removes.
    notice: whatMattersNow.length ? null : 'NEURO surfaced nothing pressing right now.',
    whatMattersNow,
    upNext,
    quickActions: QUICK_ACTIONS,
    standup: standupSections,
    email: {
      source: email ? sourceFor(email, ctx) : provenance.SOURCE.UNAVAILABLE,
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
      // `todos` answered, so the source is NEURO whether or not it had rows — an
      // empty task list is a real answer and must not read as a missing feed.
      source: todos ? sourceFor(todos, ctx) : provenance.SOURCE.UNAVAILABLE,
      items: todoItems,
      candidates: todoCandidates,
      todayLane,
    },
    capture: {
      source: capture ? sourceFor(capture, ctx) : provenance.SOURCE.UNAVAILABLE,
      shortcuts: CAPTURE_SHORTCUTS,
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
  const slipping = (domains.people.members || []).find((m) => m.status === 'slipping');
  if (slipping) parts.push(`${slipping.name} is slipping — ${slipping.flag}.`);
  if (domains.focus.current) parts.push(`Start with: ${domains.focus.current.title}.`);
  if (parts.length) return { line: parts.join(' '), derivedFrom: ['queue', 'people', 'focus'] };

  // ⚠ Nothing to say is TWO different facts and the old code collapsed them into
  // one reassuring sentence. "Queue is calm" said while SARA cannot see the queue is
  // the single most misleading line the system could produce, and during an outage it
  // was the only line it produced.
  const unread = DOMAINS.filter((name) => domains[name]?.source === provenance.SOURCE.UNAVAILABLE);
  if (unread.length === DOMAINS.length) {
    return {
      line: 'SARA cannot read anything from NEURO right now, so it cannot tell you what matters. This is not an all-clear.',
      derivedFrom: [],
      unread,
    };
  }
  if (unread.length) {
    return {
      line: `Nothing pressing in what SARA can see — but ${unread.join(', ')} could not be read, so this is a partial picture.`,
      derivedFrom: DOMAINS.filter((name) => !unread.includes(name)),
      unread,
    };
  }
  return {
    line: 'Nothing is pressing. Pick the highest-leverage thing and start.',
    derivedFrom: ['queue', 'people', 'focus'],
    unread: [],
  };
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
function buildLocation(telemetry, ctx = {}) {
  const loc = telemetry.available ? telemetry.signals.location : null;

  // Tier 1 — zone (GPS via HA). ⚠ With no HA signal the answer is UNKNOWN, not a
  // seeded office: "On-site at the Little Eaton office since 08:40" is a specific,
  // checkable claim about where Nick is, and SARA was making it from a literal.
  let zone;
  if (loc && loc.label) {
    zone = {
      source: ha.TELEMETRY_SOURCE,
      label: loc.label,
      context: locationContext(loc.zone),
      since: telemetry.polledAt,
      entityId: loc.entityId,
    };
  } else if (ctx.demoMode) {
    const seeded = LOCATION_PROVIDER();
    zone = {
      source: provenance.SOURCE.DEMO,
      label: seeded.label,
      context: seeded.context || 'elsewhere',
      since: seeded.since || null,
      telemetry: 'demo',
    };
  } else {
    zone = {
      source: provenance.SOURCE.UNAVAILABLE,
      label: 'Location unknown',
      context: 'unknown',
      since: null,
      telemetry: 'unavailable',
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
function buildModel(options = {}) {
  const env = options.env || process.env;
  const readiness = neuroConfig.readiness(env);
  const neuroSnapshot = neuro.getSnapshot();
  const neuroData = neuroSnapshot.available ? neuroSnapshot.data : null;

  // ONE context object carries provenance into every builder, so a domain, the
  // presentation block and the connection banner cannot disagree about whether what
  // is on screen is live, stale, missing or invented.
  const ctx = {
    demoMode: readiness.demoMode,
    stale: Boolean(neuroSnapshot.stale),
    detail: neuroData
      ? null
      : readiness.demoMode
        ? 'Demo mode — invented content.'
        : !readiness.ready
          ? readiness.problems.join(' ')
          : neuroSnapshot.detail || 'NEURO is not answering.',
  };

  const domains = {
    queue: buildQueue(neuroData, ctx),
    focus: buildFocus(neuroData, ctx),
    people: buildPeople(neuroData, ctx),
    vault: buildVault(neuroData, ctx),
  };

  // Read the latest cached HA telemetry snapshot. This is synchronous and never
  // throws — an absent/unreachable HA yields an honest `available: false` snapshot,
  // so model assembly is never blocked or broken by telemetry.
  const telemetry = ha.getTelemetry();

  const domainSources = DOMAINS.reduce((acc, name) => ({ ...acc, [name]: domains[name]?.source }), {});
  const dataSource = provenance.rollUp(domainSources);
  const neuroAge = provenance.ageLabel(neuroSnapshot.ageMs);
  const provenanceBlock = {
    // One word for the whole model, and it is the word the UI banner renders.
    // ⚠ A stale CONNECTION outranks the domain roll-up. Staleness is a fact about the
    // link to NEURO, not about which domains happened to answer — and with the queue
    // endpoint permanently retired the roll-up is "mixed" on a good day, so letting it
    // win would hide "NEURO stopped answering four minutes ago" behind "partly live".
    state: readiness.demoMode
      ? provenance.SOURCE.DEMO
      : neuroSnapshot.stale
        ? provenance.SOURCE.STALE
        : dataSource,
    demoMode: readiness.demoMode,
    domains: domainSources,
    neuro: {
      configured: readiness.baseUrlConfigured,
      ready: readiness.ready,
      // Non-sensitive throughout: WHERE and WHETHER, never the credential itself.
      baseUrl: readiness.baseUrl,
      credentialConfigured: readiness.credentialConfigured,
      credentialKind: readiness.credentialKind,
      problems: readiness.problems,
      snapshotState: neuroSnapshot.state,
      available: neuroSnapshot.available,
      stale: Boolean(neuroSnapshot.stale),
      reason: neuroSnapshot.reason,
      detail: neuroSnapshot.detail,
      polledAt: neuroSnapshot.polledAt,
      ageMs: neuroSnapshot.ageMs ?? null,
      ageLabel: neuroAge,
    },
  };
  provenanceBlock.message = provenance.describe({
    state: provenanceBlock.state,
    demoMode: readiness.demoMode,
    neuro: { configured: readiness.baseUrlConfigured, ageLabel: neuroAge },
  });

  const model = {
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    runtime: RUNTIME_LABEL,
    dataSource,
    generatedAt: new Date().toISOString(),
    startedAt,
    provenance: provenanceBlock,
    sara: {
      name: 'SARA',
      status: 'online',
      note: 'NEURO is the canonical brain; SARA renders and submits to it. Anything SARA cannot read from NEURO is shown as unavailable, never filled in.',
    },
    location: buildLocation(telemetry, ctx),
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
  model.presentation = buildPresentation(neuroData, domains, ctx);

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
function getState(options = {}) {
  return { ...buildModel(options), servedAt: new Date().toISOString() };
}

/**
 * Health view derived from the SAME model, so health and state can never disagree
 * about whether SARA is up or whether the model is contract-valid. Reports
 * `degraded` if the engine produced a model that fails its own contract.
 */
function getHealth(options = {}) {
  const model = buildModel(options);
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
    // Readiness for the NEURO dependency — the operator-facing answer to "is SARA
    // wired to the brain, and is what it is showing current?". Non-sensitive by
    // construction: it names the base URL and WHETHER a credential is set, never the
    // credential. This is the signal to watch in PM2 / a probe.
    neuro: {
      configured: model.provenance.neuro.configured,
      ready: model.provenance.neuro.ready,
      baseUrl: model.provenance.neuro.baseUrl,
      credentialConfigured: model.provenance.neuro.credentialConfigured,
      credentialKind: model.provenance.neuro.credentialKind,
      problems: model.provenance.neuro.problems,
      available: model.neuro.available,
      stale: model.provenance.neuro.stale,
      reason: model.neuro.reason,
      polledAt: model.neuro.polledAt,
      ageMs: model.provenance.neuro.ageMs,
    },
    provenance: {
      state: model.provenance.state,
      demoMode: model.provenance.demoMode,
      message: model.provenance.message,
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
