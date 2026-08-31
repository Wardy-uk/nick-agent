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
 * ── Completeness is reported, never inferred from the count ────────────────
 * `searchWithHealth` returns `health.truncated` / `truncationReasons` /
 * `keywordComplete` / `temporalComplete`, drawn from what the WALK did — a
 * missing vault, a depth limit, a file-scan cap, a bounded scoped-semantic
 * pass. A zero-result search that read everything and a zero-result search
 * that read nothing look identical from the outside, and only one of them is
 * evidence about the vault. No consumer may use the result count as a proxy.
 *
 * ── Available is not the same claim as complete ────────────────────────────
 * `semanticAvailable` only ever meant "the query embedded and the index had
 * rows". It said nothing about whether the index holds the VAULT — and it could
 * not, because the inventory walked to depth 4 while this file walked to 12, so
 * deep notes were permanently unindexed and every search over them came back
 * confident and thin. `health.semanticCoverage*` is the second question, asked
 * of `embeddings.getCoverage()` (durable, measured by the rebuild, never walked
 * on the search path), and an incomplete index makes the whole answer
 * incomplete even when the provider is perfectly healthy.
 *
 * CommonJS — NEURO backend convention.
 */

const fs = require('fs');
const path = require('path');
const embeddings = require('./embeddings');
const vaultExclusions = require('./vault-exclusions');
const vaultWalk = require('./vault-walk');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const RRF_K = 60; // standard RRF constant

// ⚠ The traversal policy now lives in `vault-walk.js`, shared with the
// embeddings inventory. They used to disagree — retrieval reached depth 12 and
// the index stopped at depth 4, so a deep note was findable by keyword and
// could never be indexed for semantic search. Re-exported here because callers
// and tests read them from this module.
const MAX_DEPTH = vaultWalk.MAX_DEPTH;
const MAX_FILES_SCANNED = vaultWalk.MAX_FILES_SCANNED;

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

/**
 * Is this note inside the requested date window? PURE.
 *
 * A dated daily note (`2026-08-20.md`) is judged on the DATE IN ITS NAME as
 * well as its mtime — Syncthing and NEURO's own hooks rewrite mtimes, so a note
 * about last Tuesday touched this morning is still about last Tuesday.
 */
function matchesDateRange(relativePath, modified, fromDate, toDate) {
  const when = modified instanceof Date ? modified : new Date(modified);
  if (Number.isNaN(when.getTime())) return false;
  if (when < fromDate || when > toDate) return false;
  const dateMatch = path.basename(String(relativePath || '')).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (dateMatch) {
    const noteDate = new Date(dateMatch[1]);
    if (noteDate < fromDate || noteDate > toDate) return false;
  }
  return true;
}

/**
 * Parse one end of a temporal range. PURE.
 *
 * ⚠ `new Date(x)` accepts almost anything and answers `Invalid Date` for the
 * rest, and the old code fed that straight into a comparison — where EVERY
 * comparison against `NaN` is false, so an invalid bound silently became an
 * UNBOUNDED one. Asking for notes since "lastweek" therefore searched all time
 * and reported itself as a date-bounded search. A typo must be a 400, never a
 * wider answer wearing the caller's label.
 *
 * Accepted, and nothing else:
 *   - a calendar date, `YYYY-MM-DD`
 *   - a full ISO timestamp, which must round-trip
 *
 * A date-only bound is interpreted in UTC, and `to` is taken as the END of that
 * day. ⚠ That is a deliberate fix: `new Date('2026-08-31')` is midnight, so
 * `to=2026-08-31` used to exclude everything that happened ON the 31st — a
 * whole day quietly missing from the one search whose entire purpose is a date
 * range.
 *
 * @returns {{ok:true, date:Date}|{ok:false, error:string}}
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBound(value, { end = false } = {}) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { ok: false, error: 'not a valid date' }
      : { ok: true, date: value };
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: false, error: 'empty' };

  if (DATE_ONLY.test(raw)) {
    const date = new Date(`${raw}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (Number.isNaN(date.getTime())) return { ok: false, error: `not a valid calendar date: ${raw}` };
    // `2026-02-31` parses as 2 March. Round-tripping the day is what catches it.
    if (date.toISOString().slice(0, 10) !== raw) {
      return { ok: false, error: `not a real calendar date: ${raw}` };
    }
    return { ok: true, date };
  }

  // A full timestamp. Deliberately strict: anything Date can guess at but not
  // reproduce is a typo, not a date.
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { ok: false, error: `not a valid ISO date or timestamp: ${raw}` };
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    return { ok: false, error: `not an ISO date or timestamp: ${raw}` };
  }
  return { ok: true, date };
}

/**
 * Validate and normalise a whole `from`/`to` range. PURE.
 *
 * An OMITTED bound keeps the long-standing default (30 days back / now); an
 * INVALID one is an error. Those are different acts and must not share a
 * behaviour — defaulting a typo is how a bounded search silently becomes an
 * unbounded one.
 *
 * @returns {{ok:true, from:Date, to:Date, fromIso:string, toIso:string,
 *            fromDefaulted:boolean, toDefaulted:boolean}
 *          |{ok:false, field:string, error:string}}
 */
function parseDateRange({ from, to, now = new Date(), defaultDays = 30 } = {}) {
  let fromDate;
  let toDate;
  const fromDefaulted = from === undefined || from === null || String(from).trim() === '';
  const toDefaulted = to === undefined || to === null || String(to).trim() === '';

  if (fromDefaulted) {
    fromDate = new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  } else {
    const parsed = parseDateBound(from, { end: false });
    if (!parsed.ok) return { ok: false, field: 'from', error: `Invalid "from" — ${parsed.error}` };
    fromDate = parsed.date;
  }

  if (toDefaulted) {
    toDate = new Date(now.getTime());
  } else {
    const parsed = parseDateBound(to, { end: true });
    if (!parsed.ok) return { ok: false, field: 'to', error: `Invalid "to" — ${parsed.error}` };
    toDate = parsed.date;
  }

  if (fromDate > toDate) {
    return {
      ok: false,
      field: 'range',
      error: `Invalid range — "from" (${fromDate.toISOString()}) is later than "to" (${toDate.toISOString()})`,
    };
  }

  return {
    ok: true,
    from: fromDate,
    to: toDate,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    fromDefaulted,
    toDefaulted,
  };
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
/**
 * The traversal record for a walk that never happened. Shared with the walker,
 * so "we could not look" has one definition.
 */
function noTraversal(why) {
  return vaultWalk.noWalk(why);
}

/**
 * Walk the permitted set, calling `visit(relativePath, fullPath)`.
 *
 * Returns the shared walker's record: `{scanned, truncated, why, reasons,
 * inaccessible, inaccessibleCount, excluded}`. `truncated` is the honest half —
 * it means the answer below is drawn from PART of the vault, which a consumer
 * has to be able to tell from a complete one.
 */
function walkVault(parsed, visit, bounds = {}) {
  return vaultWalk.walk(VAULT_PATH, {
    maxDepth: bounds.maxDepth,
    maxFiles: bounds.maxFiles,
    skipDir,
    // Prune to the requested folder rather than walking the whole vault and
    // filtering — the scope is known here, and this is what makes a scoped
    // search cheap enough not to need an early stop. Out of scope is NOT a gap.
    pruneDir: (relDir) => !(parsed && parsed.kind === 'folder') || folderIsReachable(relDir, parsed.value),
    skipFile: (rel) => Boolean(parsed && parsed.kind === 'folder' && !pathInFolder(rel, parsed.value)),
    visit,
  });
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
async function keywordSearchDetailed(query, options = {}) {
  const { scope, maxResults = 10, _personCache, _bounds } = options;
  if (!VAULT_PATH) {
    return { results: [], traversal: noTraversal('vault path is not configured') };
  }
  if (!query) {
    return { results: [], traversal: noTraversal('no query given to keyword search') };
  }

  const parsed = options._parsed !== undefined ? options._parsed : parseScope(scope);
  const personCache = _personCache || new Map();
  const searchTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  if (searchTerms.length === 0) {
    // The keyword arm did not run. That is a smaller answer, not a complete one.
    return { results: [], traversal: noTraversal('keyword search needs a term of at least 3 characters') };
  }

  const results = [];
  const traversal = walkVault(parsed, (rel, full) => {
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
  }, _bounds);

  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, maxResults), traversal };
}

/** Back-compat: the array-returning shape every existing caller uses. */
async function keywordSearch(query, options = {}) {
  return (await keywordSearchDetailed(query, options)).results;
}

/**
 * Semantic search — the embeddings index, scoped where the index can answer it.
 *
 * Returns `{results, available, why, recall, boundedRecall}` rather than a bare
 * array, because "the index is empty / the query could not be embedded" and
 * "nothing matched" are different facts and the caller has to be able to say
 * which. `null` out of the embeddings layer is the honest degrade to keyword,
 * NOT an empty vault.
 *
 * ⚠ It no longer over-fetches the global top 200 and filters. That was the
 * recall bug: a `folder:` scope whose notes all ranked 201st and below came
 * back empty, and looked exactly like a folder with nothing in it. The index
 * stores `relative_path`, which is all a folder scope needs, so the candidate
 * set is narrowed BEFORE ranking — exact recall, and cheaper.
 *
 * A `person:` scope cannot be decided from the path (it means reading the
 * note), so it stays a post-filter over the ranked list — but a BOUNDED one
 * that reports when it stopped looking, rather than a fixed 200-candidate
 * window that never said so. The scope itself is never widened to compensate.
 */
async function semanticSearchScoped(query, options = {}) {
  const { maxResults = 10, _parsed = null, _personCache } = options;
  const personCache = _personCache || new Map();

  let pathFilter = null;
  let postFilter = null;
  if (_parsed) {
    if (_parsed.kind === 'folder') {
      pathFilter = (rel) => pathInFolder(rel, _parsed.value);
    } else if (_parsed.kind === 'person') {
      postFilter = (rel) => noteMentionsPerson(rel, _parsed.value, personCache);
    } else {
      // Unrecognised scope admits nothing — fail CLOSED, as `inScope` does.
      pathFilter = () => false;
    }
  }

  // ⚠ Asked whether or not the query succeeds, because the two failures are
  // independent: a working provider over a half-built index is the quiet one.
  // Cheap by construction — one KV read, never a walk.
  let coverage;
  try { coverage = embeddings.coverageForScope(embeddings.getCoverage(), _parsed); }
  catch { coverage = { known: false, complete: null, reasons: ['coverage could not be read'] }; }

  try {
    const detail = await embeddings.semanticSearchDetailed(query, maxResults, { pathFilter, postFilter });
    if (!detail || detail.results === null) {
      return {
        results: [],
        available: false,
        why: (detail && detail.why) || 'embeddings unavailable — degraded to keyword search',
        recall: 'none',
        boundedRecall: false,
        coverage,
      };
    }
    // Belt and braces: the gate runs over the source's output too, so a filter
    // that is ever wired up wrongly cannot leak past this function.
    const scoped = detail.results
      .map((r) => ({ ...r, sources: ['semantic'] }))
      .filter((r) => inScope(r, _parsed, personCache))
      .slice(0, maxResults);
    return {
      results: scoped,
      available: true,
      why: null,
      recall: detail.recall || 'exact',
      boundedRecall: detail.boundedRecall === true,
      coverage,
    };
  } catch (e) {
    console.warn('[Retrieval] Semantic search failed:', e.message);
    return { results: [], available: false, why: e.message, recall: 'none', boundedRecall: false, coverage };
  }
}

/** Back-compat: the old array-returning shape, still exported under its old name. */
async function semanticSearchWrapper(query, options = {}) {
  const parsed = options._parsed !== undefined ? options._parsed : parseScope(options.scope);
  return (await semanticSearchScoped(query, { ...options, _parsed: parsed })).results;
}

/**
 * Temporal search — notes modified (or dated) within a range that match.
 *
 * Returns `{results, traversal}` for the same reason keyword search does: a
 * date-bounded answer drawn from part of the vault has to be distinguishable
 * from one drawn from all of it.
 */
async function temporalSearchDetailed(query, options = {}) {
  const { from, to, maxResults = 10, scope, _personCache, _bounds } = options;

  // ⚠ An invalid bound is an EMPTY range here, never an unbounded one — every
  // comparison against Invalid Date is false, which is how a typo used to
  // become a search of all time wearing the caller's date label. The route
  // validates first and 400s; this is the backstop for a programmatic caller.
  //
  // Checked BEFORE the vault, deliberately: a bad range is a caller error and
  // is the same error whatever the environment, so reporting "no vault" over it
  // would hide a typo behind a deployment problem.
  const range = parseDateRange({ from, to });
  if (!range.ok) {
    return { results: [], traversal: noTraversal(`temporal range rejected: ${range.error}`) };
  }

  if (!VAULT_PATH) {
    return { results: [], traversal: noTraversal('vault path is not configured') };
  }

  const parsed = options._parsed !== undefined ? options._parsed : parseScope(scope);
  const personCache = _personCache || new Map();
  const fromDate = range.from;
  const toDate = range.to;
  const searchTerms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 3);

  const results = [];
  const traversal = walkVault(parsed, (rel, full) => {
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    if (!matchesDateRange(rel, stat.mtime, fromDate, toDate)) return;

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
  }, _bounds);

  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return { results: results.slice(0, maxResults), traversal };
}

/** Back-compat: the array-returning shape. */
async function temporalSearch(query, options = {}) {
  return (await temporalSearchDetailed(query, options)).results;
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
  const { maxResults = 5, scope, from, to, maxDepth, maxFiles } = options;
  const parsed = parseScope(scope);
  const personCache = new Map();
  // Bounds on the walk. Defaulted in `walkVault`; passed through so a caller
  // (and a test) can drive the caps that make an answer partial.
  const _bounds = (maxDepth !== undefined || maxFiles !== undefined) ? { maxDepth, maxFiles } : undefined;
  const shared = { _parsed: parsed, _personCache: personCache, _bounds };
  const temporalAsked = Boolean(from || to);

  const [keyword, semantic, temporal] = await Promise.all([
    keywordSearchDetailed(query, { ...shared, scope, maxResults: maxResults * 2 }),
    semanticSearchScoped(query, { ...shared, maxResults: maxResults * 2 }),
    temporalAsked
      ? temporalSearchDetailed(query, { ...shared, scope, from, to, maxResults: maxResults * 2 })
      : Promise.resolve(null),
  ]);

  const temporalResults = temporal ? temporal.results : [];

  const fused = rrfFuse([
    { results: keyword.results, weight: 1.0 },
    { results: semantic.results, weight: 1.2 },  // slight boost for semantic
    { results: temporalResults, weight: 0.8 },
  ]);

  // ⚠ The guarantee. Each source is already scoped; this is the one that holds
  // when a source added later forgets to be.
  let scoped = fused.filter((r) => inScope(r, parsed, personCache));

  // ⚠ A date range is a BOUND, not a ranking hint. Fusion mixes in keyword and
  // semantic hits that never saw the range, so without this a search for "last
  // week" happily returns a note from March, ranked above the ones from last
  // week — the temporal endpoint's own promise, silently broken by the very
  // refactor that made it honest about everything else.
  if (temporalAsked) {
    // ⚠ The SAME validated bounds the temporal arm used. Re-deriving them here
    // with `new Date(from)` was how an invalid bound became an unbounded gate
    // that let everything through while the arm above filtered properly.
    const range = parseDateRange({ from, to });
    const fromDate = range.ok ? range.from : new Date(0);
    const toDate = range.ok ? range.to : new Date(0);
    scoped = scoped.filter((r) => {
      let modified = r.modified;
      if (!modified) {
        // A semantic hit carries no mtime. Read it rather than admitting it —
        // an unreadable note is NOT in range, the same way it is not in scope.
        try { modified = fs.statSync(path.join(VAULT_PATH, r.path)).mtime; }
        catch { return false; }
      }
      return matchesDateRange(r.path, modified, fromDate, toDate);
    });
  }

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

  // ── The completeness contract ──────────────────────────────────────────────
  // ⚠ Completeness is a fact about the SEARCH, never about the result count.
  // A search that read the whole vault and found nothing, and one that could
  // not read the vault at all, both return zero results — and only one of them
  // is evidence about what the vault contains.
  const truncationReasons = [];
  if (keyword.traversal.truncated && keyword.traversal.why) {
    truncationReasons.push(`keyword: ${keyword.traversal.why}`);
  }
  if (temporal && temporal.traversal.truncated && temporal.traversal.why) {
    truncationReasons.push(`temporal: ${temporal.traversal.why}`);
  }
  if (semantic.boundedRecall) {
    const kind = parsed ? `${parsed.kind} ` : '';
    truncationReasons.push(`semantic: the ${kind}scope stopped after examining the top-ranked candidates`);
  }

  const keywordComplete = !keyword.traversal.truncated;
  const temporalComplete = temporal ? !temporal.traversal.truncated : null;
  const truncated = !keywordComplete || temporalComplete === false || semantic.boundedRecall;

  // ⚠ Semantic COVERAGE — a different question from `semanticAvailable`, and
  // the one nobody was asking. `null` means never measured, which is reported
  // as its own state and never as `true`.
  const cov = semantic.coverage || { known: false, complete: null, reasons: [] };
  const semanticCoverageComplete = cov.known === true ? cov.complete === true : null;
  const semanticCoverageReasons = cov.known === true
    ? (cov.complete === true ? [] : (cov.reasons || []))
    : ['semantic index coverage has not been measured yet'];

  return {
    results,
    health: {
      scope: parsed,
      // The honest degrade. `false` here means keyword and temporal answered
      // alone — a smaller answer, not an empty vault.
      semanticAvailable: semantic.available,
      semanticWhy: semantic.why,
      // How the scope was applied to the index. `exact` = every permitted note
      // was ranked; `bounded` = the ranked list was walked only so far, and
      // `boundedRecall` says whether that bound was actually hit.
      semanticRecall: semantic.recall,
      semanticBoundedRecall: semantic.boundedRecall === true,
      // ⚠ The stable fields a consumer should switch on.
      truncated,
      truncationReasons,
      keywordComplete,
      // null means temporal was not requested — distinct from "it ran and was
      // complete", which is `true`.
      temporalComplete,
      filesScanned: keyword.traversal.scanned + (temporal ? temporal.traversal.scanned : 0),
      // ── Semantic coverage ──────────────────────────────────────────────
      // true / false / null, where null is "not measured" — never conflate it
      // with true, which is the whole reason it is three-valued.
      semanticCoverageComplete,
      semanticCoverageKnown: cov.known === true,
      semanticCoverageReasons,
      semanticEligibleCount: cov.eligible != null ? cov.eligible : null,
      semanticIndexedCount: cov.indexed != null ? cov.indexed : null,
      semanticUnindexedCount: cov.unindexed != null ? cov.unindexed : null,
      // A bounded sample, never the whole list: the counts above are exact.
      semanticUnindexedPaths: cov.unindexedSample || [],
      semanticStaleCount: cov.stale != null ? cov.stale : null,
      semanticFailedCount: cov.failed != null ? cov.failed : null,
      semanticInaccessibleCount: cov.inaccessible != null ? cov.inaccessible : null,
      semanticCoverageScope: cov.scoped || null,
      semanticCoverageAt: cov.at || null,
      keywordCount: keyword.results.length,
      semanticCount: semantic.results.length,
      temporalCount: temporalResults.length,
      incomplete: results.filter((r) => r.indexIncomplete).map((r) => r.path),
    },
  };
}

/**
 * Put a `health` block into one sentence a model or a person can act on. PURE.
 *
 * ⚠ Traversal incompleteness is treated EXACTLY like semantic degradation, and
 * that is the point: a depth cap, a file cap, an unreadable vault and a dead
 * embeddings index all produce the same short list, and none of them is
 * evidence about what the vault holds. Answering "I could not find anything"
 * over any of them is the failure this whole area exists to prevent.
 *
 * Returns `{incomplete, reasons, note}`; `note` is null when the search was
 * complete, so a caller can say nothing rather than reassure.
 */
function describeIncompleteness(health) {
  if (!health) return { incomplete: false, reasons: [], note: null };
  const reasons = [];
  if (health.semanticAvailable === false) {
    reasons.push('semantic search was unavailable, so this is keyword matching only');
  }
  for (const r of (health.truncationReasons || [])) reasons.push(r);
  if (health.truncated && reasons.length === 0) reasons.push('part of the vault was not searched');
  // ⚠ A coverage gap gets the SAME warning as a dead provider or a capped walk.
  // A note that is not in the index is not findable by semantic search, and the
  // result set looks identical either way — which is the entire problem.
  const coverageGap = health.semanticCoverageComplete === false;
  if (coverageGap) {
    const why = (health.semanticCoverageReasons || []).filter(Boolean);
    reasons.push(why.length
      ? `the semantic index does not cover the whole vault (${why.join('; ')})`
      : 'the semantic index does not cover the whole vault');
  }
  const incomplete = health.semanticAvailable === false || health.truncated === true || coverageGap;
  if (!incomplete) return { incomplete: false, reasons: [], note: null };
  return {
    incomplete: true,
    reasons,
    note: `This search was INCOMPLETE (${reasons.join('; ')}). A thin or empty result here is not confirmation that nothing exists.`,
  };
}

/** The long-standing shape: an array of results. */
async function search(query, options = {}) {
  return (await searchWithHealth(query, options)).results;
}

module.exports = {
  search,
  searchWithHealth,
  describeIncompleteness,
  keywordSearch,
  keywordSearchDetailed,
  semanticSearch: semanticSearchWrapper,
  semanticSearchScoped,
  temporalSearch,
  temporalSearchDetailed,
  // Pure, and the rules worth pinning without a vault.
  parseScope,
  pathInFolder,
  folderIsReachable,
  inScope,
  matchesDateRange,
  parseDateBound,
  parseDateRange,
  noteMentionsPerson,
  rrfFuse,
  walkVault,
  noTraversal,
  MAX_DEPTH,
  MAX_FILES_SCANNED,
};
