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

function buildFocusItemId(relativePath, text) {
  return `note-action:${relativePath}:${hashKey(normalizeText(text))}`;
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
      autoPromote: confidence >= AUTO_PROMOTE_CONFIDENCE,
      payload: {
        text: textValue,
        sourcePath: relativePath,
        sourceLine: index + 1,
        extractedFrom: 'vault-note',
      },
    });
  }

  return candidates;
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

  const candidates = extractActionCandidates(content, relativePath);
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
    const alreadyTracked = existing.some((action) => action.focus_item_id === candidate.focusItemId);
    if (alreadyTracked) continue;

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
      if (result.ok) autoPromoted += 1;
    } else {
      pending += 1;
    }
  }

  return { created, autoPromoted, pending, superseded, candidates };
}

module.exports = {
  AUTO_PROMOTE_CONFIDENCE,
  buildFocusItemId,
  extractActionCandidates,
  syncNoteActionCandidates,
  shouldSkipPath,
};
