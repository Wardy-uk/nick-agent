// NEURO — Apple sync for Scriptable (iOS)
//
// Pushes Apple Calendar events and Reminders into NEURO. NEURO cannot reach into
// iCloud — there is no server-side API worth having (CalDAV needs an app
// password and is undocumented, EventKit needs a Mac, Reminders has no web API
// at all) — so the phone does the reaching.
//
// ⚠ Scriptable has NO HealthKit API. Health is not and cannot be part of this.
// It already arrives via the FreeReps app on /api/v1/ingest; the route for
// moving off that would be a Shortcut using "Find Health Samples", not this.
//
// ── Setup ───────────────────────────────────────────────────────────────────
// 1. Paste into Scriptable as a script named "NEURO Sync".
// 2. Run it once in-app. It reuses the base URL and API token the NEURO widget
//    already stored in the Keychain, and asks only if they are missing.
// 3. Automate it: Shortcuts > Automation > Time of Day > Run Script. A few times
//    a day is plenty; this is a diary, not a chat.
//
// ⚠ THIS FILE MUST CONTAIN NO BACKSLASHES — none, anywhere, comments included.
// It reaches the phone by being COPIED AS TEXT and pasted into Scriptable, and a
// backslash does not survive that trip: an escaped forward slash inside a regex
// literal arrived on Nick's phone as a syntax error once already and the whole
// script refused to parse. Use String.fromCharCode() for control characters,
// split/join instead of regex replace, and endsWith/slice instead of anchors.
// A test pins this.
//
// The token is NEVER written into this file: the repo is public, and a
// credential in a tracked file is exactly how the PIN leaked in July.

const KEY_URL = 'neuro_base_url';
const KEY_TOKEN = 'neuro_api_token';
const DEFAULT_URL = 'https://pi5.tailecb90f.ts.net';
const TIMEOUT_SECONDS = 20;

const VERSION = 'v1';

// How far ahead to send. Two weeks covers every question NEURO asks of the
// diary (what is on today, is this slot free, when is the next 1-2-1 due) and
// keeps the payload small enough to push over a phone connection.
const DAYS_AHEAD = 14;
// A little history, so an event that moved earlier does not linger as a ghost
// in the window NEURO already holds.
const DAYS_BACK = 1;

// ── Config ──────────────────────────────────────────────────────────────────

async function prompt(title, message, value, secure) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  if (secure) a.addSecureTextField('', value || ''); else a.addTextField('', value || '');
  a.addAction('Save');
  await a.present();
  return a.textFieldValue(0);
}

// NB: not named `config` — that is Scriptable's own global and shadowing it
// breaks config.runsInApp below.
async function loadSettings() {
  let base = Keychain.contains(KEY_URL) ? Keychain.get(KEY_URL) : null;
  let token = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : null;

  if (config.runsInApp) {
    if (!base) {
      base = await prompt('NEURO base URL', 'Tailscale host serving the API.', DEFAULT_URL);
      if (base) {
        // Trailing slashes stripped by hand rather than by regex — an escaped
        // forward slash is precisely what a paste pipeline eats.
        let clean = base.trim();
        while (clean.length && clean.charAt(clean.length - 1) === '/') clean = clean.slice(0, -1);
        Keychain.set(KEY_URL, clean);
        base = clean;
      }
    }
    if (!token) {
      token = await prompt('NEURO API token', 'NEURO_API_TOKEN from backend/.env. Stored in the iOS Keychain, not in this script.', '', true);
      if (token) Keychain.set(KEY_TOKEN, token.trim());
    }
  }
  return { base: base || DEFAULT_URL, token: token };
}

// ── Dates ───────────────────────────────────────────────────────────────────

function pad(n) { return n < 10 ? '0' + n : String(n); }

// Local wall-clock, NEVER toISOString(). The Pi may run UTC and NEURO stores
// calendar times as local strings throughout; a UTC stamp here would shift every
// event by an hour through British Summer Time — the exact bug Graph had before
// the Prefer: outlook.timezone header.
function localStamp(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}

function localDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// ── Collect ─────────────────────────────────────────────────────────────────

/**
 * Does this event have people in it other than Nick?
 *
 * Returns true, false, or UNDEFINED — three-valued, and the undefined matters.
 * Scriptable does not always populate attendees, and answering false there would
 * tell NEURO "solo block" about a real meeting. NEURO requires exactly true to
 * call something a meeting, so an unknown fails closed on its own.
 */
function attendeesOther(ev) {
  try {
    const list = ev.attendees;
    if (!list || typeof list.length !== 'number') return undefined;
    if (list.length === 0) return false;
    // Any attendee at all who is not the current user. Scriptable exposes very
    // little about an attendee, so this is a count question, not an identity
    // one — and a solo event normally has no attendees whatsoever.
    return list.length > 1;
  } catch (e) {
    return undefined;
  }
}

async function collectEvents() {
  const from = addDays(new Date(), -DAYS_BACK);
  const to = addDays(new Date(), DAYS_AHEAD);
  const found = await CalendarEvent.between(from, to);

  const events = found.map(function (ev) {
    const out = {
      id: ev.identifier,
      title: ev.title,
      start: localStamp(ev.startDate),
      end: localStamp(ev.endDate),
      isAllDay: ev.isAllDay === true,
      location: ev.location || null,
    };
    const other = attendeesOther(ev);
    // Only sent when it is actually known. An absent key stays undefined all the
    // way into the column, which is the honest answer.
    if (other !== undefined) out.attendeesOther = other;
    return out;
  });

  return { from: localStamp(from), to: localStamp(to), events: events };
}

async function collectReminders() {
  // Incomplete only. A completed reminder has nothing to add — NEURO skips them
  // anyway, and sending the whole history would grow without limit.
  const found = await Reminder.allIncomplete();
  return found.map(function (r) {
    return {
      title: r.title,
      notes: r.notes || null,
      // A plain date, never an instant. A reminder due "today" must not become
      // tomorrow once a timezone is applied to it.
      dueDate: r.dueDate ? localDate(r.dueDate) : null,
      isCompleted: r.isCompleted === true,
      // The LIST is what NEURO uses to decide work vs personal, so it has to
      // travel. Scriptable exposes it as the reminder's calendar.
      list: r.calendar ? r.calendar.title : null,
    };
  });
}

// ── Send ────────────────────────────────────────────────────────────────────

async function post(settings, path, payload) {
  const req = new Request(settings.base + path);
  req.method = 'POST';
  req.headers = {
    'Content-Type': 'application/json',
    'X-NEURO-API-TOKEN': settings.token,
  };
  req.timeoutInterval = TIMEOUT_SECONDS;
  req.body = JSON.stringify(payload);
  const res = await req.loadJSON();
  return res;
}

async function run() {
  const settings = await loadSettings();
  if (!settings.token) {
    return { ok: false, error: 'No API token — run this in the app once.' };
  }

  const lines = [];
  let failed = false;

  try {
    const cal = await collectEvents();
    const res = await post(settings, '/api/apple/calendar', cal);
    if (res && res.ok) {
      lines.push(res.stored + ' events sent' + (res.rejected ? ' (' + res.rejected + ' unusable)' : ''));
    } else {
      failed = true;
      lines.push('Calendar failed: ' + ((res && res.error) || 'unknown'));
    }
  } catch (e) {
    failed = true;
    lines.push('Calendar failed: ' + (e.message || 'unreachable'));
  }

  try {
    const reminders = await collectReminders();
    const res = await post(settings, '/api/apple/reminders', { reminders: reminders });
    if (res && res.ok) {
      lines.push(res.created + ' new tasks, ' + res.folded + ' already known');
    } else {
      failed = true;
      lines.push('Reminders failed: ' + ((res && res.error) || 'unknown'));
    }
  } catch (e) {
    failed = true;
    lines.push('Reminders failed: ' + (e.message || 'unreachable'));
  }

  return { ok: !failed, lines: lines };
}

const result = await run();

if (config.runsInApp) {
  // Said out loud on a manual run. A sync that quietly did nothing is
  // indistinguishable from one that worked, which is the whole failure mode of
  // a push-based feed.
  const a = new Alert();
  a.title = result.ok ? 'NEURO sync ' + VERSION : 'NEURO sync had a problem';
  a.message = (result.lines || []).join(String.fromCharCode(10)) || (result.error || 'Nothing to report.');
  a.addAction('OK');
  await a.present();
} else if (!result.ok) {
  // Running unattended from a Shortcut: a failure has to leave a trace
  // somewhere, or the feed silently freezes and the diary keeps answering as
  // though it were current.
  console.error((result.lines || []).join(' | ') || result.error);
}

Script.complete();
