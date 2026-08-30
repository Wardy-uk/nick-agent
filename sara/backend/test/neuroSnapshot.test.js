// The NEURO snapshot bridge — freshness is the thing under test.
//
// Three behaviours that used to be one: a failed poll threw the last good payload
// away and reported `unavailable`, so a two-second blip blanked every screen, and
// there was no way for a screen to say "this is from four minutes ago". Data has an
// age now, and the age decides what a consumer is allowed to claim about it.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const neuroSnapshot = require('../src/integrations/neuroSnapshot');

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_PIN: '1234' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Swap global fetch for the duration of one refresh, then put it back. */
async function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test('a good poll is LIVE and carries when it was taken', async () => {
  const snap = await withFetch(
    async (url) => jsonResponse({ ok: true, url: String(url) }),
    () => neuroSnapshot.refresh({ env: CONFIGURED })
  );

  assert.equal(snap.state, 'live');
  assert.equal(snap.available, true);
  assert.equal(snap.stale, false);
  assert.ok(snap.polledAt, 'a live read must say when it was taken');
  assert.ok(snap.data.focus, 'the required endpoints must be folded in');
});

test('a failed poll degrades to STALE, keeping the last good data rather than blanking', async () => {
  await withFetch(async () => jsonResponse({ marker: 'first-good-read' }), () =>
    neuroSnapshot.refresh({ env: CONFIGURED })
  );

  const snap = await withFetch(async () => { throw new Error('ECONNREFUSED'); }, () =>
    neuroSnapshot.refresh({ env: CONFIGURED })
  );

  assert.equal(snap.state, 'stale');
  assert.equal(snap.stale, true);
  // Still available — a reading from a minute ago is worth showing, LABELLED.
  assert.equal(snap.available, true);
  assert.equal(snap.data.focus.marker, 'first-good-read');
  assert.equal(snap.reason, 'unreachable');
  assert.ok(typeof snap.ageMs === 'number', 'a stale read must carry its age or nobody can judge it');
  assert.ok(snap.lastAttemptAt, 'and when we last tried');
});

test('stale data past its shelf life becomes UNAVAILABLE, not indefinitely stale', async () => {
  await withFetch(async () => jsonResponse({ marker: 'ancient' }), () =>
    neuroSnapshot.refresh({ env: CONFIGURED })
  );
  // Age the cached copy past MAX_STALE_MS. An hour-old queue presented as the current
  // state is worse than an honest blank.
  neuroSnapshot._setSnapshotForTest({
    source: 'neuro',
    state: 'live',
    available: true,
    stale: false,
    reason: null,
    detail: null,
    polledAt: new Date(Date.now() - (neuroSnapshot.MAX_STALE_MS + 60000)).toISOString(),
    data: { focus: { marker: 'ancient' } },
    errors: {},
  });

  const snap = await withFetch(async () => { throw new Error('still down'); }, () =>
    neuroSnapshot.refresh({ env: CONFIGURED })
  );

  assert.equal(snap.state, 'unavailable');
  assert.equal(snap.available, false);
  assert.equal(snap.data.focus, null, 'nothing ancient may survive into the model');
});

test('losing the configuration is NOT an outage — stale data must not paper over it', async () => {
  await withFetch(async () => jsonResponse({ marker: 'good' }), () =>
    neuroSnapshot.refresh({ env: CONFIGURED })
  );

  const snap = await neuroSnapshot.refresh({ env: {} });
  assert.equal(snap.state, 'not-configured');
  assert.equal(snap.available, false);
  assert.equal(snap.data.focus, null, 'data with no configured origin has no provenance left');
  assert.match(snap.detail, /NEURO_BASE_URL/);
});

// ⚠ NEURO DELETED its Jira queue feature in July 2026, so /api/queue/summary 404s on
// every poll, for ever. Counting that against reach would pin the snapshot at
// "partial" permanently and make the word useless for the failures that matter.
test('a retired upstream endpoint does not make a healthy poll look partial', async () => {
  const snap = await withFetch(async (url) => {
    if (String(url).includes('/api/queue/summary')) return jsonResponse({ error: 'Not Found' }, 404);
    return jsonResponse({ ok: true });
  }, () => neuroSnapshot.refresh({ env: CONFIGURED }));

  assert.equal(snap.state, 'live');
  assert.equal(snap.reason, null, 'a known-absent optional endpoint is not a fault');
  assert.equal(snap.data.queue, null, 'and it is still honestly absent, not invented');
  assert.ok(snap.errors.queue, 'the failure is recorded rather than swallowed');
});

test('a required endpoint going missing IS reported as partial, by name', async () => {
  const snap = await withFetch(async (url) => {
    if (String(url).includes('/api/team-health')) throw new Error('boom');
    if (String(url).includes('/api/queue/summary')) return jsonResponse({}, 404);
    return jsonResponse({ ok: true });
  }, () => neuroSnapshot.refresh({ env: CONFIGURED }));

  assert.equal(snap.state, 'live');
  assert.equal(snap.reason, 'partial');
  assert.match(snap.detail, /team/);
});

test('the snapshot never sends a credential it was not given', async () => {
  const seen = [];
  await withFetch(async (url, options) => {
    seen.push(options.headers);
    return jsonResponse({ ok: true });
  }, () => neuroSnapshot.refresh({ env: { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' } }));

  assert.ok(seen.length);
  assert.equal(seen[0]['x-neuro-api-token'], 'tok');
  assert.equal(seen[0]['x-neuro-pin'], undefined);
});
