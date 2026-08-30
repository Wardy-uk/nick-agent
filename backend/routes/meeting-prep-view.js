'use strict';

/**
 * Meeting Prep API — dedicated endpoint for meeting preparation.
 *
 * GET /api/meeting-prep       — next meeting with full prep context
 * GET /api/meeting-prep/all   — all meetings today with prep context
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const path = require('path');
const fs = require('fs');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// Attendee matching reads People/ frontmatter (#13). The hardcoded list this
// replaced still carried Arman (left the business) and Willem (moved teams),
// and four bare first names — 'Beth', 'Paul', 'Damon', 'Ricky' — that no rule
// could disambiguate.
const teamRoster = require('../services/team-roster');

// GET /api/meeting-prep — next upcoming meeting with prep
router.get('/', async (req, res) => {
  try {
    const meetings = await _getUpcomingMeetings(4);
    if (meetings.length === 0) {
      return res.json({ meeting: null, message: 'No upcoming meetings in the next 4 hours' });
    }

    // Enrich the next meeting with full prep
    const next = meetings[0];
    const prep = _buildPrep(next);

    res.json({
      meeting: { ...next, prep },
      laterToday: meetings.slice(1).map(m => ({
        event_id: m.event_id,
        subject: m.subject,
        start: m.start_time,
        end: m.end_time,
        minutesAway: m.minutesAway,
      })),
    });
  } catch (e) {
    console.error('[MeetingPrep] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/all — all today's meetings with prep
router.get('/all', async (req, res) => {
  try {
    const meetings = await _getUpcomingMeetings(12);
    const enriched = meetings.map(m => ({
      ...m,
      prep: _buildPrep(m),
    }));
    res.json({ meetings: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/week — all meetings for the next 7 days with prep
router.get('/week', async (req, res) => {
  try {
    const daysAhead = parseInt(req.query.days) || 7;
    const now = new Date();
    const todayStr = _localDate(now);
    const endStr = _localDate(new Date(now.getTime() + daysAhead * 86400000));

    const normalised = (await _fetchEvents(todayStr, endStr)).filter(e => !e.is_all_day);

    // Group by date
    const byDate = {};
    for (const e of normalised) {
      const dateKey = e.start_time.split('T')[0];
      if (!byDate[dateKey]) byDate[dateKey] = [];

      const start = new Date(e.start_time);
      byDate[dateKey].push({
        ...e,
        startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        endFormatted: new Date(e.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        dayLabel: start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
      });
    }

    // Build prep for each meeting
    const days = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, meetings]) => ({
        date,
        dayLabel: meetings[0]?.dayLabel || date,
        meetings: meetings.map(m => ({
          ...m,
          prep: _buildPrep(m),
        })),
      }));

    res.json({ days, totalMeetings: normalised.length });
  } catch (e) {
    console.error('[MeetingPrep] Week error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/meeting-prep/:id — prep for a specific meeting by event_id
router.get('/:id', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = _localDate(now);
    const weekEnd = _localDate(new Date(now.getTime() + 7 * 86400000));

    const events = await _fetchEvents(todayStr, weekEnd);
    const event = events.find(e => e.event_id === req.params.id);

    if (!event) return res.status(404).json({ error: 'Meeting not found' });

    const start = new Date(event.start_time);
    const enriched = {
      ...event,
      startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      endFormatted: new Date(event.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      dayLabel: start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }),
      minutesAway: Math.round((start - now) / 60000),
      prep: _buildPrep(event),
    };

    res.json({ meeting: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Local (not UTC) YYYY-MM-DD — toISOString() shifts the day either side of midnight in BST
function _localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fetch + normalise events for a date range.
// Live Microsoft Graph first (the DB calendar cache is never populated and has
// no attendee data), DB cache only as a fallback.
async function _fetchEvents(startStr, endStr) {
  const obsidian = require('../services/obsidian');
  let events;
  try {
    events = await obsidian.fetchCalendarEvents(startStr, endStr);
  } catch {
    events = null;
  }
  if (!events || events.length === 0) {
    events = db.getCalendarEvents(startStr, endStr + 'T23:59:59');
  }

  return (events || []).map(e => ({
    event_id: e.event_id || e.id || '',
    subject: e.subject || '',
    start_time: e.start_time || e.start || '',
    end_time: e.end_time || e.end || '',
    is_all_day: e.is_all_day ?? e.isAllDay ?? false,
    location: e.location || null,
    organizer: e.organizer || null,
    attendees: e.attendees || [],
    showAs: e.showAs || e.show_as || null,
  }));
}

async function _getUpcomingMeetings(hoursAhead) {
  const now = new Date();
  const todayStr = _localDate(now);
  const tomorrowStr = _localDate(new Date(now.getTime() + 86400000));
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  const events = await _fetchEvents(todayStr, tomorrowStr);

  return events
    .filter(e => {
      if (e.is_all_day) return false;
      const start = new Date(e.start_time);
      return start > now && start <= cutoff;
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .map(e => {
      const start = new Date(e.start_time);
      return {
        ...e,
        minutesAway: Math.round((start - now) / 60000),
        startFormatted: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        endFormatted: new Date(e.end_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      };
    });
}

function _buildPrep(meeting) {
  const prep = {
    attendees: [],
    recentDecisions: [],
    suggestedTopics: [],
    checklist: [],
    // ⚠ Gate 4: what could NOT be read, by name.
    //
    // Every enrichment below is wrapped in a catch, and each one used to fail
    // to a `console.warn` — so an unreachable vault or a broken roster rendered
    // as a prep sheet with no commitments on it, which is indistinguishable
    // from a person who owes Nick nothing. That is the whole species of bug
    // this codebase keeps finding, arriving at the surface where it matters
    // most: a 1-2-1 he walks into believing everything is clear.
    gaps: [],
  };

  // 1. Get attendees from Graph API data first, then fall back to subject matching
  // Filter out: self, conference rooms, resource accounts
  const graphAttendees = (meeting.attendees || [])
    .filter(a => {
      if (!a.name) return false;
      const email = (a.email || '').toLowerCase();
      // Exclude self
      if (email.includes('nickw@') || email.includes('nick.ward@')) return false;
      // Exclude rooms/resources by email domain patterns
      if (email.includes('room@') || email.includes('resource@') || email.includes('conf@')) return false;
      if (email.endsWith('@resource.nurtur.tech') || email.endsWith('@rooms.nurtur.tech')) return false;
      // Exclude if email matches the meeting location (conference room)
      const loc = (meeting.location || '').toLowerCase();
      if (loc && a.name.toLowerCase() === loc) return false;
      return true;
    })
    .map(a => a.name);

  // Merge: Graph attendees + subject/organizer matching (dedup)
  const subjectMatched = _matchPeople(meeting.subject, meeting.organizer);
  const allNames = [...new Set([...graphAttendees, ...subjectMatched])];
  const matchedPeople = allNames.length > 0 ? allNames : subjectMatched;

  // 2. Pull People notes for each attendee
  for (const person of matchedPeople) {
    const note = _readPersonNote(person);
    prep.attendees.push(note);
  }

  // Also add Graph attendees who don't have vault notes (show name + email)
  if (graphAttendees.length > 0) {
    const prepNames = new Set(prep.attendees.map(a => a.name.toLowerCase()));
    for (const att of (meeting.attendees || [])) {
      if (!att.name) continue;
      const email = (att.email || '').toLowerCase();
      const name = att.name.toLowerCase();
      if (prepNames.has(name)) continue;
      if (email.includes('nickw@') || email.includes('nick.ward@')) continue;
      if (email.includes('room@') || email.includes('resource@') || email.includes('conf@')) continue;
      if (email.endsWith('@resource.nurtur.tech') || email.endsWith('@rooms.nurtur.tech')) continue;
      const loc = (meeting.location || '').toLowerCase();
      if (loc && name === loc) continue;
      {
        prep.attendees.push({
          name: att.name,
          role: null,
          last121: null,
          next121Due: null,
          tags: [],
          recentNotes: null,
          email: att.email,
          rsvp: att.status,
        });
      }
    }
  }

  // 3. Pull recent decisions mentioning any attendee
  try {
    const obsidian = require('../services/obsidian');
    const decisions = obsidian.getRecentDecisions(30);
    if (decisions && decisions.length > 0) {
      const names = matchedPeople.map(p => p.toLowerCase());
      const firstNames = matchedPeople.map(p => p.split(' ')[0].toLowerCase());
      prep.recentDecisions = decisions
        .filter(d => [...names, ...firstNames].some(n => d.text?.toLowerCase().includes(n)))
        .slice(0, 5)
        .map(d => ({ date: d.date, text: d.text }));
    }
  } catch (e) {
    // Named, not swallowed. An unreadable source and a source with
    // nothing in it are different facts about a colleague.
    prep.gaps.push({ input: 'decisions', why: e.message });
  }

  // 4. Search vault for recent mentions of attendees
  prep.vaultContext = [];
  try {
    const entities = require('../services/entities');
    for (const person of matchedPeople.slice(0, 3)) {
      const mentions = entities.getMentionsOf(person);
      if (mentions && mentions.length > 0) {
        // Filter to meaningful paths (not People/ notes themselves)
        const meaningful = mentions
          .filter(p => !p.startsWith('People/'))
          .slice(0, 3);
        for (const notePath of meaningful) {
          prep.vaultContext.push({
            person,
            source: notePath,
            label: path.basename(notePath, '.md'),
          });
        }
      }
    }
  } catch (e) {
    // Named, not swallowed. An unreadable source and a source with
    // nothing in it are different facts about a colleague.
    prep.gaps.push({ input: 'notes', why: e.message });
  }

  // 5. Check recent daily notes for mentions
  try {
    const vaultPath = VAULT_PATH;
    const dailyDir = path.join(vaultPath, 'Daily');
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir)
        .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
        .sort().reverse().slice(0, 7); // last 7 days
      for (const file of files) {
        const content = fs.readFileSync(path.join(dailyDir, file), 'utf-8');
        const firstNames = matchedPeople.map(p => p.split(' ')[0]);
        for (const name of firstNames) {
          if (name.length > 2 && content.toLowerCase().includes(name.toLowerCase())) {
            const dateStr = file.replace('.md', '');
            // Find the line mentioning them
            const line = content.split('\n').find(l =>
              l.toLowerCase().includes(name.toLowerCase()) && l.trim().length > 10
            );
            if (line) {
              prep.vaultContext.push({
                person: name,
                source: `Daily/${file}`,
                label: `${dateStr}: ${line.trim().substring(0, 80)}`,
              });
            }
            break; // one mention per daily note is enough
          }
        }
      }
    }
  } catch (e) {
    // Named, not swallowed. An unreadable source and a source with
    // nothing in it are different facts about a colleague.
    prep.gaps.push({ input: 'daily-notes', why: e.message });
  }

  // Deduplicate vault context
  const seenLabels = new Set();
  prep.vaultContext = (prep.vaultContext || []).filter(v => {
    if (seenLabels.has(v.label)) return false;
    seenLabels.add(v.label);
    return true;
  }).slice(0, 5);

  // 6. What each attendee still owes Nick.
  //
  // This is the surface that matters: "what does Naomi owe me" is a 1-2-1
  // question, not a dashboard question, and prep is the last moment it can be
  // answered before you walk in. Read-only — chasing, resolving and snoozing
  // live on the People board, because a chase must be approved before it sends.
  //
  // waiting_on stores a canonical FIRST name and nothing else, so matching it
  // to an attendee is a first-name match — and a first name is only usable when
  // it points at exactly one person. The first cut of this attached one Lucy's
  // 16 commitments to four different Lucys on the SMT invite, and Chris
  // Middleton's 31 to a Chris Smith. `entities.getRoster().firstNames` already
  // holds exactly this rule (it is why Nathan Button and Nathan Rutland are both
  // excluded from it), so use it rather than re-deriving a looser version:
  // unambiguous in People/ AND the full name agrees, or no match at all.
  //
  // Above ROOM_SIZE the meeting is a broadcast, not a conversation — nobody
  // works through a commitment list in the 309-attendee SMT update or the daily
  // 13-person standup, and that many blocks makes the card unreadable. 8 keeps
  // 1-2-1s and small team sessions (Tier Two Team Time is 7) and drops the rest;
  // the People board is where you go through everyone.
  // Is anyone in this meeting actually on leave that day?
  //
  // Graph's `responseStatus` says whether they ACCEPTED, which is a different
  // question and is usually stale — an invite accepted three weeks ago says
  // nothing about the holiday booked since. People HR knows, so prep can say
  // "Zoe is off" before Nick spends ten minutes preparing for a conversation
  // that is not going to happen.
  //
  // Silent when it cannot tell. An absent flag must mean "nothing to report",
  // never "I could not look" — so `awayUnknown` carries the difference rather
  // than the card implying everyone is in.
  try {
    const availability = require('../services/team-availability');
    const snap = availability.snapshot();
    const day = String(meeting.start_time || '').slice(0, 10);
    if (day) {
      for (const att of prep.attendees) {
        const info = availability.daysOffFor(att.name, snap);
        if (info.known && info.dates.has(day)) {
          const row = (snap.absences || []).find(
            a => a.date === day && Number(a.rosterId) === Number(info.rosterId)
          );
          att.away = {
            status: row?.status || 'annual_leave',
            reason: row?.reason || null,
          };
        } else if (!info.known) {
          att.awayUnknown = true;
        }
      }
      prep.someoneAway = prep.attendees.filter(a => a.away).map(a => a.name);
    }
  } catch (e) {
    console.warn('[MeetingPrep] Could not check attendee leave:', e.message);
    prep.gaps.push({ input: 'leave', why: e.message });
  }

  const ROOM_SIZE = 8;
  const MAX_TOPICS = 3;
  if (prep.attendees.length <= ROOM_SIZE) {
    try {
      const waitingOn = require('../services/waiting-on');
      const { firstNames } = require('../services/entities').getRoster();
      const owed = [];

      for (const att of prep.attendees) {
        const full = String(att.name || '').trim();
        const first = full.split(/\s+/)[0];
        if (!first) continue;
        const resolved = firstNames.get(first.toLowerCase());
        if (!resolved || resolved.toLowerCase() !== full.toLowerCase()) continue;

        // Snoozed means "they told me a date" — raising it before that date is
        // exactly the nagging snooze exists to stop.
        const open = waitingOn.list({ status: 'open', person: first }).filter(i => !i.snoozed);
        if (!open.length) continue;

        // ⚠ Gate 4: every commitment carries WHERE IT CAME FROM.
        //
        // `source_path` has been in the table since the feature shipped and was
        // being dropped here — at the one surface where it matters most. These
        // rows were backfilled automatically out of 232 meeting notes, and the
        // service's own notes say some are misparses. Putting an unattributed
        // "they owe you this" in front of Nick before he walks into a room with
        // that person is exactly the failure the brief names: implying someone
        // promised something without showing the evidence.
        //
        // With the note attached he can check it in one tap. Without it, he is
        // being asked to trust a parse.
        att.waitingOn = open.map(i => ({
          key: i.key,
          text: i.text,
          ageDays: i.ageDays,
          stale: i.stale,
          chaseCount: i.chaseCount || 0,
          sourceDate: i.sourceDate,
          // The evidence. `null` is left as null and rendered as "no source
          // recorded" rather than hidden — an unattributed row is precisely the
          // one to be most careful about.
          sourcePath: i.sourcePath || null,
          sightings: i.sightings || 1,
        }));
        owed.push({ first, open });
      }

      // Oldest first, and only the worst few — the per-attendee blocks already
      // carry the detail, so the topic list is a pointer, not a second copy.
      owed.sort((a, b) => b.open[0].ageDays - a.open[0].ageDays);
      for (const { first, open } of owed.slice(0, MAX_TOPICS)) {
        const top = open[0];
        // ⚠ ATTRIBUTED, not asserted. This used to read "2 outstanding from
        // Hope", which states as fact that she owes it — a claim built on an
        // automated parse of a meeting note, put in front of Nick moments
        // before he sits down with her. It now says where it came from and
        // whether it has been seen since, so he can weigh it.
        const when = top.sourceDate ? ` (${top.sourceDate})` : '';
        const from = top.sourcePath ? ` — from ${top.sourcePath.split('/').pop().replace(/\.md$/, '')}${when}` : ' — no source recorded';
        prep.suggestedTopics.push(
          `Noted as outstanding for ${first}${from}: "${top.text.slice(0, 60)}"`
            + (open.length > 1 ? ` (+${open.length - 1} more)` : '')
        );
      }
    } catch (e) {
      console.warn('[MeetingPrep] waiting-on lookup failed:', e.message);
      // The expensive one to lose silently: "nothing outstanding" and "I could
      // not check what is outstanding" are opposite facts about a colleague.
      prep.gaps.push({ input: 'commitments', why: e.message });
    }
  }

  // 7. Generate suggested topics
  const isReview = (meeting.subject || '').toLowerCase().match(/review|probation|performance|1-2-1|121|kit/);

  for (const att of prep.attendees) {
    if (att.next121Due) {
      const due = new Date(att.next121Due);
      const daysSince = Math.round((Date.now() - due.getTime()) / 86400000);
      if (daysSince > 0) {
        prep.suggestedTopics.push(`1-2-1 overdue for ${att.name} (was due ${att.next121Due})`);
      }
    }
    if (att.last121) {
      const daysSince = Math.round((Date.now() - new Date(att.last121).getTime()) / 86400000);
      if (daysSince > 14) {
        prep.suggestedTopics.push(`Last 1-2-1 with ${att.name} was ${daysSince} days ago`);
      }
    }
    if (att.recentNotes) {
      prep.suggestedTopics.push(`Follow up: ${att.recentNotes.substring(0, 60)}`);
    }
  }

  if (isReview) {
    prep.suggestedTopics.push('Review progress against objectives');
    prep.suggestedTopics.push('Discuss any blockers or concerns');
    prep.suggestedTopics.push('Agree next actions and timeline');
  }

  // 8. Checklist (context-aware)
  prep.checklist = ['Review agenda'];
  if (prep.attendees.length > 0) prep.checklist.push('Check attendee vault notes');
  if (prep.recentDecisions.length > 0) prep.checklist.push('Review recent decisions');
  if (isReview) {
    prep.checklist.push('Check PeopleHR records');
    prep.checklist.push('Review previous performance notes');
    prep.checklist.push('Prepare feedback points');
  }
  prep.checklist.push('Prepare key questions');

  return prep;
}

/**
 * Which of Nick's people this meeting is about.
 *
 * Matching is on the FULL name, or on a first name that identifies exactly one
 * person — the rule `entities.getRoster().firstNames` already encodes and the
 * one this file's `_buildPrep` uses for waiting-on enrichment.
 *
 * The old rule was "any name part longer than 2 characters, anywhere in the
 * string", which matched substrings as well as words. Two ways that misfires on
 * real subjects: a surname fragment inside another word, and — because the
 * roster contains Hope Goodall — the ordinary English "Hope you're well" or
 * "Hope this works" naming a person in every meeting that says it. Whole-word
 * matching costs nothing and removes both.
 */
function _matchPeople(subject, organizer) {
  const matched = new Set();
  const haystack = `${subject || ''} ${organizer || ''}`.toLowerCase();
  const hasWord = (term) => {
    // Escaped, then bounded: a name may legitimately contain '-' or '.'
    const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack);
  };

  for (const person of teamRoster.directReports()) {
    if (hasWord(person.name)) matched.add(person.name);
  }
  for (const [first, full] of teamRoster.reportFirstNames()) {
    if (hasWord(first)) matched.add(full);
  }

  return [...matched];
}

function _readPersonNote(name) {
  const result = {
    name,
    role: null,
    last121: null,
    next121Due: null,
    tags: [],
    recentNotes: null,
  };

  if (!VAULT_PATH) return result;

  // Try exact name, then first name match
  const peopleDir = path.join(VAULT_PATH, 'People');
  if (!fs.existsSync(peopleDir)) return result;

  const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
  const exactMatch = files.find(f => f.replace('.md', '').toLowerCase() === name.toLowerCase());
  const partialMatch = !exactMatch && files.find(f => {
    const fname = f.replace('.md', '').toLowerCase();
    return name.split(' ').some(p => p.length > 2 && fname.includes(p.toLowerCase()));
  });

  const matchFile = exactMatch || partialMatch;
  if (!matchFile) return result;

  try {
    const content = fs.readFileSync(path.join(peopleDir, matchFile), 'utf-8');

    // Parse frontmatter
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) {
        const fm = content.substring(3, endIdx);
        const roleMatch = fm.match(/^role:[ \t]*(.+)$/m);
        const last121Match = fm.match(/^last-1-2-1:[ \t]+(.+)$/m);
        const next121Match = fm.match(/^next-1-2-1-due:[ \t]+(.+)$/m);
        const tagsMatch = fm.match(/tags:\s*\[(.+?)\]/);

        if (roleMatch) result.role = roleMatch[1].trim();
        if (last121Match) result.last121 = last121Match[1].trim();
        if (next121Match) result.next121Due = next121Match[1].trim();
        if (tagsMatch) result.tags = tagsMatch[1].split(',').map(t => t.trim());
      }
    }

    // Strip frontmatter
    let body = content;
    if (body.startsWith('---')) {
      const fmEnd = body.indexOf('---', 3);
      if (fmEnd !== -1) body = body.substring(fmEnd + 3);
    }
    // Strip ALL code-fenced blocks (dataview, etc.)
    // Split on ``` lines and remove every other segment
    const parts = body.split('```');
    body = parts.filter((_, i) => i % 2 === 0).join('');
    // Strip inline dataview keywords
    body = body.replace(/^(TASK|FROM|WHERE|AND|SORT|GROUP|LIMIT)\s.*$/gm, '');
    const noteLines = body.split('\n')
      .filter(l => {
        const t = l.trim();
        if (!t || t.length <= 3) return false;
        if (t.startsWith('#')) return false;
        if (t.startsWith('|')) return false;     // markdown tables
        if (t.startsWith('- [[')) return false;  // wiki-link lists
        if (t.startsWith('---')) return false;    // horizontal rules
        if (t.match(/^[\-\|:\s]+$/)) return false; // table separators
        return true;
      })
      .slice(-5)
      .join('\n');
    if (noteLines.length > 10) {
      result.recentNotes = noteLines.substring(0, 200);
    }
  } catch {}

  return result;
}

module.exports = router;
