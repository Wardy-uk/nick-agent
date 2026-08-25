'use strict';

/**
 * Attention — the one thing SARA should surface right now.
 *
 * NEURO is the brain: it collates and directs. SARA is the voice, ears and eyes,
 * and comes to Nick rather than waiting to be navigated. That makes THIS the
 * feed both SARA surfaces render — one primary thing, its spoken form, and the
 * honest reason it won.
 *
 * ── The rule that keeps this from becoming a second decision engine ──────────
 * Context RE-RANKS and GATES. It never ADDS candidates. `decision-engine` stays
 * the single place something becomes worth surfacing, with the dismiss, snooze
 * and category-suppression it has already learned. All this layer decides is
 * which of that pool fits the moment — and whether to say anything at all.
 *
 * The one exception is deliberate and is not a candidate: when the context
 * itself is the answer ("you're in a meeting", "you're in a focus session"),
 * the primary is a CONTEXT card. It carries no work and claims none; it is SARA
 * describing the frame, not proposing a job. `kind` distinguishes the two so no
 * consumer can mistake one for the other.
 *
 * ── Silence is a correct answer ─────────────────────────────────────────────
 * An ambient surface that always has something to say is a nudge machine, and
 * nudge volume is the one signal allowed to argue against building more. In a
 * meeting SARA says nothing. `primary: null` is a valid result, not a failure.
 *
 * ── Confidence decides how much we are allowed to HIDE ───────────────────────
 * Two different powers, two different bars:
 *   * QUIET (don't speak) follows the context and fails towards silence — the
 *     cost of a wrong silence is a thing Nick finds a minute later.
 *   * DROPPING (hide work) requires a confident read. A low-confidence context
 *     may still re-order, but it must never remove anything, because hiding
 *     real work on a bad guess is the failure that ends the feature. This is
 *     `state-of-play`'s "a board opening with false warnings is one nobody
 *     reads by week two", pointed the other way.
 *
 * Nothing here is dropped silently — `dropped` names every item and why.
 *
 * ── Why the speech is deterministic ─────────────────────────────────────────
 * No model call. This is polled continuously by two surfaces and has to be
 * instant and work with the Pi offline — `event-parser`'s regex-first rule. The
 * card already carries wording written for a human; rephrasing it through a
 * model would spend latency to make it less predictable, not more useful.
 *
 * CommonJS only — NEURO backend convention.
 */

const { resolveContext, ACTIVITY } = require('./context-state');

const SECONDARY_MAX = 3;

// Item types that ARE the queue catching fire, for the firefighting re-rank.
const QUEUE_TYPES = new Set(['escalation', 'nova-flag', 'novaFlag']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function contextCard(id, title, reason) {
  return { kind: 'context', id, title, reason, actions: [] };
}

function itemCard(item) {
  return {
    kind: 'item',
    id: item.id,
    type: item.type,
    title: item.title,
    reason: item.reason || null,
    urgency: item.urgency || null,
    tier: item.tier ?? null,
    score: item.score ?? null,
    actionHint: item.actionHint || null,
    meta: item.meta || null,
  };
}

/**
 * Decide what SARA surfaces, given a context and the decision-engine pool.
 *
 * PURE — no DB, no clock, no I/O. The gating IS the product, so it pins without
 * a Pi or a vault (the `pi-health.assess()` / `state-of-play.assess()` split).
 *
 * @param {object} context  from context-state.resolveContext
 * @param {Array}  items    decision-engine items, already ranked
 * @returns {{primary: object|null, secondary: Array, dropped: Array, quiet: boolean, speech: string|null, rationale: string}}
 */
function gate(context, items) {
  const pool = Array.isArray(items) ? items.filter(isObject) : [];
  const ctx = isObject(context) ? context : { activity: ACTIVITY.UNKNOWN, confidence: { level: 'low' } };
  const activity = ctx.activity || ACTIVITY.UNKNOWN;
  const quiet = ctx.quiet === true;

  // May this read remove work from the screen? Only on a confident one.
  const mayDrop = ctx.confidence?.level !== 'low' && activity !== ACTIVITY.UNKNOWN;

  const dropped = [];
  let kept = pool;
  let primary = null;
  let rationale;

  function drop(predicate, why) {
    if (!mayDrop) return;
    const next = [];
    for (const item of kept) {
      if (predicate(item)) next.push(item);
      else dropped.push({ id: item.id, type: item.type, why });
    }
    kept = next;
  }

  // Pick the first pool item matching a predicate, so a context-driven primary
  // is still a REAL candidate wherever one exists rather than a card invented
  // beside the pool.
  function pick(predicate) {
    const found = kept.find(predicate);
    if (!found) return null;
    kept = kept.filter((i) => i !== found);
    return itemCard(found);
  }

  switch (activity) {
    case ACTIVITY.IN_MEETING:
      // The one state where speaking up is wrong by default. Nothing is
      // surfaced; nothing is lost — it is all in `dropped` and the pool is
      // unchanged underneath.
      drop(() => false, 'in a meeting — SARA stays out of the way');
      primary = contextCard('context-in-meeting', ctx.label, ctx.summary);
      rationale = 'In a meeting, so nothing is surfaced and nothing is spoken.';
      break;

    case ACTIVITY.PRE_MEETING:
      primary = pick((i) => i.type === 'meeting') || contextCard('context-pre-meeting', ctx.label, ctx.summary);
      rationale = 'A meeting starts shortly, so prep leads whatever else is ranked.';
      break;

    case ACTIVITY.FIREFIGHTING:
      primary = pick((i) => QUEUE_TYPES.has(i.type)) || (kept.length ? itemCard(kept.shift()) : null);
      rationale = 'The queue is live, so the queue leads.';
      break;

    case ACTIVITY.IN_FOCUS_SESSION:
      // Protect the session: only a tier-1 interruption earns the screen.
      drop((i) => i.tier === 1, 'a focus session is running — held until it ends');
      primary = kept.length ? itemCard(kept.shift()) : contextCard('context-focus-session', ctx.label, ctx.summary);
      rationale = 'A focus session is running, so only a tier-1 interruption gets through.';
      break;

    case ACTIVITY.RITUAL:
      primary = pick((i) => i.type === 'nudge' && (i.meta?.type === 'standup' || i.meta?.type === 'eod'))
        || contextCard('context-ritual', ctx.label, ctx.summary);
      rationale = 'A ritual is outstanding inside its window, so it leads.';
      break;

    case ACTIVITY.OFF:
      // Not a working day. Only what the engine itself marked unsuppressable —
      // an escalation on a Saturday is still worth knowing about.
      drop((i) => i._unsuppressable === true, 'not a working day');
      primary = kept.length ? itemCard(kept.shift()) : contextCard('context-off', ctx.label, ctx.summary);
      rationale = 'Not a working day, so only what cannot be suppressed gets through.';
      break;

    case ACTIVITY.AWAY:
      // Ranking is untouched — being away is a reason not to SPEAK, not a
      // reason to decide the work is less important than it was.
      primary = kept.length ? itemCard(kept.shift()) : null;
      rationale = 'Away, so the ranking stands but nothing is spoken.';
      break;

    case ACTIVITY.UNKNOWN:
      primary = kept.length ? itemCard(kept.shift()) : null;
      rationale = 'The context could not be read, so nothing is filtered — a bad read must not hide work.';
      break;

    default: // STEADY
      primary = kept.length ? itemCard(kept.shift()) : null;
      rationale = 'Nothing stood out in the context, so the ranking stands as scored.';
      break;
  }

  if (!mayDrop && activity !== ACTIVITY.UNKNOWN) {
    rationale += ' Confidence is low, so the order was adjusted but nothing was hidden.';
  }

  const secondary = kept.slice(0, SECONDARY_MAX).map(itemCard);

  // Speech: silence when the context says so, and never for a context card that
  // is only describing the frame — "you're in a focus session" said aloud to
  // someone in a focus session is pure interruption.
  let speech = null;
  if (!quiet && primary && primary.kind === 'item') {
    speech = primary.reason ? `${primary.title}. ${primary.reason}.` : `${primary.title}.`;
    speech = speech.replace(/\.\.+$/, '.');
  }

  return { primary, secondary, dropped, quiet, speech, rationale };
}

// ── Gathering the inputs ─────────────────────────────────────────────────────
// Every read is independent and every failure is a GAP, never a zero. A block
// that could not be read comes back `{known:false}` so context-state counts it
// as unknown and lowers confidence, rather than silently reading as "nothing
// there" (`wins`'s rule, and `weekly-risk`'s null-not-zero).

function _calendarInput(gaps) {
  try {
    const db = require('../db/database');
    const total = db.get('SELECT COUNT(*) AS n FROM calendar_cache')?.n || 0;
    // An empty cache is "we cannot see the diary", not "you have no meetings" —
    // the same distinction time-fit draws with `calendarKnown`.
    if (!total) {
      gaps.push({ input: 'calendar', why: 'calendar cache is empty' });
      return { known: false };
    }
    const now = new Date();
    const from = _dayStart(now);
    const to = _dayEnd(now);
    const rows = db.getCalendarEvents(from, to) || [];
    return {
      known: true,
      events: rows.map((r) => ({
        start: r.start_time,
        end: r.end_time,
        subject: r.subject,
        showAs: r.show_as,
        isAllDay: r.is_all_day === 1,
        isCancelled: r.show_as === 'cancelled',
        // Three-valued in the column and three-valued here. NULL must stay
        // undecidable — context-state requires exactly `true` to call it a
        // meeting, so an unknown can never be announced as one.
        attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null,
      })),
    };
  } catch (e) {
    gaps.push({ input: 'calendar', why: e.message });
    return { known: false };
  }
}

function _dayStart(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00`;
}
function _dayEnd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T23:59`;
}

async function gather(now = new Date()) {
  const gaps = [];
  const inputs = {};

  inputs.calendar = _calendarInput(gaps);

  try {
    const session = require('./focus-session').current();
    // A STALE session is not a running one — #89's rule: a session that ran away
    // or crossed midnight is a question to settle, not proof Nick is heads-down.
    // Treating it as live would protect the screen from interruption on the
    // strength of a session nobody is in.
    const active = session && session.status === 'active' && !session.stale ? session : null;
    inputs.focusSession = {
      known: true,
      active: active ? { taskTitle: active.text || null, startedAt: active.startedAt || null } : null,
    };
  } catch (e) {
    gaps.push({ input: 'focusSession', why: e.message });
    inputs.focusSession = { known: false };
  }

  let ctx = null;
  try {
    ctx = await require('./working-memory').getContext();
  } catch (e) {
    gaps.push({ input: 'working-memory', why: e.message });
  }

  if (ctx) {
    inputs.queue = {
      known: true,
      unseenEscalations: Number(ctx.unseenEscalations) || 0,
      breaching: Number(ctx.queueSummary?.breaching) || 0,
    };
    inputs.rituals = {
      known: true,
      standupOutstanding: ctx.standupDone === false,
      eodOutstanding: ctx.eodDone === false,
    };
  } else {
    inputs.queue = { known: false };
    inputs.rituals = { known: false };
  }

  try {
    const location = require('./location');
    if (!location.isConfigured()) {
      gaps.push({ input: 'location', why: 'OwnTracks not configured' });
      inputs.location = { known: false };
    } else {
      const dwells = await location.getCachedDwells();
      const last = Array.isArray(dwells) && dwells.length ? dwells[dwells.length - 1] : null;
      inputs.location = last
        ? { known: true, place: last.name || last.label || 'unknown', source: 'owntracks' }
        : { known: false };
      if (!last) gaps.push({ input: 'location', why: 'no dwell recorded today' });
    }
  } catch (e) {
    gaps.push({ input: 'location', why: e.message });
    inputs.location = { known: false };
  }

  try {
    const ha = require('./ha');
    if (!ha.isConfigured()) {
      gaps.push({ input: 'presence', why: 'Home Assistant not configured' });
      inputs.presence = { known: false };
    } else {
      const phone = await ha.getPhoneStatus();
      // `null` presence is unknown, never "not present" — an unreachable HA
      // must not read as Nick having left the building.
      inputs.presence = phone && phone.presence
        ? { known: true, present: phone.presence === 'home' }
        : { known: false };
      if (!phone || !phone.presence) gaps.push({ input: 'presence', why: 'no presence entity reported' });
    }
  } catch (e) {
    gaps.push({ input: 'presence', why: e.message });
    inputs.presence = { known: false };
  }

  try {
    const workingDays = require('./working-days');
    const holidays = workingDays.holidaySet();
    inputs.workingDay = {
      known: true,
      isWorkingDay: workingDays.isWorkingDay(now, holidays),
      reason: workingDays.nonWorkingReason(now, holidays),
    };
  } catch (e) {
    gaps.push({ input: 'workingDay', why: e.message });
    inputs.workingDay = { known: false };
  }

  return { inputs, gaps };
}

/**
 * Build the attention feed. This is what both SARA surfaces render.
 */
async function build({ now = new Date() } = {}) {
  const { inputs, gaps } = await gather(now);
  const context = resolveContext(inputs, now);

  let items = [];
  let poolError = null;
  try {
    const result = await require('./decision-engine').evaluate();
    items = Array.isArray(result?.items) ? result.items : [];
  } catch (e) {
    poolError = e.message;
    gaps.push({ input: 'decision-engine', why: e.message });
  }

  const gated = gate(context, items);

  return {
    generatedAt: now.toISOString(),
    context,
    ...gated,
    // A failed pool is a GAP, never an empty feed presented as a calm day.
    poolAvailable: poolError === null,
    poolSize: items.length,
    gaps,
  };
}

module.exports = { build, gather, gate, SECONDARY_MAX };
