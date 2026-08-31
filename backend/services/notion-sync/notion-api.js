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

// ── Where the credential lives ──────────────────────────────────────────────
//
// `.env` FIRST, then the DB. Both, deliberately — and the DB is the one that
// matters, because the alternative was an SSH session, a `read -rsp`, an append
// to .env and a pm2 restart to set one value. That is six steps of friction for
// a config change, on the system whose whole premise is that Nick's bottleneck
// is initiation. NEURO already had the answer: the OpenRouter key lives in
// `agent_state` and is pasted into a panel (`routes/ai-settings.js`), so this
// follows that rather than inventing a second, worse way.
//
// Read at CALL time, not bootstrapped into process.env at startup, so pasting a
// token takes effect immediately instead of at the next restart. `.env` still
// wins where it is set, so a deployment that pins the credential in the
// environment is never quietly overridden by something typed into a browser.
const TOKEN_KEY = 'notion_sync_token';

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    // Lazily required: this module is loaded before the DB is initialised.
    return require('../../db/database').getState(TOKEN_KEY) || '';
  } catch { return ''; }
}

function isConfigured() {
  return Boolean(token());
}

/**
 * WHERE the credential came from — never what it is.
 *
 * The `/api/health` rule from the SARA bridge: report whether a credential is
 * set and which source answered, so "not configured" and "configured but wrong"
 * stay distinguishable, without the value ever leaving the server.
 */
function credentialSource() {
  if (process.env.NOTION_TOKEN) return 'env';
  try {
    return require('../../db/database').getState(TOKEN_KEY) ? 'stored' : null;
  } catch { return null; }
}

/**
 * Store a token typed into the panel.
 *
 * Shape-checked only — Notion's own tokens are `ntn_…` (and historically
 * `secret_…`). A wrong-but-well-formed token is caught by the first real call,
 * which reports 401 honestly; guessing harder here would only reject valid
 * future formats.
 */
function setStoredToken(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { ok: false, error: 'No token given.' };
  if (!/^(ntn_|secret_)[A-Za-z0-9]/.test(trimmed)) {
    return { ok: false, error: 'That does not look like a Notion integration token (expected it to start with "ntn_").' };
  }
  require('../../db/database').setState(TOKEN_KEY, trimmed);
  return { ok: true };
}

function clearStoredToken() {
  require('../../db/database').setState(TOKEN_KEY, '');
  return { ok: true, stillInEnv: Boolean(process.env.NOTION_TOKEN) };
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

// ── What Notion will actually accept in a code block ────────────────────────
//
// ⚠ Notion validates `code.language` against a closed enum and answers 400 for
// anything else — it does not fall back. Obsidian's vault is full of fences
// Notion has never heard of: measured here, `dataview` (811), `tasks` (272),
// `ics`, `query`, plus aliases like `ts` and `tsx`. Four MOCs failed to publish
// on the first real run for exactly this.
//
// The list is COPIED FROM NOTION'S OWN ERROR RESPONSE, not from memory or the
// docs — this repo has been bitten twice by an invented identifier
// (`sleep_core_hours`, `meeting_alert`), and a guessed enum here fails the same
// silent way.
//
// ⚠ Clamped HERE, at the API boundary, and deliberately NOT in blocks.js. The
// converter's contract is round-trip stability, and rewriting `dataview` to
// `plain text` during parsing would make a note containing one churn forever.
// Notion's constraint belongs where Notion is.
const NOTION_LANGUAGES = new Set([
  'abap', 'abc', 'agda', 'arduino', 'ascii art', 'assembly',
  'bash', 'basic', 'bnf', 'c', 'c#', 'c++',
  'clojure', 'coffeescript', 'coq', 'css', 'dart', 'dhall',
  'diff', 'docker', 'ebnf', 'elixir', 'elm', 'erlang',
  'f#', 'flow', 'fortran', 'gherkin', 'glsl', 'go',
  'graphql', 'groovy', 'haskell', 'hcl', 'html', 'idris',
  'java', 'java/c/c++/c#', 'javascript', 'json', 'julia', 'kotlin',
  'latex', 'less', 'lisp', 'livescript', 'llvm ir', 'lua',
  'makefile', 'markdown', 'markup', 'mathematica', 'matlab', 'mermaid',
  'nix', 'notion formula', 'objective-c', 'ocaml', 'pascal', 'perl',
  'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'purescript',
  'python', 'r', 'racket', 'reason', 'ruby', 'rust',
  'sass', 'scala', 'scheme', 'scss', 'shell', 'smalltalk',
  'solidity', 'sql', 'swift', 'toml', 'typescript', 'vb.net',
  'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
]);

// Common aliases worth keeping rather than flattening to plain text.
const LANGUAGE_ALIASES = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  sh: 'shell', zsh: 'shell', yml: 'yaml', py: 'python', md: 'markdown',
  'c++': 'c++', cs: 'c#', ps1: 'powershell', text: 'plain text', txt: 'plain text',
};

function notionLanguage(raw) {
  const lang = String(raw || '').trim().toLowerCase();
  if (!lang) return 'plain text';
  if (NOTION_LANGUAGES.has(lang)) return lang;
  const alias = LANGUAGE_ALIASES[lang];
  if (alias && NOTION_LANGUAGES.has(alias)) return alias;
  // An unknown fence is still a code block — the content is what matters, and
  // losing the highlight is a far smaller loss than failing to publish at all.
  return 'plain text';
}

/**
 * Make a block tree safe to send. Recurses into children.
 *
 * Mutates a copy, never the caller's blocks — the same tree is re-read by the
 * state stash, and rewriting it there would change what a later push restores.
 */
function sanitiseForNotion(blocks) {
  return (blocks || []).map((block) => {
    const copy = { ...block };
    if (copy.type === 'code' && copy.code) {
      copy.code = { ...copy.code, language: notionLanguage(copy.code.language) };
    }
    const data = copy[copy.type];
    if (data && Array.isArray(data.children)) {
      copy[copy.type] = { ...data, children: sanitiseForNotion(data.children) };
    }
    return copy;
  });
}

async function createPage({ parentPageId, title, blocks = [] }) {
  const page = await request('POST', '/pages', {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    children: sanitiseForNotion(blocks.slice(0, APPEND_CHUNK)),
  });
  if (blocks.length > APPEND_CHUNK) await appendChildren(page.id, blocks.slice(APPEND_CHUNK));
  return page;
}

async function appendChildren(blockId, blocks) {
  for (let i = 0; i < blocks.length; i += APPEND_CHUNK) {
    await request('PATCH', `/blocks/${blockId}/children`, {
      children: sanitiseForNotion(blocks.slice(i, i + APPEND_CHUNK)),
    });
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

/**
 * Pages this integration can see, as a breadcrumb-labelled tree.
 *
 * ⚠ The PATH is not decoration. A real workspace has several pages with the same
 * title — this one has two "Decisions", two "Current State" and two
 * "Preferences" — so a picker listing bare titles cannot be used correctly: you
 * cannot tell `Work / Decisions` from `NEURO / SARA / Decisions`, and picking the
 * wrong one points a mapping at the wrong tree with no visible error.
 *
 * Notion's search returns a parent id but no parent title, so the chain is
 * resolved locally from the same result set — no extra API calls. A parent
 * outside the result set (not shared with the integration) simply stops the
 * chain, so the path is always as much as we can honestly state.
 */
async function searchPages(query = '') {
  const results = await paged('POST', '/search', {
    query: query || undefined,
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  });

  const byId = new Map(results.map((p) => [p.id, p]));

  const pathOf = (page, depth = 0) => {
    const name = titleOf(page) || '(untitled)';
    const parent = page.parent || {};
    // Depth-capped: a cycle is not expected, but a malformed parent chain must
    // not hang the picker.
    if (parent.type === 'page_id' && byId.has(parent.page_id) && depth < 8) {
      return `${pathOf(byId.get(parent.page_id), depth + 1)} / ${name}`;
    }
    return name;
  };

  return results
    .map((page) => ({
      id: page.id,
      title: titleOf(page) || '(untitled)',
      path: pathOf(page),
      url: page.url || null,
      lastEdited: page.last_edited_time,
      archived: Boolean(page.archived || page.in_trash),
      isChild: page.parent?.type === 'page_id',
    }))
    // Tree order, so the picker reads like the workspace rather than like a
    // recently-edited feed.
    .sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  NOTION_VERSION,
  TOKEN_KEY,
  isConfigured,
  credentialSource,
  setStoredToken,
  clearStoredToken,
  isRetryable,
  request,
  paged,
  titleOf,
  notionLanguage,
  sanitiseForNotion,
  getPage,
  getBlockTree,
  createPage,
  appendChildren,
  setPageTitle,
  replaceChildren,
  searchPages,
};
