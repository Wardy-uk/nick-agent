// WS1-WP1 contract smoke tests. Zero deps — Node's built-in test runner.
//   run: npm test   (from sara/backend)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getState, getHealth, buildModel } = require('../src/state/stateEngine');
const { validate, CONTRACT, SCHEMA_VERSION, DOMAINS } = require('../src/state/contract');
const ha = require('../src/telemetry/homeAssistant');
const neuro = require('../src/integrations/neuroSnapshot');

test('assembled model conforms to the v1 contract', () => {
  neuro._setSnapshotForTest(null);
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('getState exposes the v1 contract over the shared model', () => {
  neuro._setSnapshotForTest(null);
  const s = getState();
  assert.equal(s.contract, CONTRACT);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  // ⚠ This assertion used to read 'seed'. With NEURO unreachable the model is now
  // UNAVAILABLE, not filled in from a literal — that swap is the whole point of the
  // provenance pass, and the contract still has to hold across it.
  assert.equal(s.dataSource, 'unavailable');
  assert.ok(s.servedAt, 'servedAt stamp missing');
  for (const name of DOMAINS) {
    assert.ok(s.domains[name], `missing domain ${name}`);
    assert.equal(s.domains[name].source, 'unavailable', `${name} must be flagged unavailable, not filled in`);
  }
});

test('an unreadable domain is EMPTY, and never a confident zero', () => {
  neuro._setSnapshotForTest(null);
  const s = getState();
  // null, not 0. A screen rendering "0 breaching" from a feed it could not read has
  // silently turned "no reading" into "nothing wrong".
  assert.equal(s.domains.queue.open, null);
  assert.equal(s.domains.queue.breaching, null);
  assert.deepEqual(s.domains.queue.sections.act_now, []);
  assert.equal(s.domains.focus.current, null);
  assert.deepEqual(s.domains.people.members, []);
  assert.deepEqual(s.domains.vault.picks, []);
  // and every one of them says so in words
  for (const name of DOMAINS) {
    assert.match(s.domains[name].summary, /cannot see/i, `${name} must say what it could not see`);
    assert.match(s.domains[name].summary, /not an all-clear/i, `${name} must not read as reassurance`);
  }
});

test('NO seeded person, ticket or meeting can reach a screen in production', () => {
  neuro._setSnapshotForTest(null);
  const blob = JSON.stringify(getState());
  // Names and specifics straight out of seed.js. If any of these ever appear again
  // with NEURO down, SARA is inventing Nick's day during an outage.
  for (const invented of ['TECH-4412', 'TECH-4398', 'Willem', 'probation review', 'Little Eaton', 'QA 82%']) {
    assert.ok(!blob.includes(invented), `seeded content leaked into live state: ${invented}`);
  }
});

test('demo mode is the ONLY door to seeded content, and it stamps every domain', () => {
  neuro._setSnapshotForTest(null);
  const demoEnv = { ...process.env, SARA_DEMO_MODE: 'true', NODE_ENV: 'development' };
  const s = getState({ env: demoEnv });
  assert.equal(s.dataSource, 'demo');
  assert.equal(s.provenance.state, 'demo');
  assert.equal(s.provenance.demoMode, true);
  assert.match(s.provenance.message, /DEMO/);
  for (const name of DOMAINS) {
    assert.equal(s.domains[name].source, 'demo', `${name} must be stamped demo, never neuro`);
  }
  // Confidence must not survive demo mode — invented data is not data.
  assert.equal(s.confidence.level, 'low');
});

test('demo mode is REFUSED under NODE_ENV=production', () => {
  neuro._setSnapshotForTest(null);
  const s = getState({ env: { ...process.env, SARA_DEMO_MODE: 'true', NODE_ENV: 'production' } });
  assert.equal(s.provenance.demoMode, false);
  assert.equal(s.dataSource, 'unavailable', 'production must fall to unavailable, never to seed');
  assert.ok(!JSON.stringify(s).includes('Willem'), 'seeded content must not reach a production screen');
});

test('briefing is derived from domain data, not a fixed string', () => {
  neuro._setSnapshotForTest({
    source: 'neuro',
    state: 'live',
    available: true,
    stale: false,
    reason: null,
    detail: null,
    polledAt: '2026-08-30T09:00:00.000Z',
    errors: {},
    data: {
      queue: {
        total: 2,
        at_risk_count: 2,
        tickets: [
          { ticket_key: 'SUP-1', summary: 'Portal down', sla_remaining_minutes: 30 },
          { ticket_key: 'SUP-2', summary: 'Export failing', sla_remaining_minutes: 60 },
        ],
        at_risk_tickets: [{ ticket_key: 'SUP-1' }, { ticket_key: 'SUP-2' }],
      },
      team: {
        filteredCount: 1,
        perPerson: [{ name: 'Adele Norman-Swift', team: '1st Line', issues: [{ severity: 'high', title: 'no response logged since Wednesday' }] }],
      },
    },
  });
  const s = getState();
  assert.match(s.briefing.line, /breaching SLA/);
  assert.match(s.briefing.line, /Adele Norman-Swift is slipping/);
  neuro._setSnapshotForTest(null);
});

test('the briefing NEVER says the queue is calm when it could not read the queue', () => {
  neuro._setSnapshotForTest(null);
  const s = getState();
  assert.ok(!/calm/i.test(s.briefing.line), 'a reassuring line over an unread queue is the worst possible output');
  assert.match(s.briefing.line, /cannot read anything from NEURO/i);
  assert.match(s.briefing.line, /not an all-clear/i);
  assert.deepEqual(s.briefing.unread, [...DOMAINS]);
});

test('state exposes current location and confidence (WS1 criterion 2)', () => {
  neuro._setSnapshotForTest(null);
  const s = getState();
  // location: still present and still contract-shaped, but UNKNOWN rather than the
  // seeded "Office — Little Eaton", which was a specific checkable claim about where
  // Nick physically was, made up from a literal.
  assert.ok(s.location, 'location missing from state');
  assert.equal(s.location.source, 'unavailable');
  assert.equal(s.location.label, 'Location unknown');
  assert.equal(s.location.context, 'unknown');
  // confidence: derived by the engine, and LOW when nothing could be read
  assert.ok(s.confidence, 'confidence missing from state');
  assert.equal(s.confidence.source, 'derived', 'confidence should be derived, not seeded');
  assert.equal(typeof s.confidence.score, 'number');
  assert.equal(s.confidence.level, 'low', 'unreadable inputs must not yield confident state');
});

test('assembled model with location and confidence is contract-valid', () => {
  neuro._setSnapshotForTest(null);
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('health derives from the same model and reports valid', () => {
  neuro._setSnapshotForTest(null);
  const h = getHealth();
  assert.equal(h.status, 'ok');
  assert.equal(h.valid, true);
  assert.equal(h.contract, CONTRACT);
  // location + confidence exposed consistently on the health surface too
  assert.equal(typeof h.location, 'string');
  assert.ok(h.location.length, 'health.location is empty');
  assert.equal(h.confidence.level, 'low');
  assert.equal(typeof h.confidence.score, 'number');
});

test('health exposes NEURO readiness and never a credential', () => {
  neuro._setSnapshotForTest(null);
  const h = getHealth({ env: { NEURO_BASE_URL: 'http://example.test:3001', NEURO_PIN: 'super-secret-pin' } });
  assert.equal(h.neuro.configured, true);
  assert.equal(h.neuro.ready, true);
  assert.equal(h.neuro.baseUrl, 'http://example.test:3001');
  assert.equal(h.neuro.credentialConfigured, true);
  assert.equal(h.neuro.credentialKind, 'pin');
  // ⚠ The readiness signal says WHETHER a credential is set, never what it is.
  assert.ok(!JSON.stringify(h).includes('super-secret-pin'), 'health must never carry the PIN');
});

test('an unconfigured NEURO names the missing settings rather than looking like an outage', () => {
  neuro._setSnapshotForTest(null);
  const h = getHealth({ env: {} });
  assert.equal(h.neuro.configured, false);
  assert.equal(h.neuro.ready, false);
  assert.ok(h.neuro.problems.some((p) => /NEURO_BASE_URL/.test(p)));
  assert.match(h.provenance.message, /not configured/i);
});

test('validate rejects a model missing a domain (degrades honestly)', () => {
  neuro._setSnapshotForTest(null);
  const broken = buildModel();
  delete broken.domains.queue;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('queue')), 'expected a queue error');
});

// --- WS3-WP1: Home Assistant telemetry bridge ------------------------------

test('model carries a telemetry block and stays contract-valid when HA is absent', () => {
  neuro._setSnapshotForTest(null);
  ha._setSnapshotForTest(null); // restore the unconfigured/unavailable default
  const s = getState();
  assert.ok(s.telemetry, 'telemetry block missing from state');
  assert.equal(s.telemetry.source, 'home-assistant');
  assert.equal(s.telemetry.available, false, 'telemetry should be unavailable with no HA');
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('location is UNKNOWN, not a seeded office, when HA telemetry is unavailable', () => {
  neuro._setSnapshotForTest(null);
  ha._setSnapshotForTest(null);
  const s = getState();
  assert.equal(s.location.source, 'unavailable', 'absent HA must leave location unknown, never seeded');
  assert.ok(!s.location.label.includes('Little Eaton'));
  assert.equal(s.telemetry.signals.location, null);
});

test('live HA location signal feeds the shared model (location flips to HA source)', () => {
  neuro._setSnapshotForTest(null);
  ha._setSnapshotForTest({
    source: 'home-assistant',
    available: true,
    reason: null,
    detail: null,
    polledAt: '2026-05-31T09:00:00.000Z',
    signals: {
      location: { entityId: 'person.nick', state: 'home', zone: 'home', label: 'Home' },
      presence: { entityId: 'binary_sensor.occ', state: 'on', present: true, label: 'Office occupancy' },
      environment: { entityId: 'sensor.temp', state: '21.4', unit: '°C', label: 'Office temp: 21.4°C' },
    },
  });
  const s = getState();
  assert.equal(s.location.source, 'home-assistant', 'live HA location must drive the shared location');
  assert.equal(s.location.label, 'Home');
  assert.equal(s.telemetry.available, true);
  assert.equal(s.telemetry.signals.presence.present, true);
  // Still contract-valid with live telemetry folded in.
  const { valid, errors } = validate(buildModel());
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
  // Health agrees with state about liveness (no split-brain).
  const h = getHealth();
  assert.equal(h.telemetry.available, true);
  assert.equal(h.locationSource, 'home-assistant');
  ha._setSnapshotForTest(null); // reset so later/other tests see the honest default
});

test('contract rejects a model with no telemetry block', () => {
  neuro._setSnapshotForTest(null);
  const broken = buildModel();
  delete broken.telemetry;
  const { valid, errors } = validate(broken);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('telemetry')), 'expected a telemetry error');
});

test('live NEURO snapshot replaces seeded domains and presentation honestly', () => {
  neuro._setSnapshotForTest({
    source: 'neuro',
    available: true,
    reason: null,
    detail: null,
    polledAt: '2026-05-31T18:15:00.000Z',
    errors: {},
    data: {
      queue: {
        total: 2,
        at_risk_count: 1,
        open_p1s: 1,
        at_risk_tickets: [
          {
            ticket_key: 'SUP-101',
            summary: 'Portal login broken',
            assignee: 'Adele',
            priority: 'P1',
            status: 'Open',
            sla_remaining_minutes: 45,
          },
        ],
        tickets: [
          {
            ticket_key: 'SUP-101',
            summary: 'Portal login broken',
            assignee: 'Adele',
            priority: 'P1',
            status: 'Open',
            sla_remaining_minutes: 45,
          },
          {
            ticket_key: 'SUP-102',
            summary: 'Export timeout',
            assignee: 'Nathan',
            priority: 'Medium',
            status: 'Investigating',
            sla_remaining_minutes: 300,
          },
        ],
      },
      focus: {
        sara: { summary: 'Triage the portal outage first.' },
        nextAction: {
          id: 'focus-1',
          label: 'Triage portal outage',
          reason: 'Customer impact is active and SLA is inside the hour.',
          timeboxMins: 15,
          deferCount: 0,
        },
      },
      todos: {
        todos: [
          { id: 1, text: 'Prepare standup notes', priority: 'high', due_date: '2026-05-31', source: 'Vault', done: 0 },
        ],
        suggested: [
          { id: 99, text: 'Follow up with Adele on outage notes', reason: 'Likely action found in note', confidence: 0.84, sourcePath: 'Meetings/outage.md' },
        ],
        todayLane: [
          { id: 'lane-1', text: 'Reply to customer on breached queue item', why: 'Must move today', moscow: 'must', context: 'queue', due_date: '2026-05-31' },
        ],
      },
      context: {
        date: '2026-05-31',
        dailyNote: { title: 'Daily Note', path: 'Daily/2026-05-31.md' },
        todos: [{ text: 'Prep queue comms' }],
        standup: '- [ ] Follow up with Adele\n- [ ] Update the outage thread',
      },
      team: {
        filteredCount: 1,
        severityFilter: 'all',
        counts: { high: 1, med: 0, low: 0, peopleWithIssues: 1, peopleClean: 0 },
        issues: [{ person: 'Adele Norman-Swift', severity: 'high', title: '1:1 overdue by 3d' }],
        perPerson: [
          {
            name: 'Adele Norman-Swift',
            team: '1st Line Customer Care',
            issues: [{ severity: 'high', title: '1:1 overdue by 3d' }],
          },
        ],
      },
      capture: {
        items: [
          {
            filename: '2026-05-31-note.md',
            relativePath: 'Imports/2026-05-31-note.md',
            title: 'Queue outage notes',
            preview: 'Portal outage summary and holding reply.',
            modified: '2026-05-31T18:00:00.000Z',
          },
        ],
      },
    },
  });

  const s = getState();
  assert.equal(s.dataSource, 'neuro');
  assert.equal(s.domains.queue.source, 'neuro');
  assert.equal(s.domains.focus.source, 'neuro');
  assert.equal(s.domains.people.source, 'neuro');
  assert.equal(s.domains.vault.source, 'neuro');
  assert.equal(s.confidence.level, 'high');
  assert.equal(s.presentation.source, 'neuro');
  assert.equal(s.presentation.todos.source, 'neuro');
  assert.match(s.presentation.whatMattersNow[0].title, /Portal login broken/);
  assert.equal(s.presentation.capture.recent[0].title, 'Queue outage notes');
  assert.equal(s.presentation.todos.candidates[0].title, 'Follow up with Adele on outage notes');
  assert.equal(s.presentation.todos.todayLane[0].title, 'Reply to customer on breached queue item');
  neuro._setSnapshotForTest(null);
});

// --- Provenance: live vs stale vs unavailable ------------------------------
//
// Three states that a screen must be able to tell apart. Collapsing "stale" into
// "live" is how a kiosk shows a four-minute-old queue as the current one; collapsing
// it into "unavailable" throws away data that is still worth seeing. Both are wrong
// in different directions, so both are pinned.

function liveSnapshot(overrides = {}) {
  return {
    source: 'neuro',
    state: 'live',
    available: true,
    stale: false,
    reason: null,
    detail: null,
    polledAt: '2026-08-30T09:00:00.000Z',
    ageMs: 0,
    errors: {},
    data: {
      queue: null,
      focus: { nextAction: { id: 'f1', label: 'Triage the portal outage', reason: 'Customer impact is live.' } },
      todos: { todos: [], suggested: [], todayLane: [] },
      context: { date: '2026-08-30', dailyNote: { title: 'Daily Note', path: 'Daily/2026-08-30.md' } },
      team: { filteredCount: 0, perPerson: [] },
      capture: { items: [] },
      email: null,
    },
    ...overrides,
  };
}

test('stale NEURO data is marked stale everywhere, and is never presented as live', () => {
  neuro._setSnapshotForTest(liveSnapshot({
    state: 'stale',
    stale: true,
    reason: 'unreachable',
    detail: 'NEURO is not answering.',
    ageMs: 4 * 60 * 1000,
  }));
  const s = getState();
  assert.equal(s.provenance.state, 'neuro-stale');
  assert.equal(s.provenance.neuro.stale, true);
  assert.match(s.provenance.message, /last known state/i);
  assert.match(s.provenance.message, /not answering/i);
  assert.equal(s.domains.focus.source, 'neuro-stale', 'a domain built from stale data must say so');
  // Stale data is real data, so confidence is moderate — not high, and not low.
  assert.equal(s.confidence.level, 'moderate');
  neuro._setSnapshotForTest(null);
});

test('a partly-read NEURO leaves the unread domains blank rather than guessing', () => {
  // context/capture answered; team did not, and focus answered with nothing pressing.
  neuro._setSnapshotForTest(liveSnapshot({ data: { ...liveSnapshot().data, team: null, focus: {} } }));
  const s = getState();
  assert.equal(s.domains.focus.source, 'neuro');
  assert.equal(s.domains.people.source, 'unavailable');
  assert.deepEqual(s.domains.people.members, []);
  assert.equal(s.dataSource, 'mixed');
  assert.match(s.provenance.message, /Partly live/i);
  // and the briefing admits which half it could not see
  assert.match(s.briefing.line, /partial picture/i);
  neuro._setSnapshotForTest(null);
});

test('an empty live list stays empty — it does not fall back to invented cards', () => {
  neuro._setSnapshotForTest(liveSnapshot());
  const s = getState();
  assert.equal(s.presentation.source, 'neuro');
  // focus answered, so there IS one card; nothing is manufactured beyond it.
  assert.ok(Array.isArray(s.presentation.upNext));
  assert.deepEqual(s.presentation.upNext, [], 'no runway in the data means no runway on screen');
  assert.deepEqual(s.presentation.todos.items, []);
  assert.equal(s.presentation.todos.source, 'neuro', 'an empty task list is a real answer, not a missing feed');
  neuro._setSnapshotForTest(null);
});

test('with nothing readable the presentation block is empty and says why', () => {
  neuro._setSnapshotForTest(null);
  const s = getState();
  assert.equal(s.presentation.source, 'unavailable');
  assert.equal(s.presentation.available, false);
  assert.deepEqual(s.presentation.whatMattersNow, []);
  assert.deepEqual(s.presentation.upNext, []);
  assert.ok(s.presentation.notice, 'an empty dashboard with no reason is indistinguishable from a calm day');
  // Capture must stay reachable with the brain down — it is the one thing a kiosk
  // can still usefully offer, even if the save itself then fails honestly.
  assert.ok(s.presentation.quickActions.some((a) => a.action === 'capture'));
});

test('⚠ a RETIRED domain is not an outage, and does not make the banner amber for ever', () => {
  // Nick, 31 Aug 2026, looking at the kiosk: "why does SARA on Pi say partly
  // live - some of neuro could be read?"
  //
  // Because the Jira queue was DELETED in July 2026 ("too much noise") and the
  // state engine still reported it as `unavailable`. Three domains were live,
  // one had been removed on purpose, and the rollup called that `mixed` — so
  // the banner read "Partly live — some of NEURO could not be read" for seven
  // weeks straight, over a perfectly healthy read.
  //
  // A warning that is always on is a warning nobody reads, and it costs the
  // real one. Same species as the stale Jira cache reporting a 3 July snapshot
  // as current fact — a reader outliving its writer — one level up in the UI.
  const p = require('../src/state/provenance');

  // Excluded from the rollup entirely.
  assert.equal(p.rollUp({ queue: 'retired', focus: 'neuro', people: 'neuro', vault: 'neuro' }), 'neuro');
  assert.equal(p.rollUp({ queue: 'retired', focus: 'neuro-stale', people: 'neuro-stale', vault: 'neuro-stale' }), 'neuro-stale');
  // ⚠ But it never manufactures good news: a genuine outage elsewhere still
  // reads as mixed, and a model with NOTHING but retired domains has nothing
  // left to describe.
  assert.equal(p.rollUp({ queue: 'retired', focus: 'neuro', people: 'unavailable', vault: 'neuro' }), 'mixed');
  assert.equal(p.rollUp({ queue: 'retired' }), 'unavailable');

  // The domain itself still refuses to be read as a fact — `available:false`
  // and null counts, exactly like an unavailable one. Retired means "there is
  // no such feature", not "there is nothing in it".
  const q = p.retiredQueue();
  assert.equal(q.available, false);
  assert.equal(q.open, null);
  assert.equal(q.breaching, null);
  assert.match(q.summary, /retired/i);

  // ⚠ And it is CONTRACT-SHAPED. The first cut returned `at_risk` instead of
  // `sections`, so the model failed validation and confidence was capped low —
  // a fix for a cosmetic banner quietly making the whole read look worse.
  for (const key of ['source', 'summary', 'open', 'breaching', 'sections']) {
    assert.ok(key in q, `retiredQueue is missing the contract key "${key}"`);
  }

  // End to end: a live NEURO with the retired queue is LIVE, and the banner is
  // silent rather than amber.
  neuro._setSnapshotForTest(liveSnapshot());
  const s = getState();
  assert.equal(s.domains.queue.source, 'retired');
  assert.equal(s.provenance.state, 'neuro');
  assert.doesNotMatch(s.provenance.message, /partly live/i);
  assert.equal(s.meta.valid, true, 'the retired domain must not break contract validation');
  neuro._setSnapshotForTest(null);
});
