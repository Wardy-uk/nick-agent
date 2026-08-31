'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const exclusions = require('./vault-exclusions');
const vaultWalk = require('./vault-walk');
const MAX_CHUNK_CHARS = 1500; // keep well within token limits
// Bounds cost on genuine outliers, nothing more. It is NOT there to stop a long
// note dominating results — semanticSearch folds to the best chunk per file,
// which solves that properly.
//
// Measured against the live vault (1,091 indexable notes, 15 Aug): median 4
// chunks, p90 20, p99 60, max 151. A cap of 20 therefore truncated 107 files —
// the top 10%, which is precisely the population this whole fix exists for, and
// would have reintroduced the same bug at 30k characters instead of 1,500. At
// 60 it catches 10 files and costs 21% more chunks. Truncation is logged.
const MAX_CHUNKS_PER_FILE = 60;
const BATCH_SIZE = 16; // chunks per Voyage API call
const BATCH_DELAY_MS = 21000; // 21s between batches (free tier = 3 RPM)

// Embedding calls authenticate with VOYAGE_API_KEY. This used to read
// ANTHROPIC_API_KEY, which is a different vendor entirely — both happen to be
// set on the Pi, so it worked, and would have stopped working silently the day
// the (out-of-credit) Anthropic key was removed from .env: `vault-hooks` gates
// on-write re-embedding on this, so live indexing would have died while the
// nightly rebuild carried on and nothing looked broken.
function isConfigured() {
  return !!process.env.VOYAGE_API_KEY;
}

// voyage-3.5-lite returns 1024 dimensions; computeSimpleVector returns 128.
// The gap is not cosmetic — cosineSimilarity() returns 0 whenever the lengths
// differ, so a fallback vector sitting in the index is not "a worse match", it
// is UNREACHABLE by any real query, while still occupying the row that says the
// file is indexed.
const VOYAGE_DIMENSIONS = 1024;
const FALLBACK_DIMENSIONS = 128;

function isRealEmbedding(vector) {
  return Array.isArray(vector) && vector.length === VOYAGE_DIMENSIONS;
}

// Is what we stored for this row a usable vector, or a fallback that will score
// 0 against every query? With no key configured the whole index is hash vectors
// and that is self-consistent, so there is nothing to re-embed.
function _storedIsReal(row) {
  if (!isConfigured()) return true;
  if (!row || !row.embedding) return false;
  try { return isRealEmbedding(JSON.parse(row.embedding)); }
  catch { return false; }
}

/**
 * #56 — what the embedding path actually did, rather than whether it is
 * configured. Follows `getBridgeHealth` (#65): "not probed" is a real third
 * state, distinct from working, and a degraded path must never read as healthy.
 *
 * Voyage bypasses ai-routing entirely — no budget, no telemetry, nothing on the
 * AI panel — so before this a failure was visible only as a console.warn that
 * nobody was reading. On 13 Aug it timed out and the only trace was vault search
 * quietly getting worse.
 */
const _health = {
  lastOk: null,
  lastFailure: null,
  lastError: null,
  calls: 0,
  failures: 0,
  fallbacksServed: 0,
  writesSkipped: 0,
};

function _recordOk() {
  _health.calls++;
  _health.lastOk = new Date().toISOString();
}

function _recordFailure(reason) {
  _health.calls++;
  _health.failures++;
  _health.lastFailure = new Date().toISOString();
  _health.lastError = reason;
  console.warn(`[Embeddings] DEGRADED — ${reason}. Falling back to hash vectors; `
    + `these are not written to the index.`);
}

function getEmbeddingHealth() {
  const configured = isConfigured();
  let status;
  if (!configured) status = 'not-configured';
  else if (_health.calls === 0) status = 'unprobed';
  else if (_health.lastFailure && (!_health.lastOk || _health.lastFailure > _health.lastOk)) status = 'degraded';
  else status = 'ok';
  const truncated = truncatedDetail();
  return {
    status,
    configured,
    ...(_health),
    // Not folded into `status`: the index being partly short on a handful of very
    // long notes is a different fact from Voyage being down, and merging them
    // would make one of the two unactionable.
    truncatedCount: truncated.length,
    truncated,
    // ⚠ Separate from `status`, and it must stay separate: `status` is about the
    // PROVIDER (is Voyage answering) and this is about the INDEX (does it hold
    // your vault). A green provider over a half-built index is precisely the
    // false all-clear this exists to stop.
    coverage: getCoverage(),
  };
}


// ── Index health: notes the cap could only partly index ─────────────────────
//
// Persisted rather than held in memory: the backend restarts several times a
// day on deploys, and an in-memory list would report a clean index every time —
// the `ai-routing` budget lesson, one service along.

const TRUNCATED_KEY = 'embeddings_truncated';

function _readTruncated() {
  try {
    const raw = db.getState(TRUNCATED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function _writeTruncated(map) {
  try { db.setState(TRUNCATED_KEY, JSON.stringify(map)); } catch { /* health is bookkeeping */ }
}

function _noteTruncated(relativePath, totalChunks) {
  const map = _readTruncated();
  map[relativePath] = { totalChunks, indexed: MAX_CHUNKS_PER_FILE, at: new Date().toISOString() };
  _writeTruncated(map);
}

function _clearTruncated(relativePath) {
  const map = _readTruncated();
  if (!Object.prototype.hasOwnProperty.call(map, relativePath)) return;
  delete map[relativePath];
  _writeTruncated(map);
}

/** Vault-relative paths the index holds only part of. */
function truncatedFiles() {
  return Object.keys(_readTruncated());
}

/** The same, with how much of each note was reachable. */
function truncatedDetail() {
  const map = _readTruncated();
  return Object.entries(map).map(([relativePath, v]) => ({ relativePath, ...v }));
}

function contentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end === -1) return content;
  return content.slice(end + 3).replace(/^\n+/, '');
}

function chunkText(text) {
  // Split on paragraph breaks — keep chunks under MAX_CHUNK_CHARS
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 20);
}

/**
 * Batch embed multiple texts in a single Voyage API call.
 *
 * Returns null when the call fails — it used to return hash vectors, which the
 * caller then wrote into the index alongside real ones, stamped with the real
 * content hash. That is the #56 bug in one line: the file looks indexed, so the
 * rebuild's unchanged-check skips it forever, and every chunk of it scores 0
 * against every query. Measured on the live index: 74 such rows across 32 files,
 * including whole meeting transcripts (16 chunks of one, 13 of another) that
 * were simply absent from semantic search.
 *
 * With no key at all the fallback is still used and still returned: that mode is
 * self-consistent, because the queries are hashed the same way. It is only the
 * MIXTURE that is silently broken.
 */
async function getBatchEmbeddings(texts) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return texts.map(t => computeSimpleVector(t));

  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'voyage-3.5-lite',
        input: texts.map(t => t.substring(0, 4000)),
        input_type: 'document'
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 429) {
        console.warn('[Embeddings] Voyage 429 rate limited');
        return null; // signal rate limit — caller should wait and retry
      }
      _recordFailure(`Voyage API ${res.status}: ${err.substring(0, 120)}`);
      return null;
    }
    const data = await res.json();
    const out = texts.map((_, i) => data.data?.[i]?.embedding);
    // A partial response is a failure too: writing the chunks that came back
    // and hash vectors for the rest is exactly how a file ends up half-findable
    // while counting as fully indexed.
    if (!out.every(isRealEmbedding)) {
      _recordFailure(`Voyage returned ${out.filter(isRealEmbedding).length}/${texts.length} usable vectors`);
      return null;
    }
    _recordOk();
    return out;
  } catch (e) {
    _recordFailure(`Voyage batch call failed: ${e.message}`);
    return null;
  }
}

async function getEmbedding(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return computeSimpleVector(text);

  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'voyage-3.5-lite',
        input: [text.substring(0, 4000)],
        input_type: 'document'
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      _recordFailure(`Voyage API ${res.status}: ${err.substring(0, 120)}`);
      return null;
    }
    const data = await res.json();
    const vec = data.data?.[0]?.embedding;
    if (!isRealEmbedding(vec)) {
      _recordFailure('Voyage returned no usable vector');
      return null;
    }
    _recordOk();
    return vec;
  } catch (e) {
    _recordFailure(`Voyage call failed: ${e.message}`);
    return null;
  }
}

async function getQueryEmbedding(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return computeSimpleVector(text);

  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'voyage-3.5-lite',
        input: [text.substring(0, 4000)],
        input_type: 'query'
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      _recordFailure(`Voyage query embed ${res.status}`);
      return null;
    }
    const data = await res.json();
    const vec = data.data?.[0]?.embedding;
    if (!isRealEmbedding(vec)) {
      _recordFailure('Voyage query embed returned no usable vector');
      return null;
    }
    _recordOk();
    return vec;
  } catch (e) {
    // Deliberately null rather than a hash vector: against a 1024-dim index a
    // 128-dim query scores 0 on every row, so search would return NOTHING and
    // look like an empty vault. Null makes semanticSearch hand back to keyword
    // search, which is a real answer.
    _recordFailure(`Voyage query embed failed: ${e.message}`);
    return null;
  }
}

// Simple TF-IDF style vector — 128 dimensions based on word hashing
// Used as fallback when embeddings API unavailable
function computeSimpleVector(text) {
  const STOP_WORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for',
    'of','with','is','are','was','were','it','this','that','be','have','has','had']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  const vector = new Array(128).fill(0);
  for (const word of words) {
    // Hash word to bucket
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash * 31 + word.charCodeAt(i)) & 0x7fffffff;
    }
    vector[hash % 128] += 1;
  }
  // Normalize
  const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => v / magnitude);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

// Prepare a file for embedding — returns { relativePath, hash, chunks[], modified } or null.
//
// This used to compute every chunk and then return `chunks[0]`, throwing the
// rest away — 3,216 rows in the DB, every one chunk_index 0. So semantic search,
// chat RAG, related_notes and the MCP tools only ever saw the first ~1,500
// characters of a note: for a meeting transcript that is the frontmatter and the
// opening exchange, and everything DECIDED in the back half was unreachable.
// It was invisible because search always returns something.
function prepareFile(relativePath, fullPath) {
  let content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); }
  catch { return null; }

  const body = stripFrontmatter(content);
  if (body.trim().length < 20) return null;

  const hash = contentHash(body);
  let modified;
  try { modified = fs.statSync(fullPath).mtime.toISOString(); }
  catch { return null; }

  // Unchanged only if the content matches AND every chunk of it is stored AND
  // what is stored is a real embedding — otherwise a file indexed under the old
  // chunk-0-only code would look done forever and never pick up its remaining
  // chunks, and (#56) a file embedded during a Voyage outage would keep its
  // unreachable hash vectors for as long as nobody edited it. 74 rows across 32
  // files were in exactly that state, the oldest since 18 June.
  const existing = db.getEmbedding(relativePath);
  let chunks = chunkText(body);
  if (chunks.length === 0) return null;
  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    console.warn(`[Embeddings] ${relativePath}: ${chunks.length} chunks, indexing first ${MAX_CHUNKS_PER_FILE}`);
    // ⚠ RECORDED, not merely logged. A note whose tail was never embedded looks
    // exactly as searchable as one indexed in full — the search returns three
    // good hits from its first half and nothing says the rest is unreachable.
    // Retrieval reads this back and marks such a result `indexIncomplete`, so
    // "partly indexed" stays distinguishable from "fully indexed and this is
    // all there is". Recorded BEFORE the slice, so the number is the note's
    // real size and not the cap.
    _noteTruncated(relativePath, chunks.length);
    chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);
  } else {
    // A note that has SHRUNK below the cap is no longer incomplete, and leaving
    // a stale entry would keep flagging a note that is now fully indexed —
    // exactly the kind of permanent false warning nobody reads by week two.
    _clearTruncated(relativePath);
  }
  if (existing && existing.content_hash === hash
      && db.getEmbeddingChunkCount(relativePath) === chunks.length
      && _storedIsReal(existing)) {
    return null; // unchanged and fully indexed
  }

  return { relativePath, hash, chunks, modified };
}

async function embedVaultFile(relativePath, fullPath) {
  const prepared = prepareFile(relativePath, fullPath);
  if (!prepared) return false;

  const embeddings = await getBatchEmbeddings(prepared.chunks);
  if (!embeddings) {
    // Leave the file alone. Its old rows (if any) stay searchable, and it stays
    // un-stamped so the next run retries it — where writing hash vectors here
    // would mark it done forever with content nothing can reach.
    _health.writesSkipped++;
    _noteFailed(relativePath, _health.lastError || 'embedding unavailable');
    console.warn(`[Embeddings] ${relativePath}: embedding unavailable — left unindexed for the next run`);
    return false;
  }

  // Clear first: a shortened note has fewer chunks than last time, and
  // INSERT OR REPLACE alone would leave the tail behind as orphan rows.
  db.deleteEmbedding(prepared.relativePath);
  prepared.chunks.forEach((chunk, i) => {
    db.saveEmbedding(prepared.relativePath, prepared.hash, embeddings[i], chunk, prepared.modified, i);
  });
  _clearFailed(prepared.relativePath);
  return true;
}

/**
 * Every note this index is SUPPOSED to hold, plus an account of the walk.
 *
 * ⚠ This was hard-coded to **depth 4** while retrieval reached depth 12. So a
 * note in `Meetings/2026/08/deep/` was findable by keyword and could never be
 * indexed for semantic search — permanently, silently, and invisibly, because
 * a hybrid search always returns something. The traversal policy now comes from
 * `vault-walk.js`, shared with retrieval, so the two cannot drift again.
 *
 * The EXCLUSION policy stays embeddings-specific on purpose: `Daily/` is out of
 * the semantic index (hundreds of scratchpads ruin it) and deliberately kept
 * for entity extraction. That is a decision, not drift.
 *
 * Returns `{files, traversal}`. `listVaultFiles()` keeps the bare-array shape.
 */
function inventoryVaultFiles() {
  if (!VAULT_PATH) return { files: [], traversal: vaultWalk.noWalk('vault path is not configured') };
  const files = [];
  const traversal = vaultWalk.walk(VAULT_PATH, {
    skipDir: (name) => name.startsWith('.') || exclusions.isExcludedDir(name, { forEmbeddings: true }),
    skipFile: (rel) => exclusions.isExcludedPath(rel, { forEmbeddings: true }),
    visit: (relativePath, fullPath) => files.push({ relativePath, fullPath }),
  });
  return { files, traversal };
}

/** Back-compat: the long-standing array shape. */
function listVaultFiles() {
  return inventoryVaultFiles().files;
}


// ── Index coverage: what the semantic index can and cannot see ──────────────
//
// ⚠ THE POINT. "The embeddings provider answered my query" and "the index holds
// your vault" are different claims, and until now only the first was ever
// checked. A vault indexed to depth 4, or half-indexed by a rebuild that ran
// out of Voyage quota, answered every search with a confident, complete-looking
// result set drawn from part of itself.
//
// The report is DURABLE (`agent_state`) and read synchronously by the search
// path — the `team-availability` split: `getCoverage()` is a cheap cache read
// that never does I/O beyond one KV get, `refreshCoverage()` is the pass that
// walks. A failed refresh KEEPS the previous report rather than emptying it,
// because "we measured and it was fine an hour ago" beats "no idea".

const COVERAGE_KEY = 'embeddings_coverage';
const FAILED_KEY = 'embeddings_failed';

// How many unindexed paths are named. The COUNTS are always exact; the sample
// is bounded so a never-indexed vault cannot write a megabyte of health.
const MAX_COVERAGE_SAMPLE = 25;

function _readJsonState(key, fallback) {
  try {
    const raw = db.getState(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function _writeJsonState(key, value) {
  try { db.setState(key, JSON.stringify(value)); } catch { /* health is bookkeeping */ }
}

/**
 * Files a run could not embed, and why. Durable, because the backend restarts
 * several times a day and an in-memory list would report a clean index every
 * deploy — the `ai-routing` budget lesson, one service along.
 */
function _readFailed() { return _readJsonState(FAILED_KEY, {}); }

function _noteFailed(relativePath, reason) {
  const map = _readFailed();
  const prior = map[relativePath];
  map[relativePath] = {
    reason,
    at: new Date().toISOString(),
    attempts: (prior && prior.attempts ? prior.attempts : 0) + 1,
  };
  _writeJsonState(FAILED_KEY, map);
}

function _clearFailed(relativePath) {
  const map = _readFailed();
  if (!Object.prototype.hasOwnProperty.call(map, relativePath)) return;
  delete map[relativePath];
  _writeJsonState(FAILED_KEY, map);
}

/** Paths a previous run left unindexed, with the reason. */
function failedFiles() {
  return Object.entries(_readFailed()).map(([relativePath, v]) => ({ relativePath, ...v }));
}

/**
 * Measure what the index holds against what the vault contains. Walks.
 *
 * Stores the result and returns it. Never throws: a coverage pass that dies
 * must not take down the caller that scheduled it.
 */
function refreshCoverage() {
  try {
    const { files, traversal } = inventoryVaultFiles();

    // One row per note, WITHOUT the vectors — see `getEmbeddingIndexSummary`.
    const indexed = new Map();
    try {
      for (const row of db.getEmbeddingIndexSummary()) indexed.set(row.relative_path, row);
    } catch (e) {
      // We could not read the index. That is emphatically not "the index is
      // empty" — keep the last known report rather than publishing a scare.
      console.warn('[Embeddings] Coverage: index unreadable —', e.message);
      return getCoverage();
    }

    const unindexed = [];
    const stale = [];
    for (const { relativePath, fullPath } of files) {
      const row = indexed.get(relativePath);
      if (!row) { unindexed.push(relativePath); continue; }
      // Stale by MTIME, which is a stat rather than a full read. The content
      // hash is the authority and `prepareFile` checks it at index time; this
      // pass only has to notice that the note moved on.
      let mtime = null;
      try { mtime = fs.statSync(fullPath).mtime.toISOString(); } catch { /* counted below */ }
      if (mtime && row.file_modified && mtime !== row.file_modified) stale.push(relativePath);
    }

    const failed = failedFiles();
    const truncated = truncatedDetail();

    const reasons = [];
    if (traversal.truncated) {
      for (const r of (traversal.reasons || [])) reasons.push(`the vault walk was partial: ${r}`);
    }
    if (unindexed.length) reasons.push(`${unindexed.length} eligible note(s) are not in the semantic index`);
    if (stale.length) reasons.push(`${stale.length} indexed note(s) have changed since they were embedded`);
    if (failed.length) reasons.push(`${failed.length} note(s) could not be embedded by the last run`);
    if (traversal.inaccessibleCount) reasons.push(`${traversal.inaccessibleCount} path(s) could not be read`);

    const report = {
      known: true,
      at: new Date().toISOString(),
      // ⚠ `complete` is about COVERAGE, not about the provider. It is false
      // whenever the index does not hold what the vault holds — which is a
      // different question from whether a query can be embedded right now.
      complete: reasons.length === 0,
      reasons,
      eligible: files.length,
      indexed: files.length - unindexed.length,
      unindexed: unindexed.length,
      unindexedSample: unindexed.slice(0, MAX_COVERAGE_SAMPLE),
      stale: stale.length,
      staleSample: stale.slice(0, MAX_COVERAGE_SAMPLE),
      failed: failed.length,
      failedSample: failed.slice(0, MAX_COVERAGE_SAMPLE),
      // Truncated notes ARE indexed — just not all the way to the end. Counted
      // separately, because "we hold none of it" and "we hold the first 60
      // chunks of it" license different answers.
      truncated: truncated.length,
      truncatedSample: truncated.slice(0, MAX_COVERAGE_SAMPLE).map(t => t.relativePath),
      // Deliberately kept out of the vault: the exclude list is a decision, so
      // it is reported as a number and never as a gap.
      excluded: traversal.excluded,
      inaccessible: traversal.inaccessibleCount,
      inaccessibleSample: traversal.inaccessible,
      walkTruncated: traversal.truncated === true,
      walkReasons: traversal.reasons || [],
      // Orphans: indexed rows with no eligible note behind them. Informational —
      // the next rebuild prunes them, and they cannot make an answer thin.
      orphaned: Math.max(0, indexed.size - (files.length - unindexed.length)),
    };

    _writeJsonState(COVERAGE_KEY, report);
    return report;
  } catch (e) {
    console.warn('[Embeddings] Coverage refresh failed:', e.message);
    return getCoverage();
  }
}

/**
 * The last measured coverage. SYNCHRONOUS and cheap — one KV read, no walk.
 *
 * ⚠ `known: false` means nobody has measured yet. It is NOT the same as
 * complete, and callers must not treat it as one: it is reported as its own
 * state so the difference survives. It is durable, so on any system that has
 * ever run a refresh this is only ever seen on a brand-new install.
 */
function getCoverage() {
  const stored = _readJsonState(COVERAGE_KEY, null);
  if (!stored || stored.known !== true) {
    return {
      known: false,
      complete: null,
      reasons: ['semantic index coverage has not been measured yet'],
      eligible: null, indexed: null, unindexed: null, unindexedSample: [],
      stale: null, failed: null, truncated: null, excluded: null,
      inaccessible: null, at: null,
    };
  }
  return { ...stored, ageMs: stored.at ? Date.now() - new Date(stored.at).getTime() : null };
}

/**
 * Is the index complete for one scope? PURE given a report.
 *
 * ⚠ A scope narrows what MATTERS. A vault with an unindexed `Projects/` note is
 * complete as far as `folder:Meetings` is concerned, and saying otherwise
 * teaches Nick to ignore the warning on the searches where it is real. The
 * counts stay vault-wide (they are the honest totals); only `complete` and
 * `reasons` are scoped, and ONLY when the sample is exhaustive — a truncated
 * sample cannot prove a scope is clean, so it stays incomplete.
 */
function coverageForScope(report, scope) {
  const base = report || getCoverage();
  if (!scope || scope.kind !== 'folder' || base.known !== true || base.complete === true) return base;

  const prefix = String(scope.value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return base;

  const inScope = (p) => p === prefix || String(p).startsWith(prefix + '/');
  const sampleExhaustive = (listed, total) => total === 0 || listed.length >= Math.min(total, MAX_COVERAGE_SAMPLE) && total <= MAX_COVERAGE_SAMPLE;

  const gaps = [];
  const check = (listName, sample, total, phrase) => {
    if (!total) return;
    if (!sampleExhaustive(sample || [], total)) {
      // Too many to enumerate — we cannot prove this scope is unaffected.
      gaps.push(`${phrase} (too many to attribute to a scope)`);
      return;
    }
    const hits = (sample || []).filter(inScope);
    if (hits.length) gaps.push(`${hits.length} ${phrase}`);
  };

  check('unindexed', base.unindexedSample, base.unindexed, 'eligible note(s) in this folder are not in the semantic index');
  check('stale', base.staleSample, base.stale, 'note(s) in this folder have changed since they were embedded');
  check('failed', (base.failedSample || []).map(f => f.relativePath), base.failed, 'note(s) in this folder could not be embedded');

  // A partial WALK is never scoped away: if the walk did not finish, we do not
  // know what is in any folder, including this one.
  if (base.walkTruncated) gaps.push(...(base.walkReasons || []).map(r => `the vault walk was partial: ${r}`));
  if (base.inaccessible) gaps.push(`${base.inaccessible} path(s) could not be read`);

  return { ...base, complete: gaps.length === 0, reasons: gaps, scoped: prefix };
}

async function rebuildEmbeddings(onProgress) {
  if (!isConfigured()) {
    console.log('[Embeddings] No API key — using simple vector fallback');
  }

  const files = listVaultFiles();
  console.log(`[Embeddings] Rebuilding — ${files.length} files to check`);

  // Drop rows for anything no longer indexable — deleted notes, and everything
  // the exclude list now keeps out (Archive, _toDelete, NEURO's own reports).
  // Without this the bin stays in the index forever and only new writes improve.
  const indexable = new Set(files.map(f => f.relativePath));
  let pruned = 0;
  for (const row of db.getAllEmbeddings()) {
    if (indexable.has(row.relative_path)) continue;
    db.deleteEmbedding(row.relative_path);
    indexable.add(row.relative_path); // deleteEmbedding clears every chunk — only do it once
    pruned++;
  }
  if (pruned) console.log(`[Embeddings] Pruned ${pruned} files no longer indexable`);

  // #56 — drop any file holding a fallback vector, so the pass below re-embeds
  // it. These cannot heal on their own: the row carries the real content hash,
  // so the unchanged-check counts the file as done, and cosineSimilarity scores
  // it 0 against every query because the dimensions differ. A whole meeting
  // transcript can be missing from search with nothing anywhere saying so.
  // Done as a sweep rather than only in prepareFile's chunk-0 check, because a
  // batch could straddle two files and leave one of them real at chunk 0 and
  // fallback further in.
  if (isConfigured()) {
    const poisoned = new Set();
    for (const row of db.getAllEmbeddings()) {
      if (poisoned.has(row.relative_path)) continue;
      if (!_storedIsReal(row)) poisoned.add(row.relative_path);
    }
    for (const p of poisoned) db.deleteEmbedding(p);
    if (poisoned.size) {
      console.warn(`[Embeddings] Re-embedding ${poisoned.size} file(s) whose vectors were `
        + `written during an outage — they were unreachable by search until now`);
    }
  }

  // Prepare all files first (fast, no API calls)
  const needsEmbedding = [];
  let skipped = 0;
  for (const { relativePath, fullPath } of files) {
    const prepared = prepareFile(relativePath, fullPath);
    if (prepared) {
      needsEmbedding.push(prepared);
    } else {
      skipped++;
    }
  }

  // Flatten to one work item per CHUNK — batching by file would make a batch
  // size mean wildly different amounts of text depending on note length.
  const work = [];
  for (const f of needsEmbedding) {
    f.chunks.forEach((chunk, chunkIndex) => {
      work.push({ relativePath: f.relativePath, hash: f.hash, modified: f.modified, chunk, chunkIndex });
    });
  }

  console.log(`[Embeddings] ${needsEmbedding.length} files / ${work.length} chunks need embedding, ${skipped} unchanged`);

  const hasVoyage = !!process.env.VOYAGE_API_KEY;
  let updated = 0, errors = 0, rateLimitRetries = 0, skippedForFailure = 0;
  // A file's stale rows are cleared once, on the first chunk of it we save.
  const cleared = new Set();

  // Process in batches
  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const batch = work.slice(i, i + BATCH_SIZE);
    const texts = batch.map(b => b.chunk);

    try {
      let embeddings = await getBatchEmbeddings(texts);

      // Handle rate limit — wait and retry once
      if (embeddings === null) {
        rateLimitRetries++;
        console.log(`[Embeddings] Rate limited — waiting 65s before retry (attempt ${rateLimitRetries})`);
        await new Promise(r => setTimeout(r, 65000));
        embeddings = await getBatchEmbeddings(texts);
      }

      // No usable vectors — skip the batch entirely rather than writing hash
      // vectors that would mark these chunks done and unreachable (#56). The
      // files stay un-stamped, so the next run picks them up.
      if (embeddings === null) {
        _health.writesSkipped += batch.length;
        skippedForFailure += batch.length;
        // ⚠ WHICH files, not just how many chunks. Their old rows stay
        // searchable (that is the point of skipping rather than writing hash
        // vectors), so from the outside a partially failed rebuild is
        // indistinguishable from a complete one — this ledger is the only thing
        // that can say otherwise, and it is what makes the search say so too.
        for (const b of batch) _noteFailed(b.relativePath, _health.lastError || 'embedding unavailable');
        console.warn(`[Embeddings] Skipped ${batch.length} chunk(s) — no usable embedding; `
          + `they remain queued for the next run`);
        if (onProgress) onProgress({ i: Math.min(i + BATCH_SIZE, work.length), total: work.length, updated, skipped });
        if (hasVoyage && i + BATCH_SIZE < work.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        continue;
      }

      // Save each embedding
      for (let j = 0; j < batch.length; j++) {
        const { relativePath, hash, chunk, modified, chunkIndex } = batch[j];
        if (!cleared.has(relativePath)) {
          db.deleteEmbedding(relativePath);
          cleared.add(relativePath);
        }
        db.saveEmbedding(relativePath, hash, embeddings[j], chunk, modified, chunkIndex);
        _clearFailed(relativePath);
        updated++;
      }
    } catch (e) {
      console.error(`[Embeddings] Batch error at ${i}:`, e.message);
      errors += batch.length;
      for (const b of batch) _noteFailed(b.relativePath, e.message);
    }

    if (onProgress) onProgress({ i: Math.min(i + BATCH_SIZE, work.length), total: work.length, updated, skipped });

    // Rate limit pause between batches (only if using Voyage and more batches remain)
    if (hasVoyage && i + BATCH_SIZE < work.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`[Embeddings] Done — ${updated} chunks across ${needsEmbedding.length} files, ${skipped} unchanged, ${pruned} pruned, ${errors} errors, ${rateLimitRetries} rate-limit retries, ${skippedForFailure} chunks left for the next run`);
  // A run that embedded nothing because every call failed used to report the
  // same shape as a clean one. Say it plainly instead.
  if (skippedForFailure) {
    console.warn(`[Embeddings] INCOMPLETE — ${skippedForFailure} chunk(s) could not be embedded. `
      + `Last error: ${_health.lastError}`);
  }
  // ⚠ Measured at the END of every run, so the search path never has to walk
  // the vault to know whether the index is whole. A run that failed halfway
  // publishes a report saying exactly that, rather than leaving the previous
  // (clean) one standing.
  const coverage = refreshCoverage();
  if (coverage.known && !coverage.complete) {
    console.warn(`[Embeddings] Coverage INCOMPLETE — ${coverage.reasons.join('; ')}`);
  }
  return { updated, skipped, errors, pruned, skippedForFailure, files: needsEmbedding.length,
    health: getEmbeddingHealth(), coverage };
}

/**
 * How many notes a POST-filtered scoped search will examine before it stops.
 *
 * A `folder:` scope is answered exactly — the index stores `relative_path`, so
 * the candidate set is narrowed BEFORE ranking and nothing in scope can be
 * ranked out by something outside it. A `person:` scope cannot be: deciding it
 * means reading the note, so the ranked list is walked from the top and the
 * predicate applied until enough answers are found or this many notes have been
 * looked at. Hitting it is REPORTED (`boundedRecall`), never silent — that is
 * the difference between "there is nothing else" and "I stopped looking".
 */
const SCOPED_POST_FILTER_LIMIT = 500;

// The minimum cosine similarity worth calling a match.
const MIN_RELEVANCE = 0.1;

/**
 * Semantic search, with an honest account of how it answered.
 *
 * Returns `{results, available, why, recall, examined, boundedRecall}`.
 * `results` is `null` when the index could not answer at all — the caller must
 * degrade to keyword search rather than render an empty vault.
 *
 * @param {object} [options]
 * @param {(relativePath:string)=>boolean} [options.pathFilter] applied to every
 *   row BEFORE ranking. Cheap and exact — this is what makes a `folder:` scope
 *   a real narrowing rather than "the global top 200, then filtered".
 * @param {(relativePath:string)=>boolean} [options.postFilter] applied to the
 *   RANKED list, top down, for a scope that cannot be decided from the path.
 * @param {number} [options.postFilterLimit]
 */
async function semanticSearchDetailed(query, maxResults = 5, options = {}) {
  const {
    pathFilter = null,
    postFilter = null,
    postFilterLimit = SCOPED_POST_FILTER_LIMIT,
  } = options;

  const allEmbeddings = db.getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    console.log('[Embeddings] No embeddings yet — falling back to keyword search');
    // Null, not []: the caller must be able to tell "the index cannot answer"
    // from "the index answered and nothing matched".
    return { results: null, available: false, why: 'no embeddings indexed yet', recall: 'none', examined: 0, boundedRecall: false };
  }

  // Embed the query. Null means the call failed, and handing back to keyword
  // search is the honest degrade — a hash vector here would score 0 against
  // every real row and return an empty result set that reads as "nothing in
  // the vault matches" rather than "semantic search is down".
  const queryEmbedding = await getQueryEmbedding(query);
  if (!queryEmbedding) {
    console.warn('[Embeddings] Query could not be embedded — falling back to keyword search');
    return { results: null, available: false, why: 'query could not be embedded', recall: 'none', examined: 0, boundedRecall: false };
  }

  // Score every chunk, then keep the best chunk PER FILE. Without the fold,
  // maxResults counts chunks rather than notes and one long transcript can fill
  // the entire result set with five passages of itself.
  const best = new Map();
  for (const row of allEmbeddings) {
    // ⚠ Applied here, before scoring, so an in-scope note cannot be ranked out
    // by a better-scoring note the scope excludes.
    if (pathFilter && !pathFilter(row.relative_path)) continue;
    let embedding;
    try { embedding = JSON.parse(row.embedding); }
    catch { continue; }
    const score = cosineSimilarity(queryEmbedding, embedding);
    const current = best.get(row.relative_path);
    if (!current || score > current.score) {
      best.set(row.relative_path, { relativePath: row.relative_path, chunkText: row.chunk_text, score });
    }
  }

  const ranked = [...best.values()]
    .filter(r => r.score > MIN_RELEVANCE)   // minimum relevance threshold
    .sort((a, b) => b.score - a.score);

  let kept;
  let examined = ranked.length;
  let boundedRecall = false;

  if (postFilter) {
    kept = [];
    examined = 0;
    for (const candidate of ranked) {
      if (kept.length >= maxResults) break;
      if (examined >= postFilterLimit) {
        // We stopped looking. Say so — an answer short of maxResults here is
        // not evidence that the scope holds nothing more.
        boundedRecall = true;
        break;
      }
      examined += 1;
      let ok = false;
      try { ok = postFilter(candidate.relativePath); } catch { ok = false; }
      if (ok) kept.push(candidate);
    }
  } else {
    kept = ranked.slice(0, maxResults);
  }

  return {
    results: kept.map(r => ({
      path: r.relativePath,
      name: path.basename(r.relativePath, '.md'),
      excerpts: [r.chunkText ? r.chunkText.slice(0, 300) : ''],
      score: r.score,
    })),
    available: true,
    why: null,
    // `exact` means every candidate the scope permits was ranked. `bounded`
    // means the ranked list was walked only so far.
    recall: postFilter ? 'bounded' : 'exact',
    examined,
    boundedRecall,
  };
}

/** The long-standing shape: an array of results, or null to degrade. */
async function semanticSearch(query, maxResults = 5, options = {}) {
  return (await semanticSearchDetailed(query, maxResults, options)).results;
}

module.exports = {
  isConfigured,
  getEmbeddingHealth,
  rebuildEmbeddings,
  semanticSearch,
  semanticSearchDetailed,
  SCOPED_POST_FILTER_LIMIT,
  truncatedFiles,
  truncatedDetail,
  inventoryVaultFiles,
  refreshCoverage,
  getCoverage,
  coverageForScope,
  failedFiles,
  // Exported for tests: a partially failed run is the state that is hardest
  // to reach honestly, and the ledger is the only thing that records it.
  _noteFailed,
  _clearFailed,
  embedVaultFile,
  listVaultFiles,
  // exported for tests — the chunker is the thing that was silently discarding
  // 90% of every note, so it is worth being able to assert on directly.
  chunkText,
  prepareFile,
  MAX_CHUNKS_PER_FILE,
  // #56 — the dimension check is the whole fix, so it is directly assertable.
  isRealEmbedding,
  _storedIsReal,
  VOYAGE_DIMENSIONS,
  FALLBACK_DIMENSIONS,
  computeSimpleVector,
};
