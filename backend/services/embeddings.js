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

// Batch embed multiple texts in a single Voyage API call
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
      console.warn('[Embeddings] Voyage API error:', res.status, err.substring(0, 200));
      return texts.map(t => computeSimpleVector(t));
    }
    const data = await res.json();
    // Return embeddings in same order as input
    return texts.map((_, i) => data.data?.[i]?.embedding || computeSimpleVector(texts[i]));
  } catch (e) {
    console.warn('[Embeddings] Voyage batch call failed:', e.message);
    return texts.map(t => computeSimpleVector(t));
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
      console.warn('[Embeddings] Voyage API error:', res.status, err.substring(0, 200));
      return computeSimpleVector(text);
    }
    const data = await res.json();
    return data.data?.[0]?.embedding || computeSimpleVector(text);
  } catch (e) {
    console.warn('[Embeddings] Voyage call failed:', e.message);
    return computeSimpleVector(text);
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
    if (!res.ok) return computeSimpleVector(text);
    const data = await res.json();
    return data.data?.[0]?.embedding || computeSimpleVector(text);
  } catch {
    return computeSimpleVector(text);
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

  // Unchanged only if the content matches AND every chunk of it is stored —
  // otherwise a file indexed under the old chunk-0-only code would look done
  // forever and never pick up its remaining chunks.
  const existing = db.getEmbedding(relativePath);
  let chunks = chunkText(body);
  if (chunks.length === 0) return null;
  if (chunks.length > MAX_CHUNKS_PER_FILE) {
    console.warn(`[Embeddings] ${relativePath}: ${chunks.length} chunks, indexing first ${MAX_CHUNKS_PER_FILE}`);
    chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }
  if (existing && existing.content_hash === hash
      && db.getEmbeddingChunkCount(relativePath) === chunks.length) {
    return null; // unchanged and fully indexed
  }

  return { relativePath, hash, chunks, modified };
}

async function embedVaultFile(relativePath, fullPath) {
  const prepared = prepareFile(relativePath, fullPath);
  if (!prepared) return false;

  const embeddings = await getBatchEmbeddings(prepared.chunks)
    || prepared.chunks.map(c => computeSimpleVector(c));

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
  let updated = 0, errors = 0, rateLimitRetries = 0;
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
        if (embeddings === null) {
          // Still rate limited — fall back to simple vectors for this batch
          console.warn('[Embeddings] Still rate limited after retry — using simple vectors for batch');
          embeddings = texts.map(t => computeSimpleVector(t));
        }
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

  console.log(`[Embeddings] Done — ${updated} chunks across ${needsEmbedding.length} files, ${skipped} unchanged, ${pruned} pruned, ${errors} errors, ${rateLimitRetries} rate-limit retries`);
  return { updated, skipped, errors, pruned, files: needsEmbedding.length };
}

async function semanticSearch(query, maxResults = 5) {
  // Get all stored embeddings
  const allEmbeddings = db.getAllEmbeddings();
  if (allEmbeddings.length === 0) {
    console.log('[Embeddings] No embeddings yet — falling back to keyword search');
    return null; // caller should fall back to keyword search
  }

  // Embed the query
  const queryEmbedding = await getQueryEmbedding(query);
  if (!queryEmbedding) return null;

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
  rebuildEmbeddings,
  semanticSearch,
  embedVaultFile,
  listVaultFiles,
  // exported for tests — the chunker is the thing that was silently discarding
  // 90% of every note, so it is worth being able to assert on directly.
  chunkText,
  prepareFile,
  MAX_CHUNKS_PER_FILE,
};
