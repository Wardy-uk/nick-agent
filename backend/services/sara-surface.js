'use strict';

/**
 * What SARA SHOWS, and what Nick could SAY next.
 *
 * ⚠ WHY THIS EXISTS. Nick, 31 Aug 2026, on what SARA actually is:
 *
 *   "if we start with the principle that SARA is a manifestation so shouldn't be
 *    bogged down in menus — she should be a series of dashboards, and everything
 *    she can do should be achievable conversationally. She should adapt what
 *    she's showing me, but she isn't a click here to do this interface... we
 *    should allow that when I can't speak to her, but that's the principle."
 *
 * Three things follow, and this module is all three:
 *
 *   1. THE DASHBOARD IS AN ANSWER, NOT A DESTINATION. It changes because the
 *      situation changed or because he asked something — never because he went
 *      looking. So which one to show is a DECISION, and decisions are composed
 *      here, server-side, beside `say` / `speech` / `tab`. Three surfaces
 *      already render one attention decision; they must not each invent a
 *      fourth thing about it.
 *   2. EVERY ACTION IS A SENTENCE. `utterances` are the literal words — "make it
 *      smaller", "not now, an hour", "that's done" — each carrying a STRUCTURED
 *      intent so no client ever parses language. The mute path and the spoken
 *      path are then one vocabulary rather than two competing ones.
 *   3. THE BUTTONS ARE THE FALLBACK, NOT THE PRODUCT. They exist for when he
 *      cannot speak, which is why every one of them reads as the thing he would
 *      have said.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No DB, no clock, no I/O, no fetching. It takes the payload `attention.build()`
 * already assembled and returns a view of it — the `pi-health.assess()` /
 * `state-of-play.assess()` / `context-state` split, for the same reason: the
 * decision IS the product, so it has to pin without a Pi, a vault or a network.
 *
 * ⚠ IT ADDS NO CANDIDATES AND RE-RANKS NOTHING. `decision-engine` stays the one
 * place something becomes worth surfacing and `attention.gate()` the one place
 * it is filtered. This only decides how to FRAME what those two already
 * decided. That boundary is not stylistic: `sara/backend/src/state/inference.js`
 * was retired for computing its own activity enum, confidence model and
 * recommended-view map — a second brain — and the strip that rendered its
 * suggestion was removed for putting a second account of Nick's state on screen
 * beside the canonical one. The difference here is that there is ONE brain, the
 * choice is RENDERED rather than advised, and `surface` follows
 * `context.activity` rather than re-deriving it.
 *
 * ⚠ NOTHING HERE LEAVES THE BUILDING. No utterance sends an email, books a
 * meeting, or chases a person. Those all queue behind the approval gate on the
 * desktop, and `action-presenter` is the one place that judges what counts as
 * outbound. An ambient surface that can send is an ambient surface that can send
 * by accident.
 *
 * CommonJS.
 */

// The bounded surface set. One per situation, and adding one is a deliberate
// act — this is a fixed list, never derived from the data, or a screen nobody
// designed appears the first time an input takes an unexpected shape.
const SURFACES = {
  BLIND: 'blind',
  IN_MEETING: 'in-meeting',
  FIREFIGHTING: 'firefighting',
  PRE_MEETING: 'pre-meeting',
  SESSION: 'session',
  RITUAL: 'ritual',
  OFF_DUTY: 'off-duty',
  STEADY: 'steady',
  // Reachable only by ASKING. It has no activity of its own — "what's in my
  // inbox" is a question, not a situation — which is exactly why the dashboards
  // and the activities are not the same list.
  INBOX: 'inbox',
};

// context-state's activity → the surface that frames it. A DIRECT MAP, on
// purpose: the moment this starts adding conditions of its own it has become a
// second opinion about what kind of moment this is.
const BY_ACTIVITY = {
  'in-meeting': SURFACES.IN_MEETING,
  'pre-meeting': SURFACES.PRE_MEETING,
  firefighting: SURFACES.FIREFIGHTING,
  'in-focus-session': SURFACES.SESSION,
  ritual: SURFACES.RITUAL,
  off: SURFACES.OFF_DUTY,
  away: SURFACES.STEADY,
  steady: SURFACES.STEADY,
  unknown: SURFACES.STEADY,
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Which dashboard frames this moment. PURE.
 *
 * ⚠ Exactly ONE thing outranks the activity: an unreadable pool. A dashboard
 * drawn over work SARA could not see is a confident picture of a day nobody
 * read — the failure every honesty rule in this codebase exists to prevent. So
 * `blind` wins outright, and it is the only override.
 *
 * ⚠ An UNRECOGNISED activity resolves to `steady`, never to nothing. A missing
 * surface renders as a blank screen, and "silence is a valid answer for a
 * notification; it is never one for a screen".
 */
function surfaceFor(payload) {
  if (!isObj(payload)) return SURFACES.BLIND;
  if (payload.poolAvailable === false) return SURFACES.BLIND;
  const activity = payload.context && payload.context.activity;
  return BY_ACTIVITY[activity] || SURFACES.STEADY;
}

/**
 * Which dashboard a QUESTION implies. PURE, deterministic, no model call.
 *
 * ⚠ WHY THIS EXISTS. Nick's principle is that everything she can do should be
 * achievable conversationally, and until now asking her something streamed an
 * answer and left the screen showing whatever it was showing. So "what have I
 * got on" produced words where it should produce words AND the day — which made
 * the conversation a chat window sitting on top of a dashboard, rather than the
 * thing that drives it.
 *
 * ⚠ DETERMINISTIC ON PURPOSE — `event-parser`'s regex-first rule. This runs on
 * a path polled by three surfaces and has to be instant, free, identical every
 * time, and work with the Pi's models offline. A model call to decide which
 * panel to draw would spend latency making the screen less predictable.
 *
 * ⚠ NO MATCH RETURNS NULL, and null means "leave the dashboard where it is".
 * Guessing a panel from a question it does not understand is how she starts
 * answering a different question from the one asked — and the streamed answer
 * is still shown either way, so a miss costs nothing.
 */
const ASK_ROUTES = [
  { re: /\b(inbox|e-?mails?|mail)\b/i, surface: SURFACES.INBOX },
  { re: /\b(escalat\w*|breach\w*|on fire|firefight\w*)\b/i, surface: SURFACES.FIREFIGHTING },
  { re: /\b(diary|calendar|agenda|schedule|meetings?|got on|my day|today)\b/i, surface: SURFACES.STEADY },
  { re: /\b(finish\w*|done|wins?|this week|target|progress)\b/i, surface: SURFACES.OFF_DUTY },
  { re: /\b(session|focus|smaller|stuck)\b/i, surface: SURFACES.SESSION },
];

function surfaceForQuestion(text) {
  const q = typeof text === 'string' ? text.trim() : '';
  if (!q) return null;
  for (const r of ASK_ROUTES) if (r.re.test(q)) return r.surface;
  return null;
}

// ── Dashboard rows ──────────────────────────────────────────────────────────
//
// One uniform row shape across every dashboard, so a client renders any of them
// without a switch per kind. A renderer that knows the kinds is a renderer that
// has to be edited every time a dashboard is added.
function row(when, what, opts = {}) {
  return {
    when: when === null || when === undefined ? null : String(when),
    what: String(what),
    meta: opts.meta ? String(opts.meta) : null,
    // The evidence line. Meeting prep's rule, generalised: a row whose source
    // is unknown must not look identical to a sourced one.
    note: opts.note ? String(opts.note) : null,
    level: opts.level || null, // null | 'warn' | 'crit'
  };
}

function timeOf(event) {
  const s = event && (event.start || event.startTime || event.when);
  if (typeof s !== 'string') return null;
  // ⚠ SLICED out of the string, never parsed into a Date. The backend already
  // asked Graph for Europe/London wall-clock times; re-parsing re-applies an
  // offset and shows every BST event an hour out — the bug NEURO's calendar had
  // once already, and VESTA's had after it.
  const m = s.match(/\d{2}:\d{2}/);
  return m ? m[0] : null;
}

/** The agenda, as rows. `known:false` yields NO rows and a stated gap. */
function agendaRows(agenda, limit = 4) {
  if (!isObj(agenda) || agenda.known !== true || !Array.isArray(agenda.events)) return [];
  return agenda.events.slice(0, limit).map((e) => row(
    timeOf(e) || '—',
    e.subject || e.title || 'Untitled',
    {
      // ⚠ "solo" is only said when the brain KNOWS. `attendeesOther` is
      // three-valued and null means "we could not tell" — half Nick's diary is
      // solo blocks, so guessing either way is wrong in a way he would notice.
      meta: e.attendeesOther === true ? 'with others'
        : e.attendeesOther === false ? 'on your own'
          : null,
    }
  ));
}

/**
 * What could not be read, in SARA's own words where she has them.
 *
 * ⚠ Carried onto EVERY dashboard, not only the blind one. A partly-read day is
 * the normal case, and a dashboard that shows four of five sources without
 * saying so is the "partly live rendered as total confidence" failure the kiosk
 * banner already exists to prevent, one level in.
 */
function gapsOf(payload) {
  const out = [];
  if (Array.isArray(payload.gaps)) {
    for (const g of payload.gaps) {
      if (g && g.input) out.push({ input: String(g.input), why: g.why ? String(g.why) : null });
    }
  }
  return out;
}

// ── The dashboards ──────────────────────────────────────────────────────────
//
// Each returns { kind, label, rows, figure, note }. Every one of them renders
// what the payload ALREADY carries — none of them fetches, and that is the
// discipline that keeps this pure and free to call on every poll.

function dashSteady(payload) {
  const agenda = payload.agenda;
  const rows = agendaRows(agenda);
  const known = isObj(agenda) && agenda.known === true;

  // The one open thing, beneath the day. `primary` is the brain's choice; this
  // does not pick a different one.
  const p = payload.primary;
  if (p && p.kind === 'item') {
    rows.push(row('open', p.title, { meta: p.urgency || null, note: p.say || null }));
  }

  return {
    kind: SURFACES.STEADY,
    // The scope is the brain's word for which day these belong to, rendered
    // verbatim — a client deciding "today" vs "tomorrow" for itself is a second
    // opinion about the one thing an agenda is for.
    label: !known ? 'your day' : agenda.scope === 'today' ? 'the rest of your day' : `${agenda.scope}`,
    rows,
    figure: null,
    // ⚠ "I couldn't see your diary" and "your diary is empty" are different
    // facts and the second is good news. Never collapse them.
    note: known ? null : 'I couldn’t read your diary, so this isn’t the whole day.',
  };
}

function dashPreMeeting(payload) {
  const rows = agendaRows(payload.agenda, 3);
  const known = isObj(payload.agenda) && payload.agenda.known === true;
  return {
    kind: SURFACES.PRE_MEETING,
    label: 'what’s coming',
    rows,
    figure: null,
    note: known ? null : 'I couldn’t read your diary.',
  };
}

// What the pool calls something that is on fire. Kept in step with
// `attention.QUEUE_TYPES` by intent — a type here that the engine never emits
// simply matches nothing, which is a quiet failure, so the fallback below is
// what actually protects the screen.
const HOT_TYPES = new Set(['escalation', 'nova-flag', 'novaFlag', 'breach', 'sla']);

function dashFirefighting(payload) {
  // ⚠ REAL ESCALATIONS FIRST, when they could be read. Before this the dashboard
  // could only show the generic pool under the word "live now", so the one
  // surface that exists for things actually on fire was the vaguest of the
  // eight. These are a local `agent_state` read, not a Jira call.
  const esc = payload.escalations;
  if (isObj(esc) && esc.known === true && Array.isArray(esc.items) && esc.items.length) {
    return {
      kind: SURFACES.FIREFIGHTING,
      label: 'unanswered escalations',
      rows: esc.items.slice(0, 4).map((e) => row(
        e.key || 'open',
        e.summary || 'No summary',
        {
          // Each of these is already NULLED upstream when it is the queue's
          // default rather than a fact about the ticket — "Unset" priority,
          // "Open" status, Nick's own name. What survives is the finding.
          meta: [e.priority, e.assignee].filter(Boolean).join(' · ') || null,
          note: e.status || null,
          level: e.priority === 'Critical' ? 'crit' : 'warn',
        }
      )),
      figure: null,
      note: esc.items.length > 4 ? `${esc.items.length} unanswered in total.` : null,
    };
  }
  // ⚠ "I could not read the escalations" is NOT "there are none", and under the
  // word firefighting that difference is the whole point.
  if (isObj(esc) && esc.known === false) {
    return {
      kind: SURFACES.FIREFIGHTING,
      label: 'live now',
      rows: [],
      figure: null,
      note: 'Something is live, but I couldn’t read the escalations — don’t take this as an all-clear.',
    };
  }

  const pool = [payload.primary, ...(Array.isArray(payload.secondary) ? payload.secondary : [])]
    .filter((c) => c && c.kind === 'item');

  let hot = pool.filter((c) => HOT_TYPES.has(c.type));
  // ⚠ FALLBACK, and it is load-bearing. The brain called this firefighting, so
  // something IS live; if no card matches the type list, the honest thing is to
  // show the pool rather than an empty escalations panel under the word
  // "firefighting" — an empty box would read as an all-clear at the exact
  // moment it is least true.
  if (!hot.length) hot = pool;

  return {
    kind: SURFACES.FIREFIGHTING,
    label: 'live now',
    rows: hot.slice(0, 4).map((c) => row(
      c.urgency || 'open',
      c.title,
      { note: c.say || null, level: c.urgency === 'critical' ? 'crit' : 'warn' }
    )),
    figure: null,
    // ⚠ AN EMPTY PANEL MUST STILL SAY SOMETHING. Reached by ASKING "anything
    // escalating?" on a calm day: the escalations read fine, there were none,
    // the pool was empty too, and the dashboard rendered nothing at all — which
    // is indistinguishable from a panel that failed to load, on the surface
    // where that mistake is most expensive. Caught on the live Pi, not by a
    // test. "There are none" and "I could not look" are already kept apart
    // above; this is the third case, and it is the good news.
    note: hot.length ? null
      : (isObj(esc) && esc.known === true
        ? 'Nothing escalating.'
        : 'Nothing live that I can see.'),
  };
}

function dashSession(payload, session) {
  if (!isObj(session)) {
    return {
      kind: SURFACES.SESSION,
      label: 'this session',
      rows: [],
      figure: null,
      // The brain said he is in a session and the session itself could not be
      // read. Saying so beats drawing a zeroed progress bar.
      note: 'A session is running, but I couldn’t read it.',
    };
  }

  const elapsed = Number.isFinite(session.elapsedMinutes) ? session.elapsedMinutes : null;
  const planned = Number.isFinite(session.plannedMinutes) ? session.plannedMinutes : null;

  const rows = [];
  if (session.taskTitle) {
    rows.push(row('on', session.taskTitle, {
      // ⚠ A shrink is EVIDENCE ABOUT THE WORK, never a score against Nick. It is
      // stated as a count and nothing here phrases it as a failure.
      meta: session.shrinkCount > 0
        ? `made smaller ${session.shrinkCount === 1 ? 'once' : `${session.shrinkCount} times`}`
        : null,
    }));
  }

  return {
    kind: SURFACES.SESSION,
    label: 'this session',
    rows,
    figure: elapsed === null ? null : {
      value: elapsed,
      unit: 'min of focus',
      // ⚠ `plannedAssumed` rides all the way to the screen. "Thirty minutes" and
      // "half an hour because nobody said" are different claims, and laundering
      // the second into the first is exactly what #87 rules out.
      of: planned,
      ofLabel: planned === null ? null
        : session.plannedAssumed ? `${planned} assumed` : `${planned} planned`,
      // Clamped, because an overrun is normal and a bar past its end reads as
      // broken. `overrun` carries the fact instead.
      pct: planned ? Math.min(100, Math.round((elapsed / planned) * 100)) : null,
      overrun: session.overrun === true,
    },
    note: session.overrun === true ? 'Over the time you planned — worth a look.' : null,
  };
}

function dashRitual(payload) {
  const cards = [payload.primary, ...(Array.isArray(payload.secondary) ? payload.secondary : [])]
    .filter((c) => c && c.kind === 'item');
  return {
    kind: SURFACES.RITUAL,
    label: 'carried over',
    rows: cards.slice(0, 4).map((c) => row(c.urgency || 'open', c.title, { note: c.say || null })),
    figure: null,
    note: null,
  };
}

function dashOffDuty(payload) {
  const wt = payload.weeklyTarget;
  const rows = [];
  let figure = null;

  // ⚠ FOUR states, and keeping them apart is the whole point of weekly-target:
  // `unset` is NOT a target of zero, and `unknown` is not a bad week.
  if (isObj(wt)) {
    if (wt.state === 'unset') {
      rows.push(row(null, 'No target set for this week', { note: 'Ask me to set one.' }));
    } else if (wt.state === 'unknown') {
      rows.push(row(null, 'I couldn’t count this week', { note: wt.reason || null, level: 'warn' }));
    } else if (Number.isFinite(wt.done)) {
      figure = {
        value: wt.done,
        unit: Number.isFinite(wt.target) ? `of ${wt.target} this week` : 'done this week',
        of: Number.isFinite(wt.target) ? wt.target : null,
        ofLabel: null,
        pct: Number.isFinite(wt.target) && wt.target > 0
          ? Math.min(100, Math.round((wt.done / wt.target) * 100)) : null,
        overrun: false,
      };
    }
  }

  // ⚠ OFF DUTY SHOWS WHAT HE DID, NEVER WHAT HE OWES. That is the entire
  // distinction `resolveDuty` exists to draw, and putting the pool here would
  // undo it. A CRITICAL item is the documented exception — hiding a breaching
  // escalation because it is Saturday is the wrong failure — and the brain has
  // already decided that by leaving it as `primary`.
  const p = payload.primary;
  if (p && p.kind === 'item' && p.urgency === 'critical') {
    rows.push(row('now', p.title, { note: p.say || null, level: 'crit' }));
  }

  return { kind: SURFACES.OFF_DUTY, label: 'this week', rows, figure, note: null };
}

function dashInbox(payload) {
  const box = payload.inbox;
  if (!isObj(box) || box.known !== true) {
    return {
      kind: SURFACES.INBOX,
      label: 'your inbox',
      rows: [],
      figure: null,
      // Triage having never run and the inbox being clear are different facts,
      // and only one of them is good news.
      note: 'I couldn’t read your inbox, so this isn’t "nothing needs you".',
    };
  }
  const urgent = Array.isArray(box.urgent) ? box.urgent : [];
  return {
    kind: SURFACES.INBOX,
    label: urgent.length ? 'needs an answer' : 'your inbox',
    rows: urgent.slice(0, 5).map((m) => row(
      null,
      m.subject || '(no subject)',
      // ⚠ `from`/`fromEmail` are the triage record's fields. The retired
      // `inbox_items` table used `from_name`/`from_email`, and reading those
      // yields `undefined` — the exact bug the urgent-email nudge shipped with.
      { meta: (m.from || m.fromEmail || '').split('<')[0].trim() || null, level: 'warn' }
    )),
    figure: null,
    note: urgent.length ? null : 'Nothing needing an answer.',
  };
}

function dashInMeeting() {
  return {
    kind: SURFACES.IN_MEETING,
    label: 'nothing, on purpose',
    rows: [],
    figure: null,
    // The one state where interrupting is actively wrong. Saying WHY the screen
    // is empty is what stops it reading as broken.
    note: 'You’re in something. Whatever’s waiting will still be there.',
  };
}

function dashBlind(payload) {
  const rows = gapsOf(payload).map((g) => row(
    'gap',
    `Couldn’t read ${g.input}`,
    { note: g.why, level: 'warn' }
  ));
  return {
    kind: SURFACES.BLIND,
    label: 'what I couldn’t read',
    rows,
    figure: null,
    // ⚠ These exact words. A blind surface that does not refuse an all-clear is
    // the failure the whole provenance model exists to prevent.
    note: 'Don’t read this as an all-clear — I’m not telling you it’s quiet, I’m telling you I couldn’t look.',
  };
}

// ── Utterances ──────────────────────────────────────────────────────────────
//
// The sentence IS the button, and the intent travels with it so no client ever
// parses language. `intent.kind` is one of:
//   act      — an attention-lifecycle verb on `intent.recordId`
//   navigate — open a screen (`intent.tab`); moves no state
//   ask      — put this to chat as a question
//
// ⚠ There is deliberately no `send`, `reply`, `book` or `chase`. Nothing an
// ambient surface offers may leave the building.

function say(text, intent) {
  return { say: text, intent };
}

/**
 * What he could say next. PURE.
 *
 * ⚠ BOUNDED BY WHAT THE RECORD ALLOWS. `attention-lifecycle` decides which
 * verbs a card accepts — an escalation is deliberately not dismissable — and
 * offering a sentence NEURO will refuse is worse than offering none, because he
 * will have said it out loud before finding out.
 *
 * ⚠ A card with no `recordId` gets NO act utterances at all. The engine's
 * suppression is a timer and cannot express "seen it" or "this is finished", so
 * substituting it is the exact bug the lifecycle replaced.
 */
function utterancesFor(payload, surface, session) {
  const out = [];
  const p = payload.primary;
  const actionable = p && p.kind === 'item' && p.recordId;
  const allowed = new Set(Array.isArray(p && p.actions) ? p.actions : []);
  const can = (verb) => actionable && (allowed.size === 0 || allowed.has(verb));

  if (surface === SURFACES.BLIND) {
    out.push(say('Try again', { kind: 'refresh' }));
    out.push(say('What can you see?', { kind: 'ask', text: 'What can you currently see?' }));
    return finish(out, payload);
  }

  if (surface === SURFACES.IN_MEETING) {
    // Capture is the one thing that is never an interruption — it is him
    // putting something down, not her picking something up.
    out.push(say('Capture a thought', { kind: 'navigate', tab: 'capture' }));
    out.push(say('What am I missing?', { kind: 'ask', text: 'What am I missing right now?' }));
    return finish(out, payload);
  }

  if (surface === SURFACES.SESSION) {
    // ⚠ `session`, NOT `act`. These are focus-session verbs on `/api/session/*`
    // and the attention lifecycle does not accept them — an `act` intent
    // carrying `shrink` would 400, which is precisely the "a sentence NEURO
    // will refuse" failure the bounding rule above exists to prevent. Caught
    // before it shipped by checking the routes rather than assuming the verb
    // sets matched.
    //
    // ⚠ "Make it smaller" LEADS, everywhere it appears. Nick's difficulty is
    // INITIATION, and shrinking is the only control that lowers the barrier
    // rather than merely rescheduling it. A menu without it pushes him to
    // abandon, which loses the thread and reads as failure.
    out.push(say('Make it smaller', { kind: 'session', action: 'shrink' }));
    // He was pulled off it — deliberately NOT `pause`, which is a decision to
    // stop, and NOT `interrupt`, which records that something ARRIVED and
    // leaves the clock running because the brain cannot know whether he
    // switched.
    out.push(say('Something came up', { kind: 'session', action: 'step-away' }));
    if (session && session.taskTitle) {
      out.push(say('That’s done', { kind: 'session', action: 'finish' }));
    }
    return finish(out, payload);
  }

  if (surface === SURFACES.OFF_DUTY) {
    out.push(say('What did I actually finish?', { kind: 'ask', text: 'What did I finish this week?' }));
    out.push(say('Anything for tomorrow?', { kind: 'ask', text: 'What is on for tomorrow?' }));
    return finish(out, payload);
  }

  // The working surfaces — steady, pre-meeting, firefighting, ritual — all hang
  // off the primary card, so they share one vocabulary.
  if (actionable) {
    if (p.actionHint) out.push(say(p.actionHint, { kind: 'navigate', tab: p.tab || 'surface', recordId: p.recordId, action: 'open' }));
    else out.push(say('Open it', { kind: 'navigate', tab: p.tab || 'surface', recordId: p.recordId, action: 'open' }));

    // ⚠ "Not now" carries HOW LONG and WHY. A snooze whose length SARA picked is
    // one he has no reason to trust, and the reason is what makes a thing put
    // off three times for `too-big` a different problem from one put off for
    // `not-now`. Both are recoverable only at the moment the gesture is made.
    if (can('defer')) {
      out.push(say('Not now — an hour', { kind: 'act', action: 'defer', recordId: p.recordId, minutes: 60, reason: 'not-now' }));
      out.push(say('It’s too big', { kind: 'act', action: 'defer', recordId: p.recordId, minutes: 60 * 20, reason: 'too-big' }));
    }
    // Seen is NOT a snooze: it stops her asking again and leaves the card where
    // it is — the one state the old suppression timer could not express.
    if (can('acknowledge')) out.push(say('Seen it', { kind: 'act', action: 'acknowledge', recordId: p.recordId }));
    if (can('complete')) out.push(say('That’s done', { kind: 'act', action: 'complete', recordId: p.recordId }));
    if (can('dismiss')) out.push(say('Not mine', { kind: 'act', action: 'dismiss', recordId: p.recordId }));
  } else {
    out.push(say('What have I got on?', { kind: 'ask', text: 'What have I got on today?' }));
    out.push(say('What am I forgetting?', { kind: 'ask', text: 'What am I forgetting?' }));
  }

  return finish(out, payload);
}

/**
 * The escape hatch, appended last and always.
 *
 * ⚠ NON-NEGOTIABLE. Nick's failure mode is avoidance, and a thing he cannot
 * find is worse than a menu he does not need — an ambient surface that is
 * sometimes wrong must ALWAYS have a way round it, or being wrong once costs
 * the whole feature. Bounded to `MAX_UTTERANCES` so the fallback never becomes
 * the menu it replaced.
 */
const MAX_UTTERANCES = 5;

function finish(list, payload) {
  const out = list.filter(Boolean).slice(0, MAX_UTTERANCES - 1);
  out.push(say('Show me everything', { kind: 'reveal' }));
  return out;
}

/**
 * Compose the surface. PURE.
 *
 * @param {object} payload  a built `attention` payload
 * @param {object} [opts]
 * @param {object} [opts.session]  the active focus session projection, if any
 * @returns {{surface: string, dashboard: object, utterances: Array}}
 */
function compose(payload, opts = {}) {
  const safe = isObj(payload) ? payload : {};
  const session = isObj(opts.session) ? opts.session : null;

  // ⚠ A QUESTION can move the dashboard, but it can never move it off `blind`.
  // If the pool could not be read, what is on screen has to say so — answering
  // "what's in my inbox" with a confident panel while she cannot see his work
  // is the one thing the blind state exists to prevent.
  const contextSurface = surfaceFor(safe);
  const asked = contextSurface === SURFACES.BLIND ? null : surfaceForQuestion(opts.ask);
  const surface = asked || contextSurface;

  let dashboard;
  switch (surface) {
    case SURFACES.BLIND: dashboard = dashBlind(safe); break;
    case SURFACES.IN_MEETING: dashboard = dashInMeeting(); break;
    case SURFACES.FIREFIGHTING: dashboard = dashFirefighting(safe); break;
    case SURFACES.PRE_MEETING: dashboard = dashPreMeeting(safe); break;
    case SURFACES.SESSION: dashboard = dashSession(safe, session); break;
    case SURFACES.RITUAL: dashboard = dashRitual(safe); break;
    case SURFACES.OFF_DUTY: dashboard = dashOffDuty(safe); break;
    case SURFACES.INBOX: dashboard = dashInbox(safe); break;
    default: dashboard = dashSteady(safe); break;
  }

  // Gaps ride on every dashboard, not only the blind one — a partly-read day is
  // the normal case and must never render as a complete one.
  dashboard.gaps = surface === SURFACES.BLIND ? [] : gapsOf(safe);

  return {
    surface,
    dashboard,
    // ⚠ Reported, so a client can tell "she moved because I asked" from "she
    // moved because the day did". Without it a screen that changed under him
    // has no explanation, and the honest half of an adaptive surface is being
    // able to say why it adapted.
    askedSurface: asked || null,
    // ⚠ Utterances follow the surface actually SHOWN. Offering "what did I
    // finish" under an inbox panel is the mute path disagreeing with the screen
    // it is attached to.
    utterances: utterancesFor(safe, surface, session),
  };
}

module.exports = {
  compose,
  surfaceFor,
  surfaceForQuestion,
  SURFACES,
  MAX_UTTERANCES,
  // Exported for the tests, which drive each dashboard directly rather than
  // through eight payload fixtures.
  _internals: { dashSteady, dashSession, dashOffDuty, dashBlind, dashFirefighting, utterancesFor, timeOf },
};
