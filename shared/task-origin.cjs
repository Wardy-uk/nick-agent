'use strict';

/**
 * Whose idea was this task — somebody else's, or Nick's own?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The weekly risk report going to Chris counts "open" and "overdue" over the
 * whole task list, and that conflates two populations with nothing in common
 * but a due date:
 *
 *   • A COMMITMENT is work somebody else is expecting. It was asked for, or it
 *     was agreed in front of people who are now waiting on it. Missing one is a
 *     fact about Nick's reliability to other people, and it is exactly what
 *     competencies 3 and 4 are measured on.
 *
 *   • A CONTINUAL IMPROVEMENT task is one Nick set himself — a system to build,
 *     a process to tighten, a report to automate. Nobody is waiting. It slipping
 *     is a fact about his own ambition, not about a broken promise.
 *
 * Counting them together makes the improvement backlog *penalise* him: a man who
 * writes down thirty ideas for making the department better and dates them
 * optimistically reads, in a compliance report, exactly like a man who has
 * broken thirty promises. That is the wrong way round, and it is why overdue in
 * the report now counts COMMITMENTS ONLY (Nick, 1 Sep 2026).
 *
 * ── There is deliberately NO default ─────────────────────────────────────────
 *
 * `shared/task-domain.cjs` defaults unknown to `work`, and argues for it: the
 * two mistakes there are asymmetric, and one of them is visible. Here they are
 * asymmetric in OPPOSITE DIRECTIONS, and both are expensive:
 *
 *   • An improvement task counted as a COMMITMENT inflates the overdue figure in
 *     a report read by the person assessing a PIP. It manufactures broken
 *     promises out of Nick's own stretch goals.
 *   • A commitment counted as IMPROVEMENT hides a real broken promise from that
 *     same report — the worse failure, because the report's whole job is to
 *     surface those, and it would be quietly telling the assessor everything is
 *     fine.
 *
 * There is no safe way to guess, so `null` is a first-class value and the report
 * counts it as its OWN bucket, named and never folded into either. "I have not
 * classified these yet" is a different sentence from "these are mine" and from
 * "these are promises", and the report says which one it means.
 *
 * ── Proposed vs decided ──────────────────────────────────────────────────────
 *
 * `inferOrigin()` reads provenance the store already holds and proposes an
 * answer where the evidence is real. A proposal is stamped `origin_proposed`,
 * exactly as the 12 Aug MoSCoW import was: importing a guess as a decision
 * invents calls Nick never made. Setting it by hand is the decision, and the
 * flag comes off.
 *
 * Pure, browser-safe, no DB and no network — TodoPanel and sara/app both render
 * the badge, and three copies of a vocabulary is how six hardcoded rosters
 * drifted apart before it.
 */

const COMMITMENT = 'commitment';
const IMPROVEMENT = 'improvement';

const ORIGINS = Object.freeze([COMMITMENT, IMPROVEMENT]);

const LABELS = Object.freeze({
  [COMMITMENT]: 'Commitment',
  [IMPROVEMENT]: 'Continual improvement',
});

// Short forms for a task card, where the full label is most of the row.
const SHORT_LABELS = Object.freeze({
  [COMMITMENT]: 'Commitment',
  [IMPROVEMENT]: 'Improvement',
});

const DESCRIPTIONS = Object.freeze({
  [COMMITMENT]: 'Someone else asked for this, or is waiting on it',
  [IMPROVEMENT]: 'Your own idea — nobody is waiting',
});

/** The word the report uses for a task nobody has classified yet. */
const UNCLASSIFIED_LABEL = 'Not yet classified';

/**
 * Coerce anything to a known origin, or null when it is not one.
 *
 * ⚠ null here means BOTH "absent" and "not a recognised value", and callers
 * must not read it as improvement. There is no `originOrDefault` counterpart to
 * `domainOrDefault` on purpose — see the header.
 */
function normaliseOrigin(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  return ORIGINS.includes(v) ? v : null;
}

/** Display name. An unrecognised value renders as itself rather than vanishing. */
function originLabel(value) {
  const known = normaliseOrigin(value);
  if (known) return LABELS[known];
  if (value === null || value === undefined || value === '') return UNCLASSIFIED_LABEL;
  return String(value);
}

function isCommitment(task) {
  return normaliseOrigin(task && task.origin) === COMMITMENT;
}

function isImprovement(task) {
  return normaliseOrigin(task && task.origin) === IMPROVEMENT;
}

/**
 * Nobody has said which this is.
 *
 * ⚠ Deliberately NOT `!isCommitment(task)`. Every consumer that has to choose a
 * bucket has three of them, and writing the negative is how the unclassified
 * pile silently becomes whichever bucket the author happened to test for.
 */
function isUnclassified(task) {
  return normaliseOrigin(task && task.origin) === null;
}

/**
 * A badge for a task card, or null when there is nothing worth saying.
 *
 * ⚠ Unlike `domainBadge`, the SILENT case is the unclassified one, not the
 * common one. Both real values are worth showing: which of the two a task is
 * changes what missing it means, and neither is so overwhelmingly the majority
 * that marking it would be noise (measured 1 Sep 2026 on the live store: 28
 * classifiable, 82 not). A trailing `?` marks a proposal, matching the MoSCoW
 * badge one row up, so a guess never reads as Nick's own call.
 */
function originBadge(task) {
  const o = normaliseOrigin(task && task.origin);
  if (!o) return null;
  return `${SHORT_LABELS[o]}${task && task.originProposed ? '?' : ''}`;
}

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Propose an origin from provenance the store already holds.
 *
 * Returns `{ origin, basis }` or **null** when there is no evidence. Null is the
 * answer for most of the list and that is correct: the classifier's job is to
 * save Nick the taps it can honestly save, not to fill the column.
 *
 * ⚠ It reads PROVENANCE, never wording. Measured against the live store before
 * it was written: the text cannot carry this. "Prepare MyAudience vs iMail price
 * comparisons (for Chris → SLT)" is plainly an ask and "Build escalation
 * accuracy view in NOVA" is plainly Nick's own, and no rule separates them that
 * does not also mangle the eighty rows in between. A keyword matcher would be
 * confidently wrong on a compliance report, which is the one place being
 * confidently wrong costs most.
 *
 * The test is Nick's (1 Sep 2026): **is somebody else expecting it?** Something
 * he volunteered in a meeting still counts — the room heard him say it.
 */
function inferOrigin(task = {}) {
  const source = String(task.source || '').trim().toLowerCase();
  const msSource = String(task.msSource || task.ms_source || '').trim().toLowerCase();
  const originPath = String(task.originPath || task.origin_path || '');

  // A management-log mirror. Every row in that table is a conversation, concern
  // or action recorded WITH a named person — it is the compliance record of
  // Nick's management conversations — and only ones he owns are mirrored into a
  // task at all. Verified on the live log: all nineteen entries carry a Plaud
  // recording id from a real 1-2-1.
  if (source === 'management-log') {
    return { origin: COMMITMENT, basis: 'mirrored from the management log — agreed in a recorded conversation' };
  }

  // Extracted from a meeting note. Nick said it with other people in the room,
  // which is his own test for a commitment whether or not he was asked. Checked
  // rather than assumed: all 21 live meeting-promotion tasks trace to a note
  // under `Meetings/YYYY/MM/`.
  if (source === 'meeting-promotion' && /^Meetings\//i.test(originPath)) {
    return { origin: COMMITMENT, basis: 'promoted from a meeting note — said in front of others' };
  }

  // A card on a Planner board. Boards are shared and somebody else maintains
  // them, so a card sitting on one is work other people can see is assigned.
  //
  // ⚠ MS To Do is deliberately NOT included: that is Nick's own private list,
  // and treating it as a board would file his personal reminders as promises.
  if (msSource === 'ms planner') {
    return { origin: COMMITMENT, basis: 'assigned on a Planner board' };
  }

  // Everything else — the Master Todo import, capture, chat, the MCP tool, a
  // task typed by hand. All of them are a route INTO the store and none of them
  // records who wanted the work, so there is nothing here to read.
  return null;
}

module.exports = {
  COMMITMENT,
  IMPROVEMENT,
  ORIGINS,
  LABELS,
  SHORT_LABELS,
  DESCRIPTIONS,
  UNCLASSIFIED_LABEL,
  normaliseOrigin,
  originLabel,
  originBadge,
  isCommitment,
  isImprovement,
  isUnclassified,
  inferOrigin,
};
