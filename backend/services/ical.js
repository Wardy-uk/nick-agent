'use strict';

/**
 * iCalendar (RFC 5545) parsing, PURE.
 *
 * No network, no clock, no database — every function takes what it needs. That
 * is deliberate: the whole point of pulling the diary server-side is that the
 * failure modes become inspectable, and a parser that needs iCloud in order to
 * test it is one nobody re-tests (the `pi-health.assess()` split, again).
 *
 * ⚠ There is a SECOND, older ICS reader in `obsidian.js` (`parseIcsDate` /
 * `parseIcsEvents`). It is NOT reused and NOT replaced, on purpose:
 *   · it is scoped to a published Outlook feed and emits a different shape
 *     (`subject`/`showAs`) for a different consumer;
 *   · it has no VTODO and no RRULE, both of which this needs;
 *   · it strips TZID with `replace(/^.*:/, '')`, which silently treats a
 *     TZID-qualified time as local wall-clock. That is right for Europe/London
 *     and wrong for every other zone.
 * The ONE rule both must share is the timezone conversion: a trailing `Z` is
 * converted against NEURO_TIMEZONE via Intl, NEVER against the host clock,
 * because the Pi may run in UTC and that would make the conversion a silent
 * no-op. This repo has already paid for that bug twice.
 *
 * CommonJS — NEURO backend convention.
 */

const DEFAULT_TZ = () => process.env.NEURO_TIMEZONE || 'Europe/London';

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Undo RFC 5545 line folding. A continuation line begins with a space or tab and
 * belongs to the line before it. Done before anything else, or a long SUMMARY
 * arrives truncated at 75 octets and nothing complains.
 */
function unfoldLines(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** RFC 5545 escaping, in the one place that knows about it. */
function unescapeText(v) {
  return String(v == null ? '' : v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * One content line -> { name, params, value }.
 *
 * ⚠ The value is split on the FIRST unquoted colon, never the last. A
 * `LOCATION:https://teams.microsoft.com/...` is entirely normal, and splitting
 * on the last colon (which the older reader does) mangles it.
 */
function parseLine(line) {
  const s = String(line == null ? '' : line);
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon === -1) return null;

  const head = s.slice(0, colon);
  const value = s.slice(colon + 1);
  const bits = head.split(';');
  const name = bits[0].toUpperCase();

  const params = {};
  for (const p of bits.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/**
 * Pull out components of the wanted types (VEVENT / VTODO).
 *
 * Nesting is tracked so a VALARM inside a VEVENT cannot end it early — the naive
 * `split('BEGIN:VEVENT')` approach reads the alarm's own END as the event's, and
 * every event with a reminder set on it loses its tail.
 */
function parseComponents(text, wanted = ['VEVENT', 'VTODO']) {
  const want = new Set(wanted.map((w) => String(w).toUpperCase()));
  const out = [];
  const stack = [];

  for (const line of unfoldLines(text)) {
    const p = parseLine(line);
    if (!p) continue;

    if (p.name === 'BEGIN') {
      stack.push({ type: p.value.toUpperCase(), props: [] });
      continue;
    }
    if (p.name === 'END') {
      const done = stack.pop();
      if (done && want.has(done.type)) out.push(done);
      continue;
    }
    // Belongs to the innermost component, so a VALARM's TRIGGER never lands on
    // the event.
    if (stack.length) stack[stack.length - 1].props.push(p);
  }
  return out;
}

/** First property by name, or null. Params are kept — TZID lives there. */
function prop(component, name) {
  const n = String(name).toUpperCase();
  const hit = (component && component.props ? component.props : []).find((p) => p.name === n);
  return hit || null;
}

/** Every property by name (EXDATE can legally repeat). */
function propAll(component, name) {
  const n = String(name).toUpperCase();
  return (component && component.props ? component.props : []).filter((p) => p.name === n);
}

// ── Time ─────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/**
 * A civil date-time, with no zone attached. Everything downstream of this module
 * deals in local wall-clock strings (`YYYY-MM-DDTHH:MM:SS`), because that is what
 * `calendar_cache` holds and what every consumer slices rather than parses.
 */
function civil(y, mo, d, hh, mm, ss) {
  return { y, mo, d, hh: hh || 0, mm: mm || 0, ss: ss || 0 };
}

function civilToIso(c) {
  return `${c.y}-${pad(c.mo)}-${pad(c.d)}T${pad(c.hh)}:${pad(c.mm)}:${pad(c.ss)}`;
}

/** Convert a UTC instant to civil wall-clock in `tz`. Intl, never the host clock. */
function utcToCivil(msUtc, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(msUtc));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return civil(g('year'), g('month'), g('day'), g('hour'), g('minute'), g('second'));
}

/**
 * An iCal date/time value -> civil wall-clock in `tz`.
 *
 * Three shapes exist and they mean different things:
 *   · `20260905`                  DATE     — all-day, no time, no zone
 *   · `20260905T090000Z`          UTC      — MUST be converted
 *   · `20260905T090000` + TZID    zoned    — converted from that zone
 *   · `20260905T090000` bare      floating — already local wall-clock, left alone
 *
 * ⚠ A floating time is deliberately NOT converted. It means "09:00 wherever you
 * are", so converting it would move an event that was already correct.
 */
function parseIcalDate(value, params = {}, tz = DEFAULT_TZ()) {
  const raw = String(value == null ? '' : value).trim();

  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { isDate: true, iso: `${y}-${mo}-${d}T00:00:00`, date: `${y}-${mo}-${d}` };
  }

  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m.map((x) => x);

  // Zoned or UTC: resolve to an instant, then render in `tz`.
  const tzid = params && params.TZID ? String(params.TZID) : null;
  if (z === 'Z') {
    const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
    const c = utcToCivil(ms, tz);
    return { isDate: false, iso: civilToIso(c), date: `${c.y}-${pad(c.mo)}-${pad(c.d)}` };
  }
  if (tzid && tzid !== tz) {
    // Find the UTC instant whose wall-clock in `tzid` is this value, then render
    // it in `tz`. Two passes because the offset depends on the instant itself.
    let guess = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
    for (let i = 0; i < 2; i++) {
      const back = utcToCivil(guess, tzid);
      const drift = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
        - Date.UTC(back.y, back.mo - 1, back.d, back.hh, back.mm, back.ss);
      if (!drift) break;
      guess += drift;
    }
    const c = utcToCivil(guess, tz);
    return { isDate: false, iso: civilToIso(c), date: `${c.y}-${pad(c.mo)}-${pad(c.d)}` };
  }

  // Floating, or already in our own zone: keep the wall-clock verbatim.
  return { isDate: false, iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss}`, date: `${y}-${mo}-${d}` };
}

// ── Recurrence ───────────────────────────────────────────────────────────────
//
// ⚠ Why this exists at all. CalDAV can expand recurrence server-side, and the
// request asks it to — but iCloud is not guaranteed to honour it, and the
// failure is the worst possible shape: an unexpanded RRULE yields ONE occurrence
// where there should be many, so a weekly commitment shows up once and every
// other week looks free. `calendar_cache` is what answers "is Nick free", so a
// diary that reads emptier than it is books meetings over real commitments.
// Hence: expand locally, and REPORT anything that could not be expanded rather
// than dropping it silently.
//
// The supported set is CLOSED and small, matching a personal calendar: FREQ
// DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly), and
// EXDATE. Anything else is reported as unsupported — never guessed at.

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 750; // a daily event over two years, comfortably

/** Civil -> ms, treating the civil value AS IF UTC. Only ever used for arithmetic. */
function civilMs(c) {
  return Date.UTC(c.y, c.mo - 1, c.d, c.hh, c.mm, c.ss);
}
function msCivil(ms) {
  const d = new Date(ms);
  return civil(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
/** Does this civil date actually exist? 31 February does not. */
function civilExists(c) {
  const d = new Date(Date.UTC(c.y, c.mo - 1, c.d));
  return d.getUTCFullYear() === c.y && d.getUTCMonth() + 1 === c.mo && d.getUTCDate() === c.d;
}

function isoToCivil(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  return civil(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** `FREQ=WEEKLY;BYDAY=MO,WE` -> { FREQ:'WEEKLY', BYDAY:['MO','WE'] } */
function parseRrule(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    if (k === 'BYDAY') out[k] = v.split(',').map((x) => x.trim().toUpperCase());
    else if (k === 'COUNT' || k === 'INTERVAL') out[k] = Number(v);
    else out[k] = v.toUpperCase();
  }
  return out;
}

/**
 * Every occurrence of one component inside [fromIso, toIso], as local wall-clock.
 *
 * Returns `{ occurrences, unsupported }`. `unsupported` is a REASON string when
 * the rule could not be honoured — the caller is expected to surface it, not
 * swallow it, because the alternative is a diary that quietly under-reports.
 */
function expandRecurrence(component, fromIso, toIso, tz = DEFAULT_TZ()) {
  const dtstartProp = prop(component, 'DTSTART');
  if (!dtstartProp) return { occurrences: [], unsupported: 'no DTSTART' };

  const start = parseIcalDate(dtstartProp.value, dtstartProp.params, tz);
  if (!start) return { occurrences: [], unsupported: 'unparseable DTSTART' };

  const dtendProp = prop(component, 'DTEND');
  const end = dtendProp ? parseIcalDate(dtendProp.value, dtendProp.params, tz) : null;

  const startC = isoToCivil(start.iso);
  const durationMs = end ? Math.max(0, civilMs(isoToCivil(end.iso)) - civilMs(startC)) : 0;

  const fromC = isoToCivil(fromIso);
  const toC = isoToCivil(toIso);
  if (!fromC || !toC) return { occurrences: [], unsupported: 'bad window' };
  const fromMs = civilMs(fromC);
  const toMs = civilMs(toC);

  const emit = (c) => ({
    start: civilToIso(c),
    end: civilToIso(msCivil(civilMs(c) + durationMs)),
    isDate: start.isDate,
  });
  const inWindow = (c) => {
    const ms = civilMs(c);
    return ms + durationMs >= fromMs && ms <= toMs;
  };

  const rruleProp = prop(component, 'RRULE');
  if (!rruleProp) {
    return { occurrences: inWindow(startC) ? [emit(startC)] : [], unsupported: null };
  }

  const rule = parseRrule(rruleProp.value);
  const freq = rule.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    // Fail LOUD and still emit the base occurrence — better a partial diary that
    // says it is partial than a silent one.
    return { occurrences: inWindow(startC) ? [emit(startC)] : [], unsupported: `FREQ=${freq || '(none)'}` };
  }
  for (const k of Object.keys(rule)) {
    if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(k)) {
      return { occurrences: inWindow(startC) ? [emit(startC)] : [], unsupported: `${k} not supported` };
    }
  }
  if (rule.BYDAY && freq !== 'WEEKLY') {
    return { occurrences: inWindow(startC) ? [emit(startC)] : [], unsupported: `BYDAY with FREQ=${freq}` };
  }

  const interval = Number.isFinite(rule.INTERVAL) && rule.INTERVAL > 0 ? rule.INTERVAL : 1;
  const untilC = rule.UNTIL ? isoToCivil((parseIcalDate(rule.UNTIL, {}, tz) || {}).iso || '') : null;
  const untilMs = untilC ? civilMs(untilC) : null;

  // EXDATE, in whatever shape it arrives (repeated properties, comma lists).
  const excluded = new Set();
  for (const ex of propAll(component, 'EXDATE')) {
    for (const one of String(ex.value).split(',')) {
      const p = parseIcalDate(one.trim(), ex.params, tz);
      if (p) excluded.add(p.iso);
    }
  }

  const byDay = rule.BYDAY && rule.BYDAY.length
    ? new Set(rule.BYDAY.map((d) => d.replace(/^[+-]?\d+/, '')))
    : null;

  const occurrences = [];
  let produced = 0;
  let cursor = { ...startC };

  for (let step = 0; step < MAX_OCCURRENCES; step++) {
    // One "step" is one interval period; WEEKLY+BYDAY yields several per period.
    const candidates = [];
    if (freq === 'WEEKLY' && byDay) {
      // Walk the 7 days of this week from the cursor's week start (Sunday).
      const cursorMs = civilMs(cursor);
      const dow = new Date(cursorMs).getUTCDay();
      for (let i = 0; i < 7; i++) {
        const c = msCivil(cursorMs + (i - dow) * 86400000);
        if (byDay.has(DAY_CODES[new Date(civilMs(c)).getUTCDay()])) candidates.push(c);
      }
    } else {
      candidates.push({ ...cursor });
    }

    for (const c of candidates) {
      const ms = civilMs(c);
      if (ms < civilMs(startC)) continue;             // BYDAY can reach before DTSTART
      if (untilMs !== null && ms > untilMs) continue;
      // ⚠ The 31st of a 30-day month DOES NOT OCCUR. RFC 5545 skips it rather
      // than sliding it — and sliding would invent a commitment on a day Nick
      // never agreed to. Without this the expander emitted `2026-02-31`, which
      // is not a date, straight into calendar_cache.
      if (!civilExists(c)) continue;
      // COUNT bounds the recurrence SET, and EXDATE removes from that set — so
      // an excluded instance still consumes one, which is what python-dateutil
      // and ical.js both do. Counting after exclusion silently extends the
      // series past where the organiser ended it.
      produced++;
      if (Number.isFinite(rule.COUNT) && produced > rule.COUNT) break;
      if (excluded.has(civilToIso(c))) continue;
      if (inWindow(c)) occurrences.push(emit(c));
    }

    if (Number.isFinite(rule.COUNT) && produced >= rule.COUNT) break;
    if (untilMs !== null && civilMs(cursor) > untilMs) break;
    if (civilMs(cursor) > toMs) break;

    // Advance one interval.
    if (freq === 'DAILY') cursor = msCivil(civilMs(cursor) + interval * 86400000);
    else if (freq === 'WEEKLY') cursor = msCivil(civilMs(cursor) + interval * 7 * 86400000);
    else if (freq === 'MONTHLY') {
      const next = { ...cursor, mo: cursor.mo + interval };
      while (next.mo > 12) { next.mo -= 12; next.y += 1; }
      // The 31st of a 30-day month simply does not occur — RFC 5545 skips it
      // rather than sliding it, and sliding would invent a commitment.
      const probe = new Date(Date.UTC(next.y, next.mo - 1, next.d, next.hh, next.mm, next.ss));
      if (probe.getUTCDate() !== next.d) { cursor = next; continue; }
      cursor = next;
    } else if (freq === 'YEARLY') cursor = { ...cursor, y: cursor.y + interval };
  }

  return { occurrences, unsupported: null };
}

module.exports = {
  DEFAULT_TZ,
  unfoldLines,
  unescapeText,
  parseLine,
  parseComponents,
  prop,
  propAll,
  parseIcalDate,
  expandRecurrence,
  parseRrule,
  civilToIso,
  utcToCivil,
  _pad: pad,
};
