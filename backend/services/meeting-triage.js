'use strict';

/**
 * Meeting triage — does this invitation say what it is for?
 *
 * Policy (Nick, 14 Aug 2026): ANY meeting without an agenda or expected
 * outcomes gets a request for one, seniority included. That is deliberately a
 * blanket rule rather than a whitelist — a policy applied to everyone is easier
 * to defend and easier to live with than a judgement about who is worth asking.
 *
 * The rules therefore go on TONE and WHAT IS ASKED FOR, not on who is exempt:
 *
 *   - Ask for the outcome, not "an agenda". "What does good look like by the
 *     end?" is answerable in one line; "please provide an agenda" sounds like
 *     process for its own sake and gets ignored.
 *   - Never imply the meeting is unnecessary. The request is to prepare well,
 *     not to challenge whether it should exist.
 *   - Always offer the out: happy to go ahead regardless. Otherwise it reads as
 *     a condition of attendance, which is not what this is.
 *   - Same words for everyone. If the wording would embarrass you sent to the
 *     CEO, it is the wrong wording for anyone.
 *
 * Nothing here sends. It produces a draft that queues for approval.
 */

// Detail that means someone has thought about the meeting. Deliberately broad —
// the cost of missing a real agenda (an unnecessary chaser) is much higher than
// the cost of missing a vague one (no chaser on a meeting that deserved one).
const AGENDA_MARKERS = /\b(agenda|outcome|purpose|objective|discuss|decide|decision|review|walk through|cover|topics?|prep|pre-?read|questions?|goal|aim|scope|action)\b/i;

// Boilerplate that carries no meaning, stripped before measuring length so a
// Teams join blurb doesn't read as an agenda.
const BOILERPLATE = [
  /_{5,}/g,
  /Microsoft Teams.*?meeting/gis,
  /Join (the )?meeting now/gi,
  /Meeting ID:.*$/gim,
  /Passcode:.*$/gim,
  /Dial in by phone.*$/gim,
  /Find a local number.*$/gim,
  /For organizers:.*$/gim,
  /Meeting options.*$/gim,
  /https?:\/\/\S+/g,
  /<[^>]+>/g,
  /&nbsp;/gi,
];

function stripBoilerplate(text) {
  let out = String(text || '');
  for (const rx of BOILERPLATE) out = out.replace(rx, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Should this meeting be chased for an agenda?
 *
 * Returns { chase: boolean, reason: string }. The reason is recorded on the
 * queued action so a wrong call can be diagnosed rather than guessed at.
 */
function assess(event, { now = new Date() } = {}) {
  if (!event) return { chase: false, reason: 'no event' };
  if (event.isCancelled) return { chase: false, reason: 'cancelled' };

  // Nick's own meetings are his problem, not the sender's.
  if (event.isOrganizer) return { chase: false, reason: 'you organised it' };

  // Already answered — chasing after accepting is noise.
  if (event.responseStatus && !['none', 'notResponded'].includes(event.responseStatus)) {
    return { chase: false, reason: `already responded (${event.responseStatus})` };
  }

  // Recurring instances inherit their series' purpose. Chasing every occurrence
  // of a standing meeting is the fastest way to make this feature hated.
  if (event.type === 'occurrence' || event.type === 'exception') {
    return { chase: false, reason: 'occurrence of a recurring series' };
  }

  const attendees = (event.attendees || []).filter(a => a.email);
  // A one-to-one is a conversation, not a meeting with an agenda gap.
  if (attendees.length <= 2) return { chase: false, reason: 'one-to-one or solo' };

  if (event.start) {
    const mins = (new Date(event.start) - now) / 60000;
    // Too soon to be worth asking — they will not answer before it starts.
    if (mins < 120) return { chase: false, reason: 'starts within 2 hours' };
    // Too far out to be urgent; it will get picked up closer to the day.
    if (mins > 14 * 24 * 60) return { chase: false, reason: 'more than a fortnight away' };
  }

  const body = stripBoilerplate(event.bodyPreview || event.bodyHtml || '');
  if (body.length >= 80 && AGENDA_MARKERS.test(body)) {
    return { chase: false, reason: 'body describes the purpose' };
  }
  // A long body without any agenda language is still probably context.
  if (body.length >= 300) return { chase: false, reason: 'substantial body text' };

  // A subject can carry the purpose on its own: "Decide Q4 pricing" needs no
  // agenda. "Catch up" does.
  if (AGENDA_MARKERS.test(event.subject || '') && (event.subject || '').split(/\s+/).length >= 4) {
    return { chase: false, reason: 'subject states the purpose' };
  }

  return {
    chase: true,
    reason: body.length === 0 ? 'no body and no purpose in the subject' : 'body carries no agenda or outcome',
  };
}

/**
 * The words. Short, warm, asks for the outcome rather than a document, and
 * always offers the out.
 */
function buildChaser(event) {
  const organiserName = (event.organizer?.name || '').split(' ')[0] || 'there';
  const when = event.start
    ? new Date(event.start).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    : 'the meeting';

  return [
    `Hi ${organiserName},`,
    '',
    `Looking at "${event.subject || 'the meeting'}" on ${when} — what would you like to get out of it? Even a line on the outcome you're after helps me come prepared with the right things.`,
    '',
    `Happy to join either way.`,
    '',
    'Nick',
  ].join('\n');
}

/**
 * Check a specific set of events and queue a chaser for each that needs one.
 *
 * Queued, never sent: these are emails to real colleagues, several of them
 * senior. Everything here waits for approval.
 */
async function checkEvents(eventIds, { dryRun = false, now = new Date() } = {}) {
  const db = require('../db/database');
  const microsoft = require('./microsoft');
  const suggestionEngine = require('./suggestion-engine');

  const ids = [...new Set((eventIds || []).filter(Boolean))];
  if (!ids.length) return { scanned: 0, queued: 0, skipped: [] };

  // Never queue the same meeting twice. Also covers a chaser already approved
  // and sent — a second ask is worse than none.
  let seen = new Set();
  try {
    // Every chase_agenda ever, not the newest 200 rows across all types. The
    // table churns thousands of rows a day, so that window covered well under
    // a day — and this set is what stops a second email going to the same
    // organiser about the same meeting.
    seen = new Set(
      db.getSaraActionsByType('chase_agenda')
        .filter(a => a.status !== 'rejected')
        .map(a => a.payload?.eventId)
        .filter(Boolean)
    );
  } catch {}

  const skipped = [];
  let queued = 0;
  let scanned = 0;

  for (const eventId of ids) {
    if (seen.has(eventId)) { skipped.push({ eventId, reason: 'already asked' }); continue; }

    const event = await microsoft.fetchEventById(eventId);
    if (!event) { skipped.push({ eventId, reason: 'could not fetch detail' }); continue; }
    scanned++;

    const verdict = assess(event, { now });
    if (!verdict.chase) { skipped.push({ eventId, subject: event.subject, reason: verdict.reason }); continue; }

    if (dryRun) { queued++; continue; }

    suggestionEngine.queueAction(
      'chase_agenda',
      {
        eventId,
        subject: event.subject,
        organizer: event.organizer,
        start: event.start,
        body: buildChaser(event),
        why: verdict.reason,
      },
      `Ask ${event.organizer?.name || 'the organiser'} what "${event.subject}" is for`,
      0.75
    );
    queued++;
  }

  if (queued || scanned) {
    console.log(`[MeetingTriage] Checked ${scanned}, queued ${queued} agenda chaser(s)`);
  }
  return { scanned, queued, skipped };
}

/**
 * Sweep everything in the cache for the next `days`. The safety net, not the
 * main path: invites are caught on arrival by checkEvents, and this exists to
 * pick up anything that slipped through — a sync that failed, a restart during
 * a delivery, a meeting whose body was filled in later.
 */
async function scanUpcoming({ days = 7, limit = 30, dryRun = false } = {}) {
  const db = require('../db/database');
  const now = new Date();
  const from = now.toISOString().split('T')[0];
  const to = new Date(now.getTime() + days * 86400000).toISOString().split('T')[0];

  let events = [];
  try { events = db.getCalendarEvents(from, to); } catch (e) {
    console.warn('[MeetingTriage] Calendar read failed:', e.message);
    return { scanned: 0, queued: 0, skipped: [] };
  }

  const ids = events
    .filter(e => !e.is_all_day)
    .map(e => e.event_id || e.id)
    .filter(Boolean)
    .slice(0, limit);

  return checkEvents(ids, { dryRun, now });
}

module.exports = { assess, buildChaser, checkEvents, scanUpcoming, stripBoilerplate };
