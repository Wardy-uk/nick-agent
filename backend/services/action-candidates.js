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
    value.startsWith('Archive/')
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
  const candidates = extractActionCandidates(content, relativePath);
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

module.exports = {
  AUTO_PROMOTE_CONFIDENCE,
  buildFocusItemId,
  buildSemanticSignature,
  extractActionCandidates,
  rememberReviewedAction,
  syncNoteActionCandidates,
  shouldSkipPath,
};
