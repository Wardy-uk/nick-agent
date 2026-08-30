'use strict';

/**
 * mobile-snapshot — "Nick Now", the compact working set Neuro Mobile renders.
 *
 * This is a NEURO-OWNED CONTRACT, deliberately defined here rather than allowed
 * to become "whatever SARA's presentation model happens to be this week". The
 * phone caches it and shows it offline, so its shape is a promise.
 *
 * Three rules run through the whole thing, and they are the same three that run
 * through `attention` and `state-of-play`:
 *
 *  1. EVERY item carries a stable canonical id, a source and an updatedAt. A
 *     cached item with no provenance cannot be labelled honestly a day later.
 *  2. A section that could not be READ is `{known:false, why}` — never an empty
 *     list. "I couldn't look" and "there is nothing" are different facts, and
 *     conflating them is how a broken feed comes to look like a calm day.
 *  3. Nothing here is a bulk dump. Retrieval is POINTERS — title, path, updated
 *     — never private source content, because the point of the cache is a
 *     working set on a device, not a copy of the brain.
 *
 * Read-only. An ambient screen polled every few minutes must never be the reason
 * something changed.
 */

const SNAPSHOT_SCHEMA = 'neuro.mobile.nick-now/1';

/** How much of each section a phone gets. Bounded on purpose — see rule 3. */
const LIMITS = {
  tasks: 12,
  followUps: 5,
  agenda: 6,
  captures: 8,
  people: 4,
  retrieval: 8,
};

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function unavailable(why) {
  return { known: false, why: String(why || 'unavailable'), items: [] };
}

/** Local YYYY-MM-DD. Never toISOString — the Pi may run in UTC. */
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * The bounded task working set, ranked by NEURO's own scoring so the phone's
 * order matches Focus and the rest of the system. Re-ranking on the device
 * would be a second opinion about what matters.
 */
function tasksSection(now) {
  try {
    const taskStore = require('./task-store');
    const { rankTasks } = require('./task-scoring');
    // ⚠ activeTodos() returns the LEGACY TODO shape (`task_id`, `estimateMinutes`),
    // not task rows (`id`, `estimate_minutes`). Reading the wrong keys filters
    // everything out and reports a full backlog as a quiet day — 27 Aug's
    // day-planner bug, which cost a silent "nothing open to schedule" against
    // 148 open tasks.
    const todos = taskStore.activeTodos();
    const ranked = rankTasks(todos, dateKey(now));
    const items = ranked.slice(0, LIMITS.tasks).map((t) => ({
      id: `task:${t.task_id}`,
      taskId: t.task_id,
      source: 'neuro.tasks',
      updatedAt: t.updatedAt || t.updated_at || null,
      text: t.text,
      status: t.status,
      priority: t.priority || null,
      moscow: t.moscow || null,
      dueDate: t.due_date || null,
      domain: t.domain || null,
      estimateMinutes: t.estimateMinutes == null ? null : t.estimateMinutes,
      // Whether the phone may tick it offline. Only a NEURO-owned task has an
      // identity that survives the delay — see mobile-sync's TODO_COMPLETE note.
      completableOffline: Number.isInteger(t.task_id),
    }));
    return { known: true, total: ranked.length, items };
  } catch (e) {
    return unavailable(e.message);
  }
}

/**
 * Today's commitments and the next transition. Taken from the attention
 * payload's own agenda so the phone and the widget cannot disagree about which
 * day's events these are — `scope` names the day and is rendered verbatim.
 */
function agendaSection(attentionPayload) {
  const agenda = attentionPayload && attentionPayload.agenda;
  if (!agenda || agenda.known !== true) {
    return { known: false, why: 'calendar could not be read', scope: null, items: [], next: null };
  }
  // ⚠ `agendaFor` does not carry a Graph event id, so the canonical id is
  // derived from the two things that DO identify the sitting — its start and
  // its subject. Deterministic, so the same meeting keeps the same id across
  // refreshes and a client can hold onto it; explicitly `event:derived:` so
  // nobody mistakes it for a Graph id and tries to PATCH with it.
  const items = (agenda.events || []).slice(0, LIMITS.agenda).map((e) => ({
    id: `event:derived:${e.start || ''}:${String(e.subject || '').slice(0, 60)}`,
    source: 'microsoft.calendar',
    // The event was read at snapshot time; the calendar cache does not stamp a
    // per-event updated time, so this is null rather than a plausible guess.
    updatedAt: null,
    title: e.subject || 'Untitled',
    start: e.start || null,
    // Null, never 0 — `Number(null)` is 0 and `isFinite(0)` is true, so a
    // renderer that coerces before checking prints a confident "0m" for a
    // deliberate "no answer" (28 Aug). Clients must null-check first.
    minutesAway: e.minutesAway === undefined ? null : e.minutesAway,
    running: e.running === true,
    allDay: e.allDay === true,
    withOthers: e.attendeesOther === undefined ? null : e.attendeesOther,
  }));
  return {
    known: true,
    scope: agenda.scope || 'today',
    items,
    // The next transition, as its own field, because that is the single fact
    // "Now" leads with and a client picking `items[0]` would be re-deriving it.
    next: items.length ? items[0] : null,
  };
}

/**
 * Urgent / important follow-ups. This is the DECISION POOL as `attention`
 * already gated it — not a second engine. `decision-engine` stays the one place
 * something becomes worth surfacing.
 */
function followUpsSection(attentionPayload) {
  if (!attentionPayload) return unavailable('attention could not be built');
  if (attentionPayload.poolAvailable !== true) {
    return {
      known: false,
      why: "the decision pool couldn't be read — this is NOT an all-clear",
      items: [],
    };
  }
  const cards = [];
  if (attentionPayload.primary) cards.push(attentionPayload.primary);
  for (const s of attentionPayload.secondary || []) cards.push(s);

  const items = cards.slice(0, LIMITS.followUps).map((c) => ({
    id: c.id ? `attention:${c.id}` : `attention:${c.type || 'card'}`,
    source: 'neuro.decision-engine',
    updatedAt: attentionPayload.generatedAt,
    kind: c.kind || 'item',
    type: c.type || null,
    title: c.title,
    say: c.say || null,
    reason: c.reason || null,
    urgency: c.urgency || null,
    tab: c.tab || null,
  }));

  return {
    known: true,
    total: attentionPayload.poolSize || 0,
    quiet: attentionPayload.quiet === true,
    // `dropped` is surfaced, never swallowed — held is not lost.
    dropped: (attentionPayload.dropped || []).length,
    items,
  };
}

/** The current focus item and a concrete next step. */
function focusSection(attentionPayload) {
  let session = null;
  try {
    const s = require('./focus-session').current();
    if (s) {
      session = {
        id: `focus-session:${s.id || s.startedAt || 'current'}`,
        source: 'neuro.focus-session',
        updatedAt: s.startedAt || null,
        status: s.status || null,
        stale: !!s.stale,
        text: s.text || null,
        taskId: s.taskId ?? null,
        startedAt: s.startedAt || null,
        elapsedMinutes: s.elapsedMinutes == null ? null : s.elapsedMinutes,
        plannedMinutes: s.plannedMinutes == null ? null : s.plannedMinutes,
        // #87's rule, carried through: a "you're halfway" built on an assumed
        // length must SAY it is assumed, every time it is read.
        plannedAssumed: !!s.plannedAssumed,
      };
    }
  } catch (e) {
    return { known: false, why: e.message, session: null, item: null, nextStep: null };
  }

  const primary = attentionPayload && attentionPayload.primary ? attentionPayload.primary : null;
  return {
    known: true,
    // A running session IS the current focus. Without one, the brain's primary
    // card is the best answer to "what now" — and `null` is a correct answer.
    session,
    item: primary
      ? {
        id: primary.id ? `attention:${primary.id}` : 'attention:primary',
        title: primary.title,
        say: primary.say || null,
        kind: primary.kind || 'item',
        tab: primary.tab || null,
      }
      : null,
    nextStep: primary ? (primary.actionHint || primary.say || null) : null,
  };
}

/** Recent captures — what Nick has thrown at the brain lately. */
function capturesSection() {
  const fs = require('fs');
  const path = require('path');
  try {
    const captureStore = require('./capture-store');
    const dir = captureStore.importsDir();
    const vault = process.env.OBSIDIAN_VAULT_PATH || '';
    if (!vault) return unavailable('vault path not configured');
    if (!fs.existsSync(dir)) return { known: true, items: [] };

    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => {
        const full = path.join(dir, e.name);
        const stat = fs.statSync(full);
        return { full, name: e.name, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, LIMITS.captures);

    const items = entries.map((e) => {
      const content = fs.readFileSync(e.full, 'utf-8');
      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      const preview = content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 140).trim();
      const relative = captureStore.relativePath(e.full);
      return {
        id: `capture:${relative}`,
        source: 'vault.imports',
        updatedAt: e.mtime.toISOString(),
        title: titleMatch ? titleMatch[1] : null,
        preview,
        path: relative,
      };
    });
    return { known: true, items };
  } catch (e) {
    return unavailable(e.message);
  }
}

/**
 * Compact people/meeting context — only when it is relevant to TODAY, which
 * means: someone is in the diary. A roster dump is not context, it is a
 * directory, and it belongs nowhere near a bounded mobile working set.
 */
function peopleSection(agenda) {
  if (!agenda || agenda.known !== true) {
    return { known: false, why: 'calendar could not be read', items: [] };
  }
  try {
    const entities = require('./entities');
    // `getRoster()` returns `{ full, firstNames, aliases }` — the full names are
    // on `.full`. (`.fullNames` does not exist; reading it would silently give
    // an empty roster and a permanently empty people section.)
    const roster = entities.getRoster();
    const names = Array.isArray(roster && roster.full) ? roster.full : [];
    if (!names.length) return { known: true, items: [] };

    const seen = new Map();
    for (const ev of agenda.items || []) {
      const title = String(ev.title || '');
      for (const name of names) {
        // FULL NAME matching only. A first name is an identifier only when it
        // maps to exactly one person, and this is the wrong place to relitigate
        // that — four Lucys got one Lucy's commitments the last time.
        if (!seen.has(name) && title.includes(name)) {
          seen.set(name, { id: `person:${name}`, source: 'vault.people', updatedAt: null, name, meeting: ev.title, start: ev.start });
        }
      }
    }
    return { known: true, items: Array.from(seen.values()).slice(0, LIMITS.people) };
  } catch (e) {
    return unavailable(e.message);
  }
}

/**
 * Retrieval POINTERS, not content. Title, path and updated time so the phone
 * can offer "open this" and NEURO can serve the body when there is signal.
 * Returning the bodies to make mobile search feel complete would put private
 * vault content on the device for no gain — the pointer is what is useful
 * offline, the content is what needs the connection.
 */
function retrievalSection(captures, tasks) {
  const pointers = [];
  for (const c of (captures.items || []).slice(0, 4)) {
    pointers.push({ id: c.id, source: c.source, updatedAt: c.updatedAt, title: c.title || c.path, path: c.path, kind: 'note' });
  }
  for (const t of (tasks.items || []).slice(0, 4)) {
    pointers.push({ id: t.id, source: t.source, updatedAt: t.updatedAt, title: t.text, path: null, kind: 'task' });
  }
  return {
    known: captures.known === true || tasks.known === true,
    // Stated plainly so no client has to infer it: this is a set of handles, and
    // the brain is where the content lives.
    note: 'pointers only — request the body from NEURO when online',
    items: pointers.slice(0, LIMITS.retrieval),
  };
}

// ── The snapshot ─────────────────────────────────────────────────────────────

/**
 * Build the Nick Now snapshot.
 *
 * @param {{now?: Date}} opts
 * @returns the versioned payload documented in `docs/mobile-contract.md`.
 */
async function build({ now = new Date() } = {}) {
  const gaps = [];

  let attentionPayload = null;
  try {
    attentionPayload = await require('./attention').build({ now });
  } catch (e) {
    gaps.push({ input: 'attention', why: e.message });
  }

  const agenda = agendaSection(attentionPayload);
  const tasks = tasksSection(now);
  const followUps = followUpsSection(attentionPayload);
  const focus = focusSection(attentionPayload);
  const captures = capturesSection();
  const people = peopleSection(agenda);
  const retrieval = retrievalSection(captures, tasks);

  for (const [name, section] of Object.entries({ agenda, tasks, followUps, focus, captures, people })) {
    if (section.known === false) gaps.push({ input: name, why: section.why || 'unavailable' });
  }
  for (const g of (attentionPayload && attentionPayload.gaps) || []) gaps.push(g);

  // Every section names its own state, so a client never has to infer "was this
  // read?" from an empty array — rule 2, made checkable.
  const sources = Object.entries({ agenda, tasks, followUps, focus, captures, people, retrieval })
    .map(([id, s]) => ({ id, state: s.known === true ? 'live' : 'unavailable', why: s.known === true ? null : (s.why || null) }));

  return {
    schema: SNAPSHOT_SCHEMA,
    contract: require('./mobile-sync').CONTRACT_VERSION,
    generatedAt: nowIso(now),
    // The situational read, carried through rather than re-derived: the phone
    // must not be a second opinion about what kind of moment this is.
    context: attentionPayload ? attentionPayload.context : null,
    duty: attentionPayload && attentionPayload.context ? attentionPayload.context.duty || null : null,
    focus,
    agenda,
    followUps,
    tasks,
    captures,
    people,
    retrieval,
    weeklyTarget: attentionPayload ? attentionPayload.weeklyTarget : null,
    readiness: attentionPayload ? attentionPayload.readiness : null,
    // Whether the pool behind `followUps` could be read at all. A client that
    // renders "nothing pending" over this being false is asserting an all-clear
    // NEURO never gave.
    poolAvailable: attentionPayload ? attentionPayload.poolAvailable === true : false,
    sources,
    gaps,
  };
}

module.exports = {
  SNAPSHOT_SCHEMA,
  LIMITS,
  build,
  // exported for tests — pure-ish section builders that take their input
  agendaSection,
  followUpsSection,
  focusSection,
  peopleSection,
  retrievalSection,
  dateKey,
};
