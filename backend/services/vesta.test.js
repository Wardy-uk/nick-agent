'use strict';

/**
 * VESTA — the shared home surface.
 *
 * The redaction tests are the ones that matter. This is served to the PUBLIC
 * INTERNET (pi5 runs Tailscale Funnel), to an account that deliberately has no
 * NEURO PIN, and a work subject line reaching the browser is a leak whatever the
 * page chooses to render. So the assertions are not "the title says Busy" — they
 * are "the real subject is NOWHERE in the returned object".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vesta = require('./vesta');
const capture = require('./capture-links');

// ── Redaction ────────────────────────────────────────────────────────────────

const WORK_EVENT = {
  event_id: 'abc',
  subject: 'Sandford escalation — NT-14855 with Chancellors',
  location: "Chancellors' Offices, Coalville",
  start_time: '2026-09-01T10:00:00',
  end_time: '2026-09-01T11:00:00',
  domain: 'work',
};

test('a work subject is not redacted, it is ABSENT', () => {
  const out = vesta.redactEvent(WORK_EVENT, { domain: 'work' });
  assert.equal(out.title, 'Busy');
  // The real test. A truncated subject, or one left on a field the component
  // happens not to render, has still left the building.
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes('Sandford'), 'the customer name must not be in the payload');
  assert.ok(!blob.includes('NT-14855'), 'nor the ticket');
  assert.ok(!blob.includes('Chancellors'), 'nor the location — a location names a client too');
});

test('the times DO show — she needs to know when he is tied up', () => {
  const out = vesta.redactEvent(WORK_EVENT, { domain: 'work' });
  assert.equal(out.start, '2026-09-01T10:00:00');
  assert.equal(out.end, '2026-09-01T11:00:00');
});

test('a personal event shows properly', () => {
  const out = vesta.redactEvent(
    { subject: 'Dentist', location: 'Coalville', start_time: '2026-09-01T09:00:00', domain: 'personal' },
    { domain: 'personal' },
  );
  assert.equal(out.title, 'Dentist');
  assert.equal(out.location, 'Coalville');
  assert.equal(out.personal, true);
});

test('an event with no domain is treated as WORK', () => {
  // Fail closed. An unclassified event is exactly the one most likely to be a
  // client meeting, and guessing "personal" once is a leak that cannot be undone.
  const out = vesta.redactEvent({ subject: 'Something sensitive' });
  assert.equal(out.title, 'Busy');
  assert.ok(!JSON.stringify(out).includes('sensitive'));
});

test('free and cancelled events are dropped from the day', () => {
  const day = vesta.redactDay([
    { subject: 'Focus block', show_as: 'free', domain: 'work', start_time: '09:00' },
    { subject: 'Gone', show_as: 'cancelled', domain: 'work', start_time: '10:00' },
    { subject: 'Real', show_as: 'busy', domain: 'work', start_time: '11:00' },
  ]);
  assert.equal(day.length, 1);
  assert.equal(day[0].title, 'Busy');
});

test('a whole day leaks nothing', () => {
  const day = vesta.redactDay([WORK_EVENT, { ...WORK_EVENT, subject: 'Disciplinary — Stephen', event_id: 'd' }]);
  const blob = JSON.stringify(day);
  for (const secret of ['Sandford', 'NT-14855', 'Chancellors', 'Disciplinary', 'Stephen']) {
    assert.ok(!blob.includes(secret), `"${secret}" must not survive redaction`);
  }
});

// ── Meals ────────────────────────────────────────────────────────────────────
//
// The kitchen's file format lives in catalogue.test.js now — the fridge is one
// catalogue among many (vinyl, hiking equipment) and never earned a bespoke
// store. What is left here is the only kitchen-specific thing VESTA does:
// knowing what can be cooked out of a list.

const catalogue = require('./catalogue');
const stock = (...names) => catalogue.parse(
  `---\nsections: [Fridge]\nshared: true\n---\n# Kitchen\n\n## Fridge\n\n${names.map(n => `- ${n}`).join('\n')}\n`,
);

test('a meal is only suggested when its ingredients are actually IN', () => {
  const s = vesta.suggestMeals(stock('eggs', 'cheddar cheese'));
  assert.equal(s.known, true);
  const names = s.meals.map(m => m.name);
  assert.ok(names.includes('Omelette'));
  // Nothing here can make a jacket potato. A model asked the same question
  // would cheerfully offer one, and convincingly.
  assert.ok(!names.includes('Jacket potato'));
});

test('every suggestion names what it is using', () => {
  const omelette = vesta.suggestMeals(stock('eggs', 'cheddar cheese', 'mushrooms'))
    .meals.find(m => m.name === 'Omelette');
  assert.ok(omelette.using.includes('egg'));
  assert.ok(omelette.using.includes('cheese'), 'the extras it found are the reason it ranked');
});

test('everything in every section counts — a tin in the cupboard is food', () => {
  const cat = catalogue.parse(
    '---\nsections: [Fridge, Cupboard]\n---\n# K\n\n## Fridge\n\n- cheese\n\n## Cupboard\n\n- bread\n',
  );
  assert.ok(vesta.suggestMeals(cat).meals.some(m => m.name === 'Cheese toastie'));
});

test('an empty kitchen is UNKNOWN, not a fridge with nothing in it', () => {
  const s = vesta.suggestMeals(catalogue.parse('# Kitchen\n'));
  assert.equal(s.known, false);
  assert.match(s.why, /nothing recorded/);
  assert.deepEqual(s.meals, []);
});

test('a stocked kitchen matching no rule says so rather than showing nothing', () => {
  const s = vesta.suggestMeals(stock('pickled walnuts'));
  assert.equal(s.known, true);
  assert.deepEqual(s.meals, []);
  assert.match(s.why, /matches what I know/);
});

// ── Scopes ───────────────────────────────────────────────────────────────────

test('an account predating VESTA sees only its own tasks', () => {
  // The whole reason scopes default closed. Widening the rule globally would
  // have handed every existing account sight of his diary.
  const legacy = { username: 'someone', label: 'Someone' };
  assert.deepEqual(capture.scopesOf(legacy), ['tasks']);
  assert.equal(capture.hasScope(legacy, 'calendar'), false);
  assert.equal(capture.hasScope(legacy, 'kitchen'), false);
});

test('an unknown scope is dropped, never granted', () => {
  assert.deepEqual(capture.normaliseScopes(['calendar', 'everything', 'admin']), ['tasks', 'calendar']);
});

test('tasks cannot be revoked — an account with no scopes is just confusing', () => {
  assert.deepEqual(capture.normaliseScopes([]), ['tasks']);
  assert.deepEqual(capture.normaliseScopes(['kitchen']), ['tasks', 'kitchen']);
});

test('the work/personal split is the CALENDAR SOURCE, measured not guessed', () => {
  // calendar_cache.source is `graph` (Microsoft 365) or `apple` (his iCloud),
  // checked against the live table. Getting this the wrong way round publishes
  // a client meeting.
  assert.equal(vesta.domainOf({ source: 'apple' }), 'personal');
  assert.equal(vesta.domainOf({ source: 'graph' }), 'work');
});

test('an unrecognised or missing calendar source is WORK', () => {
  // Fails closed. A calendar added next year is work until somebody decides
  // otherwise, and an unclassified event is the one most likely to be a client.
  assert.equal(vesta.domainOf({}), 'work');
  assert.equal(vesta.domainOf({ source: 'some-new-calendar' }), 'work');
  assert.equal(vesta.domainOf({ source: 'APPLE-ish' }), 'work');

  const day = vesta.redactDay([
    { subject: 'Client strategy — Sandford', source: 'some-new-calendar', show_as: 'busy', start_time: '09:00' },
  ]);
  assert.equal(day[0].title, 'Busy');
  assert.ok(!JSON.stringify(day).includes('Sandford'));
});

test('his personal calendar shows through in full', () => {
  const day = vesta.redactDay([
    { subject: 'Dentist', source: 'apple', show_as: 'busy', start_time: '09:00' },
  ]);
  assert.equal(day[0].title, 'Dentist');
  assert.equal(day[0].personal, true);
});
