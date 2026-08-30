// Provenance — where every number on a SARA screen actually came from.
//
// This module exists because of one failure: the State Engine used to fall back to
// `seed.js` whenever NEURO was unreachable. Seeded content is not neutral filler — it
// names real colleagues, invents SLA breaches and puts a probation review in Nick's
// day that does not exist. A kiosk showing that during an outage looks exactly like a
// kiosk that is working, which is the worst of both: SARA is wrong AND confident.
//
// So there are now four, and only four, provenances a domain may carry, and every
// consumer must be able to tell them apart:
//
//   live        — read from NEURO just now.
//   stale       — read from NEURO a while ago; NEURO is not answering right now.
//   unavailable — we could not read it. NOT "there is nothing there".
//   demo        — invented. Only reachable behind SARA_DEMO_MODE, never in production.
//
// The domain builders below are the `unavailable` renderings. They are contract-shaped
// (so the model still validates and no screen crashes) and structurally EMPTY (so no
// screen can read a fact out of them), and each carries a sentence saying what SARA
// could not see. Empty-because-unread must never be mistaken for empty-because-clear.
//
// CommonJS only.

const SOURCE = {
  LIVE: 'neuro',
  STALE: 'neuro-stale',
  UNAVAILABLE: 'unavailable',
  DEMO: 'demo',
};

const UNAVAILABLE_SOURCES = new Set([SOURCE.UNAVAILABLE]);

/** The one sentence every unavailable domain leads with. */
function cannotSee(what, detail) {
  const because = detail ? ` ${detail}` : '';
  return `SARA cannot see ${what} — this is not an all-clear.${because}`;
}

function unavailableQueue(detail) {
  return {
    source: SOURCE.UNAVAILABLE,
    available: false,
    detail: detail || null,
    summary: cannotSee('the queue', detail),
    // null, never 0: "no tickets" and "no reading" are different facts, and a screen
    // that renders 0 has silently made the second into the first.
    open: null,
    breaching: null,
    sections: { act_now: [], today: [], watch: [] },
  };
}

function unavailableFocus(detail) {
  return {
    source: SOURCE.UNAVAILABLE,
    available: false,
    detail: detail || null,
    summary: cannotSee('what you should be working on', detail),
    current: null,
    deferEscalation: [],
  };
}

function unavailablePeople(detail) {
  return {
    source: SOURCE.UNAVAILABLE,
    available: false,
    detail: detail || null,
    summary: cannotSee('your team', detail),
    members: [],
    meta: { counts: null, filteredCount: null, severityFilter: null, needAttention: null },
  };
}

function unavailableVault(detail) {
  return {
    source: SOURCE.UNAVAILABLE,
    available: false,
    detail: detail || null,
    summary: cannotSee('the vault', detail),
    picks: [],
  };
}

const UNAVAILABLE_BUILDERS = {
  queue: unavailableQueue,
  focus: unavailableFocus,
  people: unavailablePeople,
  vault: unavailableVault,
};

/**
 * Roll the per-domain sources up into one word for the whole model.
 * @param {Record<string,string>} bySource domain name -> source
 * @returns {'demo'|'unavailable'|'neuro'|'neuro-stale'|'mixed'}
 */
function rollUp(bySource) {
  const sources = Object.values(bySource);
  if (!sources.length) return SOURCE.UNAVAILABLE;
  if (sources.every((s) => s === SOURCE.DEMO)) return SOURCE.DEMO;
  if (sources.every((s) => UNAVAILABLE_SOURCES.has(s))) return SOURCE.UNAVAILABLE;
  if (sources.every((s) => s === SOURCE.LIVE)) return SOURCE.LIVE;
  if (sources.every((s) => s === SOURCE.LIVE || s === SOURCE.STALE)) return SOURCE.STALE;
  return 'mixed';
}

/**
 * The human sentence the status indicator prints. One line, no jargon, and it never
 * says a reassuring thing SARA has not earned.
 */
function describe({ state, demoMode, neuro }) {
  if (demoMode) return 'DEMO DATA — invented content, not Nick\'s real state.';
  // ⚠ The "we have data" cases are tested BEFORE the configuration check. Data on
  // screen has a provenance whatever the config now says, and reporting a cached
  // reading as "not configured" describes the wrong problem.
  switch (state) {
    case SOURCE.LIVE:
      return 'Live from NEURO.';
    case SOURCE.STALE:
      return `Showing NEURO's last known state${neuro.ageLabel ? ` from ${neuro.ageLabel}` : ''} — NEURO is not answering now.`;
    case 'mixed':
      return 'Partly live — some of NEURO could not be read, and those parts are blank rather than guessed.';
    case SOURCE.UNAVAILABLE:
    default:
      // Nothing on screen. Now the reason matters, and "we were never told where the
      // brain is" needs a different fix from "the brain is down".
      if (!neuro.configured) return 'NEURO is not configured. SARA does not know where the brain is.';
      return 'NEURO is unreachable. Nothing on screen is current — this is not an all-clear.';
  }
}

/** "4 minutes ago" — for the one place a raw ageMs would be unreadable. */
function ageLabel(ageMs) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return null;
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return 'moments ago';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

module.exports = {
  SOURCE,
  cannotSee,
  unavailableQueue,
  unavailableFocus,
  unavailablePeople,
  unavailableVault,
  UNAVAILABLE_BUILDERS,
  rollUp,
  describe,
  ageLabel,
};
