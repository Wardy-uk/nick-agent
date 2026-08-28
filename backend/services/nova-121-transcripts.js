'use strict';

/**
 * 1-2-1 transcripts, offered to NOVA.
 *
 * NOVA used to read Plaud itself over MCP. That connection has never been authorised in
 * prod — `plaud_oauth_tokens` unset, transport closing on a loop — so not one 1-2-1 has
 * ever had a recording attached. NEURO's plaud-sync, meanwhile, has been landing every
 * note in the vault reliably for months, with `plaud_id`, the date and the `people:`
 * links in frontmatter. So NEURO is the Plaud route now, and NOVA gets the transcript
 * over the bridge keyed on that same `plaud_id`.
 *
 * ⚠ IT OFFERS. IT DOES NOT ATTACH.
 *
 * Attribution is a guess and must be treated as one. Plaud names recordings by timestamp,
 * so the title rarely says whose 1-2-1 it was; a note that mentions three people says
 * nothing about which of them it was *with*; and Plaud has previously filed a 1-2-1
 * against Nick with the other person logged as "Unknown Speaker 1" (see Nathan's holding
 * note). Binding the wrong transcript writes one person's conversation onto another
 * person's permanent record, and NOVA's extractor would then close THAT person's actions
 * from words they never said. So every candidate goes to NOVA as a proposal, carrying HOW
 * it was attributed, and a human approves it there.
 *
 * Read-only against the vault.
 */

const fs = require('fs');
const path = require('path');

const nova = require('./nova-client');
const detect = require('./one-to-one-detect');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

/** Mirrors one-to-one-detect: generated output and dead copies resurrect old meetings. */
const EXCLUDE_DIRS = new Set([
  'Archive', 'Recycle Bin', '_toDelete', '_Staging - Keep in Archive',
  'Vault Audit', '.lint-backups', '.git', '.stversions', '.stfolder',
]);

/**
 * Below this many words of real content, a "transcript" is a stub rather than a record.
 * A 14-minute 1-2-1 runs to thousands of characters; 200 is a heading and a back-link.
 */
const MIN_TRANSCRIPT_CHARS = 400;

/** How far back a sweep looks. Older recordings are history, not something to file now. */
const DEFAULT_DAYS = 30;

/** Anything that reads as a 1-2-1, however Plaud happened to title it. */
const ONE_TO_ONE_TITLE = /1-2-1|1:1|(^|[^\d-])1-1([^\d-]|$)|one[- ]to[- ]one|one[- ]on[- ]one/i;

/**
 * Frontmatter, line endings normalised FIRST.
 *
 * The vault is authored on Windows, `\r` is a line terminator in a JS regex, and an
 * anchored `/^key:\s*(.*)$/` therefore fails on every CRLF line and returns nothing at
 * all. one-to-one-detect and meeting-notes-source both learned this the hard way.
 */
function readNote(file) {
  const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text };

  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      fm[key] = kv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // `people:` is a YAML list — the wiki-links are on their own `  - "[[…]]"` lines.
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && key) {
      if (!Array.isArray(fm[`${key}__list`])) fm[`${key}__list`] = [];
      fm[`${key}__list`].push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

/** The People names a note's `people:` frontmatter links to. */
function peopleLinks(fm) {
  const raw = fm?.people__list ?? [];
  const names = [];
  for (const entry of raw) {
    const m = String(entry).match(/\[\[People\/([^|\]]+)/);
    if (m) names.push(m[1].trim());
  }
  return names;
}

/**
 * Plaud writes `> Participants: [Nick Ward] [Maria Pappa]` into the summary body.
 *
 * This is by far the best attribution signal available and the first cut ignored it,
 * falling back to first-name-in-title and answering "could not tell" for most notes.
 * `[Speaker 3]` is Plaud failing to identify a voice — a placeholder, never a person, and
 * treating it as one would attribute a meeting to somebody who was not named at all.
 */
const SPEAKER_PLACEHOLDER = /^speaker\s*\d+$/i;

function participantsFrom(body) {
  const m = String(body).match(/^\s*>?\s*Participants:\s*(.+)$/mi);
  if (!m) return [];
  return (m[1].match(/\[([^\]]+)\]/g) || [])
    .map(x => x.slice(1, -1).trim())
    .filter(x => x && !SPEAKER_PLACEHOLDER.test(x));
}

/**
 * The part of the summary a human needs to judge whether this is the right person's
 * 1-2-1 — the actual meeting notes, not the boilerplate Recording block above them.
 */
function summaryExcerptFrom(body, max = 1200) {
  const text = String(body);
  const start = text.search(/^##+\s*(Meeting Notes|Summary)\s*$/mi);
  const from = start === -1 ? 0 : start;
  return text.slice(from)
    // Strip the quoted "Meeting Information" preamble; it is the same on every note.
    .replace(/^>.*$/gm, '')
    .replace(/^#+\s*/gm, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .slice(0, max);
}

/**
 * The transcript note this summary points at, via `transcript_path` frontmatter.
 *
 * The transcripts live in `Plaud/Transcripts/`, NOT under `Meetings/` — which is why the
 * first cut, walking only `Meetings/`, sent every candidate over saying "no transcript
 * text". The summary note names its own twin, so follow that rather than guessing a path.
 */
function transcriptFor(fm) {
  const rel = fm && fm.transcript_path;
  if (!rel) return null;
  try {
    const abs = path.join(VAULT_PATH(), String(rel).replace(/\.md$/, '') + '.md');
    const raw = fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n');
    // Frontmatter off — the extractor wants the words, not the metadata.
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (!body) return null;

    // plaud-sync writes a STUB when Plaud has no transcript for a recording — the note
    // exists, has the right frontmatter and says "No transcript returned by Plaud".
    // Sending that on is worse than sending nothing: NOVA would show "transcript 276
    // chars", and the extractor would read a sentence of boilerplate as the meeting and
    // conclude nothing was agreed. Absent has to look absent.
    if (/^\s*No transcript returned by Plaud/mi.test(body)) return null;
    // A note with only its title, the back-link and an empty Transcript heading is the
    // same thing wearing different words.
    const words = body.replace(/^#+.*$/gm, '').replace(/\[\[[^\]]*\]\]/g, '').trim();
    if (words.length < MIN_TRANSCRIPT_CHARS) return null;

    return body;
  } catch {
    return null;
  }
}

function walk(dir, depth, out) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1, out);
    } else if (e.name.endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * Decide who a recording was with, and say how confidently.
 *
 * Returns `{ person, attribution }`. `person` is null when there is no defensible answer,
 * which is a fine outcome — NOVA shows the candidate with an empty dropdown and Nick
 * picks. Guessing here would be worse than not answering.
 */
function attribute(fm, filePath, reports, body = '') {
  const byName = new Map(reports.map(p => [p.name.toLowerCase(), p.name]));

  // 1. The note is filed under Meetings/1-2-1/<Person>/ — the strongest signal there is,
  //    because a human (or the importer) already decided.
  const rel = path.relative(VAULT_PATH(), filePath).replace(/\\/g, '/');
  const folder = rel.match(/^Meetings\/1-2-1\/([^/]+)\//);
  if (folder && byName.has(folder[1].toLowerCase())) {
    return { person: byName.get(folder[1].toLowerCase()), attribution: 'note filed under their 1-2-1 folder' };
  }

  // 2. Plaud's own participant list — who was actually in the room, by voice. Exactly
  //    one direct report among them means it was with them; several means it was a team
  //    meeting and not anybody's 1-2-1.
  const heard = participantsFrom(body).filter(n => byName.has(n.toLowerCase()));
  const heardUnique = [...new Set(heard.map(n => byName.get(n.toLowerCase())))];
  if (heardUnique.length === 1) {
    return { person: heardUnique[0], attribution: 'the only direct report Plaud heard speaking' };
  }
  if (heardUnique.length > 1) {
    return { person: null, attribution: `${heardUnique.length} direct reports in the room — not a 1-2-1` };
  }

  // 3. Frontmatter `people:` links, minus Nick. Exactly one direct report left = it was
  //    with them. Two or more and it was not a 1-2-1 at all, so we say nothing.
  const linked = peopleLinks(fm).filter(n => byName.has(n.toLowerCase()));
  if (linked.length === 1) {
    return { person: byName.get(linked[0].toLowerCase()), attribution: 'the only direct report linked on the note' };
  }
  if (linked.length > 1) {
    return { person: null, attribution: `${linked.length} direct reports on the note — ambiguous` };
  }

  // 4. A name in the title. Weakest, and offered as such.
  const title = String(fm?.title || path.basename(filePath, '.md'));
  const hit = reports.find(p => new RegExp(`\\b${p.name.split(' ')[0]}\\b`, 'i').test(title));
  if (hit) return { person: hit.name, attribution: 'first name in the recording title' };

  return { person: null, attribution: 'could not tell from the note' };
}

/**
 * Find 1-2-1 transcripts in the vault and offer them to NOVA.
 *
 * Dry-run by default: `apply: true` is what pushes. Recordings NOVA has already resolved
 * are skipped, so an approved or rejected one is never re-offered.
 */
async function offerTranscripts({ apply = false, days = DEFAULT_DAYS } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { ok: false, error: 'OBSIDIAN_VAULT_PATH not configured' };
  if (!nova.isConfigured()) {
    return { ok: false, error: 'NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }

  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) {
    // A missing folder is a read failure, not "no meetings happened".
    return { ok: false, error: 'Meetings/ not found in vault' };
  }

  let known = new Set();
  try {
    const r = await nova.get121KnownRecordings();
    known = new Set(r.plaudIds || []);
  } catch (e) {
    // Without this list every sweep would re-offer everything Nick has already rejected.
    return { ok: false, error: `Could not read what NOVA already has: ${e.message}` };
  }

  const reports = detect.buildRoster().people.filter(p => p.bookable);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const offered = [];
  const skipped = [];

  for (const file of walk(meetingsDir, 0, [])) {
    let fm, body;
    try { ({ fm, body } = readNote(file)); } catch { continue; }
    if (!fm) continue;

    const plaudId = fm.plaud_id;
    if (!plaudId) continue;
    if (known.has(plaudId)) continue;

    const date = String(fm.date || '').slice(0, 10)
      || (path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    if (!date || date < cutoff) continue;

    const rel = path.relative(vault, file).replace(/\\/g, '/');
    const title = String(fm.title || path.basename(file, '.md'));
    const inOneToOneFolder = /^Meetings\/1-2-1\//.test(rel);
    // Either the note lives in the 1-2-1 tree, or it reads as one by title. Everything
    // else in Meetings/ is a team meeting and not this feature's business.
    if (!inOneToOneFolder && !ONE_TO_ONE_TITLE.test(title)) continue;

    // Transcript notes are the summary's twin, sharing a plaud_id. Skip them: the
    // summary is the one with the participants and the notes, and it points AT the
    // transcript. Offering both would just fight over the same candidate row.
    const isTranscript = String(fm.type || '').toLowerCase() === 'transcript'
      || String(fm.note_type || '').toLowerCase() === 'transcript';
    if (isTranscript) continue;

    const { person, attribution } = attribute(fm, file, reports, body);
    const participants = participantsFrom(body);

    // The transcript IS the payload — the extractor reads words, not a summary — and it
    // lives in its own note that `transcript_path` points at. The first cut only looked
    // at the note in hand, so every candidate arrived saying "no transcript text".
    const transcript = transcriptFor(fm);
    const durationMinutes = Number(fm.duration_ms)
      ? Math.round(Number(fm.duration_ms) / 60000) : null;

    const candidate = {
      plaudId, agentName: person, meetingDate: date, title,
      notePath: rel, transcript, attribution,
      participants: participants.join(', ') || null,
      durationMinutes,
      summaryExcerpt: summaryExcerptFrom(body),
    };

    if (!apply) { offered.push({ ...candidate, transcript: transcript ? `${transcript.length} chars` : null }); continue; }

    try {
      await nova.push121TranscriptCandidate(candidate);
      offered.push({ plaudId, person, date, title });
    } catch (e) {
      skipped.push(`${title}: ${e.message}`);
    }
  }

  return { ok: true, dryRun: !apply, offered, skipped, reports: reports.length };
}

module.exports = {
  offerTranscripts,
  _internals: { attribute, readNote, peopleLinks, participantsFrom, summaryExcerptFrom },
};
