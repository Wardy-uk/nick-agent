'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { cadenceDaysFor } = require('./nova-121-sync');

// ---------------------------------------------------------------------------
// Cadence words
// ---------------------------------------------------------------------------
//
// The distinction that matters here is between "off the rota", "not stated" and "a word
// we don't recognise". Collapsing any two of them writes something untrue into NOVA.

test('explicit off-the-rota values map to null', () => {
  for (const v of ['n/a', 'na', 'none', '-', 'N/A', ' None ']) {
    assert.equal(cadenceDaysFor(v), null, `${v} should be off the rota`);
  }
});

test('a MISSING cadence is unknown, not off the rota', () => {
  // team-roster reports an absent frontmatter field as ''. Reading that as `null` would
  // push "off the rota" to NOVA and defer the plan of anyone whose card is merely
  // incomplete — a demotion caused by absence of data.
  assert.equal(cadenceDaysFor(''), undefined);
  assert.equal(cadenceDaysFor(null), undefined);
  assert.equal(cadenceDaysFor(undefined), undefined);
});

test('known cadences map to days; unknown words are never guessed', () => {
  assert.equal(cadenceDaysFor('weekly'), 7);
  assert.equal(cadenceDaysFor('fortnightly'), 14);
  assert.equal(cadenceDaysFor('bi-weekly'), 14);   // one card uses it; the team means 14
  assert.equal(cadenceDaysFor('monthly'), 28);
  assert.equal(cadenceDaysFor('Fortnightly '), 14); // case and whitespace tolerant
  assert.equal(cadenceDaysFor('6-weekly'), undefined);
  assert.equal(cadenceDaysFor('whenever'), undefined);
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
//
// reconcile() reaches for team-roster and nova-client at call time, so both are stubbed
// through the module cache. Dry-run only — nothing here should ever push.

function withStubs({ people, novaAgents, stateThrows = null }, run) {
  const rosterPath = require.resolve('./team-roster');
  const novaPath = require.resolve('./nova-client');
  const syncPath = require.resolve('./nova-121-sync');
  const saved = { roster: require.cache[rosterPath], nova: require.cache[novaPath] };
  const pushed = [];

  const stub = (path, exports) => {
    const m = new Module(path, null);
    m.filename = path; m.loaded = true; m.exports = exports;
    require.cache[path] = m;
  };

  stub(rosterPath, { directReports: () => people });
  stub(novaPath, {
    isConfigured: () => true,
    get121State: async () => {
      if (stateThrows) throw new Error(stateThrows);
      return { agents: novaAgents };
    },
    push121Booking: async (a) => { pushed.push(a); return { ok: true }; },
    push121Cadence: async (a) => { pushed.push(a); return { ok: true }; },
  });
  delete require.cache[syncPath];

  try {
    return run(require('./nova-121-sync'), pushed);
  } finally {
    if (saved.roster) require.cache[rosterPath] = saved.roster; else delete require.cache[rosterPath];
    if (saved.nova) require.cache[novaPath] = saved.nova; else delete require.cache[novaPath];
    delete require.cache[syncPath];
  }
}

const person = (over = {}) => ({
  name: 'Nathan Rutland', cadence: 'fortnightly',
  last121: null, next121Due: null, booked121: null, ...over,
});
const novaAgent = (over = {}) => ({
  agentName: 'Nathan Rutland', planStatus: 'active', cadenceDays: 14,
  booked: null, sessionId: 1, sessionStatus: 'scheduled', outlookEventId: null,
  lastHeld: null, ...over,
});

test('a booking NOVA has not got is pushed', async () => {
  await withStubs({
    people: [person({ booked121: '2026-09-10' })],
    novaAgents: [novaAgent({ booked: null })],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.equal(r.ok, true);
    assert.equal(r.pushes.length, 1);
    assert.equal(r.pushes[0].date, '2026-09-10');
  });
});

test('a booking NOVA already agrees with is left alone', async () => {
  // The sweep replays every morning. If a matching date still counted as a push, NOVA
  // would reset the session to 'scheduled' daily and re-arm prep emails every day.
  await withStubs({
    people: [person({ booked121: '2026-09-10' })],
    novaAgents: [novaAgent({ booked: '2026-09-10' })],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.deepEqual(r.pushes, []);
  });
});

test('a spent booking is not resurrected', async () => {
  // Once the meeting has been held AND written up, `last-1-2-1` moves past the booked
  // date. Pushing it then would book a 1-2-1 that already happened.
  await withStubs({
    people: [person({ booked121: '2026-08-19', last121: '2026-08-19' })],
    novaAgents: [novaAgent({ booked: null })],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.deepEqual(r.pushes, []);
  });
});

test('next-1-2-1-due is never pushed as a booking', async () => {
  // `next-1-2-1-due` is when the next one is OWED, not a diary entry. Pushing it would
  // fill NOVA with meetings that exist nowhere but a reminder.
  await withStubs({
    people: [person({ booked121: null, next121Due: '2026-09-01' })],
    novaAgents: [novaAgent({ booked: null })],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.deepEqual(r.pushes, []);
  });
});

test('cadence disagreement is reported; a blank card is not', async () => {
  await withStubs({
    people: [
      person({ name: 'Nathan Rutland', cadence: 'fortnightly' }),
      person({ name: 'Zoe Rees', cadence: '' }),
      person({ name: 'Hope Goodall', cadence: '6-weekly' }),
    ],
    novaAgents: [
      novaAgent({ agentName: 'Nathan Rutland', cadenceDays: null }),
      novaAgent({ agentName: 'Zoe Rees', cadenceDays: null }),
      novaAgent({ agentName: 'Hope Goodall', cadenceDays: null }),
    ],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.deepEqual(r.cadences, [{ person: 'Nathan Rutland', from: null, to: 14 }]);
    // Blank stays silent; only the unrecognised word is worth a human's attention.
    assert.deepEqual(r.drift.unknownCadence, [{ person: 'Hope Goodall', cadence: '6-weekly' }]);
  });
});

test('roster drift is reported in both directions', async () => {
  await withStubs({
    people: [person({ name: 'Nathan Rutland' }), person({ name: 'New Starter' })],
    novaAgents: [novaAgent({ agentName: 'Nathan Rutland' }), novaAgent({ agentName: 'Willem Kruger' })],
  }, async (sync) => {
    const r = await sync.reconcile({ apply: false });
    assert.deepEqual(r.drift.notInNova, ['New Starter']);
    assert.deepEqual(r.drift.notInVault, ['Willem Kruger']);
  });
});

test('an unreadable NOVA state aborts rather than re-pushing everyone', async () => {
  // "Could not read" must never be read as "NOVA has nothing booked" — that would
  // re-push the whole team on a transient error and reset everyone's prep state.
  await withStubs({
    people: [person({ booked121: '2026-09-10' })],
    novaAgents: [],
    stateThrows: 'ETIMEDOUT',
  }, async (sync) => {
    const r = await sync.reconcile({ apply: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /ETIMEDOUT/);
    assert.equal(r.pushed, undefined);
  });
});

test('an empty roster refuses to reconcile', async () => {
  await withStubs({ people: [], novaAgents: [] }, async (sync) => {
    const r = await sync.reconcile({ apply: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /No direct reports/);
  });
});
