'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const SKIP_DIRS = new Set(['Daily', 'Scripts', 'Templates', '.obsidian', '.git', '.trash', 'Imports']);
const MAX_CHUNK_CHARS = 1500; // keep well within token limits
const BATCH_SIZE = 8; // files per Voyage API call
const BATCH_DELAY_MS = 21000; // 21s between batches (free tier = 3 RPM)

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
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

// Prepare a file for embedding — returns { relativePath, hash, chunk, modified } or null
function prepareFile(relativePath, fullPath) {
  let content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); }
  catch { return null; }

  const body = stripFrontmatter(content);
  if (body.trim().length < 20) return null;

  const hash = contentHash(body);
  const stats = fs.statSync(fullPath);
  const modified = stats.mtime.toISOString();

  // Check if already embedded with same content
  const existing = db.getEmbedding(relativePath);
  if (existing && existing.content_hash === hash) return null; // unchanged

  const chunks = chunkText(body);
  if (chunks.length === 0) return null;

  return { relativePath, hash, chunk: chunks[0], modified };
}

async function embedVaultFile(relativePath, fullPath) {
  const prepared = prepareFile(relativePath, fullPath);
  if (!prepared) return false;

  const embedding = await getEmbedding(prepared.chunk);
  if (!embedding) return false;

  db.saveEmbedding(prepared.relativePath, prepared.hash, embedding, prepared.chunk, prepared.modified);
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
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
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

  console.log(`[Embeddings] ${needsEmbedding.length} need embedding, ${skipped} unchanged`);

  const hasVoyage = !!process.env.VOYAGE_API_KEY;
  let updated = 0, errors = 0, rateLimitRetries = 0;

  // Process in batches
  for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
    const batch = needsEmbedding.slice(i, i + BATCH_SIZE);
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
        const { relativePath, hash, chunk, modified } = batch[j];
        db.saveEmbedding(relativePath, hash, embeddings[j], chunk, modified);
        updated++;
      }
    } catch (e) {
      console.error(`[Embeddings] Batch error at ${i}:`, e.message);
      errors += batch.length;
    }

    if (onProgress) onProgress({ i: Math.min(i + BATCH_SIZE, needsEmbedding.length), total: needsEmbedding.length, updated, skipped });

    // Rate limit pause between batches (only if using Voyage and more batches remain)
    if (hasVoyage && i + BATCH_SIZE < needsEmbedding.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`[Embeddings] Done — ${updated} updated, ${skipped} unchanged, ${errors} errors, ${rateLimitRetries} rate-limit retries`);
  return { updated, skipped, errors };
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

  // Score all embeddings
  const scored = allEmbeddings
    .map(row => {
      let embedding;
      try { embedding = JSON.parse(row.embedding); }
      catch { return null; }
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { relativePath: row.relative_path, chunkText: row.chunk_text, score };
    })
    .filter(Boolean)
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
  listVaultFiles
};
