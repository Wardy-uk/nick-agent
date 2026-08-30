// SARA shared UI-state — the EMPTY presentation, used before /api/state answers.
//
// ⚠ This file used to hold invented content: two SLA breaches, "Willem's probation
// review is tomorrow", "Nathan has gone quiet", a 13:30 1-2-1 with Adele. It was
// described as a harmless placeholder seam, and in a running app it is not: any
// screen rendering it while the backend is unreachable shows Nick a plausible,
// specific, entirely fictional day — including a performance concern about a named
// colleague. That is the single worst thing SARA can put on a screen.
//
// So the shared fallback is now EMPTY, and it says so. The backend's own
// `presentation` block (state/provenance.js + stateEngine.buildPresentation) is the
// only thing that ever fills it, and that block is stamped with where every part of it
// came from — `neuro`, `neuro-stale`, `unavailable` or `demo`.
//
// Quick Actions and the capture shortcuts survive, because they are not data about
// Nick: they are buttons that do real things in this app, and Capture in particular
// must stay reachable when the brain is down.

export const SHARED_PRESENTATION = {
  source: 'unavailable',
  available: false,
  notice: 'Waiting for SARA — nothing here is from NEURO yet.',

  // Empty, always. An empty list is the honest rendering of "SARA has not been told
  // anything"; a populated one is a claim, and a claim needs a source.
  whatMattersNow: [],
  upNext: [],

  quickActions: [
    { id: 'qa-capture', label: 'Capture', action: 'capture', icon: '✎' },
    { id: 'qa-queue', label: 'Open Queue', action: 'open-queue', icon: '▤' },
    { id: 'qa-focus', label: 'Start Focus', action: 'start-focus', icon: '◎' },
    { id: 'qa-brief', label: 'Daily Brief', action: 'daily-brief', icon: '☼' },
  ],

  standup: {
    source: 'unavailable',
    yesterday: [],
    carryForward: [],
    // SARA's own questions, not facts about Nick — these stand whatever NEURO says.
    prompts: [
      'What is carrying forward that still matters today?',
      'What needs blocking time before lunch?',
      'Who needs a direct nudge from you today?',
    ],
  },

  email: {
    source: 'unavailable',
    available: false,
    detail: null,
    // null, never 0 — "no reading" must not render as "inbox clear".
    urgentCount: null,
    replyCount: null,
    urgent: [],
    reply: [],
  },

  todos: { source: 'unavailable', items: [], candidates: [], todayLane: [] },

  capture: {
    source: 'unavailable',
    shortcuts: [
      { id: 'cap-note', label: 'Quick note', detail: "Writes to NEURO's capture inbox." },
      { id: 'cap-todo', label: 'Todo', detail: 'Creates a real task through NEURO capture.' },
    ],
    recent: [],
  },
};
