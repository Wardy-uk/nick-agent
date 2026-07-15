// SARA view system — the "one state, many views" registry (WS2-WP1).
//
// Protected principle 7 (charter): SARA's UI must be view-based and
// interchangeable. Screens are *representations* of the one shared state model;
// they do not own data and they are not the architecture. This module is the
// canonical list of views and the current-view default — the structural proof
// that the project is NOT hardcoded around a single home screen.
//
// The current product-alignment slice reshapes the registry around the written NEURO /
// SARA screen set while preserving the protected many-views architecture. Some screens
// are fully implemented, some are honest v0 read-only surfaces, and some remain bounded
// placeholders — but every one is backed by the same shared state/context model.
//
// This is the "view type definition" called for in the build brief, expressed in
// plain JS to match the existing converged runtime (React + Vite, no TypeScript).

// Canonical SaraView identifiers. The string value is the stable view id used in
// the registry, the router, and (later) the recommended/selected view in state.
export const SARA_VIEWS = {
  COGNITION: 'cognition',
  CONTEXT: 'context',
  BRIEFING: 'mission-control',
  SARA: 'companion',
  STANDUP: 'standup',
  QUEUE: 'executive-dashboard',
  ATWORK: 'at-work',
  TEAM: 'team',
  FOCUS: 'focus',
  TODOS: 'todos',
  VAULT: 'vault',
  CAPTURE: 'capture',
  SETTINGS: 'settings',
};

const VIEW_ALIASES = {
  'mission-control': SARA_VIEWS.BRIEFING,
  'executive-dashboard': SARA_VIEWS.QUEUE,
  companion: SARA_VIEWS.SARA,
  presence: SARA_VIEWS.BRIEFING,
  'stream-deck': SARA_VIEWS.CAPTURE,
};

// The view registry. Order here is the order views are offered in the UI. Every
// view is a representation of the same shared state — none of them is "the app".
//   status: 'available' -> a screen exists and renders now
//   status: 'planned'   -> reserved by the architecture; screen is a placeholder
export const VIEW_REGISTRY = [
  {
    id: SARA_VIEWS.COGNITION,
    label: 'Cognition',
    blurb: "SARA's primary surface: ambient state, one active focus, signals — and the seam.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.CONTEXT,
    label: 'Context',
    blurb: "What's shaping this right now.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.BRIEFING,
    label: 'Briefing',
    blurb: "SARA's opening line, priority actions, and quick stats.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.SARA,
    label: 'SARA',
    blurb: 'Text conversation surface over the shared model and NEURO chat bridge.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.STANDUP,
    label: 'Standup',
    blurb: "Guided morning flow over SARA's current priorities.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.QUEUE,
    label: 'Queue',
    blurb: "SARA's Jira triage: act now, today, watch.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.ATWORK,
    label: 'At Work',
    blurb: "NOVA signals that need your eyes — approvals, overdue customers, exceptions.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.TEAM,
    label: 'Team',
    blurb: 'People board with current flags and SARA assessments.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.FOCUS,
    label: 'Focus',
    blurb: 'One thing, timeboxed — the current do-next.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.TODOS,
    label: 'Todos',
    blurb: 'Backlog view for tasks SARA is keeping in sight.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.VAULT,
    label: 'Vault',
    blurb: "Notes SARA is surfacing from the vault seam.",
    status: 'available',
  },
  {
    id: SARA_VIEWS.CAPTURE,
    label: 'Capture',
    blurb: 'Universal capture surface for thoughts and quick intents.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.SETTINGS,
    label: 'Settings',
    blurb: 'Connection, source, and runtime status.',
    status: 'available',
  },
];

// The view SARA opens on. Manual selection (charter: "manual user-selected view")
// is supported via the view switcher. As of WS5-WP1 the State Engine also derives a
// *recommended* view (model.inference.recommendedView), surfaced by RecommendedView —
// but it is ADVISORY ONLY: it never sets DEFAULT_VIEW or currentView on its own. SARA
// opens on the Cognition Environment and only a user action changes the view.
export const DEFAULT_VIEW = SARA_VIEWS.COGNITION;

export function normalizeViewId(id) {
  return VIEW_ALIASES[id] || id;
}

export function getView(id) {
  const normalized = normalizeViewId(id);
  return VIEW_REGISTRY.find((v) => v.id === normalized) || null;
}
