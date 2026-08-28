'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const aiRouting = require('./ai-routing');
const db = require('../db/database');
const obsidian = require('./obsidian');
const importsService = require('./imports');
const retrieval = require('./retrieval');
const weeklySummary = require('./weekly-summary');
const knowledgeGaps = require('./knowledge-gaps');
const vaultHooks = require('./vault-hooks');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
// ⚠ `Meetings/transcripts` is where transcripts were SUPPOSED to land and holds
// zero files — `backend/.env` sets `PLAUD_TRANSCRIPT_FOLDER=Plaud/Transcripts`,
// which is where all 311 of them actually are. Scanning an empty folder finds
// nothing and raises nothing, so the raw-intake pass had never read a transcript.
// Both are listed: the configured one because it is the truth, the old one
// because `imports.canonicalizePlaudTranscript` can still put a rescued stray
// there. Measured before changing: adding the folder moves consolidation items
// 2 -> 2, so this reads more and writes nothing new (see groupPlaudNotes).
const RAW_FOLDERS = [
  'Plaud/Summaries',
  'Plaud/Transcripts',
  'Meetings/transcripts',
  'Imports',
  'Meetings',
  'Daily',
];
const TRUSTED_ROOTS = ['Knowledge', 'Projects', 'Areas', 'People', 'Documents'];
const REFLECTION_DIR = 'Reflections/Knowledge';
const REPORT_DIR = 'Documents/System/SARA Import Reports';
const VAULT_MODEL_DOC = 'Documents/System/Vault Operating Model.md';

function isoNow() {
  return new Date().toISOString();
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function toRel(fullPath) {
  return path.relative(VAULT_PATH(), fullPath).replace(/\\/g, '/');
}

function fileNameFromPath(relPath) {
  return path.basename(relPath, '.md');
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sanitizeSegment(value, fallback = 'General') {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

function normalizePlaudId(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function cleanQuoted(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---[\s\S]*?---\s*/m, '');
}

function stripCodeFences(content) {
  return String(content || '')
    .replace(/^```(?:json|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function uniqueStrings(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJsonObject(text) {
  const clean = stripCodeFences(text);
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function markdownLinkForPath(relPath, label = '') {
  if (!relPath) return '';
  return `[[${String(relPath).replace(/\.md$/i, '')}|${label || fileNameFromPath(relPath)}]]`;
}

function excerpt(content, maxLength = 260) {
  const clean = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function extractMarkdownSection(content, heading) {
  const text = String(content || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = text.match(new RegExp(`^## ${escapedHeading}\\s*$`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';

  const sectionStart = startMatch.index + startMatch[0].length;
  const remainder = text.slice(sectionStart);
  const nextHeadingOffset = remainder.search(/\n##\s+/);
  const section = nextHeadingOffset === -1
    ? remainder
    : remainder.slice(0, nextHeadingOffset);
  return section.trim();
}

function removeMarkdownSection(content, heading) {
  const text = String(content || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\n## ${escapedHeading}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, 'm');
  return text.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
}

function shiftMarkdownHeadings(markdown, increaseBy = 1) {
  return String(markdown || '').replace(/^(#{1,6})\s+/gm, (match, hashes) => {
    const nextDepth = Math.min(6, hashes.length + increaseBy);
    return `${'#'.repeat(nextDepth)} `;
  });
}

function cleanPlaudSummaryMarkdown(markdown, titleToRemove = '') {
  let text = String(markdown || '').trim();
  if (!text) return '';

  text = text.replace(/^#\s+.+\n+/, '').trim();

  if (titleToRemove) {
    const escapedTitle = titleToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^#\\s+${escapedTitle}\\s*`, 'i'), '').trim();
  }

  text = text
    .replace(/^\s*---\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return shiftMarkdownHeadings(text, 1);
}

function extractPlaudMeetingMarkdown(note, fallbackTitle = '') {
  if (!note?.content) return '';

  const summarySection = extractMarkdownSection(note.content, 'Summary');
  if (summarySection) {
    return cleanPlaudSummaryMarkdown(summarySection, fallbackTitle);
  }

  const stripped = stripFrontmatter(note.content).trim();
  if (!stripped) return '';

  const withoutRecording = stripped.replace(
    /^#\s+.+?\n+##\s+Recording[\s\S]*?(?=\n##\s+|\n#\s+|$)/,
    ''
  ).trim();

  return cleanPlaudSummaryMarkdown(withoutRecording || stripped, fallbackTitle);
}

function hasMarkdownHeading(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,6}\\s+${escapedHeading}\\s*$`, 'im').test(String(markdown || ''));
}

function walkMarkdown(dir, depth = 0, maxDepth = 5, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, depth + 1, maxDepth, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readNoteMeta(fullPath) {
  const content = fs.readFileSync(fullPath, 'utf-8');
  const stat = fs.statSync(fullPath);
  const relPath = toRel(fullPath);
  const fm = obsidian.parseFrontmatter(content);
  const body = stripFrontmatter(content);
  const linkMatches = [...body.matchAll(/\[\[([^\]]+)\]\]/g)];
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const relLower = relPath.toLowerCase();
  const folder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const knowledgeState = String(fm.knowledge_state || '').toLowerCase();
  const trusted = relLower.startsWith('knowledge/')
    || knowledgeState === 'trusted'
    || knowledgeState === 'distilled';

  return {
    path: relPath,
    name: fileNameFromPath(relPath),
    folder,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    frontmatter: fm,
    tags: obsidian.extractTags(content),
    links: linkMatches.length,
    wordCount,
    trusted,
    knowledgeState: knowledgeState || (trusted ? 'trusted' : 'raw'),
    promotedTo: fm.knowledge_promoted_to || '',
    consolidatedTo: fm.sara_consolidated_to || '',
    excerpt: excerpt(content),
    content
  };
}

function loadFolderNotes(folder) {
  const vault = VAULT_PATH();
  if (!vault) return [];
  const fullDir = path.join(vault, folder);
  return walkMarkdown(fullDir).map(readNoteMeta);
}

function loadTrustedNotes() {
  const vault = VAULT_PATH();
  if (!vault) return [];
  const notes = [];

  for (const folder of TRUSTED_ROOTS) {
    const fullDir = path.join(vault, folder);
    if (!fs.existsSync(fullDir)) continue;
    for (const fullPath of walkMarkdown(fullDir)) {
      const note = readNoteMeta(fullPath);
      if (note.trusted) notes.push(note);
    }
  }

  return notes.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function loadRawNotes() {
  return RAW_FOLDERS.flatMap(loadFolderNotes)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function noteDateParts(note) {
  // ⚠ Same quote trap as the note_type comparisons: plaud-sync writes
  // `start_at: "2026-08-25T14:18:56"` QUOTED, and `new Date('"2026-..."')` is
  // Invalid Date, which falls through to `new Date()` below. So a consolidated
  // note for a July meeting was dated TODAY and filed in the current month —
  // silently, because a plausible date is indistinguishable from a correct one.
  const stamp = cleanQuoted(note.frontmatter.start_at)
    || cleanQuoted(note.frontmatter.created_at)
    || note.modified
    || isoNow();
  const date = new Date(stamp);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    iso: safe.toISOString().slice(0, 10),
    year: safe.toISOString().slice(0, 4),
    month: safe.toISOString().slice(5, 7)
  };
}

function scorePromotionCandidate(note) {
  let score = 0;
  if (note.path.startsWith('Plaud/Summaries/')) score += 5;
  // Both transcript locations score the same — the folder a transcript sits in is
  // a deployment detail, not a statement about how good a promotion candidate it
  // is. Scoring only the empty one meant this arm had never fired.
  if (note.path.startsWith('Meetings/transcripts/') || note.path.startsWith('Plaud/Transcripts/')) score += 3;
  if (note.path.startsWith('Meetings/')) score += 2;
  if (note.wordCount > 350) score += 2;
  if (note.links > 0) score += 1;
  if (note.tags.length > 0) score += 1;
  if (String(note.frontmatter.source || '').toLowerCase() === 'plaud') score += 2;
  if (String(note.frontmatter.summary_type || '').trim()) score += 1;
  if (note.promotedTo) score -= 10;
  return score;
}

function getPromotionCandidates({ topic, limit = 8, daysBack = 21 } = {}) {
  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
  const term = String(topic || '').trim().toLowerCase();

  return loadRawNotes()
    .filter(note => !note.promotedTo)
    .filter(note => new Date(note.modified).getTime() >= cutoff)
    .filter(note => !term || `${note.name}\n${note.excerpt}\n${note.tags.join(' ')}`.toLowerCase().includes(term))
    .map(note => ({
      ...note,
      promotionScore: scorePromotionCandidate(note)
    }))
    .sort((a, b) => {
      if (b.promotionScore !== a.promotionScore) return b.promotionScore - a.promotionScore;
      return new Date(b.modified) - new Date(a.modified);
    })
    .slice(0, limit)
    .map(note => ({
      path: note.path,
      name: note.name,
      folder: note.folder,
      modified: note.modified,
      excerpt: note.excerpt,
      wordCount: note.wordCount,
      tags: note.tags,
      knowledgeState: note.knowledgeState,
      summaryType: note.frontmatter.summary_type || null,
      promotionScore: note.promotionScore
    }));
}

async function getActiveContext({ topic, maxResults = 5 } = {}) {
  const trustedNotes = loadTrustedNotes();
  if (!topic || !topic.trim()) {
    return trustedNotes.slice(0, maxResults).map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      knowledgeState: note.knowledgeState,
      excerpt: note.excerpt
    }));
  }

  const searchResults = await retrieval.search(topic, { maxResults: maxResults * 4 });
  const trustedSet = new Map(trustedNotes.map(note => [note.path, note]));
  const filtered = searchResults
    .filter(result => trustedSet.has(result.path))
    .slice(0, maxResults)
    .map(result => {
      const note = trustedSet.get(result.path);
      return {
        path: result.path,
        name: result.name,
        modified: note.modified,
        knowledgeState: note.knowledgeState,
        score: result.score,
        excerpt: result.excerpts?.[0] || note.excerpt
      };
    });

  if (filtered.length > 0) return filtered;

  return trustedNotes
    .filter(note => `${note.name}\n${note.excerpt}`.toLowerCase().includes(topic.toLowerCase()))
    .slice(0, maxResults)
    .map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      knowledgeState: note.knowledgeState,
      excerpt: note.excerpt
    }));
}

function recentReflections(limit = 4) {
  return loadFolderNotes(REFLECTION_DIR)
    .slice(0, limit)
    .map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      excerpt: note.excerpt
    }));
}

function getAiEnrichmentNotesForDate(dateKey = isoDate()) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) return [];

  const matches = [];
  for (const fullPath of walkMarkdown(vault)) {
    let note;
    try {
      note = readNoteMeta(fullPath);
    } catch {
      continue;
    }
    const enrichedAt = cleanQuoted(note.frontmatter.sara_ai_enriched_at || '');
    if (!enrichedAt.startsWith(dateKey)) continue;
    matches.push({
      path: note.path,
      provider: cleanQuoted(note.frontmatter.sara_ai_provider || 'unknown')
    });
  }
  return matches;
}

function parseCsvField(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function getOverview({ topic } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const raw = loadRawNotes();
  const trusted = loadTrustedNotes();
  const candidates = getPromotionCandidates({ topic, limit: 6 });
  const activeContext = await getActiveContext({ topic, maxResults: 5 });
  const weekly = weeklySummary.summarizeWeek({});
  const gaps = knowledgeGaps.findKnowledgeGaps({ topic, daysBack: 90 });
  const reflections = recentReflections(4);

  const domains = new Map();
  for (const note of trusted) {
    const domain = sanitizeSegment(note.frontmatter.knowledge_domain || note.folder.split('/')[0] || 'General');
    domains.set(domain, (domains.get(domain) || 0) + 1);
  }

  return {
    status: 'ok',
    counts: {
      rawNotes: raw.length,
      trustedNotes: trusted.length,
      promotionCandidates: candidates.length,
      reflectionNotes: reflections.length,
      knowledgeDomains: domains.size
    },
    weekly: weekly.status === 'ok' ? weekly.counts : null,
    topDomains: [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([domain, count]) => ({ domain, count })),
    activeContext,
    promotionCandidates: candidates,
    recentReflections: reflections,
    knowledgeGaps: gaps.status === 'ok' ? (gaps.suggestions || []).slice(0, 5) : []
  };
}

function renderFrontmatter(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function upsertFrontmatterValue(content, key, value) {
  const line = `${key}: "${String(value).replace(/"/g, '\\"')}"`;
  if (!content.startsWith('---')) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const fmBlock = content.slice(0, endIdx + 3);
  const body = content.slice(endIdx + 3).replace(/^\s*/, '');
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  const nextFm = pattern.test(fmBlock)
    ? fmBlock.replace(pattern, line)
    : fmBlock.replace(/---\s*$/, `${line}\n---`);
  return `${nextFm}\n\n${body}`;
}

function inferDomainFromSource(sourcePath) {
  if (sourcePath.startsWith('Plaud/')) return 'Meetings';
  if (sourcePath.startsWith('Projects/')) return 'Projects';
  if (sourcePath.startsWith('People/')) return 'People';
  if (sourcePath.startsWith('Areas/')) return 'Areas';
  return 'General';
}

function hashItemSources(item) {
  const sourceFingerprint = (item.notes || [])
    .map((note) => [
      note.path,
      note.modified,
      note.frontmatter?.title || '',
      note.frontmatter?.plaud_id || '',
      note.excerpt || ''
    ].join('|'))
    .join('\n');
  return crypto.createHash('sha1').update(sourceFingerprint).digest('hex');
}

function summarizeClassification(classification) {
  if (!classification) return '';
  return [
    classification.type ? `type=${classification.type}` : '',
    classification.destination ? `destination=${classification.destination}` : '',
    classification.reason ? `reason=${classification.reason}` : ''
  ].filter(Boolean).join('; ');
}

async function resolveSuggestedLinks(terms, excludePaths = []) {
  const links = [];
  const excluded = new Set((excludePaths || []).map((value) => String(value || '').toLowerCase()));

  for (const term of uniqueStrings(terms, 8)) {
    try {
      const results = await retrieval.search(term, { maxResults: 3 });
      const match = results.find((result) => {
        const rel = String(result.path || '');
        if (!rel || excluded.has(rel.toLowerCase())) return false;
        if (rel.startsWith('Archive/')) return false;
        return true;
      });
      if (!match) continue;
      links.push({
        term,
        path: match.path,
        label: match.name || fileNameFromPath(match.path),
        score: match.score || 0
      });
    } catch {}
  }

  const seen = new Set();
  return links.filter((link) => {
    const key = `${String(link.path).toLowerCase()}|${String(link.term).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function buildAiInsight(item, targetPath, existingContent = '') {
  if (aiRouting.getAIMode() === 'off') return null;

  const sourceHash = hashItemSources(item);
  const existingFrontmatter = obsidian.parseFrontmatter(existingContent || '');
  const existingInsight = extractMarkdownSection(existingContent, 'SARA Insight');
  if (existingFrontmatter.sara_ai_source_hash === sourceHash && existingInsight) {
    return {
      skipped: true,
      sourceHash,
      provider: existingFrontmatter.sara_ai_provider || 'cached'
    };
  }

  const note = item.summary || item.note;
  const transcriptInsight = item.transcriptInsight || null;
  const prompt = [
    'You are SARA, curating an Obsidian second brain for operational leadership work.',
    'Be concise. Return ONLY a JSON object with this shape:',
    '{',
    '  "summary": "1-2 sentence synthesis of the note",',
    '  "durableInsights": ["insight"],',
    '  "openLoops": ["risk, pending decision, or follow-up"],',
    '  "promotionCandidates": ["durable knowledge worth promoting"],',
    '  "suggestedLinks": ["project, person, area, or concept to link"],',
    '  "filingNote": "one short sentence on how this should live in the vault"',
    '}',
    'Rules:',
    '- Be conservative. Do not invent facts.',
    '- Keep each array to 0-2 items max.',
    '- If the note is sparse, link-heavy, or unclear, return short summary plus empty arrays.',
    '- suggestedLinks should be short names or concepts, not file paths.',
    '',
    `Target path: ${targetPath}`,
    `Item type: ${item.type}`,
    `Source title: ${baseTitleForItem(item)}`,
    summarizeClassification(item.classification) ? `Classification: ${summarizeClassification(item.classification)}` : '',
    transcriptInsight?.summary ? `Transcript insight summary: ${transcriptInsight.summary}` : '',
    transcriptInsight?.keyTopics?.length ? `Transcript key topics: ${transcriptInsight.keyTopics.join('; ')}` : '',
    transcriptInsight?.actionItems?.length ? `Transcript actions: ${transcriptInsight.actionItems.join('; ')}` : '',
    'Source excerpts:',
    ...(item.notes || []).map((source, index) => `Source ${index + 1} (${source.path}): ${source.excerpt}`),
    '',
    'Primary note content:',
    stripFrontmatter(note.content || '').slice(0, 3500)
  ].filter(Boolean).join('\n');

  try {
    const result = await aiRouting.runTask('knowledge_consolidation', {
      prompt,
      contextWindow: 1536,
      maxTokens: 220,
      temperature: 0.2
    }, { confidence: 0.4, timeout: 45000 });

    const parsed = parseJsonObject(result.text || '');
    if (!parsed) return null;

    const suggestedLinks = await resolveSuggestedLinks(
      parsed.suggestedLinks || [],
      item.notes.map((source) => source.path).concat([targetPath])
    );

    return {
      provider: result.provider || 'unknown',
      generatedAt: isoNow(),
      sourceHash,
      summary: String(parsed.summary || '').trim(),
      filingNote: String(parsed.filingNote || '').trim(),
      durableInsights: uniqueStrings(parsed.durableInsights || [], 6),
      openLoops: uniqueStrings(parsed.openLoops || [], 6),
      promotionCandidates: uniqueStrings(parsed.promotionCandidates || [], 6),
      suggestedLinks
    };
  } catch {
    return null;
  }
}

function sourceHashForContent(relPath, content) {
  return crypto.createHash('sha1')
    .update(`${relPath}\n${stripFrontmatter(content)}`)
    .digest('hex');
}

async function buildAiInsightForExistingNote(note) {
  if (aiRouting.getAIMode() === 'off') return null;

  const sourceHash = sourceHashForContent(note.path, note.content || '');
  const existingInsight = extractMarkdownSection(note.content || '', 'SARA Insight');
  if (note.frontmatter.sara_ai_source_hash === sourceHash && existingInsight) {
    return {
      skipped: true,
      sourceHash,
      provider: note.frontmatter.sara_ai_provider || 'cached'
    };
  }

  const prompt = [
    'You are SARA, curating a trusted Obsidian second brain.',
    'Be concise. Return ONLY a JSON object with this shape:',
    '{',
    '  "summary": "1-2 sentence synthesis",',
    '  "durableInsights": ["insight"],',
    '  "openLoops": ["follow-up, risk, or unresolved question"],',
    '  "promotionCandidates": ["durable knowledge worth promoting"],',
    '  "suggestedLinks": ["project, person, area, or concept to link"],',
    '  "filingNote": "one short sentence describing how this note should live in the vault"',
    '}',
    'Rules:',
    '- Be conservative and concrete.',
    '- Do not invent facts.',
    '- Prefer operationally useful insights over generic summaries.',
    '- Keep each array to 0-2 items max.',
    '- If the note is sparse, link-heavy, or unclear, return short summary plus empty arrays.',
    '',
    `Path: ${note.path}`,
    `Name: ${note.name}`,
    `Folder: ${note.folder}`,
    '',
    stripFrontmatter(note.content || '').slice(0, 3500)
  ].join('\n');

  try {
    const result = await aiRouting.runTask('knowledge_consolidation', {
      prompt,
      contextWindow: 1536,
      maxTokens: 220,
      temperature: 0.2
    }, { confidence: 0.4, timeout: 45000 });

    const parsed = parseJsonObject(result.text || '');
    if (!parsed) return null;

    return {
      provider: result.provider || 'unknown',
      generatedAt: isoNow(),
      sourceHash,
      summary: String(parsed.summary || '').trim(),
      filingNote: String(parsed.filingNote || '').trim(),
      durableInsights: uniqueStrings(parsed.durableInsights || [], 6),
      openLoops: uniqueStrings(parsed.openLoops || [], 6),
      promotionCandidates: uniqueStrings(parsed.promotionCandidates || [], 6),
      suggestedLinks: await resolveSuggestedLinks(parsed.suggestedLinks || [], [note.path])
    };
  } catch {
    return null;
  }
}

function renderAiInsightSections(aiInsight) {
  if (!aiInsight || aiInsight.skipped) return '';
  const lines = [];
  lines.push('## SARA Insight');
  lines.push('');
  lines.push(aiInsight.summary || 'SARA reviewed this note and found no stronger synthesis worth writing yet.');
  lines.push('');

  if (aiInsight.durableInsights?.length) {
    lines.push('## Durable Insights');
    lines.push('');
    for (const itemText of aiInsight.durableInsights) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.openLoops?.length) {
    lines.push('## Open Loops');
    lines.push('');
    for (const itemText of aiInsight.openLoops) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.promotionCandidates?.length) {
    lines.push('## Promote Next');
    lines.push('');
    for (const itemText of aiInsight.promotionCandidates) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.suggestedLinks?.length) {
    lines.push('## Suggested Links');
    lines.push('');
    for (const link of aiInsight.suggestedLinks) {
      lines.push(`- ${markdownLinkForPath(link.path, link.label)}${link.term ? ` — surfaced from "${link.term}"` : ''}`);
    }
    lines.push('');
  }

  if (aiInsight.filingNote) {
    lines.push('## Filing Note');
    lines.push('');
    lines.push(aiInsight.filingNote);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function stripExistingAiSections(content) {
  let next = String(content || '');
  for (const heading of ['SARA Insight', 'Durable Insights', 'Open Loops', 'Promote Next', 'Suggested Links', 'Filing Note']) {
    next = removeMarkdownSection(next, heading);
  }
  return next.trimEnd();
}

function insertAiSections(content, aiInsight) {
  const cleaned = stripExistingAiSections(content);
  const aiBlock = renderAiInsightSections(aiInsight);
  if (!aiBlock) return cleaned;

  const marker = '\n## Manual Notes';
  const idx = cleaned.indexOf(marker);
  if (idx !== -1) {
    return `${cleaned.slice(0, idx).trimEnd()}\n\n${aiBlock}\n${cleaned.slice(idx + 1)}`.trimEnd() + '\n';
  }
  return `${cleaned.trimEnd()}\n\n${aiBlock}`.trimEnd() + '\n';
}

function operatingModelMarkdown() {
  return `# Vault Operating Model

_Managed by SARA / NUERO._

## Core Principle

Raw capture is not the same thing as durable knowledge.

SARA uses a two-stage flow:

1. Raw intake lands in staging locations such as \`Plaud/Summaries\`, \`Meetings/transcripts\`, and \`Imports/\`.
2. Consolidated notes are written into the working vault in the folder that best matches the note's real purpose.

## Folder Roles

- \`Plaud/Summaries\` and \`Meetings/transcripts\`: Plaud sync intake and transcripts.
- \`Imports/\`: raw external intake waiting for review, routing, or consolidation.
- \`Meetings/\`: working meeting notes, including consolidated Plaud meeting notes.
- \`Projects/\`, \`Areas/\`, \`People/\`, \`Ideas/\`, \`Reflections/\`: final working locations for consolidated notes.
- \`Knowledge/\`: distilled durable knowledge that SARA should reuse as trusted context.
- \`Documents/System/\`: system notes describing how the vault is operated.

## What SARA Writes

- Consolidated notes from imports into relevant working folders.
- Linking metadata back to raw source notes.
- AI insight sections showing what SARA inferred, what to link, and what may be worth promoting.
- Knowledge reflections in \`Reflections/Knowledge/\`.
- Daily import activity reports in \`${REPORT_DIR}/\`.

## Consolidation Rules

- Raw source notes remain the system of record for imports unless you intentionally archive or delete them.
- Consolidated notes are the working notes you should read and use.
- Each consolidated note links back to the raw source material.
- Where possible, SARA links people, projects, and source notes automatically.

## Reading Order

When a new import arrives:

1. Check the daily import activity report.
2. Open the consolidated note in its working folder.
3. Use the raw source note only when you need the original detail.

## Trusted Knowledge

When a consolidated note contains something durable, promote it into \`Knowledge/\` so SARA can reuse it as trusted context rather than re-deriving it from raw imports.
`;
}

function ensureVaultOperatingModelDoc() {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const fullPath = path.join(vault, VAULT_MODEL_DOC);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, operatingModelMarkdown(), 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'vault-operating-model'); } catch {}
  return { status: 'ok', path: VAULT_MODEL_DOC };
}

function buildPromotedBody({ source, title, domain }) {
  const sourceFm = source.frontmatter || {};
  const sourceLinks = parseCsvField(sourceFm.knowledge_sources);
  if (!sourceLinks.includes(source.path)) sourceLinks.unshift(source.path);

  const frontmatter = renderFrontmatter({
    type: 'knowledge',
    knowledge_state: 'distilled',
    knowledge_domain: domain,
    source: 'nuero',
    source_notes: sourceLinks,
    promoted_from: source.path,
    promoted_at: isoNow()
  });

  const summaryType = sourceFm.summary_type ? `Summary type: ${sourceFm.summary_type}\n` : '';
  return `${frontmatter}

# ${title}

## Signal

${source.excerpt || 'Promoted from raw memory for curation.'}

## Why This Matters

- Add the durable point SARA should remember.
- Capture the decision, pattern, or principle here.

## Actions / Decisions

- 

## Source Trace

- Origin: [[${source.path.replace(/\.md$/, '')}|${source.name}]]
${summaryType ? `- ${summaryType.trim()}\n` : ''}`;
}

function updateSourceFrontmatter(source, fields) {
  let content = source.content;
  for (const [key, value] of Object.entries(fields)) {
    content = upsertFrontmatterValue(content, key, value);
  }
  const fullPath = path.join(VAULT_PATH(), source.path);
  fs.writeFileSync(fullPath, content, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'knowledge-promotion'); } catch {}
}

function promoteCandidate({ sourcePath, domain, title }) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  if (!sourcePath) return { status: 'error', error: 'sourcePath required' };

  const sourceFull = path.join(vault, sourcePath);
  if (!fs.existsSync(sourceFull)) return { status: 'error', error: `Source note not found: ${sourcePath}` };

  const source = readNoteMeta(sourceFull);
  const finalDomain = sanitizeSegment(domain || inferDomainFromSource(source.path));
  const finalTitle = sanitizeSegment(title || source.name);
  const folder = path.join(vault, 'Knowledge', finalDomain);
  fs.mkdirSync(folder, { recursive: true });

  let fileBase = `${isoDate()} ${finalTitle}`;
  let filename = `${fileBase}.md`;
  let targetFull = path.join(folder, filename);
  let counter = 2;
  while (fs.existsSync(targetFull)) {
    filename = `${fileBase} ${counter}.md`;
    targetFull = path.join(folder, filename);
    counter += 1;
  }

  const content = buildPromotedBody({ source, title: finalTitle, domain: finalDomain });
  fs.writeFileSync(targetFull, content, 'utf-8');

  try { vaultHooks.onVaultWrite(targetFull, 'knowledge-promotion'); } catch {}
  updateSourceFrontmatter(source, {
    knowledge_promoted_to: toRel(targetFull),
    sara_consolidated_to: toRel(targetFull)
  });

  return {
    status: 'ok',
    sourcePath,
    promotedPath: toRel(targetFull),
    domain: finalDomain,
    title: finalTitle
  };
}

function generateReflection({ topic, write = false } = {}) {
  const overview = {
    weekly: weeklySummary.summarizeWeek({}),
    gaps: knowledgeGaps.findKnowledgeGaps({ topic, daysBack: 90 }),
    candidates: getPromotionCandidates({ topic, limit: 5, daysBack: 21 }),
    trusted: loadTrustedNotes().slice(0, 5)
  };

  const lines = [];
  lines.push(`# Knowledge Reflection — ${isoDate()}`);
  lines.push('');
  lines.push(`_Generated by NUERO on ${isoNow()}._`);
  lines.push('');

  if (overview.weekly.status === 'ok') {
    lines.push('## Weekly Signal');
    lines.push(`- Meetings: ${overview.weekly.counts.meetings}`);
    lines.push(`- Plan updates: ${overview.weekly.counts.planProgress}`);
    lines.push(`- Open actions in window: ${overview.weekly.counts.actionsOutstanding}`);
    lines.push('');
  }

  lines.push('## Promote Next');
  if (overview.candidates.length === 0) {
    lines.push('- No obvious promotion candidates right now.');
  } else {
    for (const candidate of overview.candidates) {
      lines.push(`- [[${candidate.path.replace(/\.md$/, '')}|${candidate.name}]] — ${candidate.excerpt}`);
    }
  }
  lines.push('');

  lines.push('## Trusted Context To Revisit');
  if (overview.trusted.length === 0) {
    lines.push('- No trusted knowledge notes yet.');
  } else {
    for (const note of overview.trusted) {
      lines.push(`- [[${note.path.replace(/\.md$/, '')}|${note.name}]] — ${note.excerpt}`);
    }
  }
  lines.push('');

  lines.push('## Knowledge Gaps');
  if (overview.gaps.status !== 'ok' || !(overview.gaps.suggestions || []).length) {
    lines.push('- No obvious gaps surfaced.');
  } else {
    for (const gap of overview.gaps.suggestions.slice(0, 5)) {
      lines.push(`- ${gap.topic} (${gap.count} mentions)`);
    }
  }

  const markdown = lines.join('\n');

  if (!write) {
    return { status: 'ok', markdown };
  }

  const vault = VAULT_PATH();
  const folder = path.join(vault, REFLECTION_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const filename = `${isoDate()} - Knowledge Reflection.md`;
  const fullPath = path.join(folder, filename);
  fs.writeFileSync(fullPath, markdown, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'knowledge-reflection'); } catch {}

  return { status: 'ok', markdown, path: toRel(fullPath) };
}

function getTranscriptInsight(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const transcriptProcessor = require('./transcript-processor');
    return transcriptProcessor.getLastResult(path.basename(transcriptPath));
  } catch {
    return null;
  }
}

// ⚠ This grouping is why Plaud consolidation runs on 2 recordings out of 222.
//
// It pairs a recording's summary with its transcript by `plaud_id`, and only
// considers notes under `Plaud/`. That was true when both halves lived there.
// Summaries are now ROUTED OUT to `Meetings/YYYY/MM/` — 222 notes there carry a
// `plaud_id` — so nearly every group ends up transcript-only and is dropped by
// the `some(note_type === 'summary')` filter below. Silent: a pipeline that
// processes 2 items looks identical to one with nothing to do.
//
// Widening it to key on `plaud_id` wherever the note lives is a DECISION, not a
// bug fix: the consolidated note lands in `Meetings/YYYY/MM/` — the same folder
// as the summary it was built from — so switching this on writes ~222 notes,
// each one sitting beside the note it consolidates, at 30 an hour. Hence a flag,
// default OFF, so the measurement and a sample can be taken without the
// scheduler acting on it.
const CONSOLIDATE_ALL_PLAUD = String(process.env.PLAUD_CONSOLIDATE_ALL || '').toLowerCase() === 'true';

function groupPlaudNotes(rawNotes, { includeRouted = CONSOLIDATE_ALL_PLAUD } = {}) {
  const groups = new Map();
  const inScope = (item) =>
    item.path.startsWith('Plaud/') || (includeRouted && Boolean(item.frontmatter.plaud_id));

  for (const note of rawNotes.filter(inScope)) {
    const plaudId = normalizePlaudId(note.frontmatter.plaud_id) || note.path;
    if (!groups.has(plaudId)) {
      groups.set(plaudId, {
        id: plaudId,
        type: 'plaud',
        notes: [],
        title: note.frontmatter.title || note.name
      });
    }
    groups.get(plaudId).notes.push(note);
  }
  return [...groups.values()].map((group) => {
    group.notes.sort((a, b) => a.path.localeCompare(b.path));
    // ⚠ `parseFrontmatter` does NOT strip surrounding quotes, and plaud-sync
    // writes `note_type: "summary"` quoted — so a bare `=== 'summary'` compares
    // against the string `"summary"` INCLUDING the quotes and is false for every
    // note the sync has ever written. `normalizePlaudId` in this same file already
    // strips them, which is why grouping by id worked while the summary/transcript
    // split silently did not. Same helper, applied to the same problem.
    group.summary = group.notes.find((note) => cleanQuoted(note.frontmatter.note_type) === 'summary') || group.notes[0];
    group.transcript = group.notes.find((note) => cleanQuoted(note.frontmatter.note_type) === 'transcript') || null;
    group.transcriptInsight = group.transcript ? getTranscriptInsight(group.transcript.path) : null;
    return group;
  }).filter((group) => group.notes.some((note) => cleanQuoted(note.frontmatter.note_type) === 'summary'));
}

async function resolveImportClassification(note) {
  const existing = db.getImportClassification(note.path);
  if (existing?.destination) return existing;

  const fullPath = path.join(VAULT_PATH(), note.path);
  if (!fs.existsSync(fullPath)) return null;

  try {
    return await importsService.classifyFile(fullPath);
  } catch {
    return null;
  }
}

async function collectImportItems() {
  return collectImportItemsWithOptions({});
}

async function collectImportItemsWithOptions({ includeConsolidatedPlaud = false } = {}) {
  const rawNotes = loadRawNotes();
  const items = [];

  for (const group of groupPlaudNotes(rawNotes)) {
    if (!includeConsolidatedPlaud && group.notes.every((note) => note.consolidatedTo)) continue;
    items.push(group);
  }

  for (const note of rawNotes.filter((item) => item.path.startsWith('Imports/'))) {
    if (note.consolidatedTo) continue;
    if (String(note.frontmatter.status || '').toLowerCase() === 'processed') continue;
    const classification = await resolveImportClassification(note);
    items.push({
      id: note.path,
      type: 'import',
      note,
      notes: [note],
      classification
    });
  }

  return items;
}

function destinationRootForItem(item) {
  if (item.type === 'plaud') return 'Meetings/';
  const destination = normalizePath(item.classification?.destination || '');
  return destination ? `${destination.replace(/\/?$/, '/')}` : 'Conflicts/';
}

function buildConsolidatedFolder(item) {
  const note = item.summary || item.note;
  const { year, month } = noteDateParts(note);
  const root = destinationRootForItem(item);
  const sourceChannel = item.type === 'plaud' ? 'Plaud' : 'Imports';

  if (item.type === 'plaud') return `Meetings/${year}/${month}`;

  if (root.startsWith('Meetings/')) return `Meetings/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Calls/')) return `Calls/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('People/')) return `People/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Projects/')) return `Projects/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Areas/')) return `Areas/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Ideas/')) return `Ideas/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Decision Log/')) return `Decision Log/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Reflections/')) return `Reflections/Imported/${sourceChannel}/${year}/${month}`;
  return `Conflicts/Imported/${sourceChannel}/${year}/${month}`;
}

function baseTitleForItem(item) {
  const note = item.summary || item.note;
  const title = item.type === 'plaud'
    ? item.transcript?.frontmatter.title
      || item.title
      || item.summary?.name
      || note.name
    : note.frontmatter.title || note.name;
  return sanitizeSegment(title, 'Imported Note');
}

function consolidatedFrontmatter(item, targetPath, aiInsight = null, sourceHash = '') {
  const note = item.summary || item.note;
  const sourceNotes = item.notes.map((source) => source.path);
  const frontmatter = {
    type: item.type === 'plaud' ? 'meeting' : 'import-consolidated',
    source: 'sara-import-consolidation',
    managed_by: 'sara-knowledge-memory',
    knowledge_state: 'distilled',
    knowledge_domain: inferDomainFromSource(targetPath),
    consolidated_at: isoNow(),
    source_notes: sourceNotes,
    import_origin: item.type === 'plaud' ? 'plaud' : 'imports',
    import_destination_root: destinationRootForItem(item)
  };

  if (item.type === 'plaud' && item.summary?.frontmatter.plaud_id) {
    frontmatter.plaud_id = normalizePlaudId(item.summary.frontmatter.plaud_id);
  }
  if (sourceHash) frontmatter.sara_ai_source_hash = sourceHash;
  if (aiInsight?.provider) frontmatter.sara_ai_provider = aiInsight.provider;
  if (aiInsight?.generatedAt) frontmatter.sara_ai_enriched_at = aiInsight.generatedAt;
  return renderFrontmatter(frontmatter);
}

function peopleLinksFromInsight(insight) {
  if (!insight?.people?.length) return [];
  return insight.people
    .map((person) => person.vaultMatch || person.mentioned)
    .filter(Boolean)
    .map((name) => `[[People/${sanitizeSegment(name)}|${name}]]`);
}

async function buildConsolidatedBody(item, targetPath, aiInsight = null) {
  const note = item.summary || item.note;
  const insight = item.transcriptInsight || null;
  const existingPath = path.join(VAULT_PATH(), targetPath);
  const existingContent = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf-8') : '';
  const preservedManualNotes = extractMarkdownSection(existingContent, 'Manual Notes');
  const structuredSummary = item.type === 'plaud'
    ? extractPlaudMeetingMarkdown(item.summary, baseTitleForItem(item))
    : '';
  const sourceHash = aiInsight?.sourceHash || hashItemSources(item);
  const body = [];
  body.push(consolidatedFrontmatter(item, targetPath, aiInsight, sourceHash));
  body.push('');
  body.push(`# ${baseTitleForItem(item)}`);
  body.push('');
  if (structuredSummary) {
    body.push('## Meeting Brief');
    body.push('');
    body.push(structuredSummary);
    body.push('');
  } else {
    body.push('## Working Summary');
    body.push('');
    body.push(insight?.summary || note.excerpt || 'Imported note awaiting manual refinement.');
    body.push('');
  }

  if (insight?.keyTopics?.length && !hasMarkdownHeading(structuredSummary, 'Key Topics')) {
    body.push('## Key Topics');
    body.push('');
    for (const topic of insight.keyTopics) body.push(`- ${topic}`);
    body.push('');
  }

  if (insight?.actionItems?.length && !hasMarkdownHeading(structuredSummary, 'Action Items')) {
    body.push('## Action Items');
    body.push('');
    for (const action of insight.actionItems) body.push(`- [ ] ${action}`);
    body.push('');
  }

  const peopleLinks = peopleLinksFromInsight(insight);
  if (peopleLinks.length && !hasMarkdownHeading(structuredSummary, 'Attendees') && !hasMarkdownHeading(structuredSummary, 'People')) {
    body.push('## People');
    body.push('');
    for (const person of peopleLinks) body.push(`- ${person}`);
    body.push('');
  }

  if (item.classification?.reason) {
    body.push('## Routing Reason');
    body.push('');
    body.push(item.classification.reason);
    body.push('');
  }

  if (aiInsight && !aiInsight.skipped) {
    body.push('## SARA Insight');
    body.push('');
    body.push(aiInsight.summary || 'SARA reviewed the import and found no stronger synthesis worth writing yet.');
    body.push('');

    if (aiInsight.durableInsights?.length) {
      body.push('## Durable Insights');
      body.push('');
      for (const itemText of aiInsight.durableInsights) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.openLoops?.length) {
      body.push('## Open Loops');
      body.push('');
      for (const itemText of aiInsight.openLoops) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.promotionCandidates?.length) {
      body.push('## Promote Next');
      body.push('');
      for (const itemText of aiInsight.promotionCandidates) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.suggestedLinks?.length) {
      body.push('## Suggested Links');
      body.push('');
      for (const link of aiInsight.suggestedLinks) {
        body.push(`- ${markdownLinkForPath(link.path, link.label)}${link.term ? ` — surfaced from "${link.term}"` : ''}`);
      }
      body.push('');
    }

    if (aiInsight.filingNote) {
      body.push('## Filing Note');
      body.push('');
      body.push(aiInsight.filingNote);
      body.push('');
    }
  }

  body.push('## Source Material');
  body.push('');
  for (const source of item.notes) {
    body.push(`- [[${source.path.replace(/\.md$/, '')}|${source.name}]]`);
  }
  body.push('');
  body.push('## Source Snapshot');
  body.push('');
  body.push(note.excerpt);
  body.push('');
  body.push('## Manual Notes');
  body.push('');
  body.push(preservedManualNotes || '_Add your own interpretation, decisions, and follow-up here. SARA will preserve this section on refresh._');

  return obsidian.autoLink(`${body.join('\n').trimEnd()}\n`);
}

function existingConsolidatedTarget(item) {
  const targetPath = item.notes.find((note) => note.consolidatedTo)?.consolidatedTo || null;
  if (!targetPath || item.type !== 'plaud') return targetPath;

  const fullPath = path.join(VAULT_PATH(), targetPath);
  if (!fs.existsSync(fullPath)) return null;

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const frontmatter = obsidian.parseFrontmatter(content);
    const targetPlaudId = normalizePlaudId(frontmatter.plaud_id);
    const currentPlaudId = normalizePlaudId(item.summary?.frontmatter.plaud_id || item.id);
    return targetPlaudId && targetPlaudId === currentPlaudId ? targetPath : null;
  } catch {
    return null;
  }
}

function makeConsolidatedFilename(item) {
  const note = item.summary || item.note;
  const { iso } = noteDateParts(note);
  return `${iso} - ${baseTitleForItem(item)}.md`;
}

function logConsolidationActivity({ dateKey, item, targetPath, mode }) {
  db.logActivity('import_consolidated', {
    targetPath,
    mode,
    kind: item.type,
    sourcePaths: item.notes.map((note) => note.path),
    destinationRoot: destinationRootForItem(item)
  }, dateKey);
}

function upsertSourceConsolidation(item, targetPath) {
  for (const source of item.notes) {
    updateSourceFrontmatter(source, {
      sara_consolidated_to: targetPath,
      knowledge_promoted_to: targetPath,
      import_status: 'consolidated'
    });
  }
}

async function writeConsolidatedNote(item) {
  const vault = VAULT_PATH();
  const existing = existingConsolidatedTarget(item);
  let targetPath = existing || `${buildConsolidatedFolder(item)}/${makeConsolidatedFilename(item)}`;
  let fullPath = path.join(vault, targetPath);

  if (!existing) {
    const parsed = path.parse(fullPath);
    let counter = 2;
    while (fs.existsSync(fullPath)) {
      try {
        const current = obsidian.parseFrontmatter(fs.readFileSync(fullPath, 'utf-8'));
        const currentPlaudId = normalizePlaudId(current.plaud_id);
        const wantedPlaudId = normalizePlaudId(item.summary?.frontmatter.plaud_id || item.id);
        if (!wantedPlaudId || currentPlaudId === wantedPlaudId) break;
      } catch {}

      targetPath = `${toRel(parsed.dir)}/${parsed.name} ${counter}${parsed.ext}`;
      fullPath = path.join(vault, targetPath);
      counter += 1;
    }
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const existingContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
  const aiInsight = await buildAiInsight(item, targetPath, existingContent);
  const content = await buildConsolidatedBody(item, targetPath, aiInsight);
  const mode = fs.existsSync(fullPath) ? 'updated' : 'created';
  fs.writeFileSync(fullPath, content, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'import-consolidation'); } catch {}
  try { require('./vault-logger').logCreate(targetPath, `import-consolidation:${item.type}`); } catch {}
  upsertSourceConsolidation(item, targetPath);
  logConsolidationActivity({ dateKey: isoDate(), item, targetPath, mode });
  if (aiInsight && !aiInsight.skipped) {
    db.logActivity('import_ai_enriched', {
      targetPath,
      kind: item.type,
      provider: aiInsight.provider || 'unknown',
      sourcePaths: item.notes.map((note) => note.path)
    }, isoDate());
  }
  return {
    targetPath,
    mode,
    ai: aiInsight
      ? {
          enriched: !aiInsight.skipped,
          cached: !!aiInsight.skipped,
          provider: aiInsight.provider || 'unknown'
        }
      : {
          enriched: false,
          cached: false,
          provider: 'none'
        }
  };
}

function buildDailyImportReport(dateKey = isoDate()) {
  const events = db.getActivityForDate(dateKey);
  const consolidations = events
    .filter((event) => event.event_type === 'import_consolidated')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const sweeps = events
    .filter((event) => event.event_type === 'imports_sweep')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const enrichments = events
    .filter((event) => event.event_type === 'import_ai_enriched')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const fileEnrichments = getAiEnrichmentNotesForDate(dateKey);
  const mergedEnrichments = enrichments.length > 0
    ? enrichments
    : fileEnrichments.map((item) => ({
        targetPath: item.path,
        provider: item.provider
      }));

  const lines = [];
  lines.push(`# SARA Import Activity — ${dateKey}`);
  lines.push('');
  lines.push(`_Generated ${isoNow()}._`);
  lines.push('');

  const routed = sweeps.reduce((sum, sweep) => sum + (sweep.routed || 0), 0);
  const flagged = sweeps.reduce((sum, sweep) => sum + (sweep.flagged || 0), 0);
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Consolidated notes: ${consolidations.length}`);
  lines.push(`- AI enrichments: ${mergedEnrichments.length}`);
  lines.push(`- Import routes: ${routed}`);
  lines.push(`- Needs review: ${flagged}`);
  lines.push('');

  lines.push('## AI Enrichment');
  lines.push('');
  if (mergedEnrichments.length === 0) {
    lines.push('- No AI enrichment recorded today.');
  } else {
    for (const item of mergedEnrichments) {
      lines.push(`- Enriched [[${String(item.targetPath || '').replace(/\.md$/, '')}]] via ${item.provider || 'unknown'}`);
    }
  }
  lines.push('');

  lines.push('## Consolidated Notes');
  lines.push('');
  if (consolidations.length === 0) {
    lines.push('- No consolidated notes recorded today.');
  } else {
    for (const item of consolidations) {
      const sources = (item.sourcePaths || []).map((source) => `\`${source}\``).join(', ');
      lines.push(`- ${item.mode === 'updated' ? 'Updated' : 'Created'} [[${String(item.targetPath || '').replace(/\.md$/, '')}]] from ${sources}`);
    }
  }
  lines.push('');

  lines.push('## Review Queue');
  lines.push('');
  if (flagged === 0) {
    lines.push('- No imports flagged for review today.');
  } else {
    lines.push(`- ${flagged} import(s) still need review in \`Imports/\`.`);
  }

  return lines.join('\n');
}

function writeDailyImportReport(dateKey = isoDate()) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const folder = path.join(vault, REPORT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const targetPath = `${REPORT_DIR}/${dateKey}.md`;
  const fullPath = path.join(vault, targetPath);
  fs.writeFileSync(fullPath, `${buildDailyImportReport(dateKey)}\n\n_Part of [[Logs]]_\n`, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'import-daily-report'); } catch {}
  return { status: 'ok', path: targetPath, markdown: buildDailyImportReport(dateKey) };
}

async function consolidateAllImports({ limit = 25, includeConsolidatedPlaud = false } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  ensureVaultOperatingModelDoc();
  const items = await collectImportItemsWithOptions({ includeConsolidatedPlaud });
  const processed = [];

  for (const item of items.slice(0, limit)) {
    if (item.type === 'import' && item.classification?.type === 'needs-review') continue;
    const result = await writeConsolidatedNote(item);
    processed.push({
      kind: item.type,
      targetPath: result.targetPath,
      mode: result.mode,
      sourcePaths: item.notes.map((note) => note.path),
      ai: result.ai
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.length,
    processed,
    reportPath: report.path || null
  };
}

async function reconcilePlaudRecording({ plaudId } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const normalizedPlaudId = normalizePlaudId(plaudId);
  if (!normalizedPlaudId) {
    return { status: 'error', error: 'plaudId required' };
  }

  const item = groupPlaudNotes(loadRawNotes()).find((group) => group.id === normalizedPlaudId);
  if (!item) {
    return { status: 'error', error: `Plaud recording not found in vault: ${normalizedPlaudId}` };
  }

  const result = await writeConsolidatedNote(item);
  return {
    status: 'ok',
    plaudId: normalizedPlaudId,
    targetPath: result.targetPath,
    mode: result.mode,
    sourcePaths: item.notes.map((note) => note.path)
  };
}

async function refreshAllPlaudConsolidations({ limit = 500 } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  ensureVaultOperatingModelDoc();
  const items = await collectImportItemsWithOptions({ includeConsolidatedPlaud: true });
  const plaudItems = items.filter((item) => item.type === 'plaud').slice(0, limit);
  const processed = [];

  for (const item of plaudItems) {
    const result = await writeConsolidatedNote(item);
    processed.push({
      plaudId: item.id,
      targetPath: result.targetPath,
      mode: result.mode,
      sourcePaths: item.notes.map((note) => note.path),
      ai: result.ai
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.length,
    processed,
    reportPath: report.path || null
  };
}

async function enrichManagedNotes({ limit = 25 } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const allNotes = [];
  for (const fullPath of walkMarkdown(vault)) {
    try {
      allNotes.push(readNoteMeta(fullPath));
    } catch {}
  }
  const candidates = allNotes
    .filter((note) => cleanQuoted(note.frontmatter.managed_by).toLowerCase() === 'sara-knowledge-memory'
      || cleanQuoted(note.frontmatter.source).toLowerCase() === 'sara-import-consolidation')
    .filter((note) => !note.path.startsWith('Archive/'))
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
    .slice(0, limit);

  const processed = [];
  for (const note of candidates) {
    const aiInsight = await buildAiInsightForExistingNote(note);
    if (!aiInsight || aiInsight.skipped) {
      processed.push({
        path: note.path,
        ai: {
          enriched: false,
          cached: !!aiInsight?.skipped,
          provider: aiInsight?.provider || 'none'
        }
      });
      continue;
    }

    let content = note.content;
    content = upsertFrontmatterValue(content, 'sara_ai_source_hash', aiInsight.sourceHash);
    content = upsertFrontmatterValue(content, 'sara_ai_provider', aiInsight.provider || 'unknown');
    content = upsertFrontmatterValue(content, 'sara_ai_enriched_at', aiInsight.generatedAt || isoNow());
    content = insertAiSections(content, aiInsight);

    const fullPath = path.join(vault, note.path);
    fs.writeFileSync(fullPath, content, 'utf-8');
    try { vaultHooks.onVaultWrite(fullPath, 'knowledge-ai-enrichment'); } catch {}
    db.logActivity('import_ai_enriched', {
      targetPath: note.path,
      kind: 'managed-note',
      provider: aiInsight.provider || 'unknown',
      sourcePaths: [note.path]
    }, isoDate());

    processed.push({
      path: note.path,
      ai: {
        enriched: true,
        cached: false,
        provider: aiInsight.provider || 'unknown'
      }
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.filter((item) => item.ai.enriched).length,
    processed,
    reportPath: report.path || null
  };
}

module.exports = {
  RAW_FOLDERS,
  TRUSTED_ROOTS,
  getOverview,
  getPromotionCandidates,
  getActiveContext,
  promoteCandidate,
  generateReflection,
  consolidateAllImports,
  reconcilePlaudRecording,
  refreshAllPlaudConsolidations,
  enrichManagedNotes,
  buildDailyImportReport,
  writeDailyImportReport,
  ensureVaultOperatingModelDoc
};
