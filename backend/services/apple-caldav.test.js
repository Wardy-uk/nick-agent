'use strict';

/**
 * Tests for the server-side iCloud pull.
 *
 * The centre of this file is ONE behaviour: `ingestCalendar` clears the window
 * before it inserts, so a read that fails in a way resembling success would not
 * leave the diary stale — it would EMPTY it, and report success while doing so.
 * `calendar_cache` is what answers "is Nick free", so that failure books
 * meetings over real commitments. Every refusal test below exists for that.
 *
 * `fetch` is stubbed rather than mocked at the module boundary, so the real
 * PROPFIND/REPORT bodies, the real XML reading and the real mapping all run.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// A scratch DB before anything requires the real one.
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-caldav-')), 'agent.db',
);
process.env.NEURO_TIMEZONE = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');

const caldav = require('./apple-caldav');
const appleIngest = require('./apple-ingest');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRINCIPAL_XML =
  '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop>'
  + '<current-user-principal><href>/12345/principal/</href></current-user-principal>'
  + '</prop></propstat></response></multistatus>';

const HOME_XML =
  '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response>'
  + '<href>/12345/principal/</href><propstat><prop>'
  + '<C:calendar-home-set><href>/12345/calendars/</href></C:calendar-home-set>'
  + '</prop></propstat></response></multistatus>';

function collection(href, name, comps) {
  return '<response><href>' + href + '</href><propstat><prop>'
    + '<displayname>' + name + '</displayname>'
    + '<resourcetype><collection/><C:calendar/></resourcetype>'
    + '<C:supported-calendar-component-set>'
    + comps.map((c) => '<C:comp name="' + c + '"/>').join('')
    + '</C:supported-calendar-component-set>'
    + '</prop></propstat></response>';
}

const CALENDARS_XML =
  '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
  + '<response><href>/12345/calendars/</href></response>'
  + collection('/12345/calendars/home/', 'Home', ['VEVENT'])
  + collection('/12345/calendars/work/', 'Work', ['VEVENT'])
  + collection('/12345/calendars/reminders/', 'Reminders', ['VTODO'])
  + '</multistatus>';

function icsResponse(ics) {
  return '<multistatus xmlns="DAV:"><response><propstat><prop><calendar-data>'
    + ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    + '</calendar-data></prop></propstat></response></multistatus>';
}

const HIKE_ICS = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:hike-1', 'SUMMARY:Hiking',
  'DTSTART:20260905T090000', 'DTEND:20260905T120000', 'RRULE:FREQ=WEEKLY',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const TODO_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTODO', 'UID:t1', 'SUMMARY:Buy stamps', 'DUE;VALUE=DATE:20260908', 'END:VTODO',
  'BEGIN:VTODO', 'UID:t2', 'SUMMARY:Already done', 'STATUS:COMPLETED', 'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

/**
 * Stub `fetch`, routing on what the real code actually sends. `calendarFail`
 * names a calendar href fragment that should return 500.
 */
function stubFetch({ calendarFail = null, calendarsXml = CALENDARS_XML } = {}) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = String((opts && opts.body) || '');
    calls.push({ url: u, method: opts.method });

    const reply = (status, text) => ({ status, text: async () => text });

    if (body.includes('current-user-principal')) return reply(207, PRINCIPAL_XML);
    if (body.includes('calendar-home-set')) return reply(207, HOME_XML);
    if (body.includes('supported-calendar-component-set')) return reply(207, calendarsXml);
    if (body.includes('VTODO')) return reply(207, icsResponse(TODO_ICS));
    if (body.includes('VEVENT')) {
      if (calendarFail && u.includes(calendarFail)) return reply(500, 'boom');
      return reply(207, icsResponse(HIKE_ICS));
    }
    return reply(404, '');
  };
  return calls;
}

/**
 * ⚠ MUST be async and MUST await `fn`. The first cut was synchronous, so the
 * `finally` deleted the credentials before the awaited `sync()` ever read them
 * and five tests failed as "not-configured" — the harness testing itself rather
 * than the code. Same species as the un-awaited `describe()` call site that
 * shipped a proposal consisting of nothing but two fields.
 */
async function withCredentials(fn) {
  process.env.APPLE_ID = 'nick@example.com';
  process.env.APPLE_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
  try { return await fn(); } finally {
    delete process.env.APPLE_ID;
    delete process.env.APPLE_APP_PASSWORD;
  }
}

/** Replace the ingest functions and record what they were called with. */
function spyIngest() {
  const seen = { calendar: [], reminders: [] };
  const realCal = appleIngest.ingestCalendar;
  const realRem = appleIngest.ingestReminders;
  appleIngest.ingestCalendar = (payload) => { seen.calendar.push(payload); return { ok: true, stored: payload.events.length }; };
  appleIngest.ingestReminders = (payload) => { seen.reminders.push(payload); return { ok: true, created: 0 }; };
  seen.restore = () => { appleIngest.ingestCalendar = realCal; appleIngest.ingestReminders = realRem; };
  return seen;
}

// ── Config ───────────────────────────────────────────────────────────────────

test('an unconfigured account is a CHOICE, and names what is missing', () => {
  const s = caldav.configStatus();
  assert.equal(s.configured, false);
  assert.match(s.problems.join(' '), /APPLE_APP_PASSWORD/);
});

test('the credential is never returned, and the Apple ID is masked', () => {
  withCredentials(() => {
    const s = caldav.configStatus();
    assert.equal(s.configured, true);
    assert.equal(s.credentialConfigured, true);
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes('abcd-efgh'), 'the app password must never leave this module');
    assert.ok(!blob.includes('nick@example.com'), 'the Apple ID is masked');
  });
});

// ── Mapping ──────────────────────────────────────────────────────────────────

test('a recurring event becomes one row per occurrence, sharing a UID', () => {
  const { events } = caldav.mapEvents([HIKE_ICS], 'Home', '2026-09-01T00:00:00', '2026-09-20T00:00:00');
  assert.deepEqual(events.map((e) => e.start), [
    '2026-09-05T09:00:00', '2026-09-12T09:00:00', '2026-09-19T09:00:00',
  ]);
  // normaliseEvent appends the start to the id; without that the UNIQUE index
  // collapses them into one row and a weekly commitment appears once.
  assert.equal(new Set(events.map((e) => e.id)).size, 1);
});

test('attendeesOther is ABSENT, never false', () => {
  // Three-valued. Coercing "we do not know" to "nobody else" tells context-state
  // "solo block" about a real meeting.
  const { events } = caldav.mapEvents([HIKE_ICS], 'Home', '2026-09-01T00:00:00', '2026-09-20T00:00:00');
  assert.ok(!('attendeesOther' in events[0]));
});

test('a cancelled event is dropped', () => {
  const ics = ['BEGIN:VEVENT', 'UID:x', 'SUMMARY:Gone', 'STATUS:CANCELLED',
    'DTSTART:20260905T090000', 'DTEND:20260905T100000', 'END:VEVENT'].join('\r\n');
  const { events } = caldav.mapEvents([ics], 'Home', '2026-09-01T00:00:00', '2026-09-20T00:00:00');
  assert.equal(events.length, 0);
});

test('a reminder due date is a plain YYYY-MM-DD, never an instant', () => {
  // A reminder due "today" must not become tomorrow west of here.
  const rems = caldav.mapReminders([TODO_ICS], 'Reminders');
  const stamps = rems.find((r) => r.title === 'Buy stamps');
  assert.equal(stamps.dueDate, '2026-09-08');
  assert.equal(stamps.list, 'Reminders');
});

test('a completed reminder is passed through, not filtered here', () => {
  // The ingest already skips them, for a stated reason. Filtering twice is how
  // the two come to disagree.
  const rems = caldav.mapReminders([TODO_ICS], 'Reminders');
  const done = rems.find((r) => r.title === 'Already done');
  assert.equal(done.isCompleted, true);
});

// ── The refusals ─────────────────────────────────────────────────────────────

test('an unconfigured sync ingests NOTHING', async () => {
  const seen = spyIngest();
  try {
    const r = await caldav.sync();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-configured');
    assert.equal(seen.calendar.length, 0);
  } finally { seen.restore(); }
});

test('a PARTIAL read refuses to ingest — the whole reason this file is careful', async () => {
  // One calendar times out. `ingestCalendar` would clear the window and reinsert
  // only what was read, silently erasing every event the failed calendar holds
  // and reporting success.
  const seen = spyIngest();
  stubFetch({ calendarFail: '/work/' });
  try {
    await withCredentials(async () => {
      const r = await caldav.sync();
      assert.equal(r.ok, true, 'the run itself completes and reports');
      assert.equal(r.calendarIngested, false);
      assert.equal(r.reason, 'partial-read');
      assert.equal(r.failures.length, 1);
      assert.equal(r.failures[0].calendar, 'Work');
      assert.equal(seen.calendar.length, 0, 'ingestCalendar MUST NOT be called');
    });
  } finally { seen.restore(); }
});

test('an account returning no collections is a failed read, not an empty diary', async () => {
  const seen = spyIngest();
  stubFetch({ calendarsXml: '<multistatus xmlns="DAV:"></multistatus>' });
  try {
    await withCredentials(async () => {
      const r = await caldav.sync();
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'no-collections');
      assert.equal(seen.calendar.length, 0);
    });
  } finally { seen.restore(); }
});

test('a dry run reads everything and writes nothing', async () => {
  const seen = spyIngest();
  stubFetch();
  try {
    await withCredentials(async () => {
      const r = await caldav.sync({ dryRun: true });
      assert.equal(r.ok, true);
      assert.ok(r.events > 0, 'it really did read events');
      assert.equal(r.calendarIngested, false);
      assert.equal(r.reason, 'dry-run');
      assert.equal(seen.calendar.length, 0);
      assert.equal(seen.reminders.length, 0);
    });
  } finally { seen.restore(); }
});

test('a clean read ingests, and reminder lists are told apart from calendars', async () => {
  const seen = spyIngest();
  stubFetch();
  try {
    await withCredentials(async () => {
      const r = await caldav.sync();
      assert.equal(r.ok, true);
      assert.equal(r.failures.length, 0);
      assert.equal(r.calendarIngested, true);
      assert.equal(seen.calendar.length, 1);

      // Classified by supported component set, never by name: the VTODO list
      // must not arrive as a diary, and the two VEVENT calendars must.
      const payload = seen.calendar[0];
      const cals = new Set(payload.events.map((e) => e.calendar));
      assert.deepEqual([...cals].sort(), ['Home', 'Work']);
      assert.ok(!cals.has('Reminders'));

      assert.equal(seen.reminders.length, 1);
      assert.ok(seen.reminders[0].reminders.some((x) => x.title === 'Buy stamps'));
    });
  } finally { seen.restore(); }
});

test('the ingest window is passed as local wall-clock, matching calendar_cache', async () => {
  const seen = spyIngest();
  stubFetch();
  try {
    await withCredentials(async () => {
      await caldav.sync({ now: new Date('2026-09-03T12:00:00Z') });
      const p = seen.calendar[0];
      assert.match(p.from, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      assert.ok(!/[Zz+]/.test(p.from), 'no zone suffix — these are sliced, not parsed');
    });
  } finally { seen.restore(); }
});
