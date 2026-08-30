'use strict';

// Notion REST client. Bare `fetch`, no SDK — the D&D exporter established that
// and it keeps a public repo free of another dependency for ~150 lines of work.
//
// ⚠ Notion rate-limits at roughly 3 requests/second and answers 429 with a
// `Retry-After`. A full sync of a page tree is many sequential reads, so the
// throttle is not optional: it follows plaud-sync's shape (concurrency 1, a
// fixed gap, 429 backoff with jitter) rather than inventing a second one.

const NOTION_VERSION = process.env.NOTION_API_VERSION || '2022-06-28';
const BASE = 'https://api.notion.com/v1';
const MIN_GAP_MS = Number(process.env.NOTION_MIN_GAP_MS || 350);
const MAX_ATTEMPTS = 4;

// Notion caps a children append at 100 and nesting at 2 levels on write.
const APPEND_CHUNK = 100;

let lastCallAt = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token() {
  return process.env.NOTION_TOKEN || '';
}

function isConfigured() {
  return Boolean(token());
}

/**
 * Retryable in the sense that trying again might work.
 *
 * ⚠ The message match includes `Request timed out` as well as `timeout` —
 * plaud-sync's lesson, where matching only the latter meant every timed-out
 * recording died on its first attempt with three retries unused.
 */
function isRetryable(status, error) {
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return /timed out|timeout|econnreset|enotfound|eai_again|socket hang up|fetch failed/.test(message);
}

async function throttled(fn) {
  // Serialise every call through one chain, so concurrency is 1 by construction
  // rather than by each caller remembering to await in order.
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function request(method, endpoint, body) {
  if (!isConfigured()) throw new Error('NOTION_TOKEN is not set');

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await throttled(() => fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      }));
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isRetryable(0, error)) throw error;
      await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
      continue;
    }

    if (response.ok) return response.status === 204 ? null : response.json();

    const text = await response.text().catch(() => '');
    const error = new Error(`Notion ${response.status} on ${method} ${endpoint}: ${text.slice(0, 300)}`);
    error.status = response.status;

    // 404 from Notion overwhelmingly means "not shared with this integration"
    // rather than "does not exist", and those need different fixes — so say so
    // rather than letting it read as a missing page.
    if (response.status === 404) {
      error.notShared = true;
      error.message += ' — the page may not be shared with the NEURO integration';
    }
    if (!isRetryable(response.status, null) || attempt === MAX_ATTEMPTS) throw error;

    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(retryAfter > 0
      ? retryAfter * 1000 + Math.random() * 250
      : 500 * 2 ** (attempt - 1) + Math.random() * 250);
    lastError = error;
  }
  throw lastError || new Error('Notion request failed');
}

/** Follow `next_cursor` to the end. A page_size is a page size, never the answer. */
async function paged(method, endpoint, body) {
  const results = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const payload = method === 'GET'
      ? await request('GET', `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`)
      : await request(method, endpoint, { ...body, page_size: 100, start_cursor: cursor || undefined });
    results.push(...(payload.results || []));
    cursor = payload.has_more ? payload.next_cursor : null;
  } while (cursor);
  return results;
}

function titleOf(page) {
  if (!page?.properties) return null;
  const property = Object.values(page.properties).find((p) => p?.type === 'title');
  const text = (property?.title || []).map((i) => i.plain_text).join('').trim();
  return text || null;
}

async function getPage(pageId) {
  return request('GET', `/pages/${pageId}`);
}

/**
 * Every child block of `blockId`, with nested children attached as `.children`.
 *
 * Depth-bounded: a synced block or a deeply nested toggle tree can otherwise walk
 * a very long way, and each level is a separate API call under the throttle.
 */
async function getBlockTree(blockId, { depth = 0, maxDepth = 3 } = {}) {
  const blocks = await paged('GET', `/blocks/${blockId}/children`);
  if (depth >= maxDepth) return blocks;
  for (const block of blocks) {
    // A child page is a note in its own right, not content of this one.
    if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
      block.children = await getBlockTree(block.id, { depth: depth + 1, maxDepth });
    }
  }
  return blocks;
}

async function createPage({ parentPageId, title, blocks = [] }) {
  const page = await request('POST', '/pages', {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    children: blocks.slice(0, APPEND_CHUNK),
  });
  if (blocks.length > APPEND_CHUNK) await appendChildren(page.id, blocks.slice(APPEND_CHUNK));
  return page;
}

async function appendChildren(blockId, blocks) {
  for (let i = 0; i < blocks.length; i += APPEND_CHUNK) {
    await request('PATCH', `/blocks/${blockId}/children`, { children: blocks.slice(i, i + APPEND_CHUNK) });
  }
}

async function setPageTitle(pageId, title) {
  return request('PATCH', `/pages/${pageId}`, {
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
  });
}

/**
 * Replace a page's body with `blocks`.
 *
 * ⚠ Destructive by nature, and safe ONLY because the caller has already proved
 * Notion has not changed since the last sync (see index.js `push`). Without that
 * guard this deletes edits nobody has a copy of. Child pages are left alone —
 * they are separate notes and deleting one would take its whole subtree with it.
 */
async function replaceChildren(blockId, blocks) {
  const existing = await paged('GET', `/blocks/${blockId}/children`);
  for (const block of existing) {
    if (block.type === 'child_page' || block.type === 'child_database') continue;
    await request('DELETE', `/blocks/${block.id}`);
  }
  await appendChildren(blockId, blocks);
}

/** Pages this integration can see, newest first — the folder picker's source. */
async function searchPages(query = '') {
  const results = await paged('POST', '/search', {
    query: query || undefined,
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  });
  return results.map((page) => ({
    id: page.id,
    title: titleOf(page) || '(untitled)',
    url: page.url || null,
    lastEdited: page.last_edited_time,
    archived: Boolean(page.archived || page.in_trash),
    isChild: page.parent?.type === 'page_id',
  }));
}

module.exports = {
  NOTION_VERSION,
  isConfigured,
  isRetryable,
  request,
  paged,
  titleOf,
  getPage,
  getBlockTree,
  createPage,
  appendChildren,
  setPageTitle,
  replaceChildren,
  searchPages,
};
