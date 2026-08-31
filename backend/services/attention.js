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
const { resolveSaraLiteTab } = require('../../shared/action-surfaces.cjs');

const SECONDARY_MAX = 3;

// How old a phone reading may be before it stops being "where Nick is". The same
// bar `stress-score` applies to HRV, deliberately reused rather than re-picked.
const PHONE_STALE_HOURS = 6;

// Item types that ARE the queue catching fire, for the firefighting re-rank.
const QUEUE_TYPES = new Set(['escalation', 'nova-flag', 'novaFlag']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Is this pool item personal rather than work?
 *
 * ⚠ Reads the item's own `meta.domain`, which decision-engine carries through
 * from the task — NOT the task store, because `gate()` is PURE and must stay
 * that way. Anything it cannot positively identify as personal is work, the
 * same asymmetry `shared/task-domain.cjs` argues: a personal item treated as
 * work merely stays hidden on a Saturday, while a work item treated as personal
 * would surface on one, which is the thing a day off exists to prevent.
 */
function _isPersonal(item) {
  return isObject(item) && isObject(item.meta) && item.meta.domain === 'personal';
}

function contextCard(id, title, reason) {
  // A context card is the frame, not a job — there is nowhere to route TO, so
  // it stays on the Surface rather than being given a destination it cannot honour.
  return { kind: 'context', id, title, reason, say: reason || null, tab: 'surface', actions: [] };
}

/**
 * The card's reason, said as a sentence instead of listed as fields.
 *
 * `decision-engine` builds `reason` as dot-joined fragments — "Marked high
 * priority · 1 day overdue · 34 other overdue" — which is a data dump, not SARA
 * talking. This composes the same facts from the item's own `meta` into one
 * line in her register: direct, no hedging, no cheerleading.
 *
 * PURE, and composed HERE rather than in each client, or the phone, the kiosk
 * and the notification end up phrasing the same fact three ways.
 *
 * ⚠ It never invents. Anything it cannot phrase from structured `meta` falls
 * back to the engine's own `reason` VERBATIM — a worse sentence is a fair price,
 * a fabricated one is not.
 */
function sayLine(item, now = new Date()) {
  if (!isObject(item)) return null;
  const meta = isObject(item.meta) ? item.meta : {};
  const fallback = item.reason || null;

  if (item.type === 'todo') {
    if (meta.dueDate && Number.isFinite(Number(meta.overdueCount))) {
      const days = _daysBetween(meta.dueDate, now);
      if (days == null) return fallback;
      const over = days <= 0 ? 'It was due today'
        : days === 1 ? "It's a day over"
        : `It's ${days} days over`;
      const rest = Number(meta.overdueCount) - 1;
      if (rest <= 0) return `${over}.`;
      // The verb agrees with the count, not just the noun — "1 other are
      // behind it" is the kind of sentence that stops SARA sounding like a
      // person the moment the pile drops to two.
      const tail = rest === 1 ? '1 other is behind it' : `${rest} others are behind it`;
      return `${over}, and ${tail}.`;
    }
    if (Number.isFinite(Number(meta.dueTodayCount))) {
      const rest = Number(meta.dueTodayCount) - 1;
      return rest > 0 ? `Due today, along with ${rest} more.` : 'Due today.';
    }
    if (Number.isFinite(Number(meta.undatedHighCount))) {
      const n = Number(meta.undatedHighCount);
      return n === 1 ? 'High priority, but nothing has given it a date.'
        : `${n} high-priority tasks, none of them dated.`;
    }
    return fallback;
  }

  if (item.type === 'meeting') {
    // Recomputed from the START, not from the `minutesAway` the collector
    // captured: that number was true when the pool was built, and a card that
    // still says "in 10 minutes" four minutes later is quietly lying. Same rule
    // as the navigation shortcut storing a start rather than a relative time.
    const start = meta.start ? new Date(meta.start) : null;
    if (!start || Number.isNaN(start.getTime())) return fallback;
    const mins = Math.round((start.getTime() - now.getTime()) / 60000);
    const where = meta.location ? `, in ${meta.location}` : '';
    if (mins <= 0) return `It's started${where}.`;
    if (mins === 1) return `Starting in a minute${where}.`;
    if (mins < 60) return `In ${mins} minutes${where}.`;
    const hrs = Math.round(mins / 60);
    return hrs === 1 ? `In about an hour${where}.` : `In about ${hrs} hours${where}.`;
  }

  if (item.type === 'email') {
    // Only the ACTION pile carries a sender. The delegate one does not, and its
    // reason is already a sentence, so it falls through untouched.
    const who = String(meta.from || '').split('<')[0].trim().split(/\s+/)[0];
    if (!who) return fallback;
    const count = Number(meta.count) || 1;
    if (count === 1) return `From ${who}, and it needs an answer.`;
    return `${count} need an answer — the top one is from ${who}.`;
  }

  if (item.type === 'escalation') {
    const list = Array.isArray(meta.escalations) ? meta.escalations : [];
    if (list.length > 1 || Number(meta.overflow) > 0) {
      const total = list.length + (Number(meta.overflow) || 0);
      return `${total} escalations are waiting on a reply from you.`;
    }
    const age = list[0] && Number.isFinite(Number(list[0].ageDays)) ? Number(list[0].ageDays) : null;
    if (age == null) return 'No reply from you on this one yet.';
    return age <= 0 ? 'Raised today, and you have not replied yet.'
      : age === 1 ? 'Raised yesterday, and still no reply from you.'
      : `Raised ${age} days ago, and still no reply from you.`;
  }

  return fallback;
}

/** One sentence-ending mark, never two. */
function _terminate(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Whole days from a YYYY-MM-DD due date to `now`. Local, never toISOString. */
function _daysBetween(dueStr, now) {
  const due = new Date(`${String(dueStr).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  return Math.round((today - due) / 86400000);
}

function itemCard(item, now) {
  return {
    kind: 'item',
    id: item.id,
    type: item.type,
    title: item.title,
    reason: item.reason || null,
    // What SARA actually says about it. `reason` is kept alongside so nothing
    // that wants the raw fields loses them.
    say: sayLine(item, now),
    urgency: item.urgency || null,
    tier: item.tier ?? null,
    score: item.score ?? null,
    actionHint: item.actionHint || null,
    // Where tapping this card goes. Resolved HERE, through the shared resolver,
    // for the same reason `say` is composed here: a card and the notification
    // for the same thing must not land on different tabs, and a client that
    // works it out itself is a copy free to drift. The home-screen widget is
    // the third renderer of this feed and gets the answer rather than a rule.
    tab: resolveSaraLiteTab({ type: item.type }),
    // Carried so the lifecycle can BOUND the action set: an unsuppressable item
    // is exactly what the engine keeps on screen deliberately, and offering a
    // dismiss button it will refuse to honour is worse than not offering one.
    unsuppressable: item._unsuppressable === true,
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
 * @param {Date}   now      passed in, never read from the clock (this stays pure)
 * @returns {{primary: object|null, secondary: Array, dropped: Array, quiet: boolean, speech: string|null, rationale: string}}
 */
function gate(context, items, now = new Date()) {
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
    return itemCard(found, now);
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
      primary = pick((i) => QUEUE_TYPES.has(i.type)) || (kept.length ? itemCard(kept.shift(), now) : null);
      rationale = 'The queue is live, so the queue leads.';
      break;

    case ACTIVITY.IN_FOCUS_SESSION:
      // Protect the session: only a tier-1 interruption earns the screen.
      drop((i) => i.tier === 1, 'a focus session is running — held until it ends');
      primary = kept.length ? itemCard(kept.shift(), now) : contextCard('context-focus-session', ctx.label, ctx.summary);
      rationale = 'A focus session is running, so only a tier-1 interruption gets through.';
      break;

    case ACTIVITY.RITUAL:
      primary = pick((i) => i.type === 'nudge' && (i.meta?.type === 'standup' || i.meta?.type === 'eod'))
        || contextCard('context-ritual', ctx.label, ctx.summary);
      rationale = 'A ritual is outstanding inside its window, so it leads.';
      break;

    case ACTIVITY.OFF:
      // Not a working day. THREE things get through, and the middle one is new:
      //
      //  • whatever the engine marked unsuppressable — an escalation on a
      //    Saturday is still worth knowing about;
      //  • PERSONAL work, which is the entire reason a day off has a feed at
      //    all. NEURO was built around work, so before the domain split there
      //    was nothing a Saturday could honestly surface and the only correct
      //    behaviour was silence. Now the pool can contain things that are
      //    exactly as due on a Saturday as on a Tuesday.
      //
      // This is a POOL SWITCH, not a relaxation of the gate: work is still
      // dropped, and named in `dropped` rather than quietly withheld. The rule
      // that context re-ranks and gates but never ADDS still holds — nothing
      // here invents a candidate, it only changes which of decision-engine's
      // own items survive.
      drop((i) => i._unsuppressable === true || _isPersonal(i), 'not a working day');
      primary = kept.length ? itemCard(kept.shift(), now) : contextCard('context-off', ctx.label, ctx.summary);
      rationale = 'Not a working day, so work is held back and only personal or unsuppressable items get through.';
      break;

    case ACTIVITY.AWAY:
      // Away changes NOTHING — not the ranking, not the speech. It is recorded
      // because it is true, not because it gates anything.
      //
      // ⚠ The first cut claimed "nothing is spoken" here, and was caught on the
      // live box saying exactly that in the same payload as a populated
      // `speech` and `quiet:false` — the layer built to stop NEURO asserting
      // things it had not checked, asserting something it had not checked.
      // Away must not be quiet: presence means "not at home", the phone is in
      // his pocket, and being out is precisely when SARA coming to him is the
      // whole point. Being away is also not a reason to decide the work matters
      // less than it did a minute ago.
      primary = kept.length ? itemCard(kept.shift(), now) : null;
      rationale = 'Away, so the ranking stands and nothing is filtered.';
      break;

    case ACTIVITY.UNKNOWN:
      primary = kept.length ? itemCard(kept.shift(), now) : null;
      rationale = 'The context could not be read, so nothing is filtered — a bad read must not hide work.';
      break;

    default: // STEADY
      primary = kept.length ? itemCard(kept.shift(), now) : null;
      rationale = 'Nothing stood out in the context, so the ranking stands as scored.';
      break;
  }

  if (!mayDrop && activity !== ACTIVITY.UNKNOWN) {
    rationale += ' Confidence is low, so the order was adjusted but nothing was hidden.';
  }

  const secondary = kept.slice(0, SECONDARY_MAX).map((i) => itemCard(i, now));

  // Speech: silence when the context says so, and never for a context card that
  // is only describing the frame — "you're in a focus session" said aloud to
  // someone in a focus session is pure interruption.
  let speech = null;
  if (!quiet && primary && primary.kind === 'item') {
    // Spoken and rendered from the SAME composed line, so the phone never says
    // one thing and reads another. `say` is a full sentence when composed and a
    // bare fragment when it fell back to the engine's `reason` verbatim, so the
    // terminator is added only where one is missing.
    speech = _terminate(primary.title) + (primary.say ? ` ${_terminate(primary.say)}` : '');
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
        // 'graph' = the work diary, 'apple' = the phone. The agenda needs this
        // to answer a personal question with personal events.
        source: r.source || null,
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

/**
 * What is LEFT of today, for a surface with room to show it.
 *
 * PURE, and deliberately separate from the attention pool: an agenda is not a
 * list of things needing a decision, it is the shape of the rest of the day.
 * Feeding meetings into `decision-engine` would make every one of them
 * something to action, which is exactly the nagging this system exists to avoid.
 *
 * ⚠ `known:false` is NOT an empty agenda. "The diary is clear" and "I could not
 * read the diary" license opposite behaviour, and only one of them is good news.
 */
function agendaFor(calendar, now, limit = 4, tomorrow = null, opts = {}) {
  if (!calendar || calendar.known !== true) return { known: false, events: [], scope: 'today' };

  // ⚠ A PERSONAL agenda needs the opposite filter to a work one.
  //
  // The work filter drops all-day and `free` events, because in a work diary
  // those are birthdays and blocked-out noise. In a personal one they are the
  // WHOLE POINT: the three events the phone has pushed so far are two bank
  // holidays and "hiking", every one of them all-day and every one marked free.
  // Applying the work filter to them leaves an empty weekend, which is the
  // failure Nick has already seen twice.
  const personal = opts.personal === true;
  const keep = personal
    ? (e) => !e.isCancelled && e.source === 'apple'
    : (e) => !e.isCancelled && !e.isAllDay && e.showAs !== 'free';

  const nowMs = now.getTime();
  const events = (calendar.events || [])
    .filter(keep)
    .map((e) => {
      const startMs = new Date(e.start).getTime();
      const endMs = new Date(e.end).getTime();
      return { ...e, startMs, endMs };
    })
    .filter((e) => Number.isFinite(e.endMs) && (personal ? e.endMs >= _dayStartMs(now) : e.endMs > nowMs))
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, limit)
    .map((e) => ({
      start: e.start,
      subject: e.subject,
      // Minutes until it STARTS; negative while it is running, which is a
      // different fact from "soon" and the renderer needs to tell them apart.
      minutesAway: Math.round((e.startMs - nowMs) / 60000),
      running: e.startMs <= nowMs,
      // ⚠ An all-day event has NO time. Rendering its 00:00 start as a clock
      // reading produced "hiking - at 00:00", which is the same species as the
      // null countdown printing "0m": a placeholder shown as a fact.
      allDay: e.isAllDay === true,
      attendeesOther: e.attendeesOther,
    }));

  if (events.length) return { known: true, events, scope: 'today' };

  // Nothing left today. By early evening that is the NORMAL state, and a
  // surface that empties out at 17:00 every day is one that stops being looked
  // at — so it rolls forward rather than going blank. `scope` is carried so a
  // renderer never labels tomorrow's meetings as today's.
  if (!Array.isArray(tomorrow) || !tomorrow.length) {
    return { known: true, events: [], scope: 'today' };
  }

  // The FIRST day ahead that has anything, not merely tomorrow. Nick looks at
  // this on a Friday evening, when tomorrow is a Saturday with nothing in it —
  // rolling only one day forward leaves the widget just as empty as before.
  const ahead = tomorrow
    .filter(keep)
    .map((e) => ({ ...e, startMs: new Date(e.start).getTime() }))
    .filter((e) => Number.isFinite(e.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  if (!ahead.length) return { known: true, events: [], scope: 'today' };

  const firstDay = String(ahead[0].start).slice(0, 10);
  const next = ahead
    .filter((e) => String(e.start).slice(0, 10) === firstDay)
    .slice(0, limit)
    .map((e) => ({
      start: e.start,
      subject: e.subject,
      // No countdown across a day boundary: "in 15 hours" is not a useful fact
      // and reads as though it were happening soon.
      minutesAway: null,
      running: false,
      allDay: e.isAllDay === true,
      attendeesOther: e.attendeesOther,
    }));

  if (!next.length) return { known: true, events: [], scope: 'today' };

  // Name the day rather than saying "tomorrow" about a Monday. The renderer
  // shows this verbatim, so the naming happens once, here.
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  const isTomorrow = firstDay === [
    t.getFullYear(),
    String(t.getMonth() + 1).padStart(2, '0'),
    String(t.getDate()).padStart(2, '0'),
  ].join('-');

  const scope = isTomorrow
    ? 'tomorrow'
    : new Date(`${firstDay}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();

  return { known: true, events: next, scope };
}

/**
 * Tomorrow's events, for the agenda's roll-forward only.
 *
 * Deliberately a separate read rather than a wider window on `_calendarInput`:
 * context-state decides "am I in a meeting" and "is one starting soon" from
 * that list, and quietly putting tomorrow in it would change what `current` and
 * `next` mean everywhere. Returns [] on any failure — a roll-forward is a nicety
 * and must never be the thing that breaks the feed.
 */
/** Midnight this morning, as ms. All-day events end at 00:00 the next day. */
function _dayStartMs(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// A full week ahead, not five days.
//
// ⚠ Five was too short for the half of this that matters most. Nick's personal
// diary runs on a WEEKLY rhythm — he hikes every Saturday — so a Sunday looking
// five days forward stopped at Thursday and missed next weekend entirely,
// leaving the personal card blank on the one day he is most likely to look at
// it. Seven reaches the same weekday it is standing on.
//
// It only ever changes what is shown once TODAY is spent, so a longer reach
// costs nothing on a busy day and fills the gap on a quiet one.
const LOOKAHEAD_DAYS = 7;

function _tomorrowEvents(days = LOOKAHEAD_DAYS) {
  try {
    const db = require('../db/database');
    const from = new Date();
    from.setDate(from.getDate() + 1);
    const to = new Date();
    to.setDate(to.getDate() + days);
    const rows = db.getCalendarEvents(_dayStart(from), _dayEnd(to)) || [];
    return rows.map((r) => ({
      start: r.start_time,
      end: r.end_time,
      subject: r.subject,
      showAs: r.show_as,
      isAllDay: r.is_all_day === 1,
      isCancelled: r.show_as === 'cancelled',
      source: r.source || null,
      attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null,
    }));
  } catch (e) {
    return [];
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
      // ⚠ Widened for the session DASHBOARD (`sara-surface.js`). `current()`
      // already computed every one of these, so this is a projection, not a
      // second calculation — the elapsed figure in particular must stay the
      // one focus-session owns, because it is FOCUS time with paused stretches
      // excluded, and a surface re-deriving it from `startedAt` would quietly
      // show wall clock and be wrong the moment Nick is pulled away.
      active: active ? {
        taskTitle: active.text || null,
        startedAt: active.startedAt || null,
        elapsedMinutes: active.elapsedMinutes ?? null,
        plannedMinutes: active.plannedMinutes ?? null,
        // Carried, never dropped: "thirty minutes" and "half an hour because
        // nobody said" are different claims and only one of them is a measurement.
        plannedAssumed: active.plannedAssumed === true,
        remainingMinutes: active.remainingMinutes ?? null,
        overrun: active.overrun === true,
        shrinkCount: Array.isArray(active.shrinks) ? active.shrinks.length : 0,
        stepAways: Array.isArray(active.stepAways) ? active.stepAways.length : 0,
      } : null,
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
    // `known: true` because escalations ARE live — they come straight from Jira
    // via syncEscalations, not from the queue cache that was removed on
    // 27 Aug 2026. `breaching` is no longer supplied: it read
    // `ctx.queueSummary.breaching`, a field working-memory never set, so it was
    // always 0 and this state has only ever been driven by escalations.
    // context-state defaults it to 0, so the shape is unchanged.
    inputs.queue = {
      known: true,
      unseenEscalations: Number(ctx.unseenEscalations) || 0,
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

  // ── Bodies for the dashboards ────────────────────────────────────────────
  //
  // ⚠ These add NO CANDIDATES and change no ranking. `decision-engine` stays the
  // one place something becomes worth surfacing; these are read purely so
  // `sara-surface` can render a dashboard with something in it rather than a
  // heading over the generic pool. Both are LOCAL reads (a `agent_state` blob
  // and the triage blob), so neither puts a network call on a path polled every
  // minute by three surfaces.
  //
  // Each failure is its own NAMED gap and never a silent empty list — a
  // firefighting dashboard showing nothing because the read threw is an
  // all-clear nobody earned.
  try {
    inputs.escalations = { known: true, items: require('./jira').getUnseenEscalations() || [] };
  } catch (e) {
    gaps.push({ input: 'escalations', why: e.message });
    inputs.escalations = { known: false, items: [] };
  }

  try {
    inputs.inbox = { known: true, urgent: require('./email-triage').getUrgentEmails() || [] };
  } catch (e) {
    gaps.push({ input: 'inbox', why: e.message });
    inputs.inbox = { known: false, urgent: [] };
  }

  // Home Assistant is read once and answers TWO inputs. It is the presence
  // source, and it is also the fallback for location — the OwnTracks recorder
  // has not been running (nothing listening on its port), so location was
  // permanently dark while HA knew perfectly well where the phone was.
  // Same shape as `working-days`: live → fallback → unknown, with `source`
  // always naming which one actually answered.
  let phone = null;
  try {
    const ha = require('./ha');
    if (!ha.isConfigured()) {
      gaps.push({ input: 'presence', why: 'Home Assistant not configured' });
      inputs.presence = { known: false };
    } else {
      phone = await ha.getPhoneStatus();
      // ⚠ STALENESS IS THE WHOLE GAME HERE. `/api/states` serves the last known
      // value identically whether it landed a second ago or a month ago, and the
      // Companion app stopped reporting on 22 July 2026 — so HA answered "Office"
      // with a full GPS fix that was 33 DAYS OLD, and the first version of this
      // read it as where Nick was standing. A frozen source that still answers is
      // worse than one that fails, because nothing looks wrong.
      //
      // Six hours is `stress-score`'s bar for the same judgement ("no HRV reading
      // in 6h → stale") rather than a fresh number. Past it the input is UNKNOWN,
      // not false: we do not know where he is, which is a different claim from
      // knowing he is out.
      const stale = phone && Number.isFinite(phone.presenceAgeHours) && phone.presenceAgeHours > PHONE_STALE_HOURS;
      if (stale) phone = { ...phone, presence: null, geocodedLocation: null, _stale: true };

      // `null` presence is unknown, never "not present" — an unreachable HA
      // must not read as Nick having left the building.
      inputs.presence = phone && phone.presence
        ? { known: true, present: phone.presence === 'home' }
        : { known: false };
      if (stale) {
        const days = Math.round(phone.presenceAgeHours / 24);
        gaps.push({ input: 'presence', why: `Home Assistant's phone data is ${days} day${days === 1 ? '' : 's'} stale — the Companion app has stopped reporting` });
      } else if (!phone || !phone.presence) {
        gaps.push({ input: 'presence', why: 'no presence entity reported' });
      }
    }
  } catch (e) {
    gaps.push({ input: 'presence', why: e.message });
    inputs.presence = { known: false };
    phone = null;
  }

  inputs.location = { known: false };
  try {
    const location = require('./location');
    if (!location.isConfigured()) {
      gaps.push({ input: 'location', why: 'OwnTracks not configured' });
    } else {
      const dwells = await location.getCachedDwells();
      const last = Array.isArray(dwells) && dwells.length ? dwells[dwells.length - 1] : null;
      if (last) inputs.location = { known: true, place: last.name || last.label || 'unknown', source: 'owntracks' };
      else gaps.push({ input: 'location', why: 'OwnTracks recorded no dwell today' });
    }
  } catch (e) {
    gaps.push({ input: 'location', why: e.message });
  }

  // Which ROOM, from the BLE fingerprint. Read as a sensor feed, never as a
  // second opinion — it measures, NEURO reasons. Attached to `location` rather
  // than added as a new input block, because "where is he" is one question and
  // the house is simply a finer answer to it than the town.
  //
  // ⚠ It tracks the WATCH: he showered on 31 Aug while it sat on a bedroom
  // surface and it reported `bedroom` for eight minutes. `subject` says so, and
  // nothing downstream may quietly promote that to a claim about the man.
  try {
    const roomPresence = require('./room-presence');
    const r = await roomPresence.read(now);
    if (r.known) {
      inputs.location.room = r.room;
      inputs.location.roomSubject = r.subject;
    } else if (r.why) {
      // Not a gap in `location` — the town-level read may be perfectly fine.
      // Recorded so "no room" is never mistaken for "no sensors".
      inputs.location.roomWhy = r.why;
    }
  } catch (e) {
    inputs.location.roomWhy = e.message;
  }

  // The HA fallback inherits the same freshness rule by construction: a stale
  // `phone` has had its presence nulled above, so this cannot fire on it.
  if (!inputs.location.known && phone && phone.presence) {
    // HA's `person` entity is home / not_home / a zone name. A zone name is a
    // real place; `not_home` is only ever the absence of one, so it maps to
    // 'away' rather than being reported as somewhere Nick is.
    const p = String(phone.presence).toLowerCase();
    const place = p === 'home' ? 'home'
      : p === 'not_home' ? (phone.geocodedLocation || 'away')
      : phone.presence;
    inputs.location = { known: true, place, source: 'home-assistant' };
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
async function build({ now = new Date(), view = null, ask = null } = {}) {
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

  // ── Snoozed by Nick ────────────────────────────────────────────────────────
  //
  // ⚠ A deferral has to actually take a card off the surface, and until 31 Aug
  // 2026 it did not: the pool is recomputed every poll and the lifecycle record
  // was only STAMPED onto the resulting card, so "Not now" recorded a deferral
  // and changed nothing anybody could see. On a card the engine marks
  // unsuppressable — an imminent meeting, an escalation — `dismiss` is
  // deliberately withheld, so NO button on it could clear it at all.
  //
  // Filtered before the gate rather than after, so `primary`, `speech` and the
  // rationale are all computed against what is actually being shown. The full
  // pool is still used for the lifecycle reconcile below, so a snoozed record
  // keeps being touched and cannot be aged out by the sweep while it waits.
  //
  // Fails OPEN: if the lifecycle cannot be read, the card is shown. Hiding work
  // on a failed bookkeeping read is the one direction this layer must not err.
  let visible = items;
  const snoozed = [];
  try {
    const lifecycle = require('./attention-lifecycle');
    lifecycle.releaseDeferrals(now);
    const held = lifecycle.deferredKeys(now);
    if (held.size > 0) {
      visible = items.filter((item) => {
        const entry = held.get(lifecycle.dedupeKeyFor(item));
        if (!entry) return true;
        // Named, never silently withheld — `dropped` is the contract for that.
        snoozed.push({
          id: item.id,
          type: item.type,
          why: `you put this off (${entry.reason})${entry.until ? ` until ${entry.until}` : ''}`,
        });
        return false;
      });
    }
  } catch (e) {
    gaps.push({ input: 'attention-deferrals', why: e.message });
  }

  const gated = gate(context, visible, now);
  gated.dropped = [...gated.dropped, ...snoozed];

  // ── Ambient observations ──────────────────────────────────────────────────
  //
  // What SARA can notice about Nick's body and his day: sat still a long time,
  // no exercise for three days, a health trend against his own baseline, nothing
  // logged for food when he normally logs it.
  //
  // ⚠ Carried BESIDE the pool, never through the gate, and deliberately so.
  // `decision-engine` stays the one place something becomes worth surfacing and
  // this adds no candidates to it — an observation is a fact about right now,
  // not a thing to decide about, and routing it through the pool would make
  // "you've been sitting for two hours" compete with a breaching escalation for
  // the primary slot.
  //
  // ⚠ NOTHING HERE NOTIFIES. Pull only. Six new interruption sources is how SARA
  // becomes a pest and gets muted, and nudge volume is the one budget allowed to
  // argue against building more. It is rendered where he is already looking.
  //
  // Never allowed to fail the payload: a broken sensor read must not take the
  // whole attention feed down with it.
  let ambient = null;
  try {
    ambient = await require('./ambient').build({ now, context });
  } catch (e) {
    gaps.push({ input: 'ambient', why: e.message });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  //
  // The gated feed is reconciled against durable records so a card can be
  // acknowledged, deferred and re-surfaced rather than recomputed from nothing
  // on every poll. Contract: docs/attention-contract.md.
  //
  // ⚠ Held items are reconciled TOO. The gate drops work in a meeting or on a
  // day off, and a dropped item is held, not gone — without refreshing its
  // sighting a three-hour meeting would age the entire board out from under
  // Nick, which is the false all-clear this layer exists to prevent.
  //
  // ⚠ And it is never allowed to fail the feed. The lifecycle is bookkeeping;
  // the feed is the product. A DB hiccup must cost the record, not the answer.
  let attentionBlock = { version: 'v1', available: false, why: 'not reconciled', records: [] };
  try {
    const lifecycle = require('./attention-lifecycle');
    lifecycle.releaseDeferrals(now);

    const surfacedIds = new Set(
      [gated.primary, ...gated.secondary].filter((c) => c && c.kind === 'item').map((c) => c.id)
    );
    const held = items.filter((i) => !surfacedIds.has(i.id)).map((i) => itemCard(i, now));

    const records = lifecycle.reconcile([gated.primary, ...gated.secondary], {
      now,
      confidence: context.confidence || null,
      held,
    });
    lifecycle.sweep({ now, poolAvailable: poolError === null });

    // The record id is stamped onto the card the surfaces already render, so a
    // client can act on what it is looking at without a second lookup — and so
    // the widget, the Surface and the notification all name the same record.
    const byKey = new Map(records.map((r) => [r.dedupe_key, r]));
    const stamp = (card) => {
      if (!card || card.kind !== 'item') return card;
      const row = byKey.get(lifecycle.dedupeKeyFor(card));
      if (!row) return card;
      return {
        ...card,
        recordId: row.id,
        state: row.state,
        evidence: lifecycle.present(row).evidence,
        actions: lifecycle.present(row).actions,
      };
    };
    gated.primary = stamp(gated.primary);
    gated.secondary = gated.secondary.map(stamp);
    attentionBlock = { version: 'v1', available: true, records: records.map(lifecycle.present) };
  } catch (e) {
    console.warn('[Attention] lifecycle reconcile failed:', e.message);
    attentionBlock = { version: 'v1', available: false, why: e.message, records: [] };
  }

  // The week's task target, composed server-side with its own words, like `say`
  // and `speech`. It rides here rather than being fetched separately so the
  // ring, the Surface and any later notification cannot phrase one fact three
  // ways — and so a lock-screen widget costs one request, not two.
  //
  // ⚠ Its failures are carried ON THE BLOCK (`state:'unknown'`) and deliberately
  // NOT pushed into `gaps`: that array counts inputs to the DECISION POOL, and
  // the widget renders its length as "N unreadable". A weekly-target hiccup is
  // not a hole in what needs Nick's attention, and inflating that count is how a
  // number stops meaning anything.
  let weeklyTarget;
  try {
    weeklyTarget = require('./weekly-target').snapshot(now);
  } catch (e) {
    weeklyTarget = {
      known: false,
      state: 'unknown',
      why: e.message,
      say: "Couldn't count this week's tasks.",
    };
  }

  // The body reading, composed here for the same reason `weeklyTarget` is.
  //
  // ⚠ This exists because the WIDGET WAS MAKING SIX REQUESTS A REFRESH and
  // quietly losing one: `fetchHealth` folded any failure into null, so a slow
  // radio inside a widget's execution budget silently removed the gauge while
  // leaving everything around it intact. A missing dial reads as "no data"
  // rather than "the request never finished", which is the same false-silence
  // this whole layer exists to avoid.
  //
  // Both halves are optional and INDEPENDENT: the score is what the gauge
  // needs, the week of HRV only decorates it, so a failure in one must never
  // remove the other. That coupling was the second half of the bug.
  let readiness = { known: false, why: 'not read' };
  try {
    const score = require('./stress-score').computeStressScore();
    let hrvWeek = [];
    try {
      hrvWeek = (require('./health-daily').recentDays(7) || [])
        .map((day) => Number(day.hrvMedian))
        .filter((v) => Number.isFinite(v))
        .reverse();
    } catch (e) {
      hrvWeek = [];
    }
    readiness = { known: true, ...score, hrvWeek };
  } catch (e) {
    readiness = { known: false, why: e.message };
  }

  // The seam of the day, if this is one. PURE, composed server-side like `say`
  // and `speech`, so the phone, the kiosk and the widget cannot phrase the same
  // transition three ways — and so the decision about whether NOW is a moment to
  // prompt is made once, by the brain.
  //
  // ⚠ It PROPOSES and never acts: no timer starts, no calendar is written, no
  // task is completed. And an unreadable diary yields no transition at all
  // rather than falling through to "nothing coming up".
  let transition = null;
  try {
    let recovery = null;
    try { recovery = require('./focus-session').recovery(); } catch { recovery = null; }
    transition = require('./transitions').nextTransition({
      calendar: inputs.calendar,
      recovery,
      now,
    });
  } catch (e) {
    // A transition is a nicety on top of the feed. It must never be the reason
    // the feed fails.
    console.warn('[Attention] transition failed:', e.message);
    transition = null;
  }

  // ⚠ Composed LAST, from the payload this function has just assembled, and
  // deliberately never allowed to fail the feed. SARA showing the wrong
  // dashboard is a bad afternoon; SARA showing nothing is the outage the whole
  // honesty model exists to make visible, and a framing layer must not be able
  // to cause one. A null `surface` reads to every client as "render the feed the
  // way you did before this existed", which is exactly the right degradation.
  let framed = null;
  try {
    const draft = {
      context,
      weeklyTarget,
      ...gated,
      agenda: agendaFor(inputs.calendar, now, 4, _tomorrowEvents(), {
        personal: context.duty ? context.duty.onDuty === false : false,
      }),
      poolAvailable: poolError === null,
      gaps,
      escalations: inputs.escalations,
      inbox: inputs.inbox,
    };
    framed = require('./sara-surface').compose(draft, {
      session: inputs.focusSession && inputs.focusSession.active ? inputs.focusSession.active : null,
      ask,
    });
  } catch (e) {
    console.warn('[Attention] surface composition failed:', e.message);
    framed = null;
  }

  return {
    generatedAt: now.toISOString(),
    context,
    weeklyTarget,
    readiness,
    transition,
    ambient,
    ...gated,
    // ── What she SHOWS, and what he could SAY ────────────────────────────
    // Nick, 31 Aug 2026: SARA is a manifestation, not a menu — "a series of
    // dashboards, and everything she can do should be achievable
    // conversationally". Both halves are composed server-side beside `say`,
    // `speech` and `tab`, for the same reason those are: three surfaces render
    // one decision and must not each invent a fourth thing about it.
    //
    // ⚠ ADDITIVE. Every field this payload returned before is unchanged, so the
    // Scriptable widget — which reads `say`/`speech`/`tab` and nothing else —
    // keeps working untouched.
    surface: framed ? framed.surface : null,
    dashboard: framed ? framed.dashboard : null,
    // Non-null when the DASHBOARD moved because he asked, rather than because
    // the day did. A surface that changes under him with no explanation is the
    // dishonest half of being adaptive.
    askedSurface: framed ? framed.askedSurface : null,
    utterances: framed ? framed.utterances : [],
    // The lifecycle view of the same decision. Additive: every field this
    // payload returned before is unchanged and still means the same thing, which
    // is what lets the widget and the kiosk be migrated separately.
    attention: attentionBlock,
    // The rest of the day, for surfaces with room. Not part of the pool: an
    // agenda is the shape of the day, not a list of things to decide about.
    // Tomorrow is read SEPARATELY and passed in, rather than widening
    // `_calendarInput`'s window — context-state reasons about "am I in a
    // meeting" off that same list, and tomorrow's events in it would be a
    // silent change to what "current" and "next" mean.
    // Off duty he gets his OWN diary, not the work one. The duty read is the
    // brain's, already resolved above, so the agenda cannot disagree with the
    // rest of the payload about which kind of day this is.
    //
    // ⚠ `view` OVERRIDES that, and exists for exactly one reason: a widget in a
    // Smart Stack can be pinned to a view, and a pinned personal card showing
    // work meetings under a personal heading would be the thing the whole
    // domain split exists to prevent. It changes only which DIARY is read —
    // never the duty read itself, which stays the brain's and is still reported
    // on `context` for anything that needs to know what kind of day it is.
    agenda: agendaFor(inputs.calendar, now, 4, _tomorrowEvents(), {
      // `flip` is the OPPOSITE of whatever the brain just decided, and it exists
      // for the second card in a Smart Stack: the top one follows the context,
      // the one beneath it is always the other side. It is resolved HERE rather
      // than in the widget because the duty read is the brain's — a client
      // inverting its own guess would be a second opinion about what kind of
      // day it is.
      personal: view === 'personal' ? true
        : view === 'work' ? false
          : view === 'flip' ? !(context.duty ? context.duty.onDuty === false : false)
            : (context.duty ? context.duty.onDuty === false : false),
    }),
    // What was asked for, echoed back, so a client can tell a pinned view from
    // the brain's own choice rather than inferring it — and, for `flip`, which
    // side that actually landed on, so the card can label itself honestly
    // instead of showing the word "flip" to a reader it means nothing to.
    view: view || 'auto',
    viewResolved: (() => {
      const brainOff = context.duty ? context.duty.onDuty === false : false;
      if (view === 'personal') return 'personal';
      if (view === 'work') return 'work';
      if (view === 'flip') return brainOff ? 'work' : 'personal';
      return brainOff ? 'personal' : 'work';
    })(),
    // A failed pool is a GAP, never an empty feed presented as a calm day.
    poolAvailable: poolError === null,
    poolSize: items.length,
    gaps,
  };
}

module.exports = { build, gather, gate, sayLine, agendaFor, SECONDARY_MAX };
