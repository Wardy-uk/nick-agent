'use strict';

/**
 * Pull Apple Calendar and Reminders from iCloud, server-side.
 *
 * ── Why this exists (3 Sep 2026) ────────────────────────────────────────────
 *
 * `apple-ingest.js` receives a PUSH from a Scriptable script on Nick's phone,
 * fired by a Shortcuts automation at 07:00 / 12:00 / 17:00. Measured on the day
 * this was written, that path had delivered **one push in its entire life** — the
 * setup test on 29 Aug — and its own header already names the reason:
 *
 *   "A push-based sync fails SILENTLY by definition — the phone simply stops
 *    calling, and a frozen calendar answers every question exactly as a live
 *    one does."
 *
 * Two separate faults were found underneath it, and the second is why this file
 * exists rather than a third round of fixes:
 *   1. the automation had the WRONG SCRIPT attached (fixed by Nick, 3 Sep);
 *   2. even with the right script, scheduled runs still deliver nothing. The
 *      script reads its API token from the iOS Keychain, and Keychain items
 *      written with the default accessibility are cryptographically UNREADABLE
 *      while the device is locked. So it works in the hand and never in the
 *      pocket, and the unattended failure path is a `console.error` on the
 *      phone — the one place the system watching for failures cannot read.
 *
 * There is no way to fix that from the server: iOS exposes no remote "run this
 * shortcut", and the one push command it does have (`request_location_update`)
 * was measured as best-effort — ignored entirely on an idle handset.
 *
 * So the transport changes and NOTHING ELSE does. `ingestCalendar` and
 * `ingestReminders` keep their shapes, their calendar skip-list, their reminder
 * list whitelist, their `domainForList` and their task-store dedupe. This module
 * only replaces "the phone calls us" with "we call iCloud".
 *
 * ⚠ THE ONE RULE THAT MATTERS MOST. `ingestCalendar` does
 * `clearCalendarWindow(...)` and THEN inserts. A fetch that fails in a way that
 * looks like success — an auth error rendering as an empty multistatus, one
 * calendar of six timing out — would therefore WIPE the window rather than leave
 * it stale. Stale is survivable and visible; empty is a diary that says Nick is
 * free when he is not, which is the exact failure `calendar_cache` exists to
 * prevent. Hence `sync()` refuses to ingest unless every discovered calendar was
 * read successfully, and says which one failed.
 *
 * The Scriptable script and `routes/apple.js` are deliberately LEFT IN PLACE.
 * They are a working fallback for the day iCloud changes something, and nothing
 * here writes where they write until it has a complete read.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');
const ical = require('./ical');
const appleIngest = require('./apple-ingest');

const BASE = 'https://caldav.icloud.com';
const TIMEOUT_MS = 20000;
const STATE_KEY = 'apple_caldav';

// How much diary to hold. Mirrors the Scriptable script's window so the two
// transports cannot disagree about what "the calendar" means.
const DAYS_BACK = Number(process.env.APPLE_CALDAV_DAYS_BACK || 2);
const DAYS_AHEAD = Number(process.env.APPLE_CALDAV_DAYS_AHEAD || 14);

// ── Configuration ────────────────────────────────────────────────────────────
//
// Read at CALL time, never cached at module load: the backend restarts several
// times a day and a credential pasted into Settings should work without one.
// `.env` wins where set, following `notion-sync`. The password is an Apple
// APP-SPECIFIC password (appleid.apple.com), never the account password — Apple
// refuses the latter for CalDAV, and an app password is separately revocable.

/**
 * ⚠ `agent_state` is a STRING column: `setState` stores whatever it is given and
 * `getState` hands the same string back. Passing an object stores the literal
 * `"[object Object]"` and reads back as a string with no properties — so every
 * field is `undefined`, nothing throws, and a stored credential silently reads
 * as "not configured". Caught by the routing test, not by reading. Encoding
 * lives here and nowhere else, so no caller can get it half-right.
 */
function readState() {
  try { return JSON.parse(db.getState(STATE_KEY) || '{}') || {}; } catch { return {}; }
}

function writeState(patch) {
  db.setState(STATE_KEY, JSON.stringify({ ...readState(), ...patch }));
}

/** The one writer for the credential, so the route never touches the encoding. */
function setCredentials(appleId, appPassword) {
  writeState({ appleId: String(appleId).trim(), appPassword: String(appPassword).trim() });
  return configStatus();
}

function credentials() {
  const stored = readState();
  const user = process.env.APPLE_ID || stored.appleId || null;
  const pass = process.env.APPLE_APP_PASSWORD || stored.appPassword || null;
  return { user, pass, source: process.env.APPLE_APP_PASSWORD ? 'env' : (stored.appPassword ? 'stored' : null) };
}

function isConfigured() {
  const c = credentials();
  return !!(c.user && c.pass);
}

/**
 * Non-sensitive config report. Says WHETHER a credential is set, never what it
 * is — `sara/backend`'s rule, and this one is an Apple account password.
 */
function configStatus() {
  const c = credentials();
  return {
    configured: !!(c.user && c.pass),
    appleId: c.user ? String(c.user).replace(/^(.).*(@.*)$/, '$1***$2') : null,
    credentialConfigured: !!c.pass,
    credentialSource: c.source,
    problems: [
      !c.user ? 'APPLE_ID not set' : null,
      !c.pass ? 'APPLE_APP_PASSWORD not set (generate an app-specific password at appleid.apple.com)' : null,
    ].filter(Boolean),
  };
}

// ── Minimal WebDAV XML reading ───────────────────────────────────────────────
//
// No XML dependency: the responses this asks for are small and shaped by the
// request. Matching ignores the namespace PREFIX (iCloud uses `d:`, the spec
// examples use `D:`, and neither is guaranteed) but never the local name.

function xmlUnescape(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Inner text of every `<...:localName>` element, prefix-agnostic. */
function xmlAll(xml, localName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${localName}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(xml || '')))) out.push(m[1]);
  return out;
}

function xmlFirst(xml, localName) {
  const all = xmlAll(xml, localName);
  return all.length ? all[0] : null;
}

/** Split a multistatus into its `<response>` blocks. */
function responses(xml) {
  return xmlAll(xml, 'response');
}

/** True when the element is present in self-closing or open form. */
function hasElement(xml, localName) {
  return new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}\\b`, 'i').test(String(xml || ''));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function dav(method, path, { body = null, depth = '0', contentType = 'application/xml; charset=utf-8' } = {}) {
  const { user, pass } = credentials();
  if (!user || !pass) throw new Error('not-configured');

  const url = path.startsWith('http') ? path : BASE + path;
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    Depth: depth,
  };
  if (body) headers['Content-Type'] = contentType;

  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    // Named, because this is the one failure with a specific fix: Apple refuses
    // the account password for CalDAV and wants an app-specific one.
    const e = new Error('unauthorised — check the app-specific password');
    e.code = 'unauthorised';
    throw e;
  }
  if (res.status >= 400) {
    const e = new Error(`CalDAV ${method} ${res.status}`);
    e.code = 'http-error';
    e.status = res.status;
    throw e;
  }
  return text;
}

// ── Discovery ────────────────────────────────────────────────────────────────

const PROP_PRINCIPAL =
  '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const PROP_HOME =
  '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + '<d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const PROP_CALENDARS =
  '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + '<d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>';

/**
 * Every calendar and reminder list the account can see.
 *
 * ⚠ Collections are classified by their SUPPORTED COMPONENT SET, not by name. In
 * iCloud a Reminders list and a calendar are both collections and only that
 * property tells them apart — guessing from the display name is how a list
 * called "Work" ends up ingested as a diary.
 */
async function discover() {
  const principalXml = await dav('PROPFIND', '/', { body: PROP_PRINCIPAL, depth: '0' });
  const principal = (xmlFirst(xmlFirst(principalXml, 'current-user-principal') || '', 'href') || '').trim();
  if (!principal) throw new Error('could not find the account principal');

  const homeXml = await dav('PROPFIND', principal, { body: PROP_HOME, depth: '0' });
  const home = (xmlFirst(xmlFirst(homeXml, 'calendar-home-set') || '', 'href') || '').trim();
  if (!home) throw new Error('could not find the calendar home');

  const listXml = await dav('PROPFIND', home, { body: PROP_CALENDARS, depth: '1' });

  const collections = [];
  for (const block of responses(listXml)) {
    const href = (xmlFirst(block, 'href') || '').trim();
    if (!href || href === home) continue;
    if (!hasElement(block, 'calendar')) continue; // not a calendar collection

    const name = xmlUnescape((xmlFirst(block, 'displayname') || '').trim());
    const compSet = xmlFirst(block, 'supported-calendar-component-set') || '';
    const comps = (compSet.match(/name="([A-Z]+)"/g) || []).map((s) => s.replace(/[^A-Z]/g, ''));

    collections.push({
      href,
      name: name || '(unnamed)',
      // An EMPTY component set means the server did not say. Treated as a
      // calendar rather than skipped, because dropping a collection silently is
      // the missing-event failure; a VTODO list wrongly read as a calendar just
      // yields no events.
      supportsEvents: comps.length === 0 || comps.includes('VEVENT'),
      supportsTodos: comps.includes('VTODO'),
    });
  }
  return { principal, home, collections };
}

// ── Fetching ─────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYYMMDDTHHMMSSZ` for a CalDAV time-range, from a UTC instant. */
function davStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
    + `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

function eventQuery(startStamp, endStamp) {
  return '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><c:calendar-data/></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + `<c:time-range start="${startStamp}" end="${endStamp}"/>`
    + '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
}

const TODO_QUERY =
  '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + '<d:prop><c:calendar-data/></d:prop>'
  + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/>'
  + '</c:comp-filter></c:filter></c:calendar-query>';

/** Every `<calendar-data>` payload in a multistatus, unescaped. */
function calendarData(xml) {
  return xmlAll(xml, 'calendar-data').map(xmlUnescape);
}

// ── Mapping (PURE) ───────────────────────────────────────────────────────────

/**
 * iCal text -> the event shape `ingestCalendar` already accepts.
 *
 * ⚠ `id` is the UID, and `normaliseEvent` appends the start time to it. That is
 * load-bearing for recurrence: every occurrence of a weekly event shares one
 * UID, and without the start in the key `calendar_cache.event_id` is UNIQUE so
 * all of them collapse into a single row — a repeating commitment appearing
 * once. Same reasoning as the EventKit identifier the phone sends.
 */
function mapEvents(icsTexts, calendarName, fromIso, toIso, tz = ical.DEFAULT_TZ()) {
  const events = [];
  const unsupported = [];

  for (const text of icsTexts) {
    for (const comp of ical.parseComponents(text, ['VEVENT'])) {
      const uid = (ical.prop(comp, 'UID') || {}).value || null;
      const summary = ical.unescapeText((ical.prop(comp, 'SUMMARY') || {}).value || '');
      const location = ical.unescapeText((ical.prop(comp, 'LOCATION') || {}).value || '');
      const status = String(((ical.prop(comp, 'STATUS') || {}).value || '')).toUpperCase();
      if (status === 'CANCELLED') continue;

      const { occurrences, unsupported: why } = ical.expandRecurrence(comp, fromIso, toIso, tz);
      if (why) unsupported.push({ calendar: calendarName, summary: summary.slice(0, 60), why });

      for (const occ of occurrences) {
        events.push({
          id: uid || `${calendarName}:${summary}:${occ.start}`,
          title: summary || '(no title)',
          start: occ.start,
          end: occ.end,
          isAllDay: occ.isDate === true,
          location: location || null,
          calendar: calendarName,
          // ⚠ Deliberately ABSENT, not false. `attendeesOther` is three-valued
          // and undefined must survive as undefined — CalDAV gives an ATTENDEE
          // list but not reliably, and coercing "we do not know" to "nobody
          // else" tells context-state "solo block" about a real meeting.
        });
      }
    }
  }
  return { events, unsupported };
}

/**
 * iCal text -> the reminder shape `ingestReminders` already accepts.
 *
 * Completed items are passed through with `isCompleted: true` rather than
 * filtered here, because the ingest already skips them — and it skips them for a
 * stated reason (creating a task to immediately close it would put work in the
 * wins ledger that nobody did today). Filtering in two places is how one of them
 * comes to disagree.
 */
function mapReminders(icsTexts, listName, tz = ical.DEFAULT_TZ()) {
  const out = [];
  for (const text of icsTexts) {
    for (const comp of ical.parseComponents(text, ['VTODO'])) {
      const summary = ical.unescapeText((ical.prop(comp, 'SUMMARY') || {}).value || '').trim();
      if (!summary) continue;

      const status = String(((ical.prop(comp, 'STATUS') || {}).value || '')).toUpperCase();
      const completed = status === 'COMPLETED' || !!ical.prop(comp, 'COMPLETED');

      const dueProp = ical.prop(comp, 'DUE');
      const due = dueProp ? ical.parseIcalDate(dueProp.value, dueProp.params, tz) : null;

      out.push({
        list: listName,
        title: summary,
        // ⚠ A plain YYYY-MM-DD, never an instant. A reminder due "today" must
        // not become tomorrow west of here — the bug Planner's midnight
        // timestamps already caused once.
        dueDate: due ? due.date : null,
        notes: ical.unescapeText((ical.prop(comp, 'DESCRIPTION') || {}).value || '') || null,
        isCompleted: completed,
      });
    }
  }
  return out;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function windowIso(now = new Date()) {
  const from = new Date(now.getTime() - DAYS_BACK * 86400000);
  const to = new Date(now.getTime() + DAYS_AHEAD * 86400000);
  const local = (d) => {
    const c = ical.utcToCivil(d.getTime(), ical.DEFAULT_TZ());
    return ical.civilToIso(c);
  };
  return { fromIso: local(from), toIso: local(to), fromStamp: davStamp(from), toStamp: davStamp(to) };
}

/**
 * Read iCloud and hand the result to the existing ingest.
 *
 * `dryRun` reads and reports without writing anything, which is how this gets
 * verified against a live account before it is ever allowed near
 * `clearCalendarWindow`.
 */
async function sync({ dryRun = false, now = new Date() } = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured', ...configStatus() };
  }

  let discovered;
  try {
    discovered = await discover();
  } catch (e) {
    return { ok: false, reason: e.code === 'unauthorised' ? 'unauthorised' : 'discovery-failed', error: e.message };
  }

  const { fromIso, toIso, fromStamp, toStamp } = windowIso(now);
  const calendars = discovered.collections.filter((c) => c.supportsEvents);
  const todoLists = discovered.collections.filter((c) => c.supportsTodos);

  // ⚠ Zero collections is "we could not read the account", never "the account is
  // empty". Ingesting on it would clear the window against nothing.
  if (!discovered.collections.length) {
    return { ok: false, reason: 'no-collections', error: 'the account returned no calendars at all' };
  }

  const failures = [];
  const allEvents = [];
  const unsupported = [];
  const byCalendar = {};

  for (const cal of calendars) {
    try {
      const xml = await dav('REPORT', cal.href, { body: eventQuery(fromStamp, toStamp), depth: '1' });
      const mapped = mapEvents(calendarData(xml), cal.name, fromIso, toIso);
      allEvents.push(...mapped.events);
      unsupported.push(...mapped.unsupported);
      byCalendar[cal.name] = mapped.events.length;
    } catch (e) {
      failures.push({ calendar: cal.name, error: e.message });
    }
  }

  const allReminders = [];
  const reminderFailures = [];
  for (const list of todoLists) {
    try {
      const xml = await dav('REPORT', list.href, { body: TODO_QUERY, depth: '1' });
      allReminders.push(...mapReminders(calendarData(xml), list.name));
    } catch (e) {
      reminderFailures.push({ list: list.name, error: e.message });
    }
  }

  const result = {
    ok: true,
    dryRun,
    window: { from: fromIso, to: toIso },
    calendarsSeen: discovered.collections.map((c) => c.name),
    events: allEvents.length,
    byCalendar,
    reminders: allReminders.length,
    // Never swallowed. An unexpandable rule means a series is under-reported,
    // and a diary that reads emptier than it is books over real commitments.
    unsupportedRecurrence: unsupported,
    failures,
    reminderFailures,
  };

  // ⚠ THE REFUSAL. `ingestCalendar` clears the window before inserting, so a
  // partial read must never reach it: losing one calendar to a timeout would
  // erase every event it holds and report success. Stale is visible; empty is a
  // diary that says Nick is free when he is not.
  if (failures.length) {
    result.calendarIngested = false;
    result.reason = 'partial-read';
    if (!dryRun) {
      console.warn(`[AppleCalDAV] refusing to ingest — ${failures.length} calendar(s) failed: `
        + failures.map((f) => f.calendar).join(', '));
    }
  } else if (!dryRun) {
    const ingest = appleIngest.ingestCalendar({
      from: fromIso,
      to: toIso,
      events: allEvents,
      calendars: discovered.collections.map((c) => c.name),
    });
    result.calendarIngested = ingest.ok === true;
    result.calendarResult = ingest;
  } else {
    result.calendarIngested = false;
    result.reason = 'dry-run';
  }

  // Reminders are ADDITIVE — `ingestReminders` creates tasks and deletes
  // nothing — so a partially failed read costs a missed task rather than a lost
  // one, and is worth taking. The failures are still reported.
  if (!dryRun && allReminders.length) {
    result.reminderResult = appleIngest.ingestReminders({ reminders: allReminders });
  }

  if (!dryRun) {
    try {
      writeState({
        lastRunAt: new Date().toISOString(),
        lastOk: !failures.length,
        lastEvents: allEvents.length,
        lastReminders: allReminders.length,
      });
    } catch { /* bookkeeping must never fail the sync */ }
  }

  return result;
}

/** What the last run did, for the senses panel. */
function status() {
  const stored = readState();
  return { ...configStatus(), lastRunAt: stored.lastRunAt || null, lastOk: stored.lastOk ?? null,
    lastEvents: stored.lastEvents ?? null, lastReminders: stored.lastReminders ?? null };
}

module.exports = {
  isConfigured,
  configStatus,
  setCredentials,
  status,
  discover,
  sync,
  // Pure, exported for tests.
  mapEvents,
  mapReminders,
  windowIso,
  davStamp,
  xmlAll,
  xmlFirst,
  xmlUnescape,
  calendarData,
  responses,
  _internals: { dav, eventQuery, TODO_QUERY },
};
