'use strict';

/**
 * Friction — what has actually got in the way, said without blame.
 *
 * ── Why this is not the avoidance radar ─────────────────────────────────────
 * `adhd-dashboard._avoidance()` already reads "what you're pushing away" from
 * nudge snoozes and task age. That card is honest and it stays. This is a
 * different claim: the avoidance radar reasons about things NOT done, which is
 * an absence, and an absence is always open to a second reading — busy week,
 * changed priorities, someone else's blocker. This reads only things Nick DID
 * and NEURO recorded: he deferred it and gave a reason, he asked for it to be
 * smaller, he said he was pulled away, he wrote a reflection. Every insight
 * therefore comes with the evidence that produced it, and can be checked.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * 1. **Explicit evidence only.** A defer with a REASON, a `needs-smaller`, a
 *    shrink, a step-away, a reflection. Nothing is inferred from silence, and
 *    nothing is inferred from what somebody ELSE has not done.
 * 2. **No evidence, no insight.** An empty list is the correct answer for most
 *    days and must not be padded.
 * 3. **A missed check-in means nothing.** Being heads-down is exactly why one
 *    gets skipped, and reading it as disengagement would punish the state the
 *    whole feature exists to protect.
 * 4. **No scores, no streaks, no diagnosis, no "avoidance".** Every line names
 *    a fact and, at most, what the fact might mean for the SHAPE of the work.
 *    "You have made this smaller three times, it may need a different shape" is
 *    a finding about a task. "You are avoiding this" is a claim about a person.
 *
 * PURE where it judges: `assess()` takes plain data and a clock and returns the
 * insights, so the wording and the thresholds pin without a database — the
 * `pi-health.assess()` / `state-of-play.assess()` split. Only `build()` reads.
 *
 * CommonJS — NEURO backend convention.
 */

// How many separate sightings a pattern needs before it is a pattern rather
// than a Tuesday. Two is deliberately low for shrinks and defers (the act is
// already explicit and already rare) and the wording never claims more than the
// count supports.
const MIN_DEFERS = 2;
const MIN_SHRINKS = 2;

// How far back an event still counts. A defer from six weeks ago is history,
// not friction, and letting it accumulate for ever turns this into a ledger of
// everything Nick has ever found hard.
const WINDOW_DAYS = 21;

const MAX_INSIGHTS = 5;

const DEFER_PHRASES = {
  'no-context': 'because it needs context first',
  'waiting-on-someone': 'because it is waiting on someone',
  'too-big': 'because it is too big as written',
  'not-now': 'as not-now',
  unspecified: null,
};

function _days(fromIso, now) {
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

function _times(n) {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/**
 * Turn recorded evidence into what can honestly be said about it. PURE.
 *
 * @param {object} input
 *   `defers`   [{dedupeKey, title, reason, at}]      — attention_events
 *   `session`  the live focus session, decorated, or null
 *   `history`  recent archived sessions
 * @param {Date} now
 * @returns {{insights: Array, evidenceCount: number, sources: object}}
 */
function assess(input = {}, now = new Date()) {
  const defers = Array.isArray(input.defers) ? input.defers : [];
  const history = Array.isArray(input.history) ? input.history : [];
  const session = input.session && typeof input.session === 'object' ? input.session : null;

  const insights = [];
  const cutoff = WINDOW_DAYS;

  // ── Deferred, with a reason ────────────────────────────────────────────────
  //
  // Grouped by the attention record's dedupe key, which names the THING rather
  // than the card — the identity the whole lifecycle exists to make stable.
  const byThing = new Map();
  for (const d of defers) {
    if (!d || !d.dedupeKey) continue;
    const age = _days(d.at, now);
    if (age == null || age > cutoff) continue;
    const entry = byThing.get(d.dedupeKey) || { key: d.dedupeKey, title: d.title || null, reasons: [], evidence: [] };
    entry.title = entry.title || d.title || null;
    entry.reasons.push(d.reason || 'unspecified');
    entry.evidence.push({ source: 'attention', ref: d.dedupeKey, observedAt: d.at, detail: `deferred — ${d.reason || 'no reason given'}` });
    byThing.set(d.dedupeKey, entry);
  }

  for (const entry of byThing.values()) {
    if (entry.reasons.length < MIN_DEFERS) continue;
    // The dominant reason, and ONLY when it actually dominates. A thing put off
    // once for each of three different reasons is not a pattern about any of
    // them, and naming one would be inventing the finding.
    const counts = new Map();
    for (const r of entry.reasons) counts.set(r, (counts.get(r) || 0) + 1);
    const [topReason, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const phrase = DEFER_PHRASES[topReason];
    const label = entry.title || 'This';
    const text = phrase && topCount >= MIN_DEFERS
      ? `${label} has been put off ${_times(entry.reasons.length)} ${phrase}.`
      : `${label} has been put off ${_times(entry.reasons.length)}.`;
    insights.push({
      kind: 'deferred',
      text,
      // What makes it true, said out loud. Every insight carries this and the
      // surface renders it — a claim about Nick's week that cannot show its
      // working is exactly what this file refuses to produce.
      because: `${entry.reasons.length} recorded defers${phrase ? `, ${topCount} of them ${topReason}` : ''}`,
      evidence: entry.evidence.slice(0, 4),
      weight: entry.reasons.length,
    });
  }

  // ── Made smaller ───────────────────────────────────────────────────────────
  //
  // Stated as a finding about the WORK. A task shrunk repeatedly is telling you
  // its shape is wrong, which is useful; it is never a mark against the person
  // who kept trying to start it.
  const shrinkSources = [];
  if (session && Number(session.shrinks) > 0) {
    shrinkSources.push({
      title: session.originalText || session.text,
      count: Number(session.shrinks),
      at: session.startedAt || null,
      live: true,
    });
  }
  for (const h of history) {
    if (!h || !Number(h.shrinks)) continue;
    const age = _days(h.endedAt || h.startedAt, now);
    if (age == null || age > cutoff) continue;
    shrinkSources.push({ title: h.originalText || h.text, count: Number(h.shrinks), at: h.endedAt || h.startedAt, live: false });
  }

  const shrinkByTitle = new Map();
  for (const s of shrinkSources) {
    const key = String(s.title || '').trim().toLowerCase();
    if (!key) continue;
    const entry = shrinkByTitle.get(key) || { title: s.title, count: 0, evidence: [] };
    entry.count += s.count;
    entry.evidence.push({
      source: 'focus-session',
      ref: s.title,
      observedAt: s.at,
      detail: `made smaller ${_times(s.count)}${s.live ? ' (session still open)' : ''}`,
    });
    shrinkByTitle.set(key, entry);
  }

  for (const entry of shrinkByTitle.values()) {
    if (entry.count < MIN_SHRINKS) continue;
    insights.push({
      kind: 'shrunk',
      text: `You have made "${entry.title}" smaller ${_times(entry.count)}. It may need a different shape rather than another go.`,
      because: `${entry.count} recorded shrinks on this task`,
      evidence: entry.evidence.slice(0, 4),
      weight: entry.count,
    });
  }

  // ── Stuck on size, right now ───────────────────────────────────────────────
  //
  // The live `needs-smaller` state is its own insight, separate from the count:
  // it is not history, it is where he is, and it has an obvious next move.
  if (session && session.status === 'needs-smaller') {
    insights.push({
      kind: 'needs-smaller',
      text: `"${session.text}" is parked because it is too big as it stands. Naming the smallest next bit is the way back in.`,
      because: 'the open session is in the needs-smaller state',
      evidence: [{ source: 'focus-session', ref: session.text, observedAt: session.startedAt || null, detail: 'session state: needs-smaller' }],
      weight: 3,
    });
  }

  // ── Pulled away ────────────────────────────────────────────────────────────
  //
  // ⚠ ONLY where Nick SAID he stepped away. `noteInterruption` records that
  // something ARRIVED and deliberately leaves the clock running, because NEURO
  // cannot know whether he switched — reading arrivals as interruptions would
  // build a claim about his attention out of other people's timing.
  if (session && Number(session.steppedAway) > 0) {
    insights.push({
      kind: 'stepped-away',
      text: `You were pulled away from "${session.text}" ${_times(Number(session.steppedAway))} since starting it.`,
      because: `${session.steppedAway} step-aways you recorded on this session`,
      evidence: [{ source: 'focus-session', ref: session.text, observedAt: session.startedAt || null, detail: `${session.steppedAway} step-aways` }],
      weight: 2,
    });
  }

  // ── Deliberately NOT here: what someone else owes Nick ─────────────────────
  //
  // `waiting_on` rows used to become insights, and on the live Now page that was
  // FOUR "Naomi to ..." lines under a heading reading "Friction noticed" — 316
  // open rows feeding a five-slot list, two of them 123 days old (there was a
  // minimum age and no maximum, so a commitment from April showed for ever).
  // Removed 31 Aug 2026, on the rule this file already states three lines up:
  //
  //   the evidence does not support the claim. A `waiting_on` row evidences that
  //   somebody said they would do something. It does NOT evidence that Nick is
  //   blocked on it — nothing records that — so presenting it as what got in his
  //   way asserts a fact nothing measured, and does it against a named colleague.
  //   The meeting-prep rule ("never imply a person failed, ignored or promised
  //   something without evidence") is quoted in this file's own comments, and
  //   four rows naming one person under "what got in your way" is exactly it.
  //
  // They have a home already, and a better one: `WaitingOn` on the People board
  // and inside PersonDetail, deliberately pull-only. This was a second, worse
  // copy of that list wearing the wrong label.
  //
  // ⚠ What DOES stay is a defer Nick made himself with the reason
  // `waiting-on-someone` — that is him saying he is blocked, which is an act he
  // performed and NEURO recorded. The distinction is the whole point: his own
  // statement that he cannot proceed is evidence; someone else's outstanding
  // commitment is not.

  insights.sort((a, b) => b.weight - a.weight);

  return {
    // ⚠ No evidence, no insight, and no consolation line in its place. An empty
    // list is a real answer, and a surface that always has something to say
    // about how hard the week was is a surface that gets closed.
    insights: insights.slice(0, MAX_INSIGHTS),
    evidenceCount: defers.length + shrinkSources.length,
    sources: {
      defers: defers.length,
      shrinks: shrinkSources.length,
      liveSession: !!session,
    },
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Gather the evidence and assess it.
 *
 * ⚠ Every source is allowed to fail INDEPENDENTLY and names itself in `gaps`.
 * A friction read that silently drops the defers because the DB hiccuped would
 * report "nothing in your way" over exactly the week worth reading — the same
 * false all-clear the attention pool and the wins ledger both refuse.
 */
function build(now = new Date()) {
  const gaps = [];
  const db = require('../db/database');

  let defers = [];
  try {
    // `deferred` events carry `"<minutes>m — <reason>"` as their detail, which
    // is what the lifecycle writes. Parsed rather than re-derived, because the
    // event IS the record of what Nick said at the time; the record's current
    // `defer_reason` only holds the most recent one.
    defers = db.getAttentionHistory(500)
      .filter((e) => e.event === 'deferred')
      .map((e) => {
        const m = String(e.detail || '').match(/—\s*([a-z-]+)\s*$/);
        return { dedupeKey: e.dedupe_key, title: e.title, reason: m ? m[1] : 'unspecified', at: e.at };
      });
  } catch (e) {
    gaps.push({ source: 'attention-history', why: e.message });
  }

  let session = null;
  let history = [];
  try {
    const focusSession = require('./focus-session');
    session = focusSession.current(now.getTime());
    history = focusSession.history();
  } catch (e) {
    gaps.push({ source: 'focus-session', why: e.message });
  }

  // waiting-on is deliberately not read — see the note in assess().
  const assessed = assess({ defers, session, history }, now);
  return {
    generatedAt: now.toISOString(),
    ...assessed,
    gaps,
    // "Nothing to report" and "I could not look" are different facts and must
    // stay so — an empty insight list under a non-empty `gaps` is the second.
    complete: gaps.length === 0,
  };
}

module.exports = {
  assess,
  build,
  MIN_DEFERS,
  MIN_SHRINKS,
  WINDOW_DAYS,
  MAX_INSIGHTS,
};
