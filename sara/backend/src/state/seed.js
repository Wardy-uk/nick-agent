// SARA State Engine — seed inputs (WS1-WP1).
//
// HARDCODED domain inputs. WS1 is explicitly allowed to use hardcoded inputs: the
// goal of this work package is a real contract + real engine, not real
// integrations. Every domain is stamped `source: 'seed'` so any consumer can tell
// the data is not live yet.
//
// This is the swappable layer. A later work package replaces each provider with
// one that reads the real source (Jira queue, do-next, people notes, vault) — the
// engine (stateEngine.js) and the contract (contract.js) do not change. Each
// provider must return one domain object conforming to that domain's backbone in
// contract.js DOMAIN_CONTRACTS.
//
// CommonJS only.

function queue() {
  const sections = {
    act_now: [
      {
        key: 'TECH-4412',
        summary: 'Portal login loop after SSO',
        // Names here must be people who currently work for Nick (#13): this
        // fixture is the OUTAGE fallback, so it is what the kiosk shows on the
        // day the live sources are unreachable — the worst moment to be naming
        // someone who left the business.
        assignee: 'Luke',
        slaMins: 120,
        take: "Customer escalated twice. Picked up, no response logged yet.",
      },
      {
        key: 'TECH-4398',
        summary: 'Bulk export timing out',
        assignee: 'Abdi',
        slaMins: 45,
        take: 'Breaching within the hour. Needs a holding reply now.',
      },
    ],
    today: [
      {
        key: 'TECH-4401',
        summary: 'Duplicate contacts on import',
        assignee: 'Adele',
        slaMins: 600,
        take: 'In progress, on track.',
      },
    ],
    watch: [
      {
        key: 'TECH-4380',
        summary: 'Avatar crop on Safari',
        assignee: 'Nathan',
        slaMins: 4320,
        take: 'Cosmetic, low impact. Awareness only.',
      },
    ],
  };
  const open = sections.act_now.length + sections.today.length + sections.watch.length;
  const breaching = sections.act_now.filter((t) => t.slaMins <= 120).length;
  return {
    source: 'seed',
    summary: `${open} open, ${breaching} breaching SLA. Abdi is carrying the heaviest load.`,
    open,
    breaching,
    sections,
  };
}

function focus() {
  return {
    source: 'seed',
    summary: "One thing: prep Willem's probation review. It's tomorrow.",
    current: {
      id: 'do-next-1',
      title: "Prep Willem's probation review",
      reason: "It's tomorrow and nothing is drafted. 20 minutes now saves a scramble.",
      timeboxMins: 20,
      deferCount: 1,
    },
    deferEscalation: [
      'Moved to tomorrow morning.',
      "That's twice. When are you actually doing this?",
      "You're avoiding this. What's blocking you?",
    ],
  };
}

function people() {
  const members = [
    { name: 'Abdi', role: 'Support Engineer', metric: 'QA 82%', status: 'watch', flag: "carrying 40% of today's queue" },
    { name: 'Adele', role: 'Support Engineer', metric: 'QA 91%', status: 'solid', flag: 'three consecutive green QA scores' },
    { name: 'Nathan', role: 'Support Engineer', metric: 'QA 74%', status: 'slipping', flag: 'no ticket response logged since Wednesday' },
    { name: 'Luke', role: 'Support Engineer', metric: 'QA 88%', status: 'solid', flag: 'on top of escalations' },
  ];
  const needAttention = members.filter((m) => m.status !== 'solid').length;
  return {
    source: 'seed',
    summary: `${members.length} reports, ${needAttention} need attention. Nathan is going quiet.`,
    members,
  };
}

// Current location is part of SARA's situational state, not a domain. Seeded here
// (the swappable layer) so a later work package can replace it with a live reader
// (OwnTracks / calendar context) without changing the engine or the contract.
function location() {
  return {
    source: 'seed',
    label: 'Office — Little Eaton',
    context: 'on-site',
    since: '2026-05-31T08:40:00+01:00',
    summary: 'On-site at the Little Eaton office since 08:40.',
  };
}

function vault() {
  const picks = [
    { title: '1-2-1 — Luke (12 Mar)', reason: 'Target you set here is now overdue.', path: 'People/Luke/1-2-1 2026-03-12.md' },
    { title: 'Probation framework', reason: "You'll need this for Willem tomorrow.", path: 'Process/Probation framework.md' },
  ];
  return {
    source: 'seed',
    summary: `${picks.length} notes worth surfacing right now.`,
    picks,
  };
}

module.exports = { queue, focus, people, vault, location };
