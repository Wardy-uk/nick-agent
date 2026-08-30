'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const exclusions = require('./vault-exclusions');
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
    console.warn(`[Embeddings] ${relativePath}: embedding unavailable — left unindexed for the next run`);
    return false;
  }

  // Clear first: a shortened note has fewer chunks than last time, and
  // INSERT OR REPLACE alone would leave the tail behind as orphan rows.
  db.deleteEmbedding(prepared.relativePath);
  prepared.chunks.forEach((chunk, i) => {
    db.saveEmbedding(prepared.relativePath, prepared.hash, embeddings[i], chunk, prepared.modified, i);
  });
  return true;
}

function listVaultFiles() {
  if (!VAULT_PATH) return [];
  const results = [];

  function walk(dir, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclusions.isExcludedDir(entry.name, { forEmbeddings: true })) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        if (exclusions.isExcludedPath(relativePath, { forEmbeddings: true })) continue;
        results.push({ relativePath, fullPath });
      }
    }
  }

  walk(VAULT_PATH, 0);
  return results;
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
        updated++;
      }
    } catch (e) {
      console.error(`[Embeddings] Batch error at ${i}:`, e.message);
      errors += batch.length;
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
  return { updated, skipped, errors, pruned, skippedForFailure, files: needsEmbedding.length,
    health: getEmbeddingHealth() };
}

async function semanticSearch(query, maxResults = 5) {
  // Get all stored embeddings
  const allEmbeddings = db.getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    console.log('[Embeddings] No embeddings yet — falling back to keyword search');
    return null; // caller should fall back to keyword search
  }

  // Embed the query. Null means the call failed, and handing back to keyword
  // search is the honest degrade — a hash vector here would score 0 against
  // every real row and return an empty result set that reads as "nothing in
  // the vault matches" rather than "semantic search is down".
  const queryEmbedding = await getQueryEmbedding(query);
  if (!queryEmbedding) {
    console.warn('[Embeddings] Query could not be embedded — falling back to keyword search');
    return null;
  }

  // Score every chunk, then keep the best chunk PER FILE. Without the fold,
  // maxResults counts chunks rather than notes and one long transcript can fill
  // the entire result set with five passages of itself.
  const best = new Map();
  for (const row of allEmbeddings) {
    let embedding;
    try { embedding = JSON.parse(row.embedding); }
    catch { continue; }
    const score = cosineSimilarity(queryEmbedding, embedding);
    const current = best.get(row.relative_path);
    if (!current || score > current.score) {
      best.set(row.relative_path, { relativePath: row.relative_path, chunkText: row.chunk_text, score });
    }
  }

  const scored = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .filter(r => r.score > 0.1); // minimum relevance threshold

  return scored.map(r => ({
    path: r.relativePath,
    name: path.basename(r.relativePath, '.md'),
    excerpts: [r.chunkText ? r.chunkText.slice(0, 300) : ''],
    score: r.score
  }));
}

module.exports = {
  isConfigured,
  getEmbeddingHealth,
  rebuildEmbeddings,
  semanticSearch,
  truncatedFiles,
  truncatedDetail,
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
