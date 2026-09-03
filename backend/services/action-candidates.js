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
    // Projects/ and Plaud/ generate nothing but noise, and the write hook — unlike
    // the nightly sweep — is not scoped to Meetings/, so it kept proposing from
    // them. Measured 12 Aug: 1,038 checkboxes under Projects/ produced ZERO
    // attributable to Nick. Plaud/Summaries is raw intake; the routed note in
    // Meetings/ is the record, so suggesting from both double-counts.
    // Between them these two were the entire 105-item stale queue.
    value.startsWith('Projects/') ||
    value.startsWith('Plaud/') ||
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

/**
 * What Nick has already said about this candidate, or null.
 *
 * The review state has always been read inside `syncNoteActionCandidates`; this
 * exposes the same read to the other extractor (`email-actions`), so a rejected
 * candidate is not re-raised from a second source. One reader, one meaning of
 * "handled" — the alternative is two extractors disagreeing about whether Nick
 * has already turned something down.
 */
function reviewStatusFor(relativePath, semanticSignature) {
  if (!relativePath || !semanticSignature) return null;
  return readReviewState(relativePath).handled[semanticSignature]?.status || null;
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

  // Gate on CONTENT, not mtime. `scanRecentNotes` selects notes by file mtime
  // inside a 7-day window, so on 14 Aug the restamp-people backfill rewrote
  // `people:` frontmatter across ~229 meeting notes, every mtime jumped into the
  // window, and the nightly sweep re-read the entire meetings corpus and
  // extracted every historical `- [ ]` checkbox: 911 candidates in one night.
  // One automation's bulk rewrite triggering another's flood is why this recurs
  // on every clean-up pass, and why reviewing the queue once was never going to
  // hold. If the BODY has not changed the candidate set cannot have changed
  // either — nothing to create, nothing to supersede. The hash is taken after
  // stripping frontmatter, so a restamp is invisible here by construction.
  //
  // The embeddings pipeline has gated on content_hash all along; this is the
  // same pattern, applied where it was missing.
  if (reviewState.contentHash === contentHash) {
    return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [], unchanged: true };
  }

  const candidates = candidatesFor(content, relativePath);
  const activeIds = new Set(candidates.map((candidate) => candidate.focusItemId));
  // Every capture_todo ever raised FOR THIS NOTE, not the newest 500 rows in
  // the table filtered down to it. That filter was the whole duplication bug:
  // the table churns thousands of rows a day, so the 500-row window covered
  // about 21 hours and last night's actions for this note had already fallen
  // out of it. `alreadyTracked` then found nothing, and the 10pm scan re-queued
  // the same candidates every single night — 926 pending rows, 442 distinct.
  // The supersede loop below was blinded by exactly the same window, which is
  // why the older copies stayed pending instead of being retired.
  const existing = db.getSaraActionsBySource(relativePath, 'capture_todo');

  let superseded = 0;
  for (const action of existing) {
    if (action.status !== 'pending') continue;
    if (activeIds.has(action.focus_item_id)) continue;
    db.updateSaraActionStatus(action.id, 'superseded');
    superseded += 1;
  }

  let created = 0;
  // Always 0 now that promotion is review-only, but kept in the result shape
  // because scanRecentNotes() and the routes still tally it.
  const autoPromoted = 0;
  let pending = 0;
  let folded = 0;

  // Everything already queued from a DIFFERENT note. `existing` above is scoped
  // to this one, which is correct for superseding but is exactly why the queue
  // filled up: Plaud writes a dozen summary variants of one recording, each
  // lands as its own note, and each extraction is blind to the other eleven.
  // Live proof at the time of writing — 258 pending, 54 distinct, with single
  // commitments repeated fourteen times.
  const crossPool = loadCrossNotePool(relativePath);

  for (const candidate of candidates) {
    const alreadyTracked = existing.some((action) => {
      if (action.focus_item_id === candidate.focusItemId) return true;
      if ((action.payload?.sourcePath || null) !== candidate.sourcePath) return false;
      return getActionSignature(action) === candidate.semanticSignature;
    });
    if (alreadyTracked) continue;

    // Same commitment, different note. Fold rather than create — and fold
    // LOSSLESSLY: the wording and the source line are appended to the survivor,
    // so nothing a meeting said is discarded, it is just no longer a separate
    // row Nick has to read. If the survivor is later rejected it drops out of
    // the pending pool and a fresh copy is created on the next sync, which is
    // the right way round: a rejection should not silently suppress the next
    // sighting for ever.
    const twin = crossPool.match(candidate.text);
    if (twin) {
      if (recordSighting(twin.action, candidate, twin.score)) {
        console.log(`[ActionCandidates] Folded "${candidate.text.slice(0, 60)}" into #${twin.action.id} (${twin.score})`);
        folded += 1;
      }
      continue;
    }

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

    // Every candidate stays pending. Auto-promote used to live here behind a
    // hard-false flag; it was removed once suggestionEngine.executeAction became
    // async (real Graph actuators), because this function is synchronous and
    // would have recorded every promotion as failed. On 12 Aug a Plaud repull
    // wrote 73 meeting notes, each firing onVaultWrite -> this function, and the
    // checkbox extractor auto-promoted 28 items straight into Master Todo —
    // including "Speaker 1 to email the Hughes Estates client". Nothing reaches
    // the task list without Nick approving it from the queue. If auto-promote is
    // ever wanted again, make this function async first.
    pending += 1;

    // A note can carry two wordings of one commitment. Adding what was just
    // created to the pool means the second folds into the first instead of the
    // pair surviving together — the `seen` set above only catches them when the
    // text is byte-identical.
    crossPool.add(db.getSaraAction(actionId));
  }

  writeReviewState(relativePath, {
    ...readReviewState(relativePath),
    contentHash,
    reviewedAt: new Date().toISOString(),
  });

  return { created, autoPromoted, pending, superseded, folded, candidates };
}

// ── Cross-note duplicate folding ─────────────────────────────────────────────

// Bounded because it is loaded on every note sync and the table churns. 2,000 is
// far above the worst pending queue ever observed (930) while still being a real
// bound rather than "all of them" — and a cap that could bite is logged, because
// a silent one here would quietly stop folding exactly when the pile is biggest.
const CROSS_POOL_LIMIT = 2000;

// Off is a supported state, not a bug: if folding is ever wrong for a corpus,
// the queue filling up again is recoverable and a wrongly-merged commitment is
// harder to notice.
// Default TRUE — a kill switch for behaviour that is already live and wanted.
const dedupeEnabled = () => require('./feature-flags').isEnabled('capture_dedupe');

/**
 * The fold does NOT inherit task-dedupe's 0.42, and that is the whole finding.
 *
 * 0.42 was measured on NEURO tasks against Microsoft tasks — two independently
 * worded lists. This corpus is the opposite: every row is an action extracted
 * from Nick's own meetings, so they all read "Nick will <verb> the <support
 * noun>" and share his stock vocabulary almost completely. Scored against the
 * live queue on 27 Aug 2026 (258 pending, 54 distinct), 0.42 merged two pairs
 * and BOTH were wrong — the worst folded "meet Naomi on 26/27 Aug to review and
 * sign the risk assessment" into "complete the remaining sections of the risk
 * assessment form", which would have hidden a dated meeting behind a form.
 *
 * Measured separation in the real operating condition (scored against the whole
 * pool, which is what changes the IDF and therefore the scores):
 *
 *   exact repeat .................. 1.000
 *   case / punctuation variant .... 1.000
 *   minor reword .................. 1.000
 *   same job, one clause dropped .. 1.000
 *   ── the gap ──
 *   worst live false positive ..... 0.499
 *   genuinely new commitment ...... 0.150
 *
 * 0.85 sits in that gap. It is deliberately at the conservative end, because the
 * two directions are not symmetric: a missed fold leaves a duplicate row, which
 * is visible, cheap and the status quo — while a wrong fold hides a real
 * commitment inside an unrelated one, silently, in the queue Nick uses to find
 * what he owes. Duplicates are an annoyance; a lost commitment is the failure.
 */
const FOLD_SCORE = 0.85;

/**
 * Pending capture_todos raised from OTHER notes, ready to be scored against.
 *
 * Uses `task-dedupe`'s matcher rather than a second one, so the threshold that
 * was measured against Nick's own corpus (0.42, with the highest-scoring
 * non-duplicate at 0.397) is the threshold that applies here.
 */
function loadCrossNotePool(relativePath) {
  const rows = [];
  if (dedupeEnabled()) {
    try {
      const all = db.getPendingSaraActionsByType('capture_todo', CROSS_POOL_LIMIT);
      if (all.length === CROSS_POOL_LIMIT) {
        console.warn(`[ActionCandidates] Cross-note pool hit its ${CROSS_POOL_LIMIT} cap — folding may miss older duplicates`);
      }
      for (const row of all) {
        if ((row.payload?.sourcePath || null) === relativePath) continue;
        if (!row.payload?.text) continue;
        rows.push(row);
      }
    } catch (e) {
      // A pool that could not be read must not look like "no duplicates exist".
      console.warn('[ActionCandidates] Could not load cross-note pool, folding disabled for this run:', e.message);
      return { match: () => null, add: () => {} };
    }
  }

  return {
    match(text) {
      if (!dedupeEnabled() || !rows.length) return null;
      // Lazily required: task-dedupe pulls in task-store, and this module is
      // loaded from the vault hooks at startup.
      const taskDedupe = require('./task-dedupe');
      const hit = taskDedupe.findEquivalent(text, rows.map(r => r.payload.text), { minScore: FOLD_SCORE });
      return hit ? { action: rows[hit.index], score: hit.score } : null;
    },
    add(row) {
      if (row?.payload?.text) rows.push(row);
    },
  };
}

/**
 * Attach a duplicate sighting to the action that survived. Returns false when
 * this exact candidate is already on it, so a re-sync cannot inflate the count.
 */
function recordSighting(action, candidate, score) {
  const payload = { ...action.payload };
  const sightings = Array.isArray(payload.sightings) ? [...payload.sightings] : [];
  if (sightings.some(s => s.focusItemId === candidate.focusItemId)) return false;

  sightings.push({
    focusItemId: candidate.focusItemId,
    sourcePath: candidate.sourcePath,
    sourceLine: candidate.sourceLine,
    // Kept verbatim. The whole point of folding rather than dropping is that the
    // other meeting's wording survives somewhere Nick can still read it.
    text: candidate.text,
    score,
    at: new Date().toISOString(),
  });
  payload.sightings = sightings;

  return db.updateSaraActionPayload(action.id, payload);
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

// PLAUD writes ownership three ways: "Nick to …", "Nick will …", and
// "Nick Ward: …". Missing the colon form let other people's actions through —
// "Naomi Wentworth: Test the pending ticket" was landing in the queue as yours.
const NAME = "[A-Z][\\w'’-]*(?:\\s+[A-Z][\\w'’-]*)?";
const ACTOR_GROUP = `${NAME}(?:\\s*(?:\\/|and|&)\\s*${NAME})*`;
const OWNER_RE = new RegExp(`^(${ACTOR_GROUP})(?:\\s+(?:to|will|should|must|is to)\\b|\\s*:\\s)`);
const NICK_RE = /^nick(\s+ward)?(?:’s|'s)?$/i;

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
  return classifyAction(text).owner;
}

/**
 * The same judgement, but keeping WHO. classifyActionOwner threw the names away
 * and returned a bare string, so the system could tell that Abdi owed Nick
 * something and then immediately forgot which person it was — which is why
 * nothing has ever been able to chase anyone.
 *
 * Returns { owner, actors } — actors is the matched names, empty for mine/unowned.
 */
function classifyAction(text) {
  const value = String(text || '').trim();
  const m = value.match(OWNER_RE);
  if (m) {
    const actors = m[1].split(/\s*(?:\/|and|&)\s*/).map((a) => a.trim()).filter(Boolean);
    const known = actors.filter((a) => peopleFirstNames().has(a.replace(/(?:’s|'s)$/, '').toLowerCase()));
    if (known.length) {
      const mine = known.some((a) => NICK_RE.test(a));
      return {
        owner: mine ? 'mine' : 'others',
        // Nick's own name is not a person he is waiting on.
        actors: mine ? [] : known.filter((a) => !NICK_RE.test(a)),
        // Matched the People/ index, so this is a real colleague.
        actorsKnown: true,
      };
    }
    // Not in People/ — but "Catherine will process…" is still plainly someone
    // else's, and the index only holds 42 names. Treat a leading proper noun as
    // an owner UNLESS it is an action verb, which is what stops "Reclassify
    // Lomond to low risk" and "Remind Taus to deliver…" being read as people.
    const lead = actors[0] ? actors[0].split(/\s+/)[0].toLowerCase() : '';
    // Still "not Nick's", which is all the task extractor needs — but NOT a
    // named colleague. A backfill over 232 notes produced "HR", "Explore Access"
    // and other org names this way, so actorsKnown stays false and waiting-on
    // ignores it. Chasing needs an email, which needs a People note anyway.
    if (lead && !ACTION_VERBS.includes(lead)) {
      return { owner: 'others', actors: [actors[0]], actorsKnown: false };
    }
  }
  // Only a LEADING "Nick…" counts as ownership. A bare mention anywhere used to
  // claim the line, so "Naomi Wentworth: … (agreed with Nick)" read as yours.
  if (/^nick(\s+ward)?(?:’s|'s)?\b/i.test(value)) return { owner: 'mine', actors: [], actorsKnown: false };
  return { owner: 'unowned', actors: [], actorsKnown: false };
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

    const { owner, actors, actorsKnown } = classifyAction(raw);

    // B — someone else's. Not a task for Nick, but it IS something he is waiting
    // on, and this used to be thrown away with the name attached. Recorded
    // rather than promoted: it never reaches the task list or the approval
    // queue, it just stops being forgotten.
    if (owner === 'others') {
      // Named colleagues only. Without this the list fills with org names.
      for (const person of (actorsKnown ? actors : [])) {
        try {
          require('./waiting-on').record({
            person,
            text: raw,
            sourcePath: relativePath,
            // Meeting notes are filed as Meetings/YYYY/MM/YYYY-MM-DD – Title.md,
            // so the path carries the date without parsing frontmatter.
            sourceDate: (relativePath.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
          });
        } catch (e) {
          console.warn('[ActionCandidates] waiting-on record failed:', e.message);
        }
      }
      continue;
    }

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
/**
 * Plaud ids NOVA has approved as 1-2-1s, so this scan can leave them alone.
 *
 * Read once per sweep and cached briefly: the sweep walks hundreds of notes and a
 * per-note bridge call would be absurd. An UNREADABLE list returns empty, which means
 * this scan does its normal job — extracting twice is wasteful, extracting zero times
 * loses the actions entirely, so the failure has to fall that way.
 */
let _novaClaimCache = { at: 0, ids: new Set() };

async function loadNovaClaimed() {
  if (Date.now() - _novaClaimCache.at < 5 * 60 * 1000) return _novaClaimCache.ids;
  let ids = new Set();
  try {
    const nova = require('./nova-client');
    if (nova.isConfigured()) {
      const r = await nova.get121KnownRecordings();
      ids = new Set(r.approved || []);
    }
  } catch (e) {
    console.warn('[action-candidates] Could not ask NOVA which 1-2-1s it owns:', e.message);
  }
  _novaClaimCache = { at: Date.now(), ids };
  return ids;
}

/** Does this note carry a plaud_id NOVA has claimed? */
function novaClaimedNote(absPath, claimed) {
  try {
    const head = fs.readFileSync(absPath, 'utf-8').slice(0, 2000).replace(/\r\n/g, '\n');
    const m = head.match(/^plaud_id:\s*"?([A-Za-z0-9]+)"?\s*$/m);
    return Boolean(m && claimed.has(m[1]));
  } catch {
    return false;
  }
}

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
  // scope 'meetings' (default) restricts the sweep to Meetings/. Everywhere else
  // still runs the old checkbox heuristics, which auto-promote at 0.93 and were
  // measured proposing 258 items from a single PIP meeting-actions record and 61
  // from the NOVA backlog — both of which Tasks/Task System Boundary.md routes
  // away from Master Todo. Widen to 'all' only with a dry run in hand.
  // maxCreate bounds what ONE run may add to the review queue. 911 candidates
  // landed in a single night on 14 Aug and nothing stopped it.
  const { days = 7, dryRun = true, limit = 500, scope = 'meetings', maxCreate = 60,
          novaClaimed = new Set() } = options;
  const started = Date.now();
  const result = {
    dryRun, days, scope, scanned: 0, skipped: 0, unchanged: 0, novaOwned: 0,
    created: 0, autoPromoted: 0, pending: 0, superseded: 0,
    wouldCreate: 0, wouldAutoPromote: 0,
    capped: false, maxCreate, notScanned: 0,
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
      if (scope === 'meetings' && !isMeetingNote(rel)) { result.skipped += 1; continue; }
      // A 1-2-1 NOVA has already extracted. Its transcript is read there ONCE — that is
      // the only side holding the agent's open action ids, so completion-matching cannot
      // move — and the actions it finds come back over the bridge. Scanning it here as
      // well would pay for a second LLM pass over the same words to produce the same
      // list. Note this keys on APPROVED recordings only: a candidate Nick rejected is
      // not a 1-2-1, so it falls through to the ordinary scan below, exactly as before.
      if (novaClaimed.size && novaClaimedNote(full, novaClaimed)) { result.skipped += 1; result.novaOwned += 1; continue; }
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

    if (result.created >= maxCreate) {
      result.capped = true;
      result.notScanned += 1;
      continue;
    }

    try {
      const r = syncNoteActionCandidates(rel);
      result.created += r.created;
      result.autoPromoted += r.autoPromoted;
      result.pending += r.pending;
      result.superseded += r.superseded;
      if (r.unchanged) result.unchanged += 1;
      if (r.created || r.superseded) result.files.push({ path: rel, created: r.created, pending: r.pending });
    } catch (e) {
      console.warn('[ActionCandidates] scan failed for', rel, e.message);
    }
  }

  // A run that proposes hundreds of things has failed regardless of whether each
  // one is individually defensible — a review queue that arrives faster than it
  // can be read is just a second backlog. Say so in the log rather than stopping
  // quietly: an unannounced cap is the failure mode this whole item is about.
  if (result.capped) {
    console.warn(`[ActionCandidates] Hit the ${maxCreate}-candidate cap for one run — ${result.notScanned} notes left unscanned. Something is re-writing notes in bulk; check before raising this.`);
  }

  result.ms = Date.now() - started;
  return result;
}

/**
 * The nightly entry point: ask NOVA which 1-2-1s it owns, then scan everything else.
 *
 * Split from `scanRecentNotes` so that function stays synchronous and testable with no
 * network in it — the claimed set is data, passed in, exactly like `days` or `scope`.
 */
async function scanRecentNotesExcludingNova(options = {}) {
  return scanRecentNotes({ ...options, novaClaimed: await loadNovaClaimed() });
}

/**
 * The claim set WITHOUT going to the network. Sync.
 *
 * `loadNovaClaimed` is async and `vault-hooks.onVaultWrite` is not — it is
 * called fire-and-forget from a dozen places that do not await it, so making
 * that chain async would change the semantics of every one of them. This is the
 * `team-availability` split instead: a sync cache read for the caller that
 * cannot wait, and an async refresh kicked off behind it.
 *
 * Returns `null` when there is nothing cached, which is deliberately different
 * from an empty set: "we have never asked NOVA" and "NOVA owns nothing" license
 * opposite behaviour in the caller.
 */
function novaClaimedCached() {
  return _novaClaimCache.at ? _novaClaimCache.ids : null;
}

/** Warm the cache in the background. Never awaited, never allowed to throw. */
function refreshNovaClaimed() {
  loadNovaClaimed().catch(() => {});
}

/**
 * The write-hook's version of the nightly sweep's NOVA exclusion (item 21).
 *
 * The nightly sweep has asked NOVA which 1-2-1 recordings it owns since the
 * feature shipped, and skips those notes — correctly, because NOVA extracts
 * the actions from them itself. The hook path never did, so a NOVA-owned 1-2-1
 * routed into `Meetings/` by `imports` had its actions extracted by NEURO via
 * the hook AND by NOVA: one conversation, two systems, and Nick reviewing the
 * same commitment twice in two different places.
 *
 * ⚠ **It fails OPEN, in both directions that matter.** With nothing cached
 * nothing is excluded and extraction happens as before: a duplicate candidate
 * is visible and cheap, a missed commitment is neither. And a cached set that
 * has since gone stale can only ever over-exclude for as long as it takes the
 * background refresh to land — after which the nightly sweep, which always uses
 * a FRESH set, re-reads every meeting note from the last seven days and picks up
 * anything this wrongly skipped.
 *
 * Sync, like the hook that calls it.
 */
function syncNoteActionCandidatesUnlessNova(relativePath) {
  // Kick the refresh either way, so the NEXT write has a warm set. Not awaited.
  refreshNovaClaimed();

  const claimed = novaClaimedCached();
  if (claimed && claimed.size && isMeetingNote(relativePath)) {
    const full = path.join(VAULT_PATH, relativePath);
    if (novaClaimedNote(full, claimed)) {
      return { created: 0, autoPromoted: 0, pending: 0, superseded: 0, candidates: [], novaOwned: true };
    }
  }
  return syncNoteActionCandidates(relativePath);
}

module.exports = {
  scanRecentNotesExcludingNova,
  _novaInternals: {
    loadNovaClaimed,
    novaClaimedNote,
    // The 5-minute TTL is what makes the claim set affordable on a write path;
    // it is also what makes it untestable without a way to clear it.
    resetClaimCache: () => { _novaClaimCache = { at: 0, ids: new Set() }; },
    seedClaimCache: (ids) => { _novaClaimCache = { at: Date.now(), ids: new Set(ids) }; },
  },
  AUTO_PROMOTE_CONFIDENCE,
  scanRecentNotes,
  extractMeetingActions,
  classifyActionOwner,
  buildFocusItemId,
  buildSemanticSignature,
  extractActionCandidates,
  rememberReviewedAction,
  reviewStatusFor,
  syncNoteActionCandidates,
  syncNoteActionCandidatesUnlessNova,
  novaClaimedCached,
  shouldSkipPath,
};
