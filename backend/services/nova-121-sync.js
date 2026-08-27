'use strict';

/**
 * 1-2-1 sync — NEURO's bookings, pushed into NOVA.
 *
 * NEURO schedules 1-2-1s: it finds the free slot, checks the clash, invites the person
 * and bulk-books the team. NOVA preps and runs them: the KPI snapshot, the prep questions
 * emailed the day before, the click-through, the action tracking.
 *
 * The two had never been connected. NOVA's day-before job only fires for a session it
 * holds with `status = 'scheduled'`, and nothing created one — a prod audit on
 * 2026-08-27 found the prep email had never been sent a single time in the two months
 * the job had been live. This module is that missing wire.
 *
 * Two ways in, deliberately:
 *
 *   1. `pushBooking` — called inline by book()/reschedule(). Fast path, so a 1-2-1 booked
 *      today is prepped tomorrow morning.
 *   2. `reconcile` — a morning sweep, before NOVA's 07:00 prep job, that compares every
 *      direct report's `1-2-1-booked` against what NOVA holds and pushes the difference.
 *
 * The sweep is not belt-and-braces, it is the actual guarantee. The inline push happens
 * AFTER the calendar event and the vault stamp have already succeeded, so it must never
 * roll them back on failure — which means it can only log and move on. A push dropped
 * that way is a 1-2-1 with no prep, and nobody finds out until the morning it doesn't
 * arrive. The sweep is what makes that self-healing.
 *
 * Read-only against the vault. Everything it writes, it writes to NOVA.
 */

const nova = require('./nova-client');
const teamRoster = require('./team-roster');

/**
 * Cadence words → days.
 *
 * Only what the vault actually contains, plus the obvious neighbours. `bi-weekly` is here
 * because one card uses it and every other card on the team says `fortnightly` — in this
 * vault it plainly means the same thing. An unrecognised word is NOT guessed: it returns
 * undefined, the caller warns, and NOVA keeps whatever cadence it already had. Guessing
 * 28 for a word we don't know would silently halve someone's 1-2-1 frequency.
 */
const CADENCE_DAYS = {
  weekly: 7,
  fortnightly: 14,
  'bi-weekly': 14,
  biweekly: 14,
  monthly: 28,
  '4-weekly': 28,
  quarterly: 91,
};

/**
 * `n/a` / `none` / `-` — the vault's way of taking someone out of the rota.
 *
 * A MISSING cadence is deliberately not in here, unlike `one-to-one-detect`'s copy of
 * this regex. `team-roster` reports an absent field as `''`, and treating that as "off
 * the rota" would push `null` to NOVA and defer the plan of anyone whose card simply
 * hasn't been filled in — a silent demotion caused by absence of data. Missing reads as
 * unknown instead, which changes nothing.
 */
const NO_CADENCE = /^(n\/?a|none|-)$/;

function cadenceDaysFor(cadence) {
  const key = String(cadence == null ? '' : cadence).toLowerCase().trim();
  if (!key) return undefined;                      // not stated — leave NOVA's value alone
  if (NO_CADENCE.test(key)) return null;           // off the rota, explicitly
  return CADENCE_DAYS[key];                        // undefined = unknown word, do not guess
}

/**
 * Push one booking. Never throws.
 *
 * Returns `{ ok, skipped?, unknownAgent?, error? }` so the caller can log without having
 * to care. `unknownAgent` is roster drift (NOVA has no plan under that exact name) and is
 * a different thing from a failure — it will not fix itself by retrying.
 */
async function pushBooking(person, date, { outlookEventId = null } = {}) {
  if (!nova.isConfigured()) return { ok: false, skipped: 'nova-bridge-not-configured' };
  if (!person || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return { ok: false, error: 'person and an ISO date are required' };
  }

  try {
    const data = await nova.push121Booking({ agentName: person, date, outlookEventId });
    return { ok: true, ...data };
  } catch (e) {
    if (e.status === 404) {
      console.warn(`[121-sync] NOVA has no 1-2-1 roster entry for "${person}" — booking not pushed`);
      return { ok: false, unknownAgent: true, error: e.message };
    }
    // Loud. The calendar event and the vault stamp already landed, so this is a real
    // divergence between the two systems until the morning sweep repairs it.
    console.warn(`[121-sync] Could not push ${person}'s 1-2-1 (${date}) to NOVA: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Tell NOVA a 1-2-1 has left the diary. Never throws. */
async function pushCancel(person) {
  if (!nova.isConfigured()) return { ok: false, skipped: 'nova-bridge-not-configured' };
  try {
    return { ok: true, ...(await nova.cancel121({ agentName: person })) };
  } catch (e) {
    console.warn(`[121-sync] Could not cancel ${person}'s 1-2-1 in NOVA: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Morning reconciliation.
 *
 * Compares each bookable direct report's `1-2-1-booked` against NOVA's open session and
 * pushes anything missing, wrong, or stale. Also syncs cadence, which NOVA had NULL for
 * every single agent — so a fortnightly 1-2-1 was being rebooked at NOVA's 28-day default.
 *
 * Dry-run by default, like every other sweep here: `apply: true` is what pushes.
 *
 * A failure to READ NOVA's state aborts the whole sweep rather than treating it as "NOVA
 * has nothing" — that reading would re-push the entire team on a transient error, and on
 * a bad day would reset everyone's prep state.
 */
async function reconcile({ apply = false } = {}) {
  if (!nova.isConfigured()) {
    return { ok: false, error: 'NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }

  const people = teamRoster.directReports();
  if (!people.length) {
    // Same rule as the tracker: a read failure and an empty team are different facts,
    // and only one of them should cause writes.
    return { ok: false, error: 'No direct reports readable from People/ — refusing to reconcile' };
  }

  let state;
  try {
    state = await nova.get121State({ days: 120 });
  } catch (e) {
    return { ok: false, error: `Could not read NOVA 1-2-1 state: ${e.message}` };
  }

  const novaByName = new Map((state.agents || []).map(a => [a.agentName, a]));
  const seen = new Set();

  const pushes = [];      // bookings that need sending
  const cadences = [];    // cadence values that disagree
  const drift = { notInNova: [], notInVault: [], unknownCadence: [] };

  for (const p of people) {
    const known = novaByName.get(p.name);
    seen.add(p.name);
    if (!known) { drift.notInNova.push(p.name); continue; }

    const stated = String(p.cadence || '').trim();
    const days = cadenceDaysFor(p.cadence);
    if (days === undefined) {
      // Only an unrecognised WORD is worth reporting. A blank field is a card nobody has
      // filled in, and saying so every morning for months would train Nick to ignore it.
      if (stated) drift.unknownCadence.push({ person: p.name, cadence: stated });
    } else if (known.cadenceDays !== days) {
      cadences.push({ person: p.name, from: known.cadenceDays, to: days });
    }

    // Only the diary date is pushed. `next-1-2-1-due` is when the next one is OWED,
    // which is a different fact and is NOT a booking — pushing it would fill NOVA with
    // meetings that exist nowhere but a reminder.
    const booked = p.booked121 || null;
    if (!booked) continue;
    // A booking is spent once the meeting has been held and written up; the detector's
    // `last-1-2-1` moving past it is what proves that. Don't resurrect old ones.
    if (p.last121 && p.last121 >= booked) continue;
    if (known.booked === booked) continue;

    pushes.push({ person: p.name, date: booked, from: known.booked, eventId: known.outlookEventId });
  }

  for (const a of state.agents || []) {
    if (!seen.has(a.agentName)) drift.notInVault.push(a.agentName);
  }

  if (!apply) {
    return { ok: true, dryRun: true, people: people.length, pushes, cadences, drift };
  }

  const results = { pushed: [], failed: [], cadenceSet: [] };
  for (const push of pushes) {
    const r = await pushBooking(push.person, push.date);
    (r.ok ? results.pushed : results.failed).push({ ...push, error: r.error || null });
  }
  for (const c of cadences) {
    try {
      await nova.push121Cadence({ agentName: c.person, cadenceDays: c.to });
      results.cadenceSet.push(c);
    } catch (e) {
      results.failed.push({ person: c.person, cadence: c.to, error: e.message });
    }
  }

  return { ok: true, dryRun: false, people: people.length, ...results, drift };
}

module.exports = { pushBooking, pushCancel, reconcile, cadenceDaysFor, _internals: { CADENCE_DAYS } };
