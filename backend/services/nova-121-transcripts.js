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

/**
 * How far back a sweep looks.
 *
 * Was 30 days, which quietly hid the exact 1-2-1s this feature exists to surface. A person
 * whose last recorded 1-2-1 was in June is precisely the one NOVA flags as stalled — and a
 * 30-day window meant the recording that would clear the flag was permanently out of
 * reach, so the flag could never be right. Anything already resolved is skipped, so a
 * wider window costs one pass of catch-up and nothing after that.
 */
const DEFAULT_DAYS = 180;

/** Anything that reads as a 1-2-1, however Plaud happened to title it. */
const ONE_TO_ONE_TITLE = /1-2-1|1:1|(^|[^\d-])1-1([^\d-]|$)|one[- ]to[- ]one|one[- ]on[- ]one/i;

/**
 * `meeting-type: 1-1` in frontmatter — plaud-sync already classified the recording when it
 * filed the note, and this sweep was throwing that answer away.
 *
 * The title alone is not enough and never was. Plaud titles a note by what was DISCUSSED,
 * so Stephen's monthly 1-2-1 arrived as "Meeting: Team KPIs, Ticket Management, AI Tooling
 * and Escalation Workflow" and Isabel's as "Performance Review: Isabel Busk KPIs" — both
 * carrying `meeting-type: 1-1`, both skipped, both showing in NOVA as a person who has not
 * had a 1-2-1 since the spring.
 */
const ONE_TO_ONE_MEETING_TYPE = /^(1-1|1:1|1-2-1|121|one[- ]to[- ]one|one[- ]on[- ]one)$/i;

/** The deterministic router's verdict, written into `plaud_route_reason` on filing. */
const ROUTED_AS_ONE_TO_ONE = /1-2-1\/performance note/i;

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
 * Every transcript note in the vault, indexed by the `plaud_id` it shares with its summary.
 *
 * Needed because `transcript_path` goes STALE. Sebastian's June 1-2-1 is the case that
 * exposed it: the transcript note had been moved into `Meetings/1-2-1/Sebastian Broome/`,
 * the summary's `transcript_path` still pointed at `Plaud/Transcripts/…`, and the read
 * failed silently — so a 1-2-1 with a 40-minute transcript sitting in the vault was offered
 * to NOVA as "no transcript", which attaches a date and then extracts nothing from it. A
 * note names its recording in frontmatter and THAT never moves, so match on the id and
 * treat the path as a hint.
 *
 * Built once per sweep, and only over the folders transcripts actually live in — walking
 * the whole vault takes minutes.
 */
const TRANSCRIPT_DIRS = ['Plaud/Transcripts', 'Meetings'];
let transcriptIndex = null;

function buildTranscriptIndex() {
  const byId = new Map();
  for (const dir of TRANSCRIPT_DIRS) {
    for (const file of walk(path.join(VAULT_PATH(), dir), 0, [])) {
      let fm;
      try { ({ fm } = readNote(file)); } catch { continue; }
      if (!fm || !fm.plaud_id) continue;
      const isTranscript = String(fm.type || '').toLowerCase() === 'transcript'
        || String(fm.note_type || '').toLowerCase() === 'transcript';
      if (!isTranscript) continue;
      if (!byId.has(fm.plaud_id)) byId.set(fm.plaud_id, file);
    }
  }
  return byId;
}

/** The words of one transcript note, or null if it is empty, a stub or unreadable. */
function readTranscriptBody(abs) {
  try {
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

/**
 * The transcript for a summary note.
 *
 * `transcript_path` first — the summary names its own twin, and transcripts live in
 * `Plaud/Transcripts/`, not under `Meetings/`, which is why the first cut of this sweep
 * sent every candidate over saying "no transcript text". Then the recording id, for when
 * that path no longer resolves.
 */
function transcriptFor(fm) {
  const rel = fm && fm.transcript_path;
  if (rel) {
    const viaPath = readTranscriptBody(
      path.join(VAULT_PATH(), String(rel).replace(/\.md$/, '') + '.md'));
    if (viaPath) return viaPath;
  }
  if (!fm || !fm.plaud_id) return null;
  if (!transcriptIndex) transcriptIndex = buildTranscriptIndex();
  const abs = transcriptIndex.get(fm.plaud_id);
  return abs ? readTranscriptBody(abs) : null;
}

/**
 * Is this note a 1-2-1, and on what grounds?
 *
 * `explicit` means somebody SAID so — the note is filed in the 1-2-1 tree, or the title
 * names the meeting type. Those are offered to NOVA even when nobody can be attributed,
 * because Nick can pick the person off a dropdown.
 *
 * `soft` means only plaud-sync's classifier said so, via `meeting-type` or the route
 * reason it stamped on filing. That leg is an LLM for most notes and it applies `1-1` to
 * plenty of things that are not 1-2-1s — a four-person "Weekly Meeting: Customer Service
 * Improvement Strategy" carries it. Real enough to look at, not real enough to offer
 * unattributed.
 */
function oneToOneSignal(fm, rel, title) {
  if (/^Meetings\/1-2-1\//.test(rel)) return 'explicit';
  if (ONE_TO_ONE_TITLE.test(title)) return 'explicit';
  const meetingType = String((fm && (fm['meeting-type'] || fm.meeting_type)) || '').trim();
  if (ONE_TO_ONE_MEETING_TYPE.test(meetingType)) return 'soft';
  if (ROUTED_AS_ONE_TO_ONE.test(String((fm && fm.plaud_route_reason) || ''))) return 'soft';
  return null;
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

  // 3b. plaud-sync's deterministic router named the person as it filed the note
  //     ("...a 1-2-1/performance note for Isabel Busk."). It got that by matching the
  //     vault's own People folder against the title and body, which is a firmer claim than
  //     step 4's bare first name — and it is the only signal on the HR-flavoured notes
  //     ("Performance Review: ...") where Plaud logged no participants at all.
  const routed = String(fm && fm.plaud_route_reason || '').match(/1-2-1\/performance note for ([^.]+)\./i);
  if (routed) {
    const named = routed[1].trim().toLowerCase();
    if (byName.has(named)) {
      return { person: byName.get(named), attribution: 'named by the vault router when the note was filed' };
    }
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

  transcriptIndex = null;

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
  // Notes the soft frontmatter signal picked up but nobody could be attributed to. Not
  // failures — reported so a mis-detection is visible rather than silently dropped.
  const ignored = [];

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
    // The note lives in the 1-2-1 tree, reads as one by title, or was filed as one by
    // plaud-sync. Everything else in Meetings/ is a team meeting and not this feature's
    // business.
    const signal = oneToOneSignal(fm, rel, title);
    if (!signal) continue;

    // Transcript notes are the summary's twin, sharing a plaud_id. Skip them: the
    // summary is the one with the participants and the notes, and it points AT the
    // transcript. Offering both would just fight over the same candidate row.
    const isTranscript = String(fm.type || '').toLowerCase() === 'transcript'
      || String(fm.note_type || '').toLowerCase() === 'transcript';
    if (isTranscript) continue;

    const { person, attribution } = attribute(fm, file, reports, body);
    const participants = participantsFrom(body);

    // A soft signal is only worth Nick's attention once we can say WHOSE 1-2-1 it was.
    // Offering the unattributable ones would fill the approval queue with team meetings
    // he has to reject one at a time, and a queue like that stops being read.
    if (signal === 'soft' && !person) {
      ignored.push(`${date} ${title} — filed as a 1-2-1 but ${attribution}`);
      continue;
    }

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
      // Local wall-clock, passed through as the vault stores it. NOVA renders the time
      // by string match rather than parsing — a Date would shift it by the viewer's
      // offset and move an afternoon 1-2-1 into the morning.
      startedAt: fm.start_at || null,
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

  return { ok: true, dryRun: !apply, offered, skipped, ignored, reports: reports.length };
}

module.exports = {
  offerTranscripts,
  _internals: { attribute, readNote, peopleLinks, participantsFrom, summaryExcerptFrom, oneToOneSignal },
};
