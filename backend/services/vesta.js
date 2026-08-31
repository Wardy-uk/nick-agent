'use strict';

/**
 * VESTA — the shared home surface.
 *
 * Nick, 31 Aug 2026: evolve the standalone task page for his partner into a
 * generalised capture/display surface she can actually use. First iteration:
 * shared tasks and their state, his calendar with work redacted to "Busy", what
 * is in the fridge and freezer, and something to eat out of it.
 *
 * Named for the goddess of hearth and home, and it sits beside SARA rather than
 * inside her: SARA is Nick's, VESTA is the household's.
 *
 * ── The one rule everything here follows ────────────────────────────────────
 * ⚠ **REDACTION HAPPENS HERE, ON THE SERVER, NEVER IN THE PAGE.** If a work
 * subject line reaches the browser it has leaked, whatever the component chooses
 * to render — a devtools tab, a cached response, a screenshot of a network
 * panel. `redactEvent()` is where a title becomes "Busy", and the full subject
 * is not in the object it returns.
 *
 * ⚠ **This is served to the PUBLIC INTERNET.** pi5 runs Tailscale Funnel, so the
 * auth exemption that lets his partner in without a NEURO PIN publishes these
 * routes to anyone who finds them. Everything below follows from that sentence,
 * and it is the same reasoning `capture-links.js` already carries — VESTA
 * reuses that file's accounts, PINs, brute-force throttle and sessions rather
 * than inventing a second credential system.
 *
 * ⚠ **It widens what an account can see, so it is gated per account and DEFAULTS
 * CLOSED** (`capture-links` SCOPES). The old rule was "an account sees only its
 * own submissions"; calendar and kitchen are a real step past that, and an
 * account created before this gets exactly what it had yesterday.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Nick's work tasks, his queue, his inbox, his health, his people notes, his
 * meeting notes, anything from the vault other than the kitchen file, and any
 * ability to change an account. A compromised VESTA login must be worth almost
 * nothing.
 *
 * ── What is NOT here any more ───────────────────────────────────────────────
 * The kitchen's file format and CRUD moved to `services/catalogue.js` while this
 * was being written — the fridge is one CATALOGUE among many (vinyl, hiking
 * equipment), and it never earned a bespoke store. VESTA keeps the two things
 * that are genuinely its own: redacting the diary, and knowing what can be
 * cooked out of a list.
 *
 * PURE where it judges: `redactEvent`, `domainOf` and `suggestMeals` take plain
 * data and return plain data, so the redaction rules pin without a database, a
 * vault or a clock.
 *
 * CommonJS — NEURO backend convention.
 */

// ── Calendar ─────────────────────────────────────────────────────────────────

/**
 * One calendar row as VESTA is allowed to see it. PURE.
 *
 * Nick's call (31 Aug): work shows as time + "Busy"; personal shows its real
 * title. The split is `domain`, which NEURO already carries — it is not guessed
 * from the wording here, because a classifier having an off day would be the
 * thing that leaks a client name.
 *
 * ⚠ The returned object CONTAINS NO SUBJECT for a work event. Not a truncated
 * one, not one on a field the page happens not to render. It is not there.
 */
function redactEvent(event = {}, { domain = 'work' } = {}) {
  const isPersonal = domain === 'personal';
  const allDay = !!(event.is_all_day || event.isAllDay);

  const out = {
    id: event.event_id || event.id || null,
    start: event.start_time || event.start || null,
    end: event.end_time || event.end || null,
    allDay,
    // "Busy" and nothing else. The word is deliberately dull: "Meeting" or
    // "Work" would still say something about the shape of his day that he did
    // not agree to share.
    title: isPersonal ? (event.subject || event.title || 'Something') : 'Busy',
    personal: isPersonal,
  };

  // Location is a leak too — "Chancellors' Offices, Coalville" names a customer
  // as plainly as a subject line does. Personal only.
  if (isPersonal && event.location) out.location = String(event.location).slice(0, 80);

  return out;
}

/**
 * Which calendar an event came from, as a domain. PURE.
 *
 * ⚠ Measured, not assumed: `calendar_cache.source` is `graph` (Microsoft 365 —
 * work) or `apple` (his own iCloud calendar — personal). Checked against the
 * live table rather than guessed, because guessing the wrong way round here
 * publishes a client meeting.
 *
 * ⚠ FAILS CLOSED. ONLY `apple` is personal. A new calendar source added later
 * is work until somebody decides otherwise, and an event with no source at all
 * is work — the unclassified event is exactly the one most likely to be a client
 * meeting, and guessing "personal" once is a leak that cannot be taken back.
 */
function domainOf(event = {}) {
  if (event.domain === 'personal' || event.domain === 'work') return event.domain;
  return String(event.source || '').toLowerCase() === 'apple' ? 'personal' : 'work';
}

/** A whole day, redacted. PURE. Cancelled and free-marked events are dropped:
 *  they are not commitments and padding her view with them helps nobody. */
function redactDay(events = []) {
  return events
    .filter(e => e && String(e.show_as || '').toLowerCase() !== 'free')
    .filter(e => !/cancelled/i.test(String(e.show_as || '')))
    .map(e => redactEvent(e, { domain: domainOf(e) }))
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

// ── The kitchen is a CATALOGUE ───────────────────────────────────────────────
//
// Nick, 31 Aug 2026, while this was being built: *"this should be a more
// generalised cataloguing tool — I might want to catalogue my vinyl collection,
// or my hiking equipment."* Right, and caught early enough that the fridge never
// got its own bespoke store.
//
// So the parsing, the file format and the CRUD all live in `services/catalogue.js`
// and the kitchen is simply the catalogue slugged `kitchen`. VESTA adds exactly
// one kitchen-specific thing on top: knowing what you can cook out of it.
//
// ⚠ A catalogue is only reachable from VESTA when its own frontmatter says
// `shared: true`, which DEFAULTS FALSE. His vinyl is not on the public internet
// because he made a list.

const catalogue = require('./catalogue');

const KITCHEN_SLUG = 'kitchen';

/** Every catalogue VESTA may see. Filtered by the CATALOGUE's own `shared`
 *  flag, not by a list kept here — a second place deciding what is shared is a
 *  second place to get it wrong. */
function sharedCatalogues() {
  const listed = catalogue.list();
  if (!listed.ok) return { ok: false, why: listed.why, catalogues: [] };
  return { ok: true, catalogues: listed.catalogues.filter(c => c.shared === true) };
}

/** The kitchen, if it exists and is shared. */
function readKitchen() {
  const found = catalogue.read(KITCHEN_SLUG);
  if (!found.ok) return { ok: false, why: found.why, notFound: found.notFound };
  if (found.cat.shared !== true) {
    // Refused rather than served: the flag is the whole permission, and honouring
    // it only in the list would make it decorative.
    return { ok: false, why: 'the kitchen catalogue is not shared', notShared: true };
  }
  return { ok: true, cat: found.cat };
}

// ── Meals ────────────────────────────────────────────────────────────────────

// Rough pantry staples that are almost always in and should not stop a
// suggestion from being made. Deliberately short: assuming too much is how a
// suggestion turns into a shopping list nobody asked for.
const ASSUMED = ['salt', 'pepper', 'oil', 'butter', 'flour'];

/**
 * What could be made from what is in. PURE, deterministic, no model call.
 *
 * ⚠ Rules rather than AI, first iteration, and the reason is honesty rather
 * than cost: a model asked "what can I make from milk and half a cabbage" will
 * cheerfully invent a recipe that needs four things that are not there, and it
 * will do it convincingly. A rule that only fires when its ingredients are
 * ACTUALLY on the list can be wrong about whether you fancy it, but not about
 * whether you can make it.
 *
 * Every suggestion names which of its ingredients it FOUND, so the reason it is
 * being offered is on the card and can be disagreed with.
 */
const MEALS = [
  { name: 'Omelette', needs: ['egg'], nice: ['cheese', 'mushroom', 'ham', 'onion'] },
  { name: 'Scrambled eggs on toast', needs: ['egg', 'bread'], nice: [] },
  { name: 'Pasta with whatever is in', needs: ['pasta'], nice: ['tomato', 'cheese', 'bacon', 'onion', 'garlic'] },
  { name: 'Stir fry', needs: ['rice'], nice: ['chicken', 'pepper', 'onion', 'cabbage', 'carrot', 'broccoli'] },
  { name: 'Jacket potato', needs: ['potato'], nice: ['cheese', 'beans', 'tuna', 'butter'] },
  { name: 'Soup', needs: ['stock'], nice: ['carrot', 'onion', 'potato', 'leek', 'cabbage'] },
  { name: 'Roast chicken', needs: ['chicken'], nice: ['potato', 'carrot', 'onion'] },
  { name: 'Chilli', needs: ['mince'], nice: ['beans', 'tomato', 'onion', 'rice', 'pepper'] },
  { name: 'Curry', needs: ['curry'], nice: ['chicken', 'rice', 'onion', 'tomato'] },
  { name: 'Cheese toastie', needs: ['bread', 'cheese'], nice: ['ham', 'onion'] },
  { name: 'Fish and veg', needs: ['fish'], nice: ['potato', 'peas', 'broccoli', 'carrot'] },
  { name: 'Beans on toast', needs: ['beans', 'bread'], nice: ['cheese'] },
];

/** Does the stock list contain something matching this ingredient word? */
function _have(stock, word) {
  if (ASSUMED.includes(word)) return true;
  return stock.some(item => item.includes(word));
}

function suggestMeals(cat = {}, { limit = 4 } = {}) {
  // Everything in every section — a tin in the cupboard counts as much as
  // something in the fridge.
  const stock = Object.values(cat.items || {})
    .flat()
    .map(i => String((i && i.name) || '').toLowerCase());

  if (!stock.length) {
    // ⚠ "Nothing in" and "we have not been told what is in" are different facts.
    // Suggesting meals from an empty list would be inventing a fridge.
    return { known: false, why: 'nothing recorded in the kitchen yet', meals: [] };
  }

  const scored = [];
  for (const meal of MEALS) {
    const missing = meal.needs.filter(n => !_have(stock, n));
    if (missing.length) continue;
    const extras = meal.nice.filter(n => _have(stock, n));
    scored.push({
      name: meal.name,
      // The evidence, on the card. A suggestion whose reason is invisible is
      // just a guess with a nice font.
      using: [...meal.needs.filter(n => !ASSUMED.includes(n)), ...extras],
      score: meal.needs.length * 2 + extras.length,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    known: true,
    meals: scored.slice(0, limit),
    // Said out loud rather than rendered as an empty list: a stocked kitchen
    // that matches no rule is a gap in the RULES, not an empty fridge.
    why: scored.length ? null : 'nothing here matches what I know how to suggest yet',
  };
}

module.exports = {
  // pure
  redactEvent,
  redactDay,
  domainOf,
  suggestMeals,
  // stateful
  readKitchen,
  sharedCatalogues,
  // constants
  KITCHEN_SLUG,
  MEALS,
};
