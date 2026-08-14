'use strict';

/**
 * People gap pass — find colleagues NEURO deals with who have no People note.
 *
 * Nothing in NEURO ever created a People note: person-profile.js is only
 * reachable from its route and the MCP tool, both manual. So People/ only ever
 * held whoever Nick typed in by hand, and every consumer that keys off the
 * roster (entity extraction, contact resolution, person pages) was capped at
 * that list.
 *
 * Follows the vault-hygiene convention: the scheduled pass is READ-ONLY and
 * writes a report; creating the stubs is an explicit call.
 *
 * Sources, all things that already exist — no new tables, no Graph calls:
 *   - meeting notes' Attendees/Mentioned sections
 *   - triaged inbox senders on an internal domain
 *   - calendar_cache organizers
 *
 * A name needs MIN_SIGHTINGS appearances before it counts. One stray mention in
 * one transcript is noise; the same person turning up twice is a colleague.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
const REPORT_FOLDER = 'Documents/System/Vault Audit';
const MIN_SIGHTINGS = 2;

// Only colleagues belong in People/. Customers and vendors would flood it.
const INTERNAL_DOMAINS = (process.env.PEOPLE_GAP_DOMAINS || 'nurtur.tech')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

const SKIP_DIRS = new Set(['transcripts', '_transcripts', 'Archive', 'Vault Audit', '.lint-backups', '.git', '.obsidian', 'Templates', 'Scripts']);

function existingPeople() {
  try {
    return fs.readdirSync(path.join(VAULT_PATH(), 'People'))
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.slice(0, -3));
  } catch { return []; }
}

// A display name from Graph often arrives as "Ward, Nick" — People notes are
// "Nick Ward", so compare on a normalised, order-insensitive key or the same
// person gets a second note.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function tidyName(name) {
  const raw = String(name || '').trim().replace(/\s+/g, ' ');
  const flipped = raw.match(/^([^,]+),\s*(.+)$/); // "Ward, Nick" → "Nick Ward"
  return flipped ? `${flipped[2].trim()} ${flipped[1].trim()}` : raw;
}

function looksLikePerson(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 60) return false;
  if (/no.?reply|notification|alert|support|admin|team|service|automated|do.?not.?reply/i.test(n)) return false;
  if (n.includes('@') || n.includes('/')) return false;
  const words = n.split(/\s+/);
  // Two words minimum: a bare first name can't be filed as a person note.
  return words.length >= 2 && words.length <= 4 && words.every(w => /^[\p{L}][\p{L}'’.-]*$/u.test(w));
}

function addSighting(map, name, source) {
  const tidied = tidyName(name);
  if (!looksLikePerson(tidied)) return;
  const key = nameKey(tidied);
  if (!key) return;
  const entry = map.get(key) || { name: tidied, count: 0, sources: new Set() };
  entry.count += 1;
  entry.sources.add(source);
  map.set(key, entry);
}

// ── Sources ───────────────────────────────────────────────────────────────

function fromMeetingNotes(map, days) {
  const dir = path.join(VAULT_PATH(), 'Meetings');
  if (!fs.existsSync(dir)) return;
  const { extractAttendeesForFrontmatter } = require('./imports');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  (function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
        for (const attendee of extractAttendeesForFrontmatter(fs.readFileSync(full, 'utf-8'))) {
          // Already-linked attendees come back as `[[People/X|Y]]` — they have a
          // note by definition, so only the bare names are candidates.
          if (attendee.startsWith('[[')) continue;
          addSighting(map, attendee, 'meetings');
        }
      } catch { /* unreadable note — never fail the whole scan */ }
    }
  })(dir);
}

function fromTriagedInbox(map) {
  let stored = [];
  try { stored = JSON.parse(db.getState('email_triage') || '[]'); } catch { return; }
  for (const item of stored) {
    const email = String(item?.fromEmail || '').trim().toLowerCase();
    const name = String(item?.from || '').trim();
    if (!email.includes('@') || !name || name === email) continue;
    if (!INTERNAL_DOMAINS.some(d => email.endsWith(`@${d}`))) continue;
    addSighting(map, name, 'inbox');
  }
}

// calendar_cache holds no attendee list, only the organizer — so this is a
// thin source, but it's the one that catches people Nick meets and never emails.
function fromCalendarOrganizers(map, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  let rows = [];
  try {
    rows = db.getCalendarEvents(start.toISOString(), end.toISOString()) || [];
  } catch { return; }
  for (const row of rows) {
    if (row?.organizer) addSighting(map, row.organizer, 'calendar');
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────

/**
 * Read-only. Returns the names seen at least minSightings times that have no
 * People note.
 */
function findGaps({ days = 90, minSightings = MIN_SIGHTINGS } = {}) {
  if (!VAULT_PATH()) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured', candidates: [] };

  const sightings = new Map();
  fromMeetingNotes(sightings, days);
  fromTriagedInbox(sightings);
  fromCalendarOrganizers(sightings, days);

  const known = new Set(existingPeople().map(nameKey));
  const candidates = [...sightings.values()]
    .filter(c => !known.has(nameKey(c.name)))
    .map(c => ({ name: c.name, count: c.count, sources: [...c.sources].sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    status: 'ok',
    scannedDays: days,
    minSightings,
    existing: known.size,
    candidates: candidates.filter(c => c.count >= minSightings),
    belowThreshold: candidates.filter(c => c.count < minSightings),
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────

/**
 * Create stub People notes. Explicit — the scheduled pass never calls this.
 * Stubs are marked `status: auto-stub` so a hand-written note is never mistaken
 * for one, and carry no 1-2-1 cadence: NEURO doesn't know if this is a report.
 */
function createStubs({ names = null, days = 90, minSightings = MIN_SIGHTINGS, dryRun = false } = {}) {
  const scan = findGaps({ days, minSightings });
  if (scan.status !== 'ok') return scan;

  const wanted = names && names.length
    ? new Set(names.map(nameKey))
    : null;
  const targets = scan.candidates.filter(c => !wanted || wanted.has(nameKey(c.name)));

  if (dryRun) return { status: 'dry-run', wouldCreate: targets };

  const { managePersonProfile } = require('./person-profile');
  const created = [];
  const failed = [];

  for (const candidate of targets) {
    const result = managePersonProfile({
      action: 'create',
      person: candidate.name,
      frontmatter: {
        'direct-report': false,
        manager: '',
        cadence: '',
        status: 'auto-stub',
        'first-seen': new Date().toISOString().slice(0, 10),
        'seen-in': candidate.sources.join(', '),
      },
    });
    if (result.status === 'created') created.push(candidate.name);
    else failed.push({ name: candidate.name, error: result.error });
  }

  return { status: 'ok', created, failed, skipped: scan.candidates.length - targets.length };
}

// ── Report ────────────────────────────────────────────────────────────────

function writeReport(scan) {
  const dir = path.join(VAULT_PATH(), REPORT_FOLDER);
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `People gaps — ${date}.md`);

  const lines = [
    '---',
    'type: report',
    `date: ${date}`,
    'source: NEURO people-gap',
    '---',
    '',
    '# People gaps',
    '',
    `Names seen ${scan.minSightings}+ times in the last ${scan.scannedDays} days with no note in \`People/\`.`,
    `${scan.existing} people notes exist today.`,
    '',
  ];

  if (!scan.candidates.length) {
    lines.push('Nothing to add — every name seen met an existing note.', '');
  } else {
    lines.push('| Name | Sightings | Seen in |', '|------|-----------|---------|');
    for (const c of scan.candidates) {
      lines.push(`| ${c.name} | ${c.count} | ${c.sources.join(', ')} |`);
    }
    lines.push('', 'Create these with `POST /api/people-gap/apply`, or pass `names` to pick a subset.', '');
  }

  if (scan.belowThreshold.length) {
    lines.push(`## Seen only once (${scan.belowThreshold.length})`, '');
    for (const c of scan.belowThreshold) lines.push(`- ${c.name} (${c.sources.join(', ')})`);
    lines.push('');
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  } catch (e) {
    return { status: 'error', error: e.message };
  }
  return { status: 'ok', path: `${REPORT_FOLDER}/People gaps — ${date}.md` };
}

/** What the scheduler runs: scan, write the report, never mutate People/. */
function runNightlyScan({ days = 90 } = {}) {
  const scan = findGaps({ days });
  if (scan.status !== 'ok') return scan;
  const report = writeReport(scan);
  return { ...scan, report };
}

module.exports = { findGaps, createStubs, writeReport, runNightlyScan };
