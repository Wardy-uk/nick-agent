const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
// CLAUDE_MODEL removed in Phase 3 — AI routing handles provider selection

function broadcast(event) {
  try {
    const nudges = require('./nudges');
    if (typeof nudges.broadcast === 'function') {
      nudges.broadcast(event);
    }
  } catch (e) {
    // nudges not yet initialised or circular dep — ignore
  }
}

function getVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function getImportsPath() {
  return path.join(getVaultPath(), 'Imports');
}

function listMarkdownFiles(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const results = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(nextPath);
      }
    }
  }
  return results;
}

function cleanQuoted(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function slugifySegment(value, fallback = 'Untitled') {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

function getDatePartsFromFrontmatter(frontmatter) {
  const stamp = cleanQuoted(frontmatter.start_at || frontmatter.created_at || new Date().toISOString());
  const date = new Date(stamp);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const iso = safe.toISOString().slice(0, 10);
  return {
    iso,
    year: iso.slice(0, 4),
    month: iso.slice(5, 7)
  };
}

function extractDateFromText(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  return null;
}

function buildCanonicalMeetingPath(filePath, frontmatter, content) {
  const title = getPlaudTitle(filePath, frontmatter, content)
    .replace(/^\d{4}-\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/^\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/\b(?:-summary|-obsidian meeting template|-transcript)\b/gi, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = extractDateFromText(frontmatter.date, frontmatter.start_at, frontmatter.created_at, title, path.basename(filePath))
    || getDatePartsFromFrontmatter(frontmatter).iso;
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  return {
    date,
    year,
    month,
    title: slugifySegment(title || 'Meeting'),
    relativeDir: `Meetings/${year}/${month}`,
    relativePath: `Meetings/${year}/${month}/${date} – ${slugifySegment(title || 'Meeting')}.md`
  };
}

function extractMeetingType(content, title = '') {
  const combined = `${title}\n${content}`.toLowerCase();
  const typeSection = String(content).match(/^#{1,6}\s*Meeting Type\s*$\s*([\s\S]*?)(?=^#{1,6}\s+|\Z)/im);
  const candidate = (typeSection?.[1] || combined).toLowerCase();
  if (/\b(1-1|1:1|1-2-1|121|one-to-one|one to one|probation|performance review|return-to-work)\b/i.test(candidate)) return '1-1';
  if (/\b(client meeting|consultation|customer meeting|discovery call|demo|sales call)\b/i.test(candidate)) return 'Client Meeting';
  if (/\b(project meeting|kick-?off|rollout|migration|integration|workshop|implementation)\b/i.test(candidate)) return 'Project Meeting';
  if (/\b(discussion)\b/i.test(candidate)) return 'Discussion';
  if (/\b(stand[ -]?up|daily meeting|team stand up|team meeting|weekly meeting|operational meeting|leadership meeting)\b/i.test(candidate)) return 'Operational Meeting';
  return 'Operational Meeting';
}

// PLAUD writes its people list under `## Mentioned`; the older hand-written notes
// use `### Attendees`. Matching only the latter meant `people:` came out empty on
// 223 of 229 meeting notes — the whole person graph hung off a heading that had
// stopped being written. Match either, at either level.
const PEOPLE_HEADING_RE = /(?:^|\n)#{2,3}[ \t]*(?:Attendees|Mentioned|Participants|Present)[ \t]*\r?\n([\s\S]*?)(?=\n---[ \t]*\n|\n#{1,6}[ \t]|$)/i;

// `## Mentioned` also collects note links (MOCs, projects). A person is 1-4 words
// of name-ish text; anything else is a note, not an attendee.
function looksLikePersonName(name) {
  if (!name || name.length > 60) return false;
  if (/unknown speaker|^speaker\b|^\{|^MOC\b/i.test(name)) return false;
  if (name.includes(' - ') || name.includes('/')) return false;
  const words = name.split(/\s+/);
  return words.length <= 4 && /^[\p{L}][\p{L}'’.-]*$/u.test(words[0]);
}

function extractAttendeesForFrontmatter(content) {
  const matches = [];
  const attendeesBlock = String(content).match(PEOPLE_HEADING_RE);
  if (!attendeesBlock) return matches;
  for (const line of attendeesBlock[1].split('\n')) {
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!bullet) continue;
    const rawName = bullet[1].replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1').trim();
    if (!rawName || !looksLikePersonName(rawName)) continue;
    const matched = matchKnownPerson(rawName);
    // No People note yet: record the bare name rather than inventing
    // `[[People/{slug}]]`, which only ever produced a dangling link. The nightly
    // people-gap pass is what turns these into notes.
    const entry = matched ? `[[People/${matched}|${rawName}]]` : rawName;
    if (!matches.includes(entry)) matches.push(entry);
  }
  return matches;
}

// Surgical `people:` rewrite. Deliberately NOT updateFrontmatter(): that one
// reserialises the whole block through a line-based parser that silently drops
// list values, which would eat any other list-valued key in the note.
function replacePeopleBlock(content, attendees) {
  const fm = content.match(/^---\r?\n([\s\S]*?\r?\n)---/);
  if (!fm) return null;

  // Match the note's own line endings — a handful of vault notes are CRLF and
  // splicing LF into them leaves a mixed-ending file.
  const eol = fm[1].includes('\r\n') ? '\r\n' : '\n';
  const value = attendees.length
    ? `people:${eol}${attendees.map(p => `  - "${p}"`).join(eol)}${eol}`
    : `people: ${eol}`;

  const existing = fm[1].match(/^people:[^\n]*\n(?:[ \t]+-[^\n]*\n)*/m);
  const block = existing
    ? fm[1].replace(existing[0], value)
    : `${fm[1]}${value}`;

  return content.replace(fm[1], block);
}

/**
 * Backfill `people:` on meeting notes already in the vault. The heading fix only
 * reaches notes imported from here on; 223 of 229 existing notes were stamped
 * empty by the old `### Attendees`-only regex.
 *
 * dryRun by default. Touched files are backed up first.
 */
function restampMeetingPeople({ dryRun = true, limit = 1000 } = {}) {
  const vaultPath = getVaultPath();
  const meetingsDir = path.join(vaultPath, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return { status: 'error', error: 'Meetings/ not found' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(vaultPath, 'Scripts', '.lint-backups', `people-restamp-${stamp}`);
  const changed = [];
  const skipped = [];

  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (changed.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/^(transcripts|_transcripts|Archive)$/i.test(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      let content;
      try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      const attendees = extractAttendeesForFrontmatter(content);
      if (!attendees.length) { skipped.push(entry.name); continue; }

      const updated = replacePeopleBlock(content, attendees);
      if (!updated || updated === content) { skipped.push(entry.name); continue; }

      const relativePath = path.relative(vaultPath, full).replace(/\\/g, '/');
      if (!dryRun) {
        const backupPath = path.join(backupDir, relativePath);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, content, 'utf-8');
        fs.writeFileSync(full, updated, 'utf-8');
        try { require('./vault-hooks').onVaultWrite(full, 'people-restamp'); } catch {}
      }
      changed.push({ path: relativePath, people: attendees });
    }
  })(meetingsDir);

  return {
    status: 'ok',
    dryRun,
    changed: changed.length,
    skipped: skipped.length,
    backup: dryRun ? null : path.relative(vaultPath, backupDir).replace(/\\/g, '/'),
    notes: changed.slice(0, 20),
  };
}

function setCanonicalMeetingFrontmatter(filePath, extraFields = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const canonical = buildCanonicalMeetingPath(filePath, frontmatter, content);
  const meetingType = extractMeetingType(content, canonical.title);
  const attendees = extractAttendeesForFrontmatter(content);
  updateFrontmatter(filePath, {
    type: 'meeting',
    date: canonical.date,
    'meeting-type': `"${meetingType}"`,
    people: attendees.length ? `\n${attendees.map((person) => `  - "${person}"`).join('\n')}` : '',
    source: 'PLAUD',
    ...extraFields
  });
  return canonical;
}

function buildCanonicalTranscriptPath(filePath, frontmatter, content = '') {
  const titleSource = cleanQuoted(frontmatter.title) || path.basename(filePath, path.extname(filePath));
  const title = String(titleSource)
    .replace(/^\d{4}-\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/^\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/\b(?:-transcript)\b/gi, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = extractDateFromText(frontmatter.date, frontmatter.start_at, frontmatter.created_at, titleSource, content, path.basename(filePath))
    || getDatePartsFromFrontmatter(frontmatter).iso;
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const safeTitle = slugifySegment(title || 'Transcript');
  return {
    date,
    year,
    month,
    title: safeTitle,
    relativeDir: `Meetings/transcripts/${year}/${month}`,
    relativePath: `Meetings/transcripts/${year}/${month}/${date} – ${safeTitle}.md`
  };
}

function canonicalizePlaudTranscript(transcriptPath, { summaryRelativePath = null } = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { status: 'error', error: 'transcriptPath not found' };
  }

  const vaultPath = getVaultPath();
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const canonical = buildCanonicalTranscriptPath(transcriptPath, frontmatter, content);
  const currentRelative = path.relative(vaultPath, transcriptPath).replace(/\\/g, '/');
  let finalRelativePath = currentRelative;
  let finalFullPath = transcriptPath;

  if (currentRelative !== canonical.relativePath) {
    const canonicalFullPath = path.join(vaultPath, canonical.relativePath);
    if (fs.existsSync(canonicalFullPath) && path.resolve(canonicalFullPath) !== path.resolve(transcriptPath)) {
      const parsed = path.parse(canonical.relativePath);
      let counter = 2;
      let candidateRelative = canonical.relativePath;
      let candidateFull = canonicalFullPath;
      while (fs.existsSync(candidateFull)) {
        candidateRelative = path.join(parsed.dir, `${parsed.name} ${counter}${parsed.ext}`).replace(/\\/g, '/');
        candidateFull = path.join(vaultPath, candidateRelative);
        counter += 1;
      }
      fs.mkdirSync(path.dirname(candidateFull), { recursive: true });
      fs.renameSync(transcriptPath, candidateFull);
      finalRelativePath = candidateRelative;
      finalFullPath = candidateFull;
    } else {
      fs.mkdirSync(path.dirname(canonicalFullPath), { recursive: true });
      fs.renameSync(transcriptPath, canonicalFullPath);
      finalRelativePath = canonical.relativePath;
      finalFullPath = canonicalFullPath;
    }
  }

  const linkedMeeting = summaryRelativePath ? `[[${summaryRelativePath.replace(/\.md$/i, '')}]]` : '';
  updateFrontmatter(finalFullPath, {
    type: 'transcript',
    date: canonical.date,
    source: 'PLAUD',
    meeting: linkedMeeting ? `"${linkedMeeting}"` : '',
    note_type: '"transcript"'
  });

  try {
    if (currentRelative !== finalRelativePath) {
      require('./vault-logger').logMove(currentRelative, finalRelativePath, 'transcript');
    }
  } catch {}

  try { require('./vault-hooks').onVaultWrite(finalFullPath, 'plaud-transcript-route'); } catch {}

  return {
    status: 'ok',
    relativePath: finalRelativePath
  };
}

function matchKnownPerson(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;

  const people = obsidian.listPeopleNotes()
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const person of people) {
    const personLower = person.toLowerCase();
    if (haystack.includes(personLower)) return person;

    const parts = personLower.split(/\s+/).filter((part) => part.length > 2);
    if (parts.length >= 2 && parts.every((part) => haystack.includes(part))) {
      return person;
    }
  }

  return null;
}

function getPlaudTitle(filePath, frontmatter, content) {
  const frontmatterTitle = cleanQuoted(frontmatter.title);
  if (frontmatterTitle) return frontmatterTitle;

  const headingMatch = String(content).match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  return path.basename(filePath, path.extname(filePath));
}

function looksLikePlaudSummary(filePath, frontmatter, content) {
  const noteType = cleanQuoted(frontmatter.note_type).toLowerCase();
  const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const isImportsPlaud = normalizedPath.includes('/imports/plaud/');
  const fileName = path.basename(filePath).toLowerCase();

  if (noteType && noteType !== 'summary') return false;

  return noteType === 'summary'
    || fileName.endsWith('-summary.md')
    || fileName.endsWith('-obsidian meeting template.md')
    || /###\s+meeting type/i.test(content)
    || /###\s+action items/i.test(content)
    || /###\s+key decisions/i.test(content)
    || isImportsPlaud;
}

function getPlaudSummaryPreference(frontmatter, filePath, content = '') {
  const tab = cleanQuoted(frontmatter.plaud_summary_tab).toLowerCase();
  const type = cleanQuoted(frontmatter.plaud_summary_type).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const text = `${tab}\n${type}\n${fileName}\n${content.slice(0, 400)}`.toLowerCase();

  if (text.includes('obsidian meeting template')) return 3;
  if (text.includes('summary') || type === 'consumer_note' || type === 'auto_sum_note') return 2;
  return 1;
}

function isPlaudTranscript(frontmatter, filePath) {
  const noteType = cleanQuoted(frontmatter.note_type).toLowerCase();
  const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  return noteType === 'transcript'
    || normalizedPath.includes('/plaud/transcripts/')
    || fileName.endsWith('-transcript.md');
}

function isPlaudStagingPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return normalized.startsWith('Plaud/Summaries/')
    || normalized.startsWith('Imports/PLAUD/');
}

function isLegacyPlaudCleanupPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return normalized.startsWith('Meetings/')
    || normalized.startsWith('Team/')
    || normalized.startsWith('Projects/')
    || normalized.startsWith('Plaud/');
}

function isKnowledgeMemoryGenerated(frontmatter) {
  return cleanQuoted(frontmatter.managed_by).toLowerCase() === 'sara-knowledge-memory'
    || cleanQuoted(frontmatter.source).toLowerCase() === 'sara-import-consolidation';
}

function readMarkdownNote(fullPath) {
  const vaultPath = getVaultPath();
  const content = fs.readFileSync(fullPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  return {
    fullPath,
    relativePath: path.relative(vaultPath, fullPath).replace(/\\/g, '/'),
    content,
    frontmatter,
    plaudId: cleanQuoted(frontmatter.plaud_id),
    summaryPreference: getPlaudSummaryPreference(frontmatter, fullPath, content)
  };
}

function classifyPlaudDeterministic(filePath, content, opts = {}) {
  const frontmatter = parseFrontmatter(content);
  const normalizedPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const allowLegacyPlaudCleanup = opts.context === 'plaud-cleanup';
  if (!looksLikePlaudSummary(filePath, frontmatter, content) || (!allowLegacyPlaudCleanup && !normalizedPath.includes('/plaud/') && !cleanQuoted(frontmatter.plaud_id))) {
    return null;
  }

  const title = getPlaudTitle(filePath, frontmatter, content);
  const body = content.replace(/^---[\s\S]*?---\n*/, '');
  const lower = `${title}\n${body}`.toLowerCase();
  const { year, month } = getDatePartsFromFrontmatter(frontmatter);
  const transcriptInsight = opts.transcriptInsight || null;
  const hintedPerson = transcriptInsight?.people?.find((person) => person.vaultMatch)?.vaultMatch
    || matchKnownPerson(title)
    || matchKnownPerson(body);
  const explicit121Pattern = /\b(1-1|1:1|1-2-1|121|one-to-one|one to one|one-on-one|one on one)\b/i;
  const hr121Pattern = /\b(probation|performance review|return-to-work)\b/i;
  const teamMeetingPattern = /\b(stand[ -]?up|daily meeting|team stand up|team meeting|weekly meeting|operational meeting|leadership meeting)\b/i;
  const titleLower = title.toLowerCase();
  const fileStemLower = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const explicit121 = explicit121Pattern.test(titleLower)
    || explicit121Pattern.test(fileStemLower)
    || /###\s+meeting type\s*\n\s*(1-1|1:1|1-2-1|121|one-to-one|one to one|one-on-one|one on one)\b/i.test(content);
  const hr121 = hr121Pattern.test(titleLower)
    || /###\s+meeting type\s*\n\s*(probation|performance review|return-to-work)\b/i.test(content);

  if (transcriptInsight?.is121 || explicit121 || (hr121 && hintedPerson && !teamMeetingPattern.test(lower))) {
    const canonical = buildCanonicalMeetingPath(filePath, frontmatter, content);
    return {
      type: 'meeting',
      destination: canonical.relativeDir,
      confidence: hintedPerson ? 'high' : 'medium',
      reason: hintedPerson
        ? `Deterministic PLAUD routing: identified a 1-2-1/performance note for ${hintedPerson}.`
        : 'Deterministic PLAUD routing: identified a 1-2-1/performance note.'
    };
  }

  if (teamMeetingPattern.test(lower)) {
    const canonical = buildCanonicalMeetingPath(filePath, frontmatter, content);
    return {
      type: 'meeting',
      destination: canonical.relativeDir,
      confidence: 'high',
      reason: 'Deterministic PLAUD routing: identified a team or operational meeting.'
    };
  }

  if (/\b(client meeting|consultation|customer meeting|discovery call|demo|sales call)\b/i.test(lower)) {
    const canonical = buildCanonicalMeetingPath(filePath, frontmatter, content);
    return {
      type: 'meeting',
      destination: canonical.relativeDir,
      confidence: 'high',
      reason: 'Deterministic PLAUD routing: identified a client-facing meeting.'
    };
  }

  if (/\b(project meeting|kick-?off|rollout|migration|integration|workshop|implementation)\b/i.test(lower)) {
    const canonical = buildCanonicalMeetingPath(filePath, frontmatter, content);
    return {
      type: 'meeting',
      destination: canonical.relativeDir,
      confidence: 'medium',
      reason: 'Deterministic PLAUD routing: identified a project or implementation meeting.'
    };
  }

  return null;
}

function renderKnownPersonLinks(content) {
  const people = obsidian.listPeopleNotes();
  if (!people.length) return content;

  let updated = String(content).replace(
    /((?:^|\n)#{2,3}[ \t]*(?:Attendees|Mentioned|Participants|Present)[ \t]*\r?\n)([\s\S]*?)(?=\n---[ \t]*\n|\n#{1,6}[ \t]|$)/i,
    (match, prefix, attendeesBlock) => {
      const lines = attendeesBlock
        .split('\n')
        .map((line) => line.trimEnd());

      const rewritten = lines.map((line) => {
        const bullet = line.match(/^\s*-\s+(.+?)\s*$/);
        if (!bullet) return line;
        const name = bullet[1].trim();
        const matched = matchKnownPerson(name) || people.find((person) => person.toLowerCase() === name.toLowerCase());
        if (!matched) return line;
        return `- [[People/${matched}|${name}]]`;
      });

      return `${prefix}${rewritten.join('\n')}`.trimEnd();
    }
  );

  for (const person of people) {
    const escaped = person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    updated = updated.replace(
      new RegExp(`(^|[^\\[])@${escaped}(?=\\b)`, 'gmi'),
      `$1[[People/${person}|@${person}]]`
    );
  }

  return updated;
}

function updateTranscriptSummaryLink(transcriptPath, summaryRelativePath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
  const linkedPath = summaryRelativePath.replace(/\.md$/i, '');
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const next = content.replace(/^Summary:\s*\[\[[^\]]+\]\]/m, `Summary: [[${linkedPath}]]`);
  if (next !== content) {
    fs.writeFileSync(transcriptPath, next, 'utf-8');
    try { require('./vault-hooks').onVaultWrite(transcriptPath, 'plaud-transcript-link'); } catch {}
  }
}

function updatePlaudSummaryMetadata(filePath, fields = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue;
    normalized[key] = typeof value === 'string' && !/^".*"$/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  }
  updateFrontmatter(filePath, normalized);
}

// Recursively list all .md files in Imports/ and subdirs
function listAllFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      results.push(...listAllFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Parse frontmatter from markdown content
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return {};
  const fm = content.slice(3, endIdx).trim();
  const result = {};
  for (const line of fm.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// Update or add frontmatter fields to a markdown file
function updateFrontmatter(filePath, fields) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let fm = {};
  let body = content;

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const fmBlock = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 3).replace(/^\n+/, '');
      for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
  }

  Object.assign(fm, fields);
  const fmStr = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const newContent = `---\n${fmStr}\n---\n${body}`;
  fs.writeFileSync(filePath, newContent, 'utf-8');
  return newContent;
}

// Get pending (unprocessed) import files
function getPending() {
  const importsDir = getImportsPath();
  if (!fs.existsSync(importsDir)) return [];

  const allFiles = listAllFiles(importsDir);
  const pending = [];

  // Load stored classifications for cross-device display
  let storedClassifications = {};
  try {
    const db = require('../db/database');
    const allCls = db.getAllImportClassifications();
    for (const cls of allCls) {
      storedClassifications[cls.relative_path] = cls;
    }
  } catch (e) { /* non-fatal — classifications just won't show */ }

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    // Skip files already processed or marked needs-review
    if (fm.status === 'processed') continue;

    const relativePath = path.relative(getVaultPath(), filePath).replace(/\\/g, '/');
    const subdir = path.relative(importsDir, path.dirname(filePath)).replace(/\\/g, '/');
    const stats = fs.statSync(filePath);

    pending.push({
      filePath,
      relativePath,
      fileName: path.basename(filePath),
      subdir: subdir === '.' ? '' : subdir,
      status: fm.status || null,
      reviewReason: fm['review-reason'] || null,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      preview: content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 200),
      storedClassification: storedClassifications[relativePath] || null
    });
  }

  return pending.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function buildClassifyPrompt(fileName, content) {
  const body = content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 400);
  return `You are a filing assistant for an Obsidian vault. Classify the note below and suggest which vault folder it belongs in.

VAULT FOLDERS (choose destination from this list only):
- Meetings/         → meeting notes, call notes, discussion summaries
- Calls/            → call notes (use when explicitly a phone or video call)
- People/           → notes about a specific person (1-2-1s, feedback, personal updates)
- Team/             → internal team operations and working rhythms
- Ideas/            → ideas, concepts, brainstorms, things to explore
- Projects/         → notes tied to a specific named project
- Areas/            → ongoing responsibilities (health, finance, leadership, team management)
- Decision Log/     → a decision that was made
- Reflections/      → personal reflections, journal entries, retrospectives
- Archive/          → anything that doesn't fit elsewhere or is low value

TYPES (choose one):
meeting, call-note, action, decision, idea, reference, person-update, plaud-transcript, reflection, needs-review

RULES:
- If content is fewer than 10 meaningful words with no clear category, type MUST be needs-review
- destination MUST be exactly one folder name from the list above — nothing else
- confidence is high only if the type and destination are completely obvious
- If genuinely unsure, use needs-review with low confidence

Filename: ${fileName}
Content:
${body}

Respond in EXACTLY this format with no other text:
type: <type>
destination: <folder name>
confidence: <high|medium|low>
reason: <one sentence>`;
}

// classifyWithClaude removed in Phase 3 — replaced by AI routing layer

async function classifyWithOllama(fileName, content) {
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildClassifyPrompt(fileName, content),
      stream: false,
      options: { temperature: 0.1, num_ctx: 2048, num_predict: 256 }
    }),
    signal: AbortSignal.timeout(30000) // 30s — fail fast to AI routing
  });

  if (!ollamaRes.ok) {
    throw new Error(`Ollama error: ${ollamaRes.status}`);
  }

  const data = await ollamaRes.json();
  return data.response || '';
}

async function classifyFile(filePath, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const relativePath = path.relative(getVaultPath(), filePath).replace(/\\/g, '/');

  const deterministicPlaud = classifyPlaudDeterministic(filePath, content, opts);
  if (deterministicPlaud) {
    const classification = {
      ...deterministicPlaud,
      backend: 'deterministic',
      rawResponse: deterministicPlaud.reason
    };
    try {
      const db = require('../db/database');
      db.saveImportClassification(relativePath, classification);
    } catch (e) {
      console.warn('[Imports] Failed to persist deterministic classification:', e.message);
    }
    return classification;
  }

  let responseText = '';
  let backend = 'ollama';

  // Try Ollama first, fall back through AI routing
  try {
    responseText = await classifyWithOllama(fileName, content);
    console.log(`[Imports] Classified ${fileName} via Ollama`);
  } catch (ollamaErr) {
    console.warn(`[Imports] Ollama failed for ${fileName}, trying AI routing:`, ollamaErr.message);
    try {
      const aiProvider = require('./ai-provider');
      const result = await aiProvider.classifyImport(buildClassifyPrompt(fileName, content));
      if (result.text) {
        responseText = result.text;
        backend = result.provider;
        console.log(`[Imports] Classified ${fileName} via ${result.provider} (fallback)`);
      }
    } catch (fallbackErr) {
      console.error(`[Imports] All AI providers failed for ${fileName}:`, fallbackErr.message);
      throw fallbackErr;
    }
  }

  const typeMatch = responseText.match(/type:\s*(\S+)/i);
  const destMatch = responseText.match(/destination:\s*(.+)/i);
  const confMatch = responseText.match(/confidence:\s*(\S+)/i);
  const reasonMatch = responseText.match(/reason:\s*(.+)/i);

  const classification = {
    type: typeMatch ? typeMatch[1].replace(/[^a-z-]/g, '') : 'needs-review',
    destination: destMatch ? destMatch[1].trim() : null,
    confidence: confMatch ? confMatch[1].toLowerCase() : 'low',
    reason: reasonMatch ? reasonMatch[1].trim() : 'Could not parse classification',
    backend,
    rawResponse: responseText
  };

  // Force needs-review for low confidence or missing destination
  if (classification.confidence === 'low' || !classification.destination) {
    classification.type = 'needs-review';
  }

  // Validate destination is a real vault folder — reject invented paths
  const VALID_DESTINATIONS = [
    'Meetings/', 'Calls/', 'People/', 'Ideas/', 'Projects/',
    'Areas/', 'Decision Log/', 'Reflections/', 'Team/', 'Archive/'
  ];
  const normalizedDestination = String(classification.destination || '').replace(/\\/g, '/');
  if (classification.destination && !VALID_DESTINATIONS.some((d) => normalizedDestination.startsWith(d))) {
    console.warn(`[Imports] Invalid destination "${classification.destination}" — forcing needs-review`);
    classification.type = 'needs-review';
    classification.confidence = 'low';
    classification.destination = null;
  }

  // Persist classification to DB for cross-device access
  try {
    const db = require('../db/database');
    db.saveImportClassification(relativePath, classification);
  } catch (e) {
    console.warn('[Imports] Failed to persist classification:', e.message);
  }

  broadcast({
    type: 'classification_ready',
    filePath: filePath,
    relativePath: relativePath,
    classification
  });

  return classification;
}

// Route a file to its destination
function routeFile(filePath, destination, type) {
  const vaultPath = getVaultPath();

  updateFrontmatter(filePath, {
    type: type || 'unknown',
    status: 'processed',
    'routed-date': new Date().toISOString().slice(0, 10)
  });

  const destDir = path.resolve(vaultPath, destination);
  if (!destDir.startsWith(path.resolve(vaultPath))) {
    throw new Error('Destination outside vault');
  }
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const fileName = path.basename(filePath);
  let finalPath = path.join(destDir, fileName);
  if (fs.existsSync(finalPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    finalPath = path.join(destDir, `${base}-${Date.now()}${ext}`);
  }

  const sourceRel = path.relative(vaultPath, filePath).replace(/\\/g, '/');
  fs.renameSync(filePath, finalPath);
  const destRel = path.relative(vaultPath, finalPath).replace(/\\/g, '/');

  // Log every move to vault note
  try {
    const vaultLogger = require('./vault-logger');
    vaultLogger.logMove(sourceRel, destRel, type || 'import-route');
  } catch (e) { console.warn('[Imports] Move logging failed:', e.message); }

  broadcast({
    type: 'file_actioned',
    filePath: filePath,
    action: 'routed'
  });

  // Remove classification from DB — file has been actioned
  try {
    const db = require('../db/database');
    db.deleteImportClassification(sourceRel);
  } catch (e) { /* non-fatal */ }

  // Trigger post-write hooks on the newly routed file
  try {
    require('./vault-hooks').onVaultWrite(finalPath, 'import-route');
  } catch {}

  return destRel;
}

async function routePlaudSummary(summaryPath, { transcriptPath = null, transcriptInsight = null, forceCanonical = false } = {}) {
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    return { status: 'error', error: 'summaryPath not found' };
  }

  const vaultPath = getVaultPath();
  const relativeSummaryPath = path.relative(vaultPath, summaryPath).replace(/\\/g, '/');
  const classification = await classifyFile(summaryPath, { transcriptInsight, context: 'plaud-summary' });
  const content = fs.readFileSync(summaryPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const canonical = buildCanonicalMeetingPath(summaryPath, frontmatter, content);
  const fallbackDestination = canonical.relativeDir;
  const effectiveClassification = (!classification.destination && forceCanonical)
    ? {
        ...classification,
        type: 'meeting',
        destination: fallbackDestination,
        confidence: classification.confidence || 'medium',
        reason: classification.reason && classification.reason !== 'Could not parse classification'
          ? classification.reason
          : 'Forced canonical PLAUD routing based on vault rules'
      }
    : classification;
  const destination = effectiveClassification.destination || fallbackDestination;

  const enhanced = renderKnownPersonLinks(content);
  if (enhanced !== content) {
    fs.writeFileSync(summaryPath, enhanced, 'utf-8');
  }

  let finalRelativePath = relativeSummaryPath;
  const canonicalTargetRelative = canonical.relativePath;
  const canonicalTargetFull = path.join(vaultPath, canonicalTargetRelative);
  if (relativeSummaryPath !== canonicalTargetRelative) {
    if (fs.existsSync(canonicalTargetFull) && path.resolve(summaryPath) !== path.resolve(canonicalTargetFull)) {
      const ext = path.extname(canonicalTargetRelative);
      const parsed = path.parse(canonicalTargetRelative);
      let counter = 2;
      let candidateRelative = canonicalTargetRelative;
      let candidateFull = canonicalTargetFull;
      while (fs.existsSync(candidateFull)) {
        candidateRelative = path.join(parsed.dir, `${parsed.name} ${counter}${ext}`).replace(/\\/g, '/');
        candidateFull = path.join(vaultPath, candidateRelative);
        counter += 1;
      }
      fs.mkdirSync(path.dirname(candidateFull), { recursive: true });
      fs.renameSync(summaryPath, candidateFull);
      finalRelativePath = candidateRelative;
    } else {
      fs.mkdirSync(path.dirname(canonicalTargetFull), { recursive: true });
      fs.renameSync(summaryPath, canonicalTargetFull);
      finalRelativePath = canonicalTargetRelative;
    }
  }

  const finalFullPath = path.resolve(vaultPath, finalRelativePath);
  setCanonicalMeetingFrontmatter(finalFullPath, {
    status: 'processed',
    transcript_path: transcriptPath
      ? path.relative(vaultPath, transcriptPath).replace(/\\/g, '/')
      : '',
    plaud_route_reason: effectiveClassification.reason || 'Plaud note routed to final destination',
    plaud_route_backend: effectiveClassification.backend || 'deterministic'
  });

  try {
    const sourceRel = relativeSummaryPath;
    if (sourceRel !== finalRelativePath) {
      const vaultLogger = require('./vault-logger');
      vaultLogger.logMove(sourceRel, finalRelativePath, 'meeting');
    }
  } catch {}

  broadcast({
    type: 'file_actioned',
    filePath: summaryPath,
    action: 'routed'
  });

  try {
    const db = require('../db/database');
    db.deleteImportClassification(relativeSummaryPath);
  } catch {}

  if (transcriptPath) {
    updateTranscriptSummaryLink(transcriptPath, finalRelativePath);
  }

  try { require('./vault-hooks').onVaultWrite(finalFullPath, 'plaud-route'); } catch {}

  return {
    status: 'ok',
    relativePath: finalRelativePath,
    destination,
    classification: effectiveClassification
  };
}

function chooseCanonicalPlaudNote(notes) {
  return [...notes].sort((a, b) => {
    const byPreference = (b.summaryPreference || 0) - (a.summaryPreference || 0);
    if (byPreference !== 0) return byPreference;

    const aGenerated = isKnowledgeMemoryGenerated(a.frontmatter) ? 1 : 0;
    const bGenerated = isKnowledgeMemoryGenerated(b.frontmatter) ? 1 : 0;
    if (aGenerated !== bGenerated) return aGenerated - bGenerated;

    const aStaging = isPlaudStagingPath(a.relativePath) ? 1 : 0;
    const bStaging = isPlaudStagingPath(b.relativePath) ? 1 : 0;
    if (aStaging !== bStaging) return aStaging - bStaging;

    return a.relativePath.localeCompare(b.relativePath);
  })[0] || null;
}

function ensurePlaudCleanupReportDir() {
  const dir = path.join(getVaultPath(), 'Documents', 'System', 'SARA Import Reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function archivePlaudDuplicate(note, archiveFolder, usedTargets = new Set()) {
  const vaultPath = getVaultPath();
  const destinationDir = path.join(vaultPath, archiveFolder);
  fs.mkdirSync(destinationDir, { recursive: true });

  const parsed = path.parse(note.relativePath);
  let fileName = `${sanitizeFileName(path.basename(parsed.name))}${parsed.ext}`;
  let targetRelative = path.join(archiveFolder, fileName).replace(/\\/g, '/');
  let counter = 2;
  while (fs.existsSync(path.join(vaultPath, targetRelative)) || usedTargets.has(targetRelative)) {
    fileName = `${sanitizeFileName(path.basename(parsed.name))} ${counter}${parsed.ext}`;
    targetRelative = path.join(archiveFolder, fileName).replace(/\\/g, '/');
    counter += 1;
  }

  fs.renameSync(note.fullPath, path.join(vaultPath, targetRelative));
  usedTargets.add(targetRelative);
  try { require('./vault-hooks').onVaultWrite(path.join(vaultPath, targetRelative), 'plaud-cleanup-archive'); } catch {}
  return targetRelative;
}

function sanitizeFileName(value) {
  return String(value || 'Untitled')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}

function buildPlaudCleanupReport(summary) {
  const lines = [];
  lines.push(`# Plaud Cleanup Report — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- Dry run: ${summary.dryRun ? 'yes' : 'no'}`);
  lines.push(`- Candidate groups: ${summary.scannedGroups}`);
  lines.push(`- Candidate singles: ${summary.scannedSingles}`);
  lines.push(`- Routed: ${summary.routed.length}`);
  lines.push(`- Updated in place: ${summary.updatedInPlace.length}`);
  lines.push(`- Archived duplicates: ${summary.archived.length}`);
  lines.push(`- Needs review: ${summary.needsReview.length}`);
  lines.push(`- Errors: ${summary.errors.length}`);
  lines.push('');

  const sections = [
    ['Routed', summary.routed, (item) => `- \`${item.from}\` -> \`${item.to}\` (${item.reason})`],
    ['Updated In Place', summary.updatedInPlace, (item) => `- \`${item.path}\` (${item.reason})`],
    ['Archived Duplicates', summary.archived, (item) => `- \`${item.from}\` -> \`${item.to}\` (${item.reason})`],
    ['Needs Review', summary.needsReview, (item) => `- \`${item.path}\` (${item.reason})`],
    ['Errors', summary.errors, (item) => `- \`${item.path}\` (${item.error})`]
  ];

  for (const [heading, items, render] of sections) {
    lines.push(`## ${heading}`);
    if (!items.length) {
      lines.push('- None');
    } else {
      for (const item of items) lines.push(render(item));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function backfillPlaudNotes({ limit = 500, dryRun = false, archiveDuplicates = true } = {}) {
  const vaultPath = getVaultPath();
  if (!vaultPath || !fs.existsSync(vaultPath)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const allNotes = listMarkdownFiles(vaultPath).map(readMarkdownNote);
  const transcriptByPlaudId = new Map();
  const groupedByPlaudId = new Map();
  const singleCandidates = [];

  for (const note of allNotes) {
    if (isPlaudTranscript(note.frontmatter, note.fullPath)) {
      if (note.plaudId) transcriptByPlaudId.set(note.plaudId, note);
      continue;
    }

    const looksPlaud = note.plaudId || looksLikePlaudSummary(note.fullPath, note.frontmatter, note.content);
    if (!looksPlaud) continue;

    if (note.plaudId) {
      if (!groupedByPlaudId.has(note.plaudId)) groupedByPlaudId.set(note.plaudId, []);
      groupedByPlaudId.get(note.plaudId).push(note);
    } else if (isPlaudStagingPath(note.relativePath) || isLegacyPlaudCleanupPath(note.relativePath)) {
      singleCandidates.push(note);
    }
  }

  const summary = {
    status: 'ok',
    dryRun,
    scannedGroups: groupedByPlaudId.size,
    scannedSingles: singleCandidates.length,
    routed: [],
    updatedInPlace: [],
    archived: [],
    needsReview: [],
    errors: []
  };

  const archiveFolder = `Archive/Plaud Cleanup/${new Date().toISOString().slice(0, 10)}`;
  const archiveTargets = new Set();
  let processed = 0;

  for (const [plaudId, notes] of groupedByPlaudId) {
    if (processed >= limit) break;
    processed += 1;

    const canonical = chooseCanonicalPlaudNote(notes);
    if (!canonical) continue;

    const transcript = transcriptByPlaudId.get(plaudId) || null;
    const keeper = notes.find((note) => !isPlaudStagingPath(note.relativePath) && !isKnowledgeMemoryGenerated(note.frontmatter)) || canonical;
    const duplicates = notes.filter((note) => note.fullPath !== canonical.fullPath && note.fullPath !== keeper.fullPath);

    try {
      if (!dryRun && canonical.fullPath !== keeper.fullPath) {
        fs.writeFileSync(keeper.fullPath, canonical.content, 'utf-8');
        try { require('./vault-hooks').onVaultWrite(keeper.fullPath, 'plaud-cleanup-merge'); } catch {}
        summary.updatedInPlace.push({
          path: keeper.relativePath,
          reason: `Replaced with preferred Plaud content for ${plaudId}`
        });
      }

      const routeTargetPath = canonical.fullPath !== keeper.fullPath ? keeper.fullPath : canonical.fullPath;
      const routePreview = await classifyFile(routeTargetPath, { context: 'plaud-cleanup' });
      if (!routePreview.destination) {
        if (!dryRun) {
          const forcedRouteResult = await routePlaudSummary(routeTargetPath, {
            transcriptPath: transcript?.fullPath || null,
            forceCanonical: true
          });
          if (forcedRouteResult.status === 'ok') {
            if (transcript?.fullPath) {
              const transcriptResult = canonicalizePlaudTranscript(transcript.fullPath, {
                summaryRelativePath: forcedRouteResult.relativePath
              });
              if (transcriptResult.status === 'ok') {
                transcript.fullPath = path.join(vaultPath, transcriptResult.relativePath);
                transcript.relativePath = transcriptResult.relativePath;
              }
            }
            summary.routed.push({
              from: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
              to: forcedRouteResult.relativePath,
              reason: forcedRouteResult.classification?.reason || `Forced canonical route for ${plaudId}`
            });
          } else {
            summary.needsReview.push({
              path: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
              reason: `No routing destination for ${plaudId}`
            });
          }
        } else {
          summary.routed.push({
            from: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
            to: canonical.relativePath,
            reason: `Would force canonical route for ${plaudId}`
          });
        }
      } else if (!dryRun) {
        const routeResult = await routePlaudSummary(routeTargetPath, {
          transcriptPath: transcript?.fullPath || null
        });
        if (routeResult.status === 'ok') {
          if (transcript?.fullPath) {
            const transcriptResult = canonicalizePlaudTranscript(transcript.fullPath, {
              summaryRelativePath: routeResult.relativePath
            });
            if (transcriptResult.status === 'ok') {
              transcript.fullPath = path.join(vaultPath, transcriptResult.relativePath);
              transcript.relativePath = transcriptResult.relativePath;
            }
          }
          summary.routed.push({
            from: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
            to: routeResult.relativePath,
            reason: routeResult.classification?.reason || `Routed Plaud note ${plaudId}`
          });
        } else {
          summary.errors.push({
            path: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
            error: routeResult.error || `Failed to route ${plaudId}`
          });
        }
      } else {
        summary.routed.push({
          from: path.relative(vaultPath, routeTargetPath).replace(/\\/g, '/'),
          to: routePreview.destination,
          reason: routePreview.reason || `Would route Plaud note ${plaudId}`
        });
      }

      for (const duplicate of duplicates) {
        const reason = duplicate.summaryPreference < canonical.summaryPreference
          ? `Lower-priority Plaud variant for ${plaudId}`
          : `Duplicate Plaud note for ${plaudId}`;
        if (archiveDuplicates && !dryRun) {
          const archivedTo = archivePlaudDuplicate(duplicate, archiveFolder, archiveTargets);
          summary.archived.push({
            from: duplicate.relativePath,
            to: archivedTo,
            reason
          });
        } else {
          summary.archived.push({
            from: duplicate.relativePath,
            to: `${archiveFolder}/...`,
            reason
          });
        }
      }
    } catch (error) {
      summary.errors.push({
        path: canonical.relativePath,
        error: error.message
      });
    }
  }

  for (const note of singleCandidates.slice(0, Math.max(0, limit - processed))) {
    try {
      const routePreview = await classifyFile(note.fullPath, { context: 'plaud-cleanup' });
      if (!routePreview.destination) {
        if (!dryRun) {
          const forcedRouteResult = await routePlaudSummary(note.fullPath, { forceCanonical: true });
          if (forcedRouteResult.status === 'ok') {
            summary.routed.push({
              from: note.relativePath,
              to: forcedRouteResult.relativePath,
              reason: forcedRouteResult.classification?.reason || 'Forced canonical route for legacy Plaud note'
            });
            continue;
          }
        } else {
          const canonical = buildCanonicalMeetingPath(note.fullPath, note.frontmatter, note.content);
          summary.routed.push({
            from: note.relativePath,
            to: canonical.relativePath,
            reason: 'Would force canonical route for legacy Plaud note'
          });
          continue;
        }
        summary.needsReview.push({
          path: note.relativePath,
          reason: 'Legacy Plaud note could not be deterministically routed'
        });
        continue;
      }

      if (!dryRun) {
        const routeResult = await routePlaudSummary(note.fullPath);
        if (routeResult.status === 'ok') {
          summary.routed.push({
            from: note.relativePath,
            to: routeResult.relativePath,
            reason: routeResult.classification?.reason || 'Routed legacy Plaud note'
          });
        } else {
          summary.errors.push({
            path: note.relativePath,
            error: routeResult.error || 'Failed to route legacy Plaud note'
          });
        }
      } else {
        summary.routed.push({
          from: note.relativePath,
          to: routePreview.destination,
          reason: routePreview.reason || 'Would route legacy Plaud note'
        });
      }
    } catch (error) {
      summary.errors.push({
        path: note.relativePath,
        error: error.message
      });
    }
  }

  const reportDir = ensurePlaudCleanupReportDir();
  const reportPath = path.join(reportDir, `Plaud Cleanup - ${new Date().toISOString().slice(0, 10)}${dryRun ? ' Dry Run' : ''}.md`);
  const reportMarkdown = buildPlaudCleanupReport(summary);
  fs.writeFileSync(reportPath, reportMarkdown + '\n\n_Part of [[Logs]]_\n', 'utf-8');
  try { require('./vault-hooks').onVaultWrite(reportPath, 'plaud-cleanup-report'); } catch {}

  summary.reportPath = path.relative(vaultPath, reportPath).replace(/\\/g, '/');
  return summary;
}

// Batch classify and route all pending imports
async function autoClassify() {
  const db = require('../db/database');

  // Prevent concurrent sweeps
  const sweepRunning = db.getState('imports_sweep_running');
  if (sweepRunning === 'true') {
    console.log('[Imports] Sweep already running — skipping');
    return { routed: 0, flagged: 0, errors: 0, skipped: true };
  }
  db.setState('imports_sweep_running', 'true');

  try {
    const pending = getPending().filter((file) => {
      if (file.status !== 'needs-review') return true;
      return String(file.relativePath || '').replace(/\\/g, '/').startsWith('Imports/PLAUD/');
    });

    if (pending.length === 0) {
      console.log('[Imports] No pending files to classify');
      db.setState('imports_sweep_running', 'false');
      const empty = { routed: 0, flagged: 0, errors: 0, timestamp: new Date().toISOString() };
      broadcast({ type: 'sweep_complete', ...empty });
      return empty;
    }

    console.log(`[Imports] Auto-classifying ${pending.length} files...`);
    broadcast({ type: 'sweep_started', total: pending.length });
    let routed = 0, flagged = 0, errors = 0;
    let fileIndex = 0;

    // Process in batches of 3 concurrently (Claude API handles parallel requests well)
    // Ollama fallback still needs sequential — detect which backend we're using
    // Ollama-first: sequential processing (Pi 5 can't handle concurrent Ollama calls)
    const useConcurrent = false;
    const BATCH_SIZE = 1;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(batch.map(async (file) => {
        try {
          const cls = await classifyFile(file.filePath);
          console.log(`[Imports] ${file.fileName}: ${cls.type} (${cls.confidence}) → ${cls.destination}`);

          broadcast({
            type: 'sweep_progress',
            file: file.fileName,
            relativePath: file.relativePath,
            index: fileIndex++,
            total: pending.length,
            classification: cls
          });

          if (cls.confidence === 'high' && cls.destination) {
            // High confidence — auto-route immediately, no review needed
            const newPath = routeFile(file.filePath, cls.destination, cls.type);
            console.log(`[Imports] Auto-routed (high confidence): ${file.fileName} → ${cls.destination}`);
            routed++;
            if (cls.type === 'plaud-transcript') {
              // Post-route: extract entities from PLAUD transcript
              try {
                const tp = require('./transcript-processor');
                const vaultPath = getVaultPath();
                const routedFullPath = path.resolve(vaultPath, newPath);
                const result = await tp.processTranscript(routedFullPath);
                if (result) {
                  const parts = [];
                  if (result.summary) parts.push(result.summary);
                  if (result.actionItems.length > 0) parts.push(`${result.actionItems.length} action item(s) extracted.`);
                  if (result.people.some(p => p.updated121)) {
                    const updated = result.people.filter(p => p.updated121).map(p => p.vaultMatch);
                    parts.push(`Updated 1-2-1 date for: ${updated.join(', ')}`);
                  }
                  broadcast({
                    type: 'transcript_processed',
                    sourceFile: result.sourceFile,
                    result
                  });
                  const webpush = require('./webpush');
                  webpush.sendToAll(
                    'NEURO — Transcript Processed',
                    parts.join(' ') || `Transcript filed to ${cls.destination}.`,
                    { type: 'plaud', url: '/imports' }
                  ).catch(() => {});
                } else {
                  const webpush = require('./webpush');
                  webpush.sendToAll(
                    'NEURO — PLAUD Transcript Ready',
                    `Transcript filed to ${cls.destination}. Ready to review.`,
                    { type: 'plaud', url: '/vault' }
                  ).catch(() => {});
                }
              } catch (tpErr) {
                console.error('[Imports] Transcript processing error:', tpErr.message);
                const webpush = require('./webpush');
                webpush.sendToAll(
                  'NEURO — PLAUD Transcript Ready',
                  `Transcript filed to ${cls.destination}. Ready to review.`,
                  { type: 'plaud', url: '/vault' }
                ).catch(() => {});
              }
            }
          } else {
            // Medium confidence — queue for review; Low/missing — needs-review
            const reason = cls.confidence === 'medium'
              ? `Medium confidence: ${cls.reason || 'review suggested'}`
              : cls.reason || 'Low confidence classification';
            updateFrontmatter(file.filePath, {
              status: 'needs-review',
              'review-reason': reason
            });
            try {
              const db = require('../db/database');
              db.deleteImportClassification(file.relativePath);
            } catch (e) { /* non-fatal */ }
            flagged++;
            console.log(`[Imports] Flagged for review (${cls.confidence}): ${file.fileName}`);
          }
        } catch (e) {
          console.error(`[Imports] Error classifying ${file.fileName}:`, e.message);
          errors++;
        }
      }));

      // Brief pause between batches — respect rate limits
      if (i + BATCH_SIZE < pending.length) {
        await new Promise(r => setTimeout(r, useConcurrent ? 200 : 500));
      }
    }

    const summary = { routed, flagged, errors, timestamp: new Date().toISOString() };
    console.log(`[Imports] Sweep complete: ${routed} routed, ${flagged} flagged, ${errors} errors`);
    try { require('./activity').trackImportsSweep(routed, flagged, errors); } catch {}
    db.setState('imports_last_sweep', JSON.stringify(summary));
    db.setState('imports_sweep_running', 'false');
    broadcast({ type: 'sweep_complete', ...summary });

    return summary;
  } finally {
    db.setState('imports_sweep_running', 'false');
  }
}

module.exports = {
  getPending,
  getImportsPath,
  classifyFile,
  routeFile,
  routePlaudSummary,
  backfillPlaudNotes,
  updateFrontmatter,
  autoClassify,
  extractAttendeesForFrontmatter,
  restampMeetingPeople
};
