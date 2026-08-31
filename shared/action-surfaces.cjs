'use strict';

// Must stay in step with TABS in sara/app/src/App.jsx — an id here with no tab
// there routes to a screen that does not exist, and a tab there missing from
// here silently falls back to Focus. Pinned in both directions by
// backend/services/action-surfaces.test.js, because neither half errors.
// 'now' and 'review' are Phase 2's primary modes (30 Aug 2026).
// 'controls' is Phase 3's attention control surface (30 Aug 2026) — registered
// here even though nothing routes a notification TO it, because the parity test
// reads both lists and an id in one and not the other is silent in both
// directions.
// 'brain' was REMOVED on 31 Aug 2026: vault maintenance moved to NEURO's own
// Brain Health panel, because it is a deliberate desk job with reports to read
// and writes to weigh, not something SARA should come to Nick about. The
// notification KIND 'brain' is unchanged and still routes the desktop to
// Imports; only its SARA destination is gone, so it now lands on the Surface
// like everything else with no dedicated tab.
const SARA_LITE_TABS = new Set(['surface', 'now', 'review', 'today', 'focus', 'tasks', 'capture', 'voice', 'chat', 'prep', 'standup', 'controls']);

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function normalisePath(value) {
  if (!value) return '/';
  try {
    const url = new URL(value, 'http://localhost');
    return url.pathname || '/';
  } catch {
    return String(value).trim() || '/';
  }
}

function resolveActionKind(raw = {}) {
  const explicitKind = lower(raw.kind);
  if (explicitKind) return explicitKind;

  const target = lower(raw.target);
  const targetFilter = lower(raw.targetContext?.filter);
  const type = lower(raw.type || raw.notificationType || raw.payload?.type);
  const metaType = lower(raw.meta?.type || raw.payload?.meta?.type);
  const pathname = normalisePath(raw.url || raw.notificationUrl).toLowerCase();

  if (type === 'nudge' && metaType === 'standup') return 'standup';
  if (type === 'nudge' && metaType === 'eod') return 'eod';

  if (target === 'meeting-prep' || pathname.startsWith('/meeting') || pathname.startsWith('/calendar')) return 'meeting';
  if (target === 'standup' || pathname.startsWith('/standup')) return metaType === 'eod' || type === 'eod' ? 'eod' : 'standup';
  if (target === 'capture' || pathname.startsWith('/capture')) return 'capture';
  if (target === 'chat' || pathname.startsWith('/chat')) return 'chat';
  if (target === 'todos' || pathname.startsWith('/todos')) return 'todo';
  if (target === 'inbox' || pathname.startsWith('/inbox')) return 'email';
  if (target === 'imports' || pathname.startsWith('/imports') || pathname.startsWith('/vault') || pathname.startsWith('/insights')) return 'brain';
  if (target === 'queue' || target === 'dashboard') {
    if (targetFilter === 'escalations') return 'escalation';
    if (targetFilter === 'at-risk') return 'jira_ticket';
  }

  if (['meeting', 'meeting_alert', 'meeting_prep', 'calendar'].includes(type)) return 'meeting';
  if (['standup'].includes(type)) return 'standup';
  if (['eod'].includes(type)) return 'eod';
  if (['journal'].includes(type)) return 'journal';
  if (['todo'].includes(type)) return 'todo';
  if (['email'].includes(type)) return 'email';
  if (['escalation', 'escalation_alert'].includes(type)) return 'escalation';
  if (['jira_ticket'].includes(type)) return 'jira_ticket';
  if (['plaud', 'vault_hygiene', 'knowledge_reflection', 'sweep_complete', 'imports'].includes(type)) return 'brain';
  if (['brief', '121', 'plan_milestone', 'teams_mention', 'weekly_review'].includes(type)) return 'focus';
  if (type) return type;

  return 'unsupported';
}

function resolveSaraLiteTab(raw = {}) {
  const tab = lower(raw.tab);
  if (SARA_LITE_TABS.has(tab)) return tab;

  const kind = resolveActionKind(raw);
  if (['standup', 'eod'].includes(kind)) return 'standup';
  if (kind === 'meeting') return 'prep';
  if (kind === 'capture') return 'capture';
  if (kind === 'chat') return 'chat';
  if (kind === 'todo') return 'tasks';
  // Everything with no specific home lands on SARA (25 Aug 2026). It used to
  // fall through to Focus, which meant the ONE path where SARA genuinely comes
  // to Nick — a push he taps — routed straight past her to the old list-shaped
  // surface. An escalation notification is exactly the case: no dedicated tab,
  // so it went to Focus. It now arrives where she is, with the thing that
  // pinged him already ranked in context.
  return 'surface';
}

function resolveSaraLitePlan(raw = {}) {
  const kind = resolveActionKind(raw);
  const hasExternalUrl = !!raw.url;

  if (hasExternalUrl && /^https?:/i.test(String(raw.url))) {
    return { kind, canHandle: true, presentation: 'external', tab: resolveSaraLiteTab(raw) };
  }

  if (['journal', 'meeting', 'brain'].includes(kind)) {
    return { kind, canHandle: true, presentation: 'sheet', tab: resolveSaraLiteTab(raw) };
  }

  // 'todo' used to be a sheet because there was nowhere to send it. It has a real
  // tab now, and the full list beats a five-item card pulled from a notification.
  //
  // #26 — 'standup'/'eod' moved out of the sheet for a stronger reason than
  // screen size. The sheet ran the RETIRED fixed three-question stepper
  // (/api/standup/submit-guided), which holds every answer in browser state
  // until one final POST and loses the lot when that POST fails — the exact
  // failure standup-session.js exists to end. The tab drives
  // /api/standup-session/*, where the transcript is saved before and after every
  // turn. Two flows on one phone would disagree about what today's standup was,
  // so there is now one. Note this branch is ordered AFTER the sheet branch in
  // the original file for a reason: the sheet list is checked first, so leaving
  // the ids in both would have kept the sheet and made adding the tab a no-op.
  if (['capture', 'chat', 'todo', 'standup', 'eod'].includes(kind)) {
    return { kind, canHandle: true, presentation: 'tab', tab: resolveSaraLiteTab(raw) };
  }

  return { kind, canHandle: false, presentation: 'handoff', tab: resolveSaraLiteTab(raw) };
}

function resolveNueroNavigation(raw = {}) {
  const kind = resolveActionKind(raw);

  if (kind === 'escalation') return { view: 'dashboard', context: { filter: 'escalations' } };
  if (kind === 'jira_ticket') return { view: 'dashboard', context: { filter: 'at-risk' } };
  if (kind === 'meeting') return { view: 'meeting-prep', context: {} };
  if (kind === 'todo') return { view: 'todos', context: { filter: 'overdue' } };
  if (kind === 'standup' || kind === 'eod') return { view: 'standup', context: {} };
  if (kind === 'email') return { view: 'inbox', context: { filter: 'urgent' } };
  if (kind === 'brain' || kind === 'journal') return { view: 'imports', context: {} };
  if (kind === 'focus') return { view: 'briefing', context: {} };
  if (kind === 'capture') return { view: 'chat', context: { mode: 'capture' } };
  return null;
}

function buildQuery(context = {}) {
  const params = new URLSearchParams();
  Object.entries(context).forEach(([key, value]) => {
    if (value == null || value === '') return;
    params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

function resolveNueroPath(raw = {}) {
  const kind = resolveActionKind(raw);
  if (kind === 'escalation') return '/?view=dashboard&filter=escalations';
  if (kind === 'jira_ticket') return '/?view=dashboard&filter=at-risk';
  if (kind === 'meeting') return '/?view=meeting-prep';
  if (kind === 'todo') return '/?view=todos&filter=overdue';
  if (kind === 'standup' || kind === 'eod') return '/?view=standup';
  if (kind === 'email') return '/?view=inbox&filter=urgent';
  if (kind === 'brain' || kind === 'journal') return '/?view=imports';
  if (kind === 'focus') return '/?view=briefing';
  const navigation = resolveNueroNavigation(raw);
  if (!navigation) return null;
  const context = { view: navigation.view, ...(navigation.context || {}) };
  return `/${buildQuery(context)}`;
}

function resolveNueroUrl(raw = {}, baseUrl) {
  const target = raw.url || raw.notificationUrl || null;
  if (target) {
    try {
      return new URL(target, baseUrl || 'http://localhost').toString();
    } catch {
      return null;
    }
  }

  const path = resolveNueroPath(raw);
  if (!path) return null;
  try {
    return new URL(path, baseUrl || 'http://localhost').toString();
  } catch {
    return path;
  }
}

function decorateSurfaceSupport(raw = {}) {
  const saraLite = resolveSaraLitePlan(raw);
  return {
    kind: resolveActionKind(raw),
    surfaces: {
      saraLite,
      nuero: {
        canHandle: !!resolveNueroNavigation(raw),
        navigation: resolveNueroNavigation(raw),
        path: resolveNueroPath(raw),
      },
      sara: {
        canHandle: true,
      },
    },
  };
}

module.exports = {
  decorateSurfaceSupport,
  normalisePath,
  resolveActionKind,
  resolveNueroNavigation,
  resolveNueroPath,
  resolveNueroUrl,
  resolveSaraLitePlan,
  resolveSaraLiteTab,
};
