'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const AUTO_PROMOTE_CONFIDENCE = 0.93;
const ACTION_TYPES = new Set([
  'action',
  'actions',
  'todo',
  'todos',
  'next',
  'next step',
  'next steps',
  'follow up',
  'follow-up',
  'open loops',
  'outstanding',
  'to do',
  // PLAUD writes its action list under this heading. Without it, meeting notes
  // contributed nothing but loose checkboxes.
  'next arrangements',
  'arrangements',
]);
const ACTION_VERBS = [
  'send',
  'reply',
  'call',
  'email',
  'draft',
  'review',
  'check',
  'update',
  'book',
  'schedule',
  'chase',
  'follow up',
  'follow-up',
  'share',
  'prepare',
  'finish',
  'complete',
  'raise',
  'create',
  'fix',
  'speak',
  'message',
  'write',
  'confirm',
  // Imperatives PLAUD actually produces in ## Next Arrangements. Without these
  // the unowned-action filter rejected most genuine items as non-actions.
  'reclassify', 'prioritize', 'prioritise', 'ensure', 'compile', 'obtain',
  'initiate', 'align', 'monitor', 'press', 'remind', 'continue', 'meet',
  'assess', 'implement', 'define', 'document', 'agree', 'investigate',
  'produce', 'resolve', 'report', 'set', 'add', 'plan', 'evaluate', 'secure',
  'arrange', 'coordinate', 'escalate', 'publish', 'circulate', 'contact',
  'engage', 'clarify', 'progress', 'establish', 'introduce', 'revise',
  'validate', 'audit', 'close', 'pursue', 'deliver', 'present', 'discuss',
];
const ACTION_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'for', 'of', 'on', 'in', 'into', 'with', 'from',
  'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'his', 'her',
  'is', 'are', 'be', 'been', 'being', 'it', 'as', 'at', 'by', 'or', 'if', 'then',
  'just', 'still', 'need', 'needs', 'must', 'should', 'could', 'would', 'will'
]);

function stripFrontmatter(text) {
  return String(text || '').replace(/^---[\s\S]*?---\n*/, '');
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSkipPath(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  return (
    !value ||
    !value.endsWith('.md') ||
    value.startsWith('Tasks/') ||
    value.startsWith('Daily/') ||
    value.startsWith('Templates/') ||
    value.startsWith('.obsidian/') ||
    value.startsWith('Archive/') ||
    // Generated, backup and conflict content. These were harmless while the only
    // caller was the write hook (NEURO never writes here), but a scheduled sweep
    // walks the whole vault: Scripts/ and .stversions/ alone hold ~10k checkboxes
    // of generated output and old file versions.
    value.startsWith('Scripts/') ||
    value.startsWith('.stversions/') ||
    value.startsWith('.trash/') ||
    value.startsWith('.claude/') ||
    value.startsWith('Conflicts/') ||
    value.includes('/Archive/') ||
    value.includes('sync-conflict')
  );
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function stemToken(token) {
  let value = String(token || '').toLowerCase();
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

function buildSemanticSignature(text) {
  const tokens = normalizeText(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length >= 3 && !ACTION_STOPWORDS.has(token));
  const unique = [...new Set(tokens)].sort();
  return hashKey(unique.join('|') || normalizeText(text));
}

function buildFocusItemId(relativePath, text) {
  return `note-action:${relativePath}:${hashKey(normalizeText(text))}`;
}

function buildReviewStateKey(relativePath) {
  return `note_action_review:${hashKey(relativePath)}:${relativePath}`;
}

function readReviewState(relativePath) {
  const raw = db.getState(buildReviewStateKey(relativePath));
  if (!raw) return { contentHash: null, reviewedAt: null, handled: {} };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? { contentHash: parsed.contentHash || null, reviewedAt: parsed.reviewedAt || null, handled: parsed.handled || {} }
      : { contentHash: null, reviewedAt: null, handled: {} };
  } catch {
    return { contentHash: null, reviewedAt: null, handled: {} };
  }
}

function writeReviewState(relativePath, state) {
  db.setState(buildReviewStateKey(relativePath), JSON.stringify({
    contentHash: state.contentHash || null,
    reviewedAt: state.reviewedAt || new Date().toISOString(),
    handled: state.handled || {},
  }));
}

function getActionSignature(action) {
  const payload = action?.payload || {};
  return payload.semanticSignature || buildSemanticSignature(payload.text || action?.reason || '');
}

function markHandled(relativePath, semanticSignature, status, details = {}) {
  if (!relativePath || !semanticSignature) return;
  const state = readReviewState(relativePath);
  state.handled[semanticSignature] = {
    status,
    at: new Date().toISOString(),
    ...details,
  };
  state.reviewedAt = new Date().toISOString();
  writeReviewState(relativePath, state);
}

function rememberReviewedAction(action, status) {
  const payload = action?.payload || {};
  const relativePath = payload.sourcePath || null;
  const semanticSignature = getActionSignature(action);
  markHandled(relativePath, semanticSignature, status, {
    actionId: action.id || null,
    text: payload.text || null,
  });
}

function cleanCandidateText(text) {
  return String(text || '')
    .replace(/^\s*[-*+]\s*/, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/^\[\s?\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,]+$/, '');
}

function headingName(line) {
  const match = String(line || '').trim().match(/^#{1,6}\s+(.+)$/);
  return match ? match[1].trim().toLowerCase() : null;
}

function isActionHeading(line) {
  const heading = headingName(line);
  if (!heading) return false;
  return ACTION_TYPES.has(heading.replace(/\s+/g, ' '));
}

function startsWithActionVerb(text) {
  const lower = normalizeText(text);
  return ACTION_VERBS.some((verb) => lower.startsWith(`${verb} `));
}

function buildReason(candidate) {
  if (candidate.origin === 'checkbox') return 'Checkbox task found in note';
  if (candidate.origin === 'prefixed') return 'Explicit action marker found in note';
  return 'Likely action found in note';
}

function extractActionCandidates(text, relativePath) {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const candidates = [];
  const seen = new Set();
  let actionableSection = false;
  const todoIntelligence = require('./todo-intelligence');

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      actionableSection = false;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      actionableSection = isActionHeading(trimmed);
      continue;
    }

    let confidence = 0;
    let textValue = '';
    let origin = 'inference';

    if (/^[-*+]\s*\[\s?\]\s+/.test(trimmed)) {
      confidence = actionableSection ? 0.97 : 0.93;
      textValue = cleanCandidateText(trimmed.replace(/^[-*+]\s*\[\s?\]\s+/, ''));
      origin = 'checkbox';
    } else {
      const prefixed = trimmed.match(/^(action|todo|task|follow.?up|reminder|need to|must|next step)[:\s-]+(.+)$/i);
      if (prefixed) {
        confidence = actionableSection ? 0.95 : 0.9;
        textValue = cleanCandidateText(prefixed[2]);
        origin = 'prefixed';
      } else if (actionableSection) {
        const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
        if (bullet && startsWithActionVerb(bullet[1])) {
          confidence = 0.82;
          textValue = cleanCandidateText(bullet[1]);
        }
      }
    }

    if (!textValue || textValue.length < 5) continue;
    if (textValue.length > 220) continue;

    const dedupeKey = buildFocusItemId(relativePath, textValue);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      type: 'capture_todo',
      text: textValue,
      confidence,
      reason: buildReason({ origin }),
      sourcePath: relativePath,
      sourceLine: index + 1,
      focusItemId: dedupeKey,
      semanticSignature: buildSemanticSignature(textValue),
      autoPromote: confidence >= AUTO_PROMOTE_CONFIDENCE,
      payload: {
        text: textValue,
        sourcePath: relativePath,
        sourceLine: index + 1,
        semanticSignature: buildSemanticSignature(textValue),
        extractedFrom: 'vault-note',
        origin: 'note-candidate',
        metadata: todoIntelligence.triageTodo({
          text: textValue,
          sourcePath: relativePath,
          dueDate: null,
          mustdo: origin === 'checkbox',
        }),
      },
    });
  }

  return candidates;
}

function todoAlreadyExists(candidate) {
  try {
    const obsidian = require('./obsidian');
    const { active, done } = obsidian.parseVaultTodos();
    const all = [...active, ...done];
    return all.some((task) => {
      const sameSource = (task.meta?.sourcePath || null) === candidate.sourcePath;
      const sameSignature = buildSemanticSignature(task.text) === candidate.semanticSignature;
      return sameSignature && (sameSource || task.source?.startsWith('Master'));
    });
  } catch {
    return false;
  }
}

function syncNoteActionCandidates(relativePath) {
  if (!VAULT_PATH || shouldSkipPath(relativePath)) {
    return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [] };
  }

  const fullPath = path.join(VAULT_PATH, relativePath);
  if (!fs.existsSync(fullPath)) {
    return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [] };
  }

  let content = '';
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [] };
  }

  const contentHash = hashKey(stripFrontmatter(content));
  const reviewState = readReviewState(relativePath);
  const candidates = candidatesFor(content, relativePath);
  if (reviewState.contentHash === contentHash && candidates.length === 0) {
    return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [] };
  }
  const activeIds = new Set(candidates.map((candidate) => candidate.focusItemId));
  const existing = db.getRecentSaraActions(500).filter((action) => {
    if (action.type !== 'capture_todo') return false;
    if (!action.payload || action.payload.sourcePath !== relativePath) return false;
    return true;
  });

  let superseded = 0;
  for (const action of existing) {
    if (action.status !== 'pending') continue;
    if (activeIds.has(action.focus_item_id)) continue;
    db.updateSaraActionStatus(action.id, 'superseded');
    superseded += 1;
  }

  let created = 0;
  let autoPromoted = 0;
  let pending = 0;
  const suggestionEngine = require('./suggestion-engine');

  for (const candidate of candidates) {
    const alreadyTracked = existing.some((action) => {
      if (action.focus_item_id === candidate.focusItemId) return true;
      if ((action.payload?.sourcePath || null) !== candidate.sourcePath) return false;
      return getActionSignature(action) === candidate.semanticSignature;
    });
    if (alreadyTracked) continue;

    const handled = reviewState.handled[candidate.semanticSignature];
    if (handled?.status === 'rejected' || handled?.status === 'executed' || handled?.status === 'ignored') {
      continue;
    }

    if (todoAlreadyExists(candidate)) {
      markHandled(candidate.sourcePath, candidate.semanticSignature, 'executed', {
        text: candidate.text,
        reason: 'already-in-master-todo',
      });
      continue;
    }

    const actionId = db.createSaraAction(
      candidate.type,
      candidate.payload,
      candidate.confidence,
      candidate.reason,
      candidate.focusItemId
    );
    created += 1;

    if (candidate.autoPromote) {
      const action = db.getSaraAction(actionId);
      const result = suggestionEngine.executeAction(action);
      db.updateSaraActionStatus(actionId, result.ok ? 'executed' : 'failed');
      suggestionEngine.logActionExecution(action, result);
      if (result.ok) {
        autoPromoted += 1;
        rememberReviewedAction(action, 'executed');
      }
    } else {
      pending += 1;
    }
  }

  writeReviewState(relativePath, {
    ...readReviewState(relativePath),
    contentHash,
    reviewedAt: new Date().toISOString(),
  });

  return { created, autoPromoted, pending, superseded, candidates };
}

// ── Meeting action extraction (PLAUD "## Next Arrangements") ─────────────────
//
// The generic checkbox scan is unusable on meeting notes: every "- [ ]" scores
// 0.93 (== AUTO_PROMOTE_CONFIDENCE), so a dry run proposed 562 candidates and
// wanted to auto-write all of them into Master Todo — including other people's
// actions and the NOVA backlog, which Tasks/Task System Boundary.md explicitly
// routes elsewhere.
//
// PLAUD states ownership in the prose instead ("Nick to prepare…", "Abi to
// monitor…", "Catherine will process…"), so we read that rather than relying on
// a tag. Measured over 23 meetings / 261 action lines:
//   A named-Nick 48 (18%) · B named-someone-else 45 (17%) · C unowned 168 (64%)
// B is dropped outright — that IS the "don't carry other people's actions" rule.
//
// Nothing here auto-promotes. Everything goes to the review queue.

const OWNER_RE = /^([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?(?:\s*\/\s*[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)*)\s+(?:to|will|should|must|is to)\b/;
const NICK_RE = /^nick(\s+ward)?$/i;

// "A follow-up meeting … is scheduled for August 13" is a record, not a task.
const STATEMENT_OF_FACT_RE = /\b(?:is|are|was|were|has been|have been|had been)\s+(?:scheduled|planned|arranged|agreed|booked|completed|confirmed|held|due|set up)\b/i;

let _peopleCache = null;
function peopleFirstNames() {
  if (_peopleCache) return _peopleCache;
  const set = new Set(['nick', 'nick ward']);
  try {
    const dir = path.join(VAULT_PATH, 'People');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const full = f.replace(/\.md$/, '');
      set.add(full.toLowerCase());
      const first = full.split(/\s+/)[0];
      if (first) set.add(first.toLowerCase());
    }
  } catch { /* no People/ index — everything falls through to unowned */ }
  _peopleCache = set;
  return set;
}

// mine | others | unowned. "Reclassify Lomond to low risk" must NOT read as an
// owner, so a captured actor only counts if it matches the People/ index.
function classifyActionOwner(text) {
  const m = String(text || '').trim().match(OWNER_RE);
  if (m) {
    const actors = m[1].split('/').map((a) => a.trim()).filter(Boolean);
    const known = actors.filter((a) => peopleFirstNames().has(a.toLowerCase()));
    if (known.length) {
      return known.some((a) => NICK_RE.test(a)) ? 'mine' : 'others';
    }
  }
  // Unattributed but names Nick somewhere ("… with Nick", "Nick's team")
  if (/\bnick\b/i.test(text)) return 'mine';
  return 'unowned';
}

function extractMeetingActions(text, relativePath) {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  let inActionSection = false;
  const todoIntelligence = require('./todo-intelligence');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (/^#{1,6}\s+/.test(trimmed)) { inActionSection = isActionHeading(trimmed); continue; }
    if (!inActionSection || !trimmed) continue;
    // PLAUD's "## AI Suggestions" block is quoted prose about unresolved issues,
    // explicitly NOT action items.
    if (trimmed.startsWith('>')) continue;

    const bullet = trimmed.match(/^[-*+]\s*(?:\[\s?\]\s*)?(.+)$/);
    if (!bullet) continue;

    const raw = cleanCandidateText(bullet[1]);
    if (!raw || raw.length < 8 || raw.length > 220) continue;

    const owner = classifyActionOwner(raw);
    if (owner === 'others') continue;                       // B — not yours

    if (owner === 'unowned') {                              // C — needs to look like an action
      if (STATEMENT_OF_FACT_RE.test(raw)) continue;
      if (!startsWithActionVerb(raw)) continue;
    }

    const dedupeKey = buildFocusItemId(relativePath, raw);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Both tiers sit well below AUTO_PROMOTE_CONFIDENCE, and autoPromote is
    // hard-false regardless — this queue is review-only by design.
    const confidence = owner === 'mine' ? 0.8 : 0.55;

    out.push({
      type: 'capture_todo',
      text: raw,
      confidence,
      reason: owner === 'mine'
        ? `You were named in ${path.basename(relativePath, '.md')}`
        : `Unassigned action from ${path.basename(relativePath, '.md')}`,
      sourcePath: relativePath,
      sourceLine: index + 1,
      focusItemId: dedupeKey,
      semanticSignature: buildSemanticSignature(raw),
      autoPromote: false,
      owner,
      payload: {
        text: raw,
        sourcePath: relativePath,
        sourceLine: index + 1,
        semanticSignature: buildSemanticSignature(raw),
        extractedFrom: 'meeting-action',
        origin: 'meeting-candidate',
        owner,
        metadata: todoIntelligence.triageTodo({ text: raw, sourcePath: relativePath, dueDate: null, mustdo: false }),
      },
    });
  }

  return out;
}

// Meeting notes go through the owner-classified extractor; everything else keeps
// the original checkbox/prefix heuristics.
function isMeetingNote(relativePath) {
  return /^meetings\//i.test(String(relativePath || '').replace(/\\/g, '/'));
}

function candidatesFor(content, relativePath) {
  return isMeetingNote(relativePath)
    ? extractMeetingActions(content, relativePath)
    : extractActionCandidates(content, relativePath);
}

// Walk recently-modified vault notes and extract action candidates.
//
// syncNoteActionCandidates() only ever ran from vault-hooks.onVaultWrite(), which
// fires when NEURO writes a note. Notes written in Obsidian arrive on the Pi by
// Syncthing — a file copy, not a NEURO write — so the hook never fired for them
// and nothing was ever proposed. Embeddings and entity extraction both have
// nightly jobs; action extraction never did. This is that missing job.
//
// dryRun is the default on purpose. Candidates at or above AUTO_PROMOTE_CONFIDENCE
// write straight into Master Todo, and a sweep sees far more notes than the write
// hook ever did — so the blast radius has to be measured before it is allowed.
function scanRecentNotes(options = {}) {
  const { days = 7, dryRun = true, limit = 500 } = options;
  const started = Date.now();
  const result = {
    dryRun, days, scanned: 0, skipped: 0,
    created: 0, autoPromoted: 0, pending: 0, superseded: 0,
    wouldCreate: 0, wouldAutoPromote: 0,
    files: [],
  };
  if (!VAULT_PATH) return result;

  const cutoff = Date.now() - days * 86400000;
  const queue = [VAULT_PATH];
  const candidatesByFile = [];

  while (queue.length) {
    const dir = queue.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(VAULT_PATH, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        queue.push(full);
        continue;
      }
      if (shouldSkipPath(rel)) { result.skipped += 1; continue; }
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoff) { result.skipped += 1; continue; }
      candidatesByFile.push(rel);
    }
  }

  // Newest first, so a capped run covers what changed most recently.
  candidatesByFile.sort((a, b) => {
    try {
      return fs.statSync(path.join(VAULT_PATH, b)).mtimeMs - fs.statSync(path.join(VAULT_PATH, a)).mtimeMs;
    } catch { return 0; }
  });

  for (const rel of candidatesByFile.slice(0, limit)) {
    result.scanned += 1;
    if (dryRun) {
      // Extract only — no DB writes, no promotion, no review-state update.
      let content = '';
      try { content = fs.readFileSync(path.join(VAULT_PATH, rel), 'utf-8'); } catch { continue; }
      const candidates = candidatesFor(content, rel);
      if (!candidates.length) continue;
      const auto = candidates.filter((c) => c.autoPromote).length;
      result.wouldCreate += candidates.length;
      result.wouldAutoPromote += auto;
      result.files.push({ path: rel, candidates: candidates.length, autoPromote: auto,
        sample: candidates.slice(0, 3).map((c) => c.text) });
      continue;
    }

    try {
      const r = syncNoteActionCandidates(rel);
      result.created += r.created;
      result.autoPromoted += r.autoPromoted;
      result.pending += r.pending;
      result.superseded += r.superseded;
      if (r.created || r.superseded) result.files.push({ path: rel, created: r.created, pending: r.pending });
    } catch (e) {
      console.warn('[ActionCandidates] scan failed for', rel, e.message);
    }
  }

  result.ms = Date.now() - started;
  return result;
}

module.exports = {
  AUTO_PROMOTE_CONFIDENCE,
  scanRecentNotes,
  extractMeetingActions,
  classifyActionOwner,
  buildFocusItemId,
  buildSemanticSignature,
  extractActionCandidates,
  rememberReviewedAction,
  syncNoteActionCandidates,
  shouldSkipPath,
};
