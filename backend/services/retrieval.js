'use strict';

/**
 * Unified retrieval — keyword, semantic and temporal search over the vault,
 * fused with Reciprocal Rank Fusion (RRF).
 *
 * ── Scope is a promise, not a filter on one source (Phase 4) ────────────────
 * `scope` used to be applied inside `keywordSearch` ONLY. Semantic results were
 * never checked against it, and semantic carries the HIGHEST fusion weight
 * (1.2) — so asking for `folder:Meetings` reliably returned notes from outside
 * Meetings, ranked above the ones inside it. A scope that silently does not
 * hold is worse than no scope: it is a claim about what was searched.
 *
 * Scope is now enforced in three places, deliberately redundantly: inside each
 * source where it can be applied cheaply, again on every source's output, and
 * once more after fusion. The last one is the guarantee — a source added later
 * cannot leak past it by forgetting.
 *
 * ── Ranking must see the whole permitted set ────────────────────────────────
 * `keywordSearch` used to stop walking once it had collected `maxResults * 2`
 * files, in filesystem order. So the answer was "the first N matches the
 * directory listing happened to yield", not "the best N matches", and a note
 * late in the walk could not outrank a weak one early in it however well it
 * matched. The walk now scores everything permitted and sorts afterwards; only
 * an explicit, REPORTED cap bounds it.
 *
 * ── Depth ───────────────────────────────────────────────────────────────────
 * The walk was capped at depth 4, which silently removed whole subtrees while
 * they went on looking perfectly searchable. The bound is now generous and,
 * when hit, is REPORTED rather than swallowed.
 *
 * CommonJS — NEURO backend convention.
 */

const fs = require('fs');
const path = require('path');
const embeddings = require('./embeddings');
const vaultExclusions = require('./vault-exclusions');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const RRF_K = 60; // standard RRF constant

// Generous, and a backstop against a symlink loop rather than a content
// decision. `Meetings/2026/08/note.md` is depth 3; the old limit of 4 left one
// level of headroom for a vault that already nests deeper than that.
const MAX_DEPTH = 12;

// A hard bound on how many files one walk will read, so a pathological vault
// cannot wedge a request. Hitting it is REPORTED (`truncated`), never silent —
// a capped scan that presents itself as a complete one is the bug this file
// just had in three different shapes.
const MAX_FILES_SCANNED = 5000;

// ── Scope ────────────────────────────────────────────────────────────────────

/** Parse `folder:X` / `person:Y`, or null for "no scope asked for". PURE. */
function parseScope(scope) {
  const raw = String(scope || '').trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('folder:')) {
    const folder = raw.slice(7).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return folder ? { kind: 'folder', value: folder } : null;
  }
  if (raw.toLowerCase().startsWith('person:')) {
    const person = raw.slice(7).trim();
    return person ? { kind: 'person', value: person } : null;
  }
  // An unrecognised scope is NOT silently ignored. Ignoring it would answer a
  // question nobody asked and then label the answer as scoped.
  return { kind: 'unknown', value: raw };
}

/**
 * Is this vault-relative path inside `folder:`? PURE.
 *
 * Segment-aware: `Meetings` must not match `Meetings archive/`, and the old
 * `startsWith` did exactly that. The reverse containment the old code also
 * allowed (the scope sitting inside the directory) is gone — asking for
 * `folder:Meetings/2026` and being handed `Meetings/2025` is not a scope.
 */
function pathInFolder(relativePath, folder) {
  const p = String(relativePath || '').replace(/\\/g, '/');
  const f = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!f) return true;
  return p === f || p.startsWith(`${f}/`);
}

/** Could a walk into this directory ever yield a path inside `folder:`? PURE. */
function folderIsReachable(relDir, folder) {
  const d = String(relDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const f = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!d || !f) return true;                        // the vault root, or no scope
  return pathInFolder(d, f) || f.startsWith(`${d}/`);
}

// Reading a file to answer "does this mention Naomi?" is the expensive half, so
// the answer is cached for the life of one search. Bounded, because a semantic
// pass can hand back paths from anywhere in the vault.
const PERSON_CACHE_MAX = 2000;

/**
 * Does this note actually concern `person:`?
 *
 * Two ways to qualify, and the second is why a filename test alone is not
 * enough: the note IS the person's note (`People/Naomi Wentworth.md`), or the
 * body names them. Matching is whole-word on the FULL name — `entities.js`'s
 * rule, and the reason "Liam" once matched inside "William".
 */
function noteMentionsPerson(relativePath, personName, cache) {
  const key = `${relativePath}::${personName}`;
  if (cache && cache.has(key)) return cache.get(key);

  let verdict = false;
  const name = String(personName || '').trim();
  if (name) {
    const base = path.basename(relativePath, '.md').toLowerCase();
    if (base === name.toLowerCase()) {
      verdict = true;
    } else {
      try {
        const content = fs.readFileSync(path.join(VAULT_PATH, relativePath), 'utf-8');
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        verdict = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(content);
      } catch {
        // Unreadable is NOT a match. A scope that admits notes it could not
        // read would quietly widen exactly when the disk is misbehaving.
        verdict = false;
      }
    }
  }

  if (cache && cache.size < PERSON_CACHE_MAX) cache.set(key, verdict);
  return verdict;
}

/**
 * The one gate. Every source's output passes through it, and so does the fused
 * list — see the header. `parsed` is the output of `parseScope`.
 */
function inScope(result, parsed, cache) {
  if (!parsed) return true;
  const rel = result && result.path ? String(result.path) : '';
  if (!rel) return false;
  if (parsed.kind === 'folder') return pathInFolder(rel, parsed.value);
  if (parsed.kind === 'person') return noteMentionsPerson(rel, parsed.value, cache);
  // An unrecognised scope admits nothing. Fail CLOSED: a typo'd scope must not
  // hand back the whole vault labelled as scoped.
  return false;
}

// ── The walk ─────────────────────────────────────────────────────────────────

// Kept alongside the shared exclusion list rather than instead of it. These two
// are search-specific: `Templates` is boilerplate that matches every query, and
// the vault's own generated audit output would otherwise rank against the notes
// it describes.
const EXTRA_SKIP = new Set(['Templates', 'Vault Audit']);

function skipDir(name) {
  return name.startsWith('.') || EXTRA_SKIP.has(name) || vaultExclusions.isExcludedDir(name);
}

/**
 * Walk the permitted set, calling `visit(relativePath, fullPath)`.
 *
 * Returns `{scanned, truncated, why}`. `truncated` is the honest half: it means
 * the answer below is drawn from PART of the vault, which a consumer has to be
 * able to tell from a complete one.
 */
function walkVault(parsed, visit) {
  const state = { scanned: 0, truncated: false, why: null };
  if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
    return { ...state, truncated: true, why: 'vault path is not readable' };
  }

  const stack = [{ dir: VAULT_PATH, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (state.scanned >= MAX_FILES_SCANNED) {
      state.truncated = true;
      state.why = `scan capped at ${MAX_FILES_SCANNED} files`;
      break;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(VAULT_PATH, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        // Prune to the requested folder rather than walking the whole vault and
        // filtering — the scope is known here, and this is what makes a scoped
        // search cheap enough not to need an early stop.
        if (parsed && parsed.kind === 'folder' && !folderIsReachable(rel, parsed.value)) continue;
        if (depth + 1 > MAX_DEPTH) {
          state.truncated = true;
          state.why = `directories deeper than ${MAX_DEPTH} levels were not searched`;
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (parsed && parsed.kind === 'folder' && !pathInFolder(rel, parsed.value)) continue;
      state.scanned += 1;
      visit(rel, full);
    }
  }
  return state;
}

// ── Sources ──────────────────────────────────────────────────────────────────

function excerptsFor(body, searchTerms, limit = 2) {
  const out = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const ll = lines[i].toLowerCase();
    if (searchTerms.length === 0 || searchTerms.some((t) => ll.includes(t))) {
      if (lines[i].trim()) out.push(lines[i].substring(0, 200));
    }
  }
  return out;
}

/**
 * Keyword search over the whole permitted set.
 *
 * ⚠ No early stop. Every permitted file is scored, and only then is the list
 * sorted and cut — see the header for what the old filesystem-order stop cost.
 */
async function keywordSearch(query, options = {}) {
  const { scope, maxResults = 10, _personCache } = options;
  if (!VAULT_PATH || !query) return [];

  const parsed = options._parsed !== undefined ? options._parsed : parseScope(scope);
  const personCache = _personCache || new Map();
  const searchTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  if (searchTerms.length === 0) return [];

  const results = [];
  walkVault(parsed, (rel, full) => {
    let content;
    try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
    const lower = content.toLowerCase();
    const matchCount = searchTerms.filter((t) => lower.includes(t)).length;
    if (matchCount === 0) return;
    if (!inScope({ path: rel }, parsed, personCache)) return;

    let modified = null;
    try { modified = fs.statSync(full).mtime.toISOString(); } catch { /* still a result */ }

    results.push({
      path: rel,
      name: path.basename(rel, '.md'),
      excerpts: excerptsFor(content.replace(/^---[\s\S]*?---\n*/, ''), searchTerms),
      score: matchCount / searchTerms.length,
      sources: ['keyword'],
      modified,
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Semantic search — the embeddings index, scoped afterwards.
 *
 * Returns `{results, available, why}` rather than a bare array, because
 * "the index is empty / the query could not be embedded" and "nothing matched"
 * are different facts and the caller has to be able to say which. `null` out of
 * `embeddings.semanticSearch` is the honest degrade to keyword, NOT an empty
 * vault.
 *
 * ⚠ It over-fetches before scoping. Scope is applied to the RESULT set here
 * (the index has no folder or person column), so asking for N and filtering
 * would return a handful; asking for a multiple and cutting to N is what makes
 * a scoped semantic search return a full page.
 */
async function semanticSearchScoped(query, options = {}) {
  const { maxResults = 10, _parsed = null, _personCache } = options;
  const personCache = _personCache || new Map();
  try {
    const overFetch = _parsed ? Math.min(maxResults * 10, 200) : maxResults;
    const raw = await embeddings.semanticSearch(query, overFetch);
    if (raw === null) {
      return { results: [], available: false, why: 'embeddings unavailable — degraded to keyword search' };
    }
    const scoped = raw
      .map((r) => ({ ...r, sources: ['semantic'] }))
      .filter((r) => inScope(r, _parsed, personCache))
      .slice(0, maxResults);
    return { results: scoped, available: true, why: null };
  } catch (e) {
    console.warn('[Retrieval] Semantic search failed:', e.message);
    return { results: [], available: false, why: e.message };
  }
}

/** Back-compat: the old array-returning shape, still exported under its old name. */
async function semanticSearchWrapper(query, options = {}) {
  const parsed = options._parsed !== undefined ? options._parsed : parseScope(options.scope);
  return (await semanticSearchScoped(query, { ...options, _parsed: parsed })).results;
}

/** Temporal search — notes modified (or dated) within a range that match. */
async function temporalSearch(query, options = {}) {
  const { from, to, maxResults = 10, scope, _personCache } = options;
  if (!VAULT_PATH) return [];

  const parsed = options._parsed !== undefined ? options._parsed : parseScope(scope);
  const personCache = _personCache || new Map();
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();
  const searchTerms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 3);

  const results = [];
  walkVault(parsed, (rel, full) => {
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    const modified = new Date(stat.mtime);
    if (modified < fromDate || modified > toDate) return;

    const dateMatch = path.basename(rel).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (dateMatch) {
      const noteDate = new Date(dateMatch[1]);
      if (noteDate < fromDate || noteDate > toDate) return;
    }

    let content;
    try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
    const lower = content.toLowerCase();
    const matchCount = searchTerms.length > 0 ? searchTerms.filter((t) => lower.includes(t)).length : 1;
    if (searchTerms.length > 0 && matchCount === 0) return;
    if (!inScope({ path: rel }, parsed, personCache)) return;

    results.push({
      path: rel,
      name: path.basename(rel, '.md'),
      excerpts: excerptsFor(content.replace(/^---[\s\S]*?---\n*/, ''), searchTerms),
      score: matchCount / Math.max(searchTerms.length, 1),
      sources: ['temporal'],
      modified: stat.mtime.toISOString(),
    });
  });

  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return results.slice(0, maxResults);
}

// ── Fusion ───────────────────────────────────────────────────────────────────

/** Reciprocal Rank Fusion. score(doc) = Σ weight_i / (K + rank_i(doc)) */
function rrfFuse(rankedLists) {
  const scores = new Map();

  for (const { results, weight } of rankedLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = scores.get(item.path);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.push(...(item.sources || []));
        for (const exc of (item.excerpts || [])) {
          if (!existing.excerpts.includes(exc)) existing.excerpts.push(exc);
        }
      } else {
        scores.set(item.path, {
          path: item.path,
          name: item.name,
          excerpts: [...(item.excerpts || [])],
          score: rrfScore,
          sources: [...(item.sources || [])],
          modified: item.modified || null,
        });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ ...r, excerpts: r.excerpts.slice(0, 3), sources: [...new Set(r.sources)] }));
}

/**
 * Run every source, fuse, and re-check scope on the way out.
 *
 * Returns `{results, health}`. `search()` wraps this and returns the array
 * alone, so every existing caller is untouched.
 */
async function searchWithHealth(query, options = {}) {
  const { maxResults = 5, scope, from, to } = options;
  const parsed = parseScope(scope);
  const personCache = new Map();
  const shared = { _parsed: parsed, _personCache: personCache };

  const [keywordResults, semantic, temporalResults] = await Promise.all([
    keywordSearch(query, { ...shared, scope, maxResults: maxResults * 2 }),
    semanticSearchScoped(query, { ...shared, maxResults: maxResults * 2 }),
    (from || to) ? temporalSearch(query, { ...shared, scope, from, to, maxResults: maxResults * 2 }) : Promise.resolve([]),
  ]);

  const fused = rrfFuse([
    { results: keywordResults, weight: 1.0 },
    { results: semantic.results, weight: 1.2 },  // slight boost for semantic
    { results: temporalResults, weight: 0.8 },
  ]);

  // ⚠ The guarantee. Each source is already scoped; this is the one that holds
  // when a source added later forgets to be.
  const scoped = fused.filter((r) => inScope(r, parsed, personCache));

  // Which of these notes the index holds only PART of. `MAX_CHUNKS_PER_FILE`
  // caps a very long note at 60 chunks, and until now that was invisible — a
  // transcript whose tail was never embedded looked exactly as searchable as
  // one indexed in full.
  let incomplete = new Set();
  try {
    incomplete = new Set(embeddings.truncatedFiles());
  } catch { /* index health is a nicety on top of the answer */ }

  const results = scoped.slice(0, maxResults).map((r) => (
    incomplete.has(r.path) ? { ...r, indexIncomplete: true } : r
  ));

  return {
    results,
    health: {
      scope: parsed,
      // The honest degrade. `false` here means keyword and temporal answered
      // alone — a smaller answer, not an empty vault.
      semanticAvailable: semantic.available,
      semanticWhy: semantic.why,
      keywordCount: keywordResults.length,
      semanticCount: semantic.results.length,
      temporalCount: temporalResults.length,
      incomplete: results.filter((r) => r.indexIncomplete).map((r) => r.path),
    },
  };
}

/** The long-standing shape: an array of results. */
async function search(query, options = {}) {
  return (await searchWithHealth(query, options)).results;
}

module.exports = {
  search,
  searchWithHealth,
  keywordSearch,
  semanticSearch: semanticSearchWrapper,
  semanticSearchScoped,
  temporalSearch,
  // Pure, and the rules worth pinning without a vault.
  parseScope,
  pathInFolder,
  folderIsReachable,
  inScope,
  noteMentionsPerson,
  rrfFuse,
  walkVault,
  MAX_DEPTH,
  MAX_FILES_SCANNED,
};
