'use strict';

/**
 * Which part of Nick's life a task belongs to.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * NEURO was built entirely around work. Every task in the store arrived from a
 * work source — the Master Todo import, Plaud meeting notes, Microsoft Planner,
 * Jira-adjacent capture — so nothing ever needed to ask the question. Expanding
 * to personal life makes it the first question, because the answer decides
 * which lane a task ranks in, whether the day planner may block Nurtur calendar
 * time for it, and whether it is allowed to leave the building in a briefing.
 *
 * ── Two values, and no more ──────────────────────────────────────────────────
 *
 * `work` and `personal`. Not `family`, `household`, `finance` or `errands` —
 * those are speculative, and a taxonomy with empty branches is one that gets
 * argued with rather than used. The distinction that earns its place today is
 * the one that changes behaviour: work tasks may reach work systems, personal
 * ones must not.
 *
 * ── Unknown defaults to `work`, deliberately ─────────────────────────────────
 *
 * This looks like a violation of the house rule that unknown stays unknown, and
 * it is a considered exception. The two mistakes are not symmetrical:
 *
 *   • A personal task mis-filed as WORK is VISIBLE. It turns up in the Must
 *     Move Today lane looking out of place, and Nick reclassifies it in one tap.
 *   • A work task mis-filed as PERSONAL is INVISIBLE. It silently drops out of
 *     the work lane, the day planner and the briefing, and nothing ever says so.
 *
 * So the default fails towards the visible mistake. `work` is also simply true
 * of everything already in the store — Nick's own statement, which is why the
 * backfill is a fact rather than a guess.
 *
 * Pure, browser-safe, no DB and no network: both frontends and the capture page
 * render domain badges, and three copies of this list is how `TEAMS`,
 * `DIRECT_REPORTS` and four other hardcoded rosters drifted apart.
 */

const WORK = 'work';
const PERSONAL = 'personal';

const DOMAINS = Object.freeze([WORK, PERSONAL]);

// See the header: the asymmetry of the two mistakes, not a coin toss.
const DEFAULT_DOMAIN = WORK;

const LABELS = Object.freeze({
  [WORK]: 'Work',
  [PERSONAL]: 'Personal',
});

/**
 * Coerce anything to a known domain, or null when it is not one.
 *
 * Returns null rather than the default on purpose — a caller storing a value
 * and a caller rendering one want opposite things from an unrecognised input,
 * and folding them here would hide a typo behind a silent 'work'.
 */
function normaliseDomain(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  return DOMAINS.includes(v) ? v : null;
}

/** The domain to STORE for a value that may be absent or unrecognised. */
function domainOrDefault(value) {
  return normaliseDomain(value) || DEFAULT_DOMAIN;
}

/** Display name. An unrecognised value renders as itself rather than vanishing. */
function domainLabel(value) {
  const known = normaliseDomain(value);
  return known ? LABELS[known] : String(value || '');
}

function isPersonal(task) {
  return normaliseDomain(task && task.domain) === PERSONAL;
}

function isWork(task) {
  // Absent counts as work, matching what the column stores. A task with no
  // domain at all is the pre-migration shape, and it is work by definition.
  return normaliseDomain(task && task.domain) !== PERSONAL;
}

/**
 * A badge for a task card, or null when there is nothing worth saying.
 *
 * ⚠ Work is deliberately SILENT by default. Nearly every task is work, so a
 * "Work" chip on all of them is a label every row shares — which sorts nothing
 * and reads as noise, the same finding that made nearly-every-task-a-MUST
 * useless for ranking. Only the exception is worth marking.
 *
 * `withWork: true` is for the one surface where both appear side by side and
 * the absence of a badge would be ambiguous rather than merely quiet.
 */
function domainBadge(task, { withWork = false } = {}) {
  const d = normaliseDomain(task && task.domain);
  if (d === PERSONAL) return LABELS[PERSONAL];
  if (withWork) return LABELS[WORK];
  return null;
}

/**
 * Should this task be allowed to reach a WORK system?
 *
 * The briefing sends through Graph Mail and Teams sends through Graph Chat —
 * both Nurtur's tenant, both on Nurtur's retention policy. A personal task in
 * either puts Nick's private life in his employer's mail system permanently, so
 * this is the guard those paths ask rather than each of them re-deciding it.
 *
 * ⚠ It holds back what is POSITIVELY personal, and NOT everything it cannot
 * prove is work — which is what the first cut did, on a "fail closed" instinct
 * that was wrong here and worth writing down. A task only becomes `personal` by
 * being told so, explicitly, so testing for it catches the entire real threat.
 * Requiring a positive `work` instead would have suppressed every Microsoft
 * mirror line and every vault-backed task — none of which carries the column at
 * all — and silently emptied the briefing. That is precisely the invisible
 * failure the header warns about, reintroduced by the guard meant to prevent it.
 */
function mayLeaveTheBuilding(task) {
  return !isPersonal(task);
}

module.exports = {
  WORK,
  PERSONAL,
  DOMAINS,
  DEFAULT_DOMAIN,
  normaliseDomain,
  domainOrDefault,
  domainLabel,
  domainBadge,
  isPersonal,
  isWork,
  mayLeaveTheBuilding,
};
