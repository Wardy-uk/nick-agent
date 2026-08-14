'use strict';

/**
 * Free text → a meeting draft. "create a meeting at 2pm tomorrow for me and abdi"
 * becomes { date, start, end, attendees, subject } for the composer to confirm.
 *
 * Deterministic regex first — it is instant, works with the Pi offline, and is
 * the same shape as the inline hint parsing in task-store.js. Only when no time
 * can be found do we spend a model call (via ai-routing, so it honours AI_MODE
 * and the budget guard).
 *
 * This NEVER creates anything. It returns a draft plus a `needs` list of what it
 * could not work out, because the thing it feeds sends real invites to real
 * people — the confirm step is the safety, so the parser is allowed to guess.
 */

const aiRouting = require('./ai-routing');
const contacts = require('./contact-directory');

const DEFAULT_DURATION_MINS = 30;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Local wall-clock formatting throughout — toISOString() would shift the date
// across midnight during BST, which is exactly the bug CalendarView had.
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addMinutes(dateStr, timeStr, mins) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm);
  dt.setMinutes(dt.getMinutes() + mins);
  return { date: localDate(dt), time: `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` };
}

function parseDate(text, now = new Date()) {
  const t = text.toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/\bday after tomorrow\b/.test(t)) { base.setDate(base.getDate() + 2); return localDate(base); }
  if (/\btomorrow\b|\btomo\b/.test(t)) { base.setDate(base.getDate() + 1); return localDate(base); }
  if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/.test(t)) return localDate(base);

  // ISO or dd/mm — explicit always wins over anything relative.
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = t.match(/\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = dmy[3] ? Number(dmy[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return localDate(new Date(year, month - 1, day));
    }
  }

  // "next tuesday" / "tuesday" / "on thursday"
  const wd = t.match(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    let delta = (target - base.getDay() + 7) % 7;
    // "next X" means the one after the nearest, when the nearest is today.
    if (delta === 0) delta = 7;
    if (wd[1]?.trim() === 'next' && delta < 7) delta += 0; // nearest upcoming already reads as "next"
    base.setDate(base.getDate() + delta);
    return localDate(base);
  }

  return null;
}

function parseTime(text) {
  const t = text.toLowerCase();

  // 2pm, 2.30pm, 2:30 pm, half two is not supported (too ambiguous)
  const ampm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let hh = Number(ampm[1]);
    const mm = Number(ampm[2] || 0);
    if (hh === 12) hh = 0;
    if (ampm[3] === 'pm') hh += 12;
    if (hh < 24 && mm < 60) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // 24h — require the colon so "for 30 mins" and "15/08" can't match here.
  const h24 = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (h24) {
    const hh = Number(h24[1]);
    const mm = Number(h24[2]);
    if (hh < 24 && mm < 60) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // "at 9" / "at 14"
  const bare = t.match(/\bat\s+(\d{1,2})\b(?!\s*(?:mins?|minutes?|hours?|hrs?))/);
  if (bare) {
    let hh = Number(bare[1]);
    if (hh >= 0 && hh <= 23) {
      // A bare 1–7 in a work diary means the afternoon.
      if (hh >= 1 && hh <= 7) hh += 12;
      return `${String(hh).padStart(2, '0')}:00`;
    }
  }

  return null;
}

function parseDuration(text) {
  const t = text.toLowerCase();

  if (/\b(?:for\s+)?(?:an?\s+)?hour\b/.test(t) && !/\bhalf an hour\b/.test(t)) {
    const multi = t.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/);
    if (multi) return Math.round(Number(multi[1]) * 60);
    return 60;
  }
  if (/\bhalf an hour\b/.test(t)) return 30;

  const mins = t.match(/\b(\d{1,3})\s*(?:mins?|minutes?)\b/);
  if (mins) return Number(mins[1]);

  const hrs = t.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/);
  if (hrs) return Math.round(Number(hrs[1]) * 60);

  return null;
}

// "with abdi and luke", "for me and abdi", "invite Luke Scaife"
function parseAttendeeNames(text) {
  const m = text.match(/\b(?:with|for|invite|inviting|and\s+invite)\s+([^.,;]+?)(?=\s+(?:about|re|regarding|at|on|for\s+\d|next|tomorrow|today|in\b)|[.,;]|$)/i);
  if (!m) return [];

  return m[1]
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    // "me"/"myself" is the organiser — Graph adds Nick automatically.
    .filter((s) => !/^(me|myself|i|us|my)$/i.test(s))
    // "for 45 mins" / "for an hour" is a duration the `for` alternative snags.
    .filter((s) => !/^\d/.test(s) && !/\b(mins?|minutes?|hours?|hrs?)\b/i.test(s))
    .filter((s) => s.length > 1 && s.split(/\s+/).length <= 3)
    .slice(0, 10);
}

function parseSubject(text, attendeeNames) {
  const about = text.match(/\b(?:about|re|regarding|titled|called)\s+(.+?)$/i);
  if (about) {
    const s = about[1].replace(/^the\s+/i, '').replace(/[.\s]+$/, '').trim();
    if (s) return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Strip the scheduling scaffolding and see if anything meaningful is left.
  let residue = text
    .replace(/\b(?:create|set ?up|schedule|book|add|make|put in|arrange)\b/gi, '')
    .replace(/\b(?:a|an|the)\s+(?:meeting|call|catch ?up|chat|1[- ]?2[- ]?1|one[- ]to[- ]one|sync|session)\b/gi, '')
    .replace(/\b1[- ]?2[- ]?1\b|\bone[- ]to[- ]one\b/gi, '')
    .replace(/\b(?:meeting|call|catch ?up|chat|sync|session)\b/gi, '')
    .replace(/\b(?:with|for|invite|inviting)\s+[^.,;]+/gi, '')
    // Dates before times, or "20/08" leaves a "/08" behind.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, '')
    .replace(/\b(?:at|on)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\b(?:today|tonight|tomorrow|tomo|day after tomorrow|next|this)\b/gi, '')
    .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, '')
    .replace(/\bfor\s+\d+\s*(?:mins?|minutes?|hours?|hrs?)\b/gi, '')
    .replace(/\bfor\s+(?:an?\s+)?hour\b/gi, '')
    .replace(/\b(?:in|on)\s+teams\b/gi, '')
    .replace(/[\s,.-]+/g, ' ')
    .trim();

  if (residue.length > 2) return residue.charAt(0).toUpperCase() + residue.slice(1);

  if (attendeeNames.length) {
    const names = attendeeNames.map((n) => n.split(/\s+/)[0]);
    const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.slice(-1)}`;
    return `Meeting with ${label}`;
  }
  return 'Meeting';
}

// Last resort: the model. Asked for strict JSON and validated hard, because a
// hallucinated date here becomes a real invite if Nick confirms without reading.
async function aiParse(text, now) {
  const prompt = `Extract meeting details from this request. Today is ${localDate(now)} (${WEEKDAYS[now.getDay()]}).

Request: "${text}"

Reply with ONLY a JSON object, no markdown fence, no commentary:
{"date":"YYYY-MM-DD or null","time":"HH:MM 24-hour or null","durationMins":number or null,"attendees":["first or full names, exclude Nick/me"],"subject":"short title","online":true or false}`;

  try {
    const result = await aiRouting.runTask('event_parse', { prompt, maxTokens: 250 });
    const raw = String(result?.text || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const out = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '')) out.date = parsed.date;
    if (/^\d{2}:\d{2}$/.test(parsed.time || '')) out.time = parsed.time;
    if (Number.isFinite(parsed.durationMins) && parsed.durationMins > 0 && parsed.durationMins <= 480) {
      out.durationMins = Math.round(parsed.durationMins);
    }
    if (Array.isArray(parsed.attendees)) {
      out.attendees = parsed.attendees.filter((n) => typeof n === 'string' && n.trim()).slice(0, 10);
    }
    if (typeof parsed.subject === 'string' && parsed.subject.trim()) out.subject = parsed.subject.trim();
    out.online = Boolean(parsed.online);
    return out;
  } catch (e) {
    console.warn('[EventParser] AI parse failed:', e.message);
    return null;
  }
}

/**
 * Parse free text into a confirmable draft.
 * → { draft, needs: [...], parsedBy: 'rules'|'rules+ai', resolution: [...] }
 */
async function parseEventText(text, { now = new Date(), useAi = true } = {}) {
  const input = String(text || '').trim();
  if (!input) return { draft: null, needs: ['text'], parsedBy: 'none', resolution: [] };

  let date = parseDate(input, now);
  let time = parseTime(input);
  let durationMins = parseDuration(input);
  let names = parseAttendeeNames(input);
  let subject = parseSubject(input, names);
  let online = /\bteams\b|\bonline\b|\bvideo call\b/i.test(input);
  let parsedBy = 'rules';

  // Only pay for a model call when the rules missed the thing that matters.
  if (useAi && !time) {
    const ai = await aiParse(input, now);
    if (ai) {
      parsedBy = 'rules+ai';
      date = date || ai.date || null;
      time = time || ai.time || null;
      durationMins = durationMins || ai.durationMins || null;
      if (!names.length && ai.attendees?.length) names = ai.attendees;
      if (ai.subject && subject === 'Meeting') subject = ai.subject;
      online = online || ai.online;
    }
  }

  const resolution = await contacts.resolveNames(names);
  const attendees = resolution
    .filter((r) => r.status === 'resolved')
    .map((r) => ({ name: r.name, email: r.email, source: r.source }));

  const needs = [];
  if (!date) needs.push('date');
  if (!time) needs.push('time');
  for (const r of resolution) {
    if (r.status !== 'resolved') needs.push(`attendee:${r.query}`);
  }

  const finalDate = date || localDate(now);
  const finalTime = time || '09:00';
  const finalDuration = durationMins || DEFAULT_DURATION_MINS;
  const endAt = addMinutes(finalDate, finalTime, finalDuration);

  return {
    draft: {
      subject,
      date: finalDate,
      startTime: finalTime,
      endTime: endAt.time,
      // A meeting that runs past midnight is a parse error, not a real booking.
      endsNextDay: endAt.date !== finalDate,
      durationMins: finalDuration,
      attendees,
      location: null,
      body: null,
      isAllDay: false,
      isOnline: online,
    },
    needs,
    resolution,
    parsedBy,
  };
}

module.exports = {
  parseEventText,
  parseDate,
  parseTime,
  parseDuration,
  parseAttendeeNames,
  DEFAULT_DURATION_MINS,
};
