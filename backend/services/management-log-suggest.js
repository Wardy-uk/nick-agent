'use strict';

/**
 * Management conversations NEURO can see but has never been told about.
 *
 * PLAUD has recorded 275 meetings; the management log holds 19, every one of
 * them typed in by hand from a single 1-2-1. Nick's difficulty is initiation,
 * so a compliance log that only fills up when he remembers to fill it is one
 * that runs behind — and the evidence is already on disk, with a date on it.
 *
 * ⚠ **IT PROPOSES AND NEVER WRITES.** A wrong row in a log that goes to the
 * person assessing the PIP is worse than a missing one: a missing entry is a
 * gap Nick can close, an invented one is a claim he has to defend. Nothing here
 * calls `create()`; accepting is a separate, deliberate act on a card Nick has
 * read, and every field is editable before he does.
 *
 * ⚠ **FORMAL 1-2-1s ARE EXCLUDED** — Nick's instruction, 7 Sep 2026. They are
 * a separate cadence with their own tracker, their own detection
 * (`one-to-one-detect`) and their own place in the report; folding 62 of them
 * into this log would bury the conversations that have no other home. The
 * exclusion is applied THREE ways because 1-2-1s live in two places and are
 * labelled inconsistently: the `Meetings/1-2-1/` tree, the `meeting-type`
 * field, and the title. Measured on the live vault — 62 notes carry a `1-1`
 * meeting-type, and others sit under the 1-2-1 tree with no type at all.
 *
 * The rule for what IS a management conversation is deliberately narrow and
 * deterministic — no model call, so it is instant, free, identical every run
 * and works with the Pi offline (`event-parser`'s rule). A note qualifies when
 * it NAMES ONE OF NICK'S DIRECT REPORTS. That is the signal that separates
 * "Counter-Offer to Retain Isabel Busk" from "Onboarding Tool Integration":
 * both are meetings, only one is management. It will miss things — a
 * conversation with someone outside the team, or one PLAUD never recorded — and
 * that is the right direction to miss in.
 *
 * Split like pi-health and state-of-play: `readNotes()` walks, `assess()`
 * judges. `assess()` is PURE — it takes plain arrays and returns plain objects,
 * so every rule below pins without a vault, a database or a clock.
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/database');

/** Where a dismissal lives. KV — a list of ids, not a table. */
const DISMISSED_KEY = 'management_log_suggest_dismissed';

/** How far back to offer. Beyond this a suggestion is archaeology, not a log. */
const DEFAULT_SINCE_DAYS = 90;

/**
 * How many named reports a note may hold and still be a management conversation.
 *
 * ⚠ MEASURED, not picked. Over the 183 notes in the live 90-day window the
 * split is unambiguous. At **1–3** named reports (35 notes) the population is
 * person-specific and includes every conversation that plainly belongs on this
 * log — "Counter-Offer to Retain Isabel Busk", "Workplace Dynamics and Personal
 * Updates", and the 29 Jul "Accommodation vs. Uniform Policy: Targeted WFH and
 * Neurodivergent Support to Mitigate Attrition", which is the single clearest
 * management conversation in the vault and has three people in it. At **4+**
 * (24 notes) every last one is a recurring ceremony — "Weekly Meeting: Ticket
 * Status Review", "Weekly Meeting: Queue Management", "Daily Standup" — which
 * name eight to eleven reports because the whole team is in the room.
 *
 * This is `meeting-prep`'s rule at a smaller scale: past a certain size a
 * meeting is a broadcast, not somewhere a management conversation happens. The
 * first cut had no cap and offered all 59, which would have buried the dozen
 * that matter under thirty standups — a review queue nobody reads.
 *
 * Both sides of the boundary are pinned, the 4-person one as a NEGATIVE.
 */
const MAX_PEOPLE = 3;

/** Generated output and dead copies — scanning these resurrects archived notes. */
const EXCLUDE_DIRS = new Set([
  'Archive', 'Recycle Bin', '_toDelete', '_Staging - Keep in Archive',
  'transcripts', '_transcripts', 'Vault Audit', '.lint-backups', '.git',
]);

/**
 * A 1-2-1 by its title. Same shape as one-to-one-detect's, and deliberately a
 * copy rather than an import: that module's predicate is not exported, and this
 * one has to be WIDER — it is excluding rather than attributing, so a false
 * positive here costs a suggestion and a false negative puts a 1-2-1 in a log
 * Nick has said should not hold them.
 */
const TITLE_121 = /\b(1[-\s]?[-:]?\s?1|1-2-1|one[-\s]to[-\s]one|one[-\s]on[-\s]one)\b/i;

/** The note types that are evidence something HAPPENED. */
const REAL_NOTE_TYPES = new Set(['meeting', 'transcript']);

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

/** Line endings normalised to LF — the vault is authored on Windows. */
function readNote(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

/** Local, never toISOString() — the Pi may run in UTC and would flip a day. */
function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { (out[listKey] = out[listKey] || []).push(item[1].replace(/^["']|["']$/g, '')); continue; }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === '') { listKey = key; out[key] = []; continue; }
    listKey = null;
    out[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Whole-word, so "Liam" does not match inside "William". */
function namesWord(haystack, needle) {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

/**
 * Is this note a formal 1-2-1?
 *
 * ⚠ Three tests, and all three are needed. `meeting-type` is the reliable
 * signal where it exists, but older PLAUD notes predate the field; the
 * `Meetings/1-2-1/<Person>/` tree catches those; and 1-2-1s ALSO live loose in
 * `Meetings/YYYY/MM/` with the words in the title ("2026-04-22 – 1-1 Nathan
 * 1-2-1 Return-to-Work…"), which neither of the first two would catch.
 */
function isOneToOne(note) {
  const type = String(note.frontmatter['meeting-type'] || '').trim().toLowerCase();
  if (type) {
    if (type === '1-1' || type === '1-2-1' || type === 'one-to-one' || type === '1:1') return true;
  }
  const rel = String(note.relativePath || '').replace(/\\/g, '/');
  if (/(^|\/)1-2-1(\/|$)/i.test(rel)) return true;
  return TITLE_121.test(String(note.frontmatter.title || '')) || TITLE_121.test(path.basename(rel));
}

/**
 * Which of Nick's direct reports this note is about.
 *
 * Full names always; a first name ONLY when it points at exactly one person on
 * the roster. That is `entities.getRoster()`'s rule, and it exists because
 * matching bare first names once attributed one Lucy's commitments to four
 * Lucys. Frontmatter `people:` links and the body are both read — PLAUD
 * generates the links and they are frequently incomplete.
 */
function reportsNamed(note, roster) {
  const hay = `${note.frontmatter.title || ''}\n${(note.frontmatter.people || []).join('\n')}\n${note.body}`;
  const found = [];
  for (const person of roster) {
    if (namesWord(hay, person.name)) { found.push(person.name); continue; }
    if (person.uniqueFirstName && namesWord(hay, person.uniqueFirstName)) found.push(person.name);
  }
  return [...new Set(found)];
}

/**
 * The date the note's own record was MADE.
 *
 * ⚠ This is the most consequential field in the file, so the reasoning is
 * written down. `management-log.create()` accepts an earlier `loggedAt` only
 * from a named non-manual source, and a PLAUD note IS a contemporaneous record:
 * it was written by a device in the room, at the time, and it carries its own
 * `created_at`. That is exactly the argument `scripts/seed-management-log.js`
 * makes for the 12 Aug 1-2-1, and it is why importing one is not the same as
 * back-dating a typed entry.
 *
 * ⚠ But it is only honest while the stamp is REAL. An unreadable or absent
 * `created_at` returns **null**, and the caller then logs it as happening NOW
 * and says so — guessing would manufacture competency-3 compliance out of
 * nothing, which is the fabricated-baseline bug wearing a different hat.
 */
function recordedAt(note) {
  const raw = note.frontmatter.created_at || note.frontmatter.start_at || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** The date the meeting HAPPENED — frontmatter first, then the filename. */
function meetingDate(note) {
  const fm = String(note.frontmatter.date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fm)) return fm;
  const start = String(note.frontmatter.start_at || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  return (String(note.relativePath || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
}

/**
 * A stable id for a suggestion, so a dismissal survives a re-scan.
 *
 * Keyed on the PLAUD recording where there is one and the path otherwise —
 * never on the array position, which changes the moment a note is added.
 */
function suggestionId(note) {
  const plaud = String(note.frontmatter.plaud_id || '').trim();
  if (plaud && plaud !== 'undefined') return `plaud:${plaud}`;
  return `note:${note.relativePath}`;
}

/**
 * Is this already on the log?
 *
 * Two tests. The SOURCE match is exact and is what stops an accepted suggestion
 * coming straight back. The date+person match is the loose one, and it exists
 * because the 19 seeded rows were typed by hand and carry no path at all — so
 * without it every one of them would be offered again as new.
 */
function alreadyLogged(note, rows, people) {
  const id = suggestionId(note);
  const date = meetingDate(note);
  for (const row of rows) {
    const source = String(row.source || '');
    if (source && source === id) return 'source';
    if (source && note.relativePath && source.includes(note.relativePath)) return 'source';
    if (date && row.entry_date === date && row.person && people.some(p => namesWord(row.person, p) || namesWord(p, row.person))) {
      return 'date-and-person';
    }
  }
  return null;
}

// ── The walk ────────────────────────────────────────────────────────────────

/**
 * Read the meeting notes. Returns `{ ok, notes, gaps }` — ⚠ an unreadable vault
 * is a NAMED GAP and never an empty list, because "there is nothing to suggest"
 * and "I could not look" license opposite conclusions, and only one of them is
 * an all-clear.
 */
function readNotes({ root = vaultPath(), sinceDays = DEFAULT_SINCE_DAYS, now = new Date() } = {}) {
  const gaps = [];
  if (!root) return { ok: false, notes: [], gaps: ['OBSIDIAN_VAULT_PATH is not set — NEURO does not know where the vault is.'] };

  const meetings = path.join(root, 'Meetings');
  if (!fs.existsSync(meetings)) {
    return { ok: false, notes: [], gaps: [`No Meetings/ folder under ${root} — the vault may not be mounted.`] };
  }

  const cutoff = new Date(now.getTime() - sinceDays * 86400000);
  const cutoffKey = todayLocal(cutoff);
  const notes = [];

  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      // ⚠ Recorded, not skipped. Both of this vault's older walkers swallowed
      // this, so a broken permission produced a smaller answer that called
      // itself complete.
      gaps.push(`Could not read ${path.relative(root, dir)} — ${e.code || e.message}.`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const full = path.join(dir, entry.name);
      let content;
      try { content = readNote(full); } catch (e) {
        gaps.push(`Could not read ${entry.name} — ${e.code || e.message}.`);
        continue;
      }
      const fm = frontmatter(content);
      const relativePath = path.relative(root, full).replace(/\\/g, '/');
      const note = { relativePath, frontmatter: fm, body: content.replace(/^---\n[\s\S]*?\n---\n?/, '') };
      const date = meetingDate(note);
      if (date && date < cutoffKey) continue;
      notes.push(note);
    }
  };

  walk(meetings, 0);
  return { ok: true, notes, gaps };
}

// ── The judgement (PURE) ────────────────────────────────────────────────────

/**
 * Turn notes into suggestions.
 *
 * PURE: no filesystem, no database, no clock beyond what is passed in. Every
 * rule above pins from here without a vault under it.
 *
 * `roster` is `[{ name, uniqueFirstName }]`; `rows` is the management log;
 * `dismissed` is the set of suggestion ids Nick has already said no to.
 */
function assess({ notes = [], roster = [], rows = [], dismissed = [], gaps = [], ok = true } = {}) {
  const skip = {
    notOneToOneCandidate: 0, oneToOne: 0, noReport: 0,
    alreadyLogged: 0, dismissed: 0, undated: 0, tooManyPeople: 0,
  };
  const dismissedSet = new Set(dismissed);
  const suggestions = [];

  for (const note of notes) {
    const type = String(note.frontmatter.type || '').toLowerCase();
    // Prep is not evidence a conversation happened — one-to-one-detect's rule,
    // and the reason a prep note must never become a logged management action.
    if (!REAL_NOTE_TYPES.has(type)) { skip.notOneToOneCandidate += 1; continue; }

    if (isOneToOne(note)) { skip.oneToOne += 1; continue; }

    const people = reportsNamed(note, roster);
    if (!people.length) { skip.noReport += 1; continue; }
    // ⚠ Not a silent cap — `skipped.tooManyPeople` is returned and the panel
    // states it, because a filter that quietly removes two thirds of what it
    // found reads as "there was nothing else". See MAX_PEOPLE.
    if (people.length > MAX_PEOPLE) { skip.tooManyPeople += 1; continue; }

    const date = meetingDate(note);
    // ⚠ Refused rather than dated today. `entry_date` is when the conversation
    // HAPPENED and the whole competency-3 measurement hangs off it; a guess
    // there is a measurement about nothing.
    if (!date) { skip.undated += 1; continue; }

    const id = suggestionId(note);
    if (dismissedSet.has(id)) { skip.dismissed += 1; continue; }

    const logged = alreadyLogged(note, rows, people);
    if (logged) { skip.alreadyLogged += 1; continue; }

    const stamp = recordedAt(note);
    suggestions.push({
      id,
      // Deliberately `conversation`, never `action`: the note is evidence a
      // discussion took place. What came OUT of it is Nick's to say, and the
      // card lets him change it.
      type: 'conversation',
      summary: String(note.frontmatter.title || path.basename(note.relativePath, '.md')).trim(),
      people,
      person: people.length === 1 ? people[0] : null,
      entryDate: date,
      sourcePath: note.relativePath,
      plaudId: String(note.frontmatter.plaud_id || '').trim() || null,
      // ⚠ Carried so the card can SAY it, never applied silently. Null means
      // the note's own stamp was missing or unreadable, and the entry is then
      // logged as happening now — see recordedAt.
      recordedAt: stamp,
      contemporaneous: Boolean(stamp),
      meetingType: String(note.frontmatter['meeting-type'] || '').trim() || null,
    });
  }

  // Newest first — a conversation from last week is likelier to still need an
  // owner and a due date than one from June.
  suggestions.sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0));

  return {
    // ⚠ `ok:false` means the vault could not be read. It is NOT an empty list,
    // and no screen may render it as "nothing to suggest".
    ok,
    suggestions,
    skipped: skip,
    gaps,
    scanned: notes.length,
  };
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** The roster, with the first names that identify exactly one person. */
function loadRoster() {
  try {
    const teamRoster = require('./team-roster');
    const reports = teamRoster.directReports() || [];
    const firstNames = new Map();
    for (const r of reports) {
      const first = String(r.name || '').split(/\s+/)[0];
      if (!first) continue;
      firstNames.set(first.toLowerCase(), (firstNames.get(first.toLowerCase()) || 0) + 1);
    }
    return reports.map(r => {
      const first = String(r.name || '').split(/\s+/)[0];
      return {
        name: r.name,
        // ⚠ Only when it points at exactly ONE person. Nathan Rutland is a
        // report and Nathan Button exists, so "Nathan" identifies nobody.
        uniqueFirstName: first && firstNames.get(first.toLowerCase()) === 1 ? first : null,
      };
    });
  } catch {
    return [];
  }
}

function getDismissed() {
  const raw = db.getState(DISMISSED_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

function dismiss(id) {
  if (!id || typeof id !== 'string') throw new Error('a suggestion id is required');
  const next = [...new Set([...getDismissed(), id])];
  db.setState(DISMISSED_KEY, JSON.stringify(next));
  return next;
}

/** Put one back. Every other decision in NEURO has a way back; so does this. */
function undismiss(id) {
  const next = getDismissed().filter(x => x !== id);
  db.setState(DISMISSED_KEY, JSON.stringify(next));
  return next;
}

/** Read, judge and return — the one call a route makes. */
function suggest({ sinceDays = DEFAULT_SINCE_DAYS, now = new Date() } = {}) {
  const roster = loadRoster();
  const read = readNotes({ sinceDays, now });

  const gaps = [...read.gaps];
  // ⚠ An empty roster is BROKEN, not a manager with nobody reporting to him,
  // and without saying so this would return zero suggestions and look calm.
  if (!roster.length) gaps.push('No direct reports found in People/ — without a roster nothing can be recognised as a management conversation.');

  let rows = [];
  try {
    rows = require('./management-log').list({ limit: 2000 });
  } catch (e) {
    gaps.push(`Could not read the management log — ${e.message}. Suggestions may duplicate what is already on it.`);
  }

  return assess({
    notes: read.notes,
    roster,
    rows,
    dismissed: getDismissed(),
    gaps,
    ok: read.ok && roster.length > 0,
  });
}

module.exports = {
  suggest, assess, readNotes,
  getDismissed, dismiss, undismiss,
  // exported for tests
  isOneToOne, reportsNamed, meetingDate, recordedAt, suggestionId, alreadyLogged,
  DEFAULT_SINCE_DAYS, DISMISSED_KEY, MAX_PEOPLE,
};
