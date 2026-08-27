#!/usr/bin/env node

/**
 * NEURO MCP Server — exposes local brain/cortex to external chat clients.
 *
 * Connects to the NEURO backend API and exposes tools for:
 *   - Focus / SARA state
 *   - Vault search and note reading
 *   - Queue / SLA status
 *   - Meeting prep
 *   - Task management
 *   - Daily note operations
 *   - People notes
 *   - Action management
 *
 * Usage:
 *   NEURO_URL=http://localhost:3001 NEURO_PIN=123456 \
 *   NEURO_VAULT_KEY=... OBSIDIAN_VAULT_PATH="C:\\...\\Nicks knowledge base" node index.js
 *
 * Vault tools are NEURO-first: they call the backend so writes re-index
 * embeddings/entities. If the Pi is unreachable they fall back to direct
 * filesystem access via OBSIDIAN_VAULT_PATH (a local Syncthing copy), and
 * NEURO reconciles those changes on next startup (hash-based re-embed).
 *
 * Or configure in Claude Desktop / Claude Code MCP settings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

const NEURO_URL = process.env.NEURO_URL || 'http://localhost:3001';
const NEURO_PIN = process.env.NEURO_PIN || '';
const VAULT_API_KEY = process.env.NEURO_VAULT_KEY || '';
const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// ── API helper ──
async function neuroApi(path, options = {}) {
  const url = `${NEURO_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(NEURO_PIN ? { 'X-Neuro-Pin': NEURO_PIN } : {}),
    ...(VAULT_API_KEY && path.startsWith('/api/vault') ? { 'X-Api-Key': VAULT_API_KEY } : {}),
    ...options.headers,
  };

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(options.timeout || 15000),
    });
  } catch (e) {
    // fetch rejected before any response — Pi unreachable / timed out.
    // Tag as transport so callers can fall back to the local vault.
    const err = new Error(`NEURO unreachable: ${e.message}`);
    err.transport = true;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NEURO API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════
// Local vault fallback — direct filesystem access for when the
// Pi/NEURO backend is unreachable. Requires OBSIDIAN_VAULT_PATH to
// point at a local (e.g. Syncthing) copy of the vault.
//
// Writes here bypass NEURO's embedding/entity hooks, but the backend
// reconciles on next startup: rebuildEmbeddings() is content-hash based,
// so any file changed while the Pi was down is re-indexed automatically
// (same path as editing the vault directly in Obsidian).
// ═══════════════════════════════════════════════════════

const VAULT_CONFIGURED = () => Boolean(VAULT_PATH) && fs.existsSync(VAULT_PATH);

function safeVaultPath(rel) {
  if (rel == null) return null;
  const resolved = path.resolve(VAULT_PATH, rel);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) return null; // path traversal guard
  return resolved;
}

function vaultRel(abs) {
  return path.relative(VAULT_PATH, abs).replace(/\\/g, '/');
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// Local equivalents of the /api/vault/* endpoints — same return shapes.
const localVault = {
  read(rel) {
    const fp = safeVaultPath(rel);
    if (!fp || !fs.existsSync(fp)) throw new Error(`File not found: ${rel}`);
    return { path: rel, content: fs.readFileSync(fp, 'utf-8') };
  },
  write(rel, content) {
    const fp = safeVaultPath(rel);
    if (!fp) throw new Error('Invalid path');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    return { success: true, path: rel };
  },
  append(rel, content) {
    const fp = safeVaultPath(rel);
    if (!fp) throw new Error('Invalid path');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const existing = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
    fs.writeFileSync(fp, existing + content, 'utf-8');
    return { success: true, path: rel };
  },
  list(dir) {
    const dp = safeVaultPath(dir || '');
    if (!dp || !fs.existsSync(dp)) throw new Error(`Directory not found: ${dir || '/'}`);
    const files = fs.readdirSync(dp, { withFileTypes: true })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
    return { dir: dir || '', files };
  },
  search(query, dir) {
    const root = safeVaultPath(dir || '');
    if (!root) throw new Error('Invalid path');
    const results = [];
    const max = 20;
    const q = query.toLowerCase();
    (function walk(d, depth) {
      if (depth > 4 || results.length >= max || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (results.length >= max) break;
        if (e.name.startsWith('.')) continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        if (!e.name.endsWith('.md')) continue;
        const content = fs.readFileSync(fp, 'utf-8');
        if (!content.toLowerCase().includes(q)) continue;
        const lines = content.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length && matches.length < 3; i++) {
          if (lines[i].toLowerCase().includes(q)) matches.push({ line: i + 1, text: lines[i].substring(0, 200) });
        }
        results.push({ path: vaultRel(fp), name: e.name.replace('.md', ''), matches });
      }
    })(root, 0);
    return { query, results };
  },
  searchTemporal(query, from, to, limit = 5) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    const q = query.toLowerCase();
    const SKIP = new Set(['.obsidian', '.git', '.trash', 'Imports']);
    const results = [];
    (function walk(d, depth) {
      if (depth > 4 || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(fp, depth + 1); continue; }
        if (!e.name.endsWith('.md')) continue;
        const stat = fs.statSync(fp);
        if (stat.mtime < fromDate || stat.mtime > toDate) continue;
        const content = fs.readFileSync(fp, 'utf-8');
        if (!content.toLowerCase().includes(q)) continue;
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          if (lines[i].toLowerCase().includes(q)) excerpts.push(lines[i].substring(0, 200));
        }
        results.push({ path: vaultRel(fp), name: e.name.replace('.md', ''), modified: stat.mtime, excerpts });
      }
    })(VAULT_PATH, 0);
    results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return { results: results.slice(0, limit), from: fromDate, to: toDate };
  },
  backlinks(rel) {
    const name = path.basename(rel, '.md');
    const needle = `[[${name}`.toLowerCase();
    const SKIP = new Set(['.obsidian', '.git', '.trash']);
    const backlinks = [];
    const seen = new Set();
    (function walk(d, depth) {
      if (depth > 5 || !fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(fp, depth + 1); continue; }
        if (!e.name.endsWith('.md')) continue;
        const r = vaultRel(fp);
        if (r === rel || seen.has(r)) continue;
        const content = fs.readFileSync(fp, 'utf-8');
        if (content.toLowerCase().includes(needle)) {
          seen.add(r);
          backlinks.push({ path: r, name: e.name.replace('.md', ''), type: 'link' });
        }
      }
    })(VAULT_PATH, 0);
    return { backlinks: backlinks.slice(0, 10), total: backlinks.length };
  },
  readDaily() {
    const fp = path.join(VAULT_PATH, 'Daily', `${todayStr()}.md`);
    return { content: fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '' };
  },
  appendDaily(content) {
    const dir = path.join(VAULT_PATH, 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${todayStr()}.md`);
    const existing = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : '';
    fs.writeFileSync(fp, existing + '\n' + content, 'utf-8');
    return { success: true };
  },
};

// Circuit breaker — once a transport error is seen, prefer the local vault for
// a short window so we don't wait on a dead endpoint for every call.
let neuroDownUntil = 0;
const COOLDOWN_MS = 15000;
function markNeuroDown() { neuroDownUntil = Date.now() + COOLDOWN_MS; }
function neuroProbablyDown() { return Date.now() < neuroDownUntil; }

// Run a vault op NEURO-first, falling back to the local filesystem on transport
// failure. `local` must return the same JSON shape as the NEURO endpoint.
async function vaultDispatch(neuro, local) {
  if (local && VAULT_CONFIGURED() && neuroProbablyDown()) {
    return { data: await local(), source: 'local' };
  }
  try {
    return { data: await neuro(), source: 'neuro' };
  } catch (e) {
    if (e.transport) {
      markNeuroDown();
      if (local && VAULT_CONFIGURED()) return { data: await local(), source: 'local' };
      throw new Error('NEURO backend is offline and no local vault is configured (set OBSIDIAN_VAULT_PATH on the MCP host).');
    }
    throw e; // genuine HTTP error (e.g. 404) — surface it, don't mask with local
  }
}

// NEURO-only op (no safe local equivalent — e.g. delete needs index cleanup).
async function neuroRequired(neuro, offlineMsg) {
  if (neuroProbablyDown()) throw new Error(offlineMsg);
  try {
    return await neuro();
  } catch (e) {
    if (e.transport) { markNeuroDown(); throw new Error(offlineMsg); }
    throw e;
  }
}

function offlineBanner(source) {
  return source === 'local' ? '⚠️ NEURO offline — served directly from the local vault copy.\n\n' : '';
}

// ── Create MCP Server ──
const server = new McpServer({
  name: 'neuro',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════
// Tools: Focus / SARA
// ═══════════════════════════════════════════════════════

server.tool('get_focus', 'Get current Focus — what matters now (prioritised items + SARA directive)', {}, async () => {
  const data = await neuroApi('/api/focus?noai=true');
  const items = (data.items || []).map(i => `- [${i.type}] ${i.title}: ${i.reason}`).join('\n');
  const sara = data.sara?.primary?.message || 'No directive';
  return {
    content: [{
      type: 'text',
      text: `## Focus (${data.returned} items, ${data.suppressed} suppressed)\n\nSARA: ${sara}\n${data.sara?.ignore || ''}\n\n${items}\n\nTone: ${data.tone}, Mode: ${data.mode}`,
    }],
  };
});

server.tool('get_suggestions', 'Get SARA action suggestions (pending)', {}, async () => {
  const data = await neuroApi('/api/actions');
  const pending = (data.pending || []).map(a => `- [${a.id}] ${a.type}: ${a.reason}`).join('\n');
  return { content: [{ type: 'text', text: pending || 'No pending suggestions.' }] };
});

server.tool('approve_action', 'Approve a SARA suggested action', { actionId: z.number().describe('Action ID to approve') }, async ({ actionId }) => {
  const data = await neuroApi(`/api/actions/${actionId}/approve`, { method: 'POST' });
  return { content: [{ type: 'text', text: data.ok ? `Approved: ${data.detail}` : `Failed: ${data.error}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Vault / Knowledge  (NEURO-first, local-vault fallback)
// ═══════════════════════════════════════════════════════

server.tool('search_vault', 'Search the Obsidian vault for notes (keyword)', {
  query: z.string().describe('Search query'),
  maxResults: z.number().optional().describe('Max results (default 5)'),
}, async ({ query, maxResults }) => {
  const limit = maxResults || 5;
  const { data, source } = await vaultDispatch(
    () => neuroApi(`/api/vault/search?query=${encodeURIComponent(query)}&limit=${limit}`, { timeout: 8000 }),
    () => localVault.search(query),
  );
  const results = (data.results || []).slice(0, limit).map(r => {
    const title = r.name || r.path?.split('/').pop()?.replace('.md', '') || 'Untitled';
    const excerpt = r.excerpt || r.preview || (r.matches || []).map(m => m.text).join('\n') || (r.excerpts || []).join('\n') || '';
    return `### ${title}\nPath: ${r.path || '?'}\n${excerpt}`;
  }).join('\n\n');
  return { content: [{ type: 'text', text: offlineBanner(source) + (results || 'No results found.') }] };
});

server.tool('read_note', 'Read a specific vault note by path', {
  path: z.string().describe('Relative path in vault, e.g. "People/Stephen Mitchell.md"'),
}, async ({ path: notePath }) => {
  const { data, source } = await vaultDispatch(
    () => neuroApi(`/api/vault/read?path=${encodeURIComponent(notePath)}`, { timeout: 8000 }),
    () => localVault.read(notePath),
  );
  return { content: [{ type: 'text', text: offlineBanner(source) + (data.content?.substring(0, 6000) || 'Note not found.') }] };
});

server.tool('write_note',
  'Create or overwrite a vault note. Routes through NEURO so embeddings + entities re-index; if the Pi is down it writes straight to the local vault and NEURO reconciles on next startup.',
  {
    path: z.string().describe('Relative path in vault, e.g. "Notes/Idea.md"'),
    content: z.string().describe('Full markdown content (overwrites existing)'),
  },
  async ({ path: notePath, content }) => {
    const { data, source } = await vaultDispatch(
      () => neuroApi('/api/vault/write', { method: 'POST', body: JSON.stringify({ path: notePath, content }), timeout: 8000 }),
      () => localVault.write(notePath, content),
    );
    return { content: [{ type: 'text', text: `${offlineBanner(source)}Wrote ${data.path || notePath}.` }] };
  });

server.tool('append_note',
  'Append content to any vault note (creates it if missing). NEURO-first with local fallback.',
  {
    path: z.string().describe('Relative path in vault'),
    content: z.string().describe('Markdown to append'),
  },
  async ({ path: notePath, content }) => {
    const { data, source } = await vaultDispatch(
      () => neuroApi('/api/vault/append', { method: 'POST', body: JSON.stringify({ path: notePath, content }), timeout: 8000 }),
      () => localVault.append(notePath, content),
    );
    return { content: [{ type: 'text', text: `${offlineBanner(source)}Appended to ${data.path || notePath}.` }] };
  });

server.tool('list_vault', 'List files and folders in a vault directory.', {
  dir: z.string().optional().describe('Relative directory (default: vault root)'),
}, async ({ dir }) => {
  const { data, source } = await vaultDispatch(
    () => neuroApi(`/api/vault/list?dir=${encodeURIComponent(dir || '')}`, { timeout: 8000 }),
    () => localVault.list(dir),
  );
  const lines = (data.files || []).map(f => `${f.type === 'directory' ? '📁' : '📄'} ${f.name}`).join('\n');
  return { content: [{ type: 'text', text: `${offlineBanner(source)}${data.dir || '/'}\n\n${lines || '(empty)'}` }] };
});

server.tool('search_vault_temporal', 'Search the vault within a date range (by file modified time).', {
  query: z.string().describe('Search query'),
  from: z.string().optional().describe('ISO date (YYYY-MM-DD). Default: 30 days ago'),
  to: z.string().optional().describe('ISO date (YYYY-MM-DD). Default: today'),
  limit: z.number().optional().describe('Max results (default 5)'),
}, async ({ query, from, to, limit }) => {
  const lim = limit || 5;
  const qs = new URLSearchParams({ query, limit: String(lim) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const { data, source } = await vaultDispatch(
    () => neuroApi(`/api/vault/search/temporal?${qs.toString()}`, { timeout: 8000 }),
    () => localVault.searchTemporal(query, from, to, lim),
  );
  const out = (data.results || []).map(r => {
    const when = r.modified ? new Date(r.modified).toISOString().split('T')[0] : '?';
    return `### ${r.name}  _(${when})_\nPath: ${r.path}\n${(r.excerpts || []).join('\n')}`;
  }).join('\n\n');
  return { content: [{ type: 'text', text: offlineBanner(source) + (out || 'No results in range.') }] };
});

server.tool('vault_backlinks',
  'Find notes that link to a given note. NEURO adds entity mentions; the local fallback finds [[wiki-links]] only.',
  {
    path: z.string().describe('Relative path of the target note'),
  },
  async ({ path: notePath }) => {
    const { data, source } = await vaultDispatch(
      () => neuroApi(`/api/vault/backlinks?path=${encodeURIComponent(notePath)}`, { timeout: 8000 }),
      () => localVault.backlinks(notePath),
    );
    const lines = (data.backlinks || []).map(b => `- [[${b.path?.replace(/\.md$/, '')}|${b.name}]] _(${b.type})_`).join('\n');
    return { content: [{ type: 'text', text: `${offlineBanner(source)}${data.total || 0} backlinks:\n\n${lines || '(none)'}` }] };
  });

server.tool('related_notes',
  'Find notes related to a given note. Uses NEURO semantic search; if the Pi is down, degrades to a local keyword match.',
  {
    path: z.string().describe('Relative path of the note'),
    limit: z.number().optional().describe('Max results (default 3)'),
  },
  async ({ path: notePath, limit }) => {
    const lim = limit || 3;
    const { data, source } = await vaultDispatch(
      () => neuroApi(`/api/vault/related?path=${encodeURIComponent(notePath)}&limit=${lim}`, { timeout: 8000 }),
      () => {
        // Degraded local mode: keyword search on the note's title.
        const q = path.basename(notePath, '.md');
        const res = localVault.search(q || '', '');
        return { related: (res.results || []).filter(r => r.path !== notePath).slice(0, lim), degraded: true };
      },
    );
    const lines = (data.related || []).map(r => `- [[${r.path?.replace(/\.md$/, '')}|${r.name}]]`).join('\n');
    const note = data.degraded ? ' _(keyword match — semantic search needs NEURO)_' : '';
    return { content: [{ type: 'text', text: `${offlineBanner(source)}Related notes${note}:\n\n${lines || '(none)'}` }] };
  });

server.tool('delete_note',
  'Delete a vault note. Requires NEURO online (also cleans up embeddings, entities, and links). Refuses if the Pi is down rather than leaving a stale index.',
  {
    path: z.string().describe('Relative path of the note to delete'),
  },
  async ({ path: notePath }) => {
    const data = await neuroRequired(
      () => neuroApi(`/api/vault/delete?path=${encodeURIComponent(notePath)}`, { method: 'DELETE', timeout: 8000 }),
      'Delete needs NEURO online so the search index stays clean — the Pi is unreachable, so the file was NOT touched. Retry when NEURO is back.',
    );
    return { content: [{ type: 'text', text: data.ok ? `Deleted ${data.path || notePath}.` : `Failed: ${data.error || 'unknown'}` }] };
  });

server.tool('get_daily_note', 'Get today\'s daily note content', {}, async () => {
  const { data, source } = await vaultDispatch(
    () => neuroApi('/api/obsidian/daily', { timeout: 8000 }),
    () => localVault.readDaily(),
  );
  return { content: [{ type: 'text', text: offlineBanner(source) + (data.content?.substring(0, 4000) || 'No daily note today.') }] };
});

server.tool('append_daily_note', 'Append content to today\'s daily note', {
  content: z.string().describe('Content to append'),
}, async ({ content }) => {
  const { source } = await vaultDispatch(
    () => neuroApi('/api/obsidian/daily/append', { method: 'POST', body: JSON.stringify({ content }), timeout: 8000 }),
    () => localVault.appendDaily(content),
  );
  return { content: [{ type: 'text', text: `${offlineBanner(source)}Appended to daily note.` }] };
});

server.tool('get_person', 'Get full detail about a person from the vault', {
  name: z.string().describe('Person name, e.g. "Stephen Mitchell"'),
}, async ({ name }) => {
  const data = await neuroApi(`/api/person/${encodeURIComponent(name)}`);
  const parts = [`# ${data.name}`];
  if (data.vaultNote?.frontmatter?.role) parts.push(`Role: ${data.vaultNote.frontmatter.role}`);
  if (data.meetings?.length) parts.push(`\n## Meetings (${data.meetings.length})\n${data.meetings.slice(0, 5).map(m => `- ${m.date}: ${m.title}`).join('\n')}`);
  if (data.tasks?.length) parts.push(`\n## Tasks (${data.tasks.length})\n${data.tasks.map(t => `- ${t.text}`).join('\n')}`);
  if (data.decisions?.length) parts.push(`\n## Decisions (${data.decisions.length})\n${data.decisions.map(d => `- ${d.date}: ${d.text}`).join('\n')}`);
  return { content: [{ type: 'text', text: parts.join('\n') }] };
});

server.tool('list_people', 'List all people in the vault', {}, async () => {
  const data = await neuroApi('/api/person/list');
  return { content: [{ type: 'text', text: (data.people || []).join(', ') }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Vault Hygiene  (NEURO-owned; server-side whole-vault scans)
// ═══════════════════════════════════════════════════════

server.tool('vault_lint',
  'Read-only vault health scan: broken [[links]], orphans (no links in/out), under-linked People notes, and stale notes. Writes a dated report to Documents/System/Vault Audit/. Touches nothing else.',
  {},
  async () => {
    const data = await neuroApi('/api/vault-hygiene/lint', { timeout: 30000 });
    const c = data.counts || {};
    const lines = [
      `# Vault Lint — ${data.scanned} notes scanned`,
      '',
      `| Check | Count |`,
      `|---|---|`,
      `| Broken links | ${c.broken} |`,
      `| Orphans | ${c.orphans} |`,
      `| Under-linked People | ${c.underlinkedPeople} |`,
      `| Stale | ${c.stale} |`,
      '',
    ];
    if (data.broken?.length) lines.push('## Broken (first 15)', ...data.broken.slice(0, 15).map(b => `- \`${b.from}\` → \`[[${b.target}]]\``), '');
    if (data.orphans?.length) lines.push('## Orphans', ...data.orphans.map(o => `- \`${o}\``), '');
    if (data.reportPath) lines.push(`_Full report: \`${data.reportPath}\`_`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('vault_contextual_link',
  'Add contextual [[wikilinks]] for genuine prose mentions of roster People/Projects. mode="plan" (default) is read-only and produces autonomy cards (per note: proposed link + the justifying sentence); mode="apply" appends an idempotent "## Mentioned" block, backs up every touched file, and writes a changelog. Full-name matching only — never bare first names. ALWAYS run plan and review before apply.',
  {
    mode: z.enum(['plan', 'apply']).optional().describe('plan (default, read-only cards) or apply (append links)'),
    roots: z.array(z.string()).optional().describe('Vault folders to scan (default: Meetings, Reflections, Calls, Decision Log)'),
    only: z.array(z.string()).optional().describe('apply mode only — restrict to these note paths (the approved subset). Omit to apply every proposal.'),
  },
  async ({ mode, roots, only }) => {
    const m = mode || 'plan';
    if (m === 'apply') {
      const data = await neuroApi('/api/vault-hygiene/contextual-link/apply', {
        method: 'POST', body: JSON.stringify({ roots, only }), timeout: 60000,
      });
      const lines = [`Applied **${data.totalLinks} links across ${data.notesDone} notes**.`, `Backups: \`${data.backupDir}\``, `Changelog: \`${data.changelogPath}\``, ''];
      for (const a of (data.applied || []).slice(0, 40)) lines.push(`- \`${a.rel}\` (+${a.links.length}): ${a.links.map(l => `[[${l}]]`).join(', ')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    const data = await neuroApi('/api/vault-hygiene/contextual-link/plan', {
      method: 'POST', body: JSON.stringify({ roots }), timeout: 60000,
    });
    const lines = [
      `# Contextual-Link Plan (DRY RUN)`,
      `**${data.total} proposed links across ${data.notesTouched} notes** (scanned ${data.scanned}). By area: ${Object.entries(data.byRoot || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
      '',
    ];
    for (const n of (data.perNote || []).slice(0, 40)) {
      lines.push(`## ${n.rel}`);
      for (const x of n.props) lines.push(`- **[[${x.link}]]**${x.via} — "…${x.why}…"`);
      lines.push('');
    }
    if (data.reportPath) lines.push(`_Full cards: \`${data.reportPath}\` — review, then call again with mode="apply"._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('vault_alias_suggest',
  'Scan the vault for capitalised full-name variants that closely match a roster person but are not an exact name/alias (e.g. "Abdi Mohammad" → Abdi Mohamed). Read-only — proposes aliases for you to approve; never edits frontmatter.',
  {
    threshold: z.number().optional().describe('Minimum similarity 0–1 (default 0.82)'),
  },
  async ({ threshold }) => {
    const qs = threshold ? `?threshold=${threshold}` : '';
    const data = await neuroApi(`/api/vault-hygiene/alias-suggest${qs}`, { timeout: 30000 });
    const lines = [`# Alias Suggestions — ${data.count} candidates`, ''];
    for (const s of data.suggestions || []) lines.push(`- **${s.candidate}** → [[${s.person}]] _(score ${s.score})_ — "…${s.sample}…"`);
    if (data.reportPath) lines.push('', `_Report: \`${data.reportPath}\`_`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('vault_fix',
  'Propose or apply fixes for broken links + orphans. mode="plan" (default) is read-only and writes a tiered Fix Plan. mode="apply" actions ONLY the tiers you pass per category (each: skip|conservative|moderate|aggressive, default skip). Links: conservative = exact-match repoints only (recommended); moderate/aggressive add fuzzy matches that mislink on this data (wrong-date stand-ups) — review-only. Every touched file is backed up; changelog written.',
  {
    mode: z.enum(['plan', 'apply']).optional().describe('plan (default, read-only) or apply'),
    links: z.enum(['skip', 'conservative', 'moderate', 'aggressive']).optional().describe('apply only — link repoint tier (default skip; conservative recommended)'),
    archived: z.enum(['skip', 'conservative', 'moderate', 'aggressive']).optional().describe('apply only — restore notes that exist only in Archive (moderate+ )'),
    expected: z.enum(['skip', 'conservative', 'moderate', 'aggressive']).optional().describe('apply only — suppress expected orphans via config (moderate+)'),
    missing: z.enum(['skip', 'conservative', 'moderate', 'aggressive']).optional().describe('apply only — stub genuinely-missing targets (aggressive only)'),
  },
  async ({ mode, links, archived, expected, missing }) => {
    if ((mode || 'plan') === 'apply') {
      const data = await neuroApi('/api/vault-hygiene/fix/apply', { method: 'POST', body: JSON.stringify({ links, archived, expected, missing }), timeout: 60000 });
      return { content: [{ type: 'text', text: `Fix applied — repointed ${data.repointed}, restored ${data.restored}, stubs ${data.stubs}, expected-suppressed ${data.expectedSuppressed}.\nBackups: \`${data.backupDir}\`\nChangelog: \`${data.changelogPath}\`` }] };
    }
    const data = await neuroApi('/api/vault-hygiene/fix/plan', { method: 'POST', body: JSON.stringify({}), timeout: 60000 });
    const s = data.summary || {};
    const lines = [
      `# Vault Fix Plan (DRY RUN)`, '',
      `**Link repoints** — conservative ${s.links?.conservative} | +moderate ${s.links?.moderate} | +aggressive ${s.links?.aggressive}`,
      `**Archived-only targets** — ${s.archivedLinks} links / ${s.archivedNotes} notes`,
      `**Expected orphans** ${s.expectedOrphans} · **People orphans** ${s.peopleOrphans} · **Content orphans** ${s.contentOrphans}`,
      `**Missing targets** ${s.missing}`, '',
      '⚠️ Only conservative link repoints are exact-safe. Moderate/aggressive are fuzzy and mislink here — review first.', '',
    ];
    if (data.linkFixes?.length) { lines.push('## Sample repoints'); for (const x of data.linkFixes.slice(0, 12)) lines.push(`- [${x.tier} ${x.sim}] \`${x.from}\`: \`[[${x.oldTarget}]]\` → \`[[${x.newBase}]]\``); }
    if (data.reportPath) lines.push('', `_Full plan: \`${data.reportPath}\`_`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('vault_connect_orphans',
  'FALLBACK for graph density (prefer vault_contextual_link). Appends hub links to orphans: NOVA orphans → [[MOC - NOVA]]; Daily notes → prev/next nav chain. Append-only, backed up, idempotent. Trades orphans for single-link leaves — use sparingly.',
  {
    nova: z.boolean().optional().describe('Link NOVA orphans to [[MOC - NOVA]] (default true)'),
    daily: z.boolean().optional().describe('Chain Daily notes prev/next (default true)'),
  },
  async ({ nova, daily }) => {
    const data = await neuroApi('/api/vault-hygiene/connect-orphans', { method: 'POST', body: JSON.stringify({ nova, daily }), timeout: 60000 });
    return { content: [{ type: 'text', text: `Connected — NOVA orphans linked ${data.nova}, Daily notes chained ${data.daily}.\nBackups: \`${data.backupDir}\`\nChangelog: \`${data.changelogPath}\`` }] };
  });

server.tool('vault_graph_config',
  'Manage Obsidian .obsidian/graph.json. mode="read" (default) returns the current colour groups; mode="apply" backs up to graph.json.bak-<date> then writes the canonical area colour scheme (People/Team teal, Meetings/Calls blue, Daily green, Ideas purple, Reflections rose, Decision Log red, NOVA orange, MOCs gold). WARNING: apply with the Obsidian graph view CLOSED — Obsidian rewrites graph.json on close and will clobber the change.',
  {
    mode: z.enum(['read', 'apply']).optional().describe('read (default) or apply'),
  },
  async ({ mode }) => {
    const apply = mode === 'apply';
    const data = await neuroApi('/api/vault-hygiene/graph-config', { method: 'POST', body: JSON.stringify({ apply }), timeout: 15000 });
    const groups = (data.colorGroups || []).map(g => `- ${g.query}`).join('\n');
    const head = data.applied ? `Applied canonical colour scheme. Backup: \`${data.backupPath}\`` : `Current colour groups (${(data.colorGroups || []).length}):`;
    return { content: [{ type: 'text', text: `${head}\n${groups}\n\n⚠️ ${data.warning}` }] };
  });

server.tool('vault_plaud_reconcile',
  'Read-only. List every PLAUD recording and find those with no ACTIVE vault note (notes may be binned in Archive). Matches by plaud_id, or date + title-token overlap (≥0.5). Writes a missing-recordings report. Re-pull fetches these FRESH — never from Archive.',
  {},
  async () => {
    const data = await neuroApi('/api/plaud/reconcile', { method: 'POST', body: JSON.stringify({}), timeout: 120000 });
    const lines = [
      `# PLAUD Reconciliation`,
      `${data.total} recordings · ${data.present} have an active note · **${data.missing?.length || 0} missing**.`,
      '',
    ];
    for (const m of (data.missing || []).slice(0, 40)) lines.push(`- ${m.date} \`${m.id}\` — ${m.title}`);
    if ((data.missing?.length || 0) > 40) lines.push(`…and ${data.missing.length - 40} more`);
    if (data.reportPath) lines.push('', `_Report: \`${data.reportPath}\`. Re-pull with vault_plaud_repull._`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('vault_plaud_repull',
  'Throttled, resumable re-pull of PLAUD recordings that have no active note (default: the reconcile "missing" set). Sequential with backoff on 429 and incremental ledger persistence, so a crash resumes instead of restarting. Use limit to batch safely. Routes pulled notes into Meetings/.',
  {
    limit: z.number().optional().describe('Cap recordings this run (e.g. 20) for a safe batch; re-run to continue'),
    ids: z.array(z.string()).optional().describe('Specific PLAUD recording ids to pull (default: all missing from reconcile)'),
  },
  async ({ limit, ids }) => {
    const data = await neuroApi('/api/plaud/repull', { method: 'POST', body: JSON.stringify({ limit, ids }), timeout: 600000 });
    if (data.skipped) return { content: [{ type: 'text', text: `Skipped: ${data.reason}` }] };
    const lines = [
      `Re-pull complete — requested ${data.requested}, pulled ${data.pulled}, failed ${data.failed}, remaining ${data.remaining}.`,
      data.resumable ? '_Resumable: re-run to continue from where it stopped._' : '',
    ];
    if (data.failures?.length) { lines.push('', 'Failures:'); for (const f of data.failures.slice(0, 10)) lines.push(`- \`${f.id}\` ${f.title}: ${f.error}`); }
    return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
  });

server.tool('vault_plaud_repull_stubs',
  'Recover "No transcript returned by Plaud" stub notes. PLAUD often returns an empty transcript under load even when the full transcript exists — this re-fetches each stub\'s transcript (retrying on empty) and rewrites its ## Transcript section in place. Backed up, throttled, resumable. Use limit to test a small batch first.',
  {
    limit: z.number().optional().describe('Cap notes this run (e.g. 5) to test; re-run to continue'),
  },
  async ({ limit }) => {
    const data = await neuroApi('/api/plaud/repull-stubs', { method: 'POST', body: JSON.stringify({ limit }), timeout: 600000 });
    if (data.skipped) return { content: [{ type: 'text', text: `Skipped: ${data.reason}` }] };
    const lines = [
      `Stub re-fetch — ${data.totalStubs} stubs found, processed ${data.scanned}: **${data.recovered} recovered**, ${data.stillEmpty} still empty, ${data.failed} failed.`,
      data.backupDir ? `Backups: \`${data.backupDir}\`` : '',
    ];
    for (const r of (data.results || []).filter(r => r.status !== 'recovered').slice(0, 10)) lines.push(`- ${r.status}: \`${r.rel}\`${r.error ? ' — ' + r.error : ''}`);
    return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
  });

// ═══════════════════════════════════════════════════════
// Tools: Operational Context
// ═══════════════════════════════════════════════════════

// `get_queue` removed 27 Aug 2026 with the Jira queue cache — see
// backend/db/database.js. Two things were wrong with it beyond the dead cache:
// it called `/api/queue`, which never existed (the router only ever defined
// `/summary`), so it had been 404ing; and it had no freshness gate, so had the
// path been right it would have stated seven-week-old figures as current — the
// one failure the backend readers were fixed to prevent.
// Escalations are unaffected and remain live via the NEURO API.

server.tool('get_next_meeting_prep', 'Get meeting prep for next upcoming calendar meeting (automatic, no params)', {}, async () => {
  const data = await neuroApi('/api/meeting-prep');
  if (!data.meeting) return { content: [{ type: 'text', text: 'No upcoming meetings.' }] };
  const m = data.meeting;
  const prep = m.prep || {};
  const attendees = (prep.attendees || []).map(a => `- ${a.name}${a.role ? ` (${a.role})` : ''}`).join('\n');
  const topics = (prep.suggestedTopics || []).map(t => `- ${t}`).join('\n');
  return {
    content: [{
      type: 'text',
      text: `## ${m.subject}\n${m.startFormatted}–${m.endFormatted}${m.location ? ` · ${m.location}` : ''}\n\n### Attendees\n${attendees || 'None matched'}\n\n### Topics\n${topics || 'None'}\n\n### Checklist\n${(prep.checklist || []).map(c => `- [ ] ${c}`).join('\n')}`,
    }],
  };
});

server.tool('get_todos', 'Get prioritised todo shortlist', {
  filter: z.enum(['overdue', 'today', 'all']).optional().describe('Filter (default: overdue)'),
}, async ({ filter }) => {
  const data = await neuroApi(`/api/todos/focus?filter=${filter || 'overdue'}&limit=10`);
  const items = (data.items || []).map(t => `- [${t._score}] ${t.text} (${t._scoreReason})`).join('\n');
  return { content: [{ type: 'text', text: `${data.totalCount} total, showing ${data.returned}:\n\n${items}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: Actions
// ═══════════════════════════════════════════════════════

// NEURO owns tasks (13 Aug 2026) — this writes to its task store, not to a vault
// markdown file. The vault export note is regenerated from it shortly after.
server.tool('create_task', 'Create a task in NEURO (the source of truth for tasks)', {
  text: z.string().describe('Task text'),
  moscow: z.enum(['must', 'should', 'could', 'wont']).optional().describe('MoSCoW bucket. Leave unset if unsure — untriaged is a valid state'),
  priority: z.number().int().min(1).max(3).optional().describe('Priority 1-3, where 3 is most pressing'),
  due: z.string().optional().describe('Due date, YYYY-MM-DD'),
}, async ({ text, moscow, priority, due }) => {
  const data = await neuroApi('/api/capture/todo', {
    method: 'POST',
    body: JSON.stringify({ text, moscow, priority, due, source: 'mcp' }),
  });
  const verb = data?.created === false ? 'Folded into existing task' : 'Task created';
  return { content: [{ type: 'text', text: `${verb}${data?.taskId ? ` #${data.taskId}` : ''}: ${text}` }] };
});

// ═══════════════════════════════════════════════════════
// Tools: 1:1 Meeting Workflow
// ═══════════════════════════════════════════════════════

// generate_1to1_prep was removed on 14 Aug 2026 — NOVA owns 1-2-1 prep now.

server.tool('list_recent_1to1s',
  'List the most recent 1-2-1s that actually took place with each direct report, detected from meeting notes in the vault. Use this to answer "when did I last have a 1-2-1 with X" — it reads held meetings, not prep documents or calendar bookings.',
  {
    person: z.string().optional().describe('Limit to one person, e.g. "Heidi Power". Omit for everyone.'),
  },
  async ({ person }) => {
    const data = await neuroApi('/api/1to1/recent');
    const byPerson = data.byPerson || {};
    const names = person ? [person] : Object.keys(byPerson).sort();
    const lines = names.map((name) => {
      const list = byPerson[name] || [];
      if (!list.length) return `**${name}** — no 1-2-1 found in the vault`;
      const history = list.map(m => `  - ${m.date} — ${m.title}`).join('\n');
      return `**${name}** — last ${list[0].date}\n${history}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') || 'No 1-2-1s detected.' }] };
  });

server.tool('manage_meeting_note',
  'Create, append to, or update a structured meeting note in the vault.',
  {
    action: z.enum(['create', 'append', 'update']).describe('create: new note; append: add to end; update: replace a section'),
    title: z.string().describe('Meeting title (becomes filename slug)'),
    date: z.string().optional().describe('ISO date (default today)'),
    type: z.enum(['1-1', 'team', 'project', 'external']).optional().describe('Meeting type (default 1-1)'),
    people: z.array(z.string()).optional().describe('Attendee names (must match People/{name}.md)'),
    body: z.string().optional().describe('Body content (for create/append)'),
    section: z.string().optional().describe('Section name to replace (for update), e.g. "Action Items"'),
    content: z.string().optional().describe('New section content (for update)'),
  },
  async (args) => {
    const data = await neuroApi('/api/1to1/notes', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('find_action_items',
  'Find open (or closed) action items across the vault, optionally filtered by person.',
  {
    person: z.string().optional().describe('Filter to actions assigned to or mentioning this person'),
    status: z.enum(['open', 'done', 'all']).optional().describe('Default: open'),
    daysBack: z.number().optional().describe('Only scan dated files within this many days (default 90)'),
  },
  async ({ person, status, daysBack }) => {
    const qs = new URLSearchParams();
    if (person) qs.set('person', person);
    if (status) qs.set('status', status);
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/vault-actions?${qs.toString()}`);
    const items = (data.items || []).slice(0, 30).map(a => {
      const check = a.done ? '[x]' : '[ ]';
      const due = a.dueDate ? ` 📅 ${a.dueDate}` : '';
      const who = a.assignee ? ` 👤 ${a.assignee}` : '';
      return `- ${check} ${a.text}${due}${who}\n  _(${a.file}:${a.lineNumber})_`;
    }).join('\n');
    return {
      content: [{
        type: 'text',
        text: `Found ${data.count} action items${person ? ` for ${person}` : ''}.\n\n${items || '(none)'}`,
      }],
    };
  });

server.tool('manage_development_plan',
  'Read or update a direct report\'s development plan (Documents/HR/{Person} - Development Plan.md).',
  {
    action: z.enum(['read', 'update_progress', 'add_goal', 'complete_goal']),
    person: z.string().describe('Person name'),
    goalNumber: z.number().optional().describe('Goal number (for update_progress / complete_goal)'),
    progressNote: z.string().optional().describe('Progress note to append'),
    newGoal: z.object({
      title: z.string(),
      targetDate: z.string(),
      what: z.string().optional(),
      why: z.string().optional(),
      measure: z.string().optional(),
    }).optional().describe('New goal payload (for add_goal)'),
    date: z.string().optional().describe('Override date (default today)'),
  },
  async (args) => {
    const data = await neuroApi('/api/development-plan', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (args.action === 'read') {
      const goals = (data.goals || []).map(g =>
        `**Goal ${g.number}${g.complete ? ' ✅' : ''} — ${g.title}** (target: ${g.targetDate || '—'})\n  Progress: ${g.progress.length} entries`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${data.path}\n\n${goals || '(no goals)'}` }] };
    }
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('get_person_timeline',
  'Get a chronological timeline of events for a direct report (meetings, reviews, development plan progress, action items) over the last N days.',
  {
    person: z.string().describe('Person name, must match People/{name}.md'),
    daysBack: z.number().optional().describe('How far back to look (default 60)'),
  },
  async ({ person, daysBack }) => {
    const qs = new URLSearchParams();
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/person/${encodeURIComponent(person)}/timeline?${qs.toString()}`);
    const { counts, events } = data;
    const lines = [`# Timeline: ${data.person} (last ${data.daysBack} days)`, ''];
    lines.push(`**${counts.total} events** — meetings:${counts.meetings} reviews:${counts.reviews} plan:${counts.planEntries} actions:${counts.actions}`);
    lines.push('');
    for (const e of events.slice(0, 40)) {
      const icon = e.type === 'meeting' ? '📅' : e.type === 'review' ? '📊' : e.type === 'plan' ? '🎯' : '✓';
      lines.push(`${icon} **${e.date}** — ${e.title}`);
      if (e.excerpt) lines.push(`  > ${e.excerpt}`);
      if (e.path) lines.push(`  [[${e.path.replace(/\.md$/, '')}]]`);
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('team_health_snapshot',
  'Get a prioritised list of issues across direct reports. Defaults to HIGH severity only — the things requiring Nick\'s immediate attention. Override with severity="medium" to include elevated items or severity="all" for the full picture.',
  {
    team: z.string().optional().describe('Filter to a single team ("2nd Line Technical Support", "1st Line Customer Care", "Digital Design")'),
    severity: z.enum(['high', 'medium', 'low', 'all']).optional().describe('Minimum severity to include. Default: "high" (only urgent items). "medium" includes high+med. "all" or "low" returns everything.'),
  },
  async ({ team, severity }) => {
    const qs = new URLSearchParams();
    if (team) qs.set('team', team);
    if (severity) qs.set('severity', severity);
    const data = await neuroApi(`/api/team-health?${qs.toString()}`);
    const { counts, issues, severityFilter, filteredCount } = data;
    const lines = [`# Team Health — ${data.team}`, ''];
    lines.push(`**Filter:** ${severityFilter}  (showing ${filteredCount} of ${counts.high + counts.med + counts.low} total issues)`);
    lines.push(`**All severities:** 🔴 ${counts.high} high · 🟡 ${counts.med} med · ⚪ ${counts.low} low  (${counts.peopleWithIssues} people with issues, ${counts.peopleClean} clean)`);
    lines.push('');
    if (!issues.length) {
      lines.push(`_No issues at severity '${severityFilter}' or above. Use severity='all' to see the full picture._`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    const byPerson = {};
    for (const i of issues) {
      if (!byPerson[i.person]) byPerson[i.person] = [];
      byPerson[i.person].push(i);
    }
    for (const [person, list] of Object.entries(byPerson)) {
      lines.push(`## ${person} _(${list[0].team})_`);
      for (const i of list) {
        const dot = i.severity === 'high' ? '🔴' : i.severity === 'med' ? '🟡' : '⚪';
        lines.push(`- ${dot} **${i.type}** — ${i.title}`);
      }
      lines.push('');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

// ═══════════════════════════════════════════════════════
// Tools: Tier 3 — Profile, Plan, Weekly, KB
// ═══════════════════════════════════════════════════════

server.tool('manage_person_profile',
  'Create or modify a person profile file in People/. Actions: create (new note), update (merge frontmatter), add_meeting (append to 1-2-1 history table), add_task (add a tagged task bullet).',
  {
    action: z.enum(['create', 'update', 'add_meeting', 'add_task']),
    person: z.string().describe('Person name (must match People/{name}.md)'),
    frontmatter: z.record(z.string(), z.any()).optional().describe('Frontmatter fields to set (for create/update)'),
    date: z.string().optional().describe('ISO date (for add_meeting/add_task, default today)'),
    meetingType: z.string().optional().describe('For add_meeting — e.g. "1-2-1", "Probation check-in"'),
    peopleHR: z.string().optional().describe('For add_meeting — "✅" or "❌"'),
    notes: z.string().optional().describe('For add_meeting — row notes cell'),
    task: z.string().optional().describe('For add_task — the task description'),
    accepted: z.boolean().optional().describe('For add_task — tag as #accepted (true) or #watch (false)'),
    force: z.boolean().optional().describe('Overwrite existing file on create'),
  },
  async (args) => {
    const data = await neuroApi('/api/person-profile', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('manage_evidence_register',
  'Add or update an entry in the 90-Day Plan Evidence Register (Projects/90 Day Plan/Evidence Register.md). Entries are grouped by Outcome.',
  {
    action: z.enum(['add', 'update', 'list']),
    outcome: z.string().optional().describe('Outcome reference ("1", "Outcome 1", or substring of title). Required for add/update.'),
    evidence: z.string().optional().describe('Evidence description (new row for add, or substring to find for update)'),
    location: z.string().optional().describe('Where the evidence lives (URL or [[wiki-link]])'),
    checkpoint: z.string().optional().describe('Which checkpoint this satisfies — e.g. "Day 15", "Day 30 + Day 45"'),
  },
  async (args) => {
    const data = await neuroApi('/api/evidence', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (args.action === 'list') {
      const lines = [`# Evidence Register\nPath: ${data.path}\n`];
      for (const o of data.outcomes || []) {
        lines.push(`## ${o.title} _(${o.rowCount} rows)_`);
        for (const r of o.rows.slice(0, 5)) {
          lines.push(`- ${r.evidence.substring(0, 80)} — ${r.checkpoint}`);
        }
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.outcome || data.path}\n${(data.changes || []).join('\n')}` }] };
  });

server.tool('compare_checkpoint_progress',
  'Compare the 90-Day Plan deliverables for a checkpoint against the Evidence Register and return a gap analysis with completion %.',
  {
    checkpoint: z.string().describe('Checkpoint reference — e.g. "day-15", "day-30", "Day 60"'),
  },
  async ({ checkpoint }) => {
    const data = await neuroApi(`/api/checkpoint/${encodeURIComponent(checkpoint)}`);
    const a = data.analysis;
    const lines = [
      `# Checkpoint: ${data.checkpoint} (${data.plan.date})`,
      `**Status:** ${data.plan.status || 'n/a'}`,
      `**Completion:** ${a.covered} / ${a.total} (${a.completionPct}%)`,
      `**Evidence entries tagged:** ${data.evidence.count}`,
      '',
      '## Deliverables',
    ];
    for (const d of a.deliverables) {
      lines.push(`- ${d.covered ? '✅' : '❌'} ${d.deliverable}${d.covered ? ` _(${d.evidenceCount} evidence)_` : ''}`);
    }
    if (a.gaps.length) {
      lines.push('', '## Gaps');
      for (const g of a.gaps) lines.push(`- ${g}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('summarize_week',
  'Generate a weekly summary markdown brief for Chris Middleton, aggregating meetings, reviews, dev plan updates, and action items from the week.',
  {
    weekStarting: z.string().optional().describe('ISO date (YYYY-MM-DD) of Monday. Defaults to this week\'s Monday.'),
  },
  async ({ weekStarting }) => {
    const qs = new URLSearchParams();
    if (weekStarting) qs.set('weekStarting', weekStarting);
    const data = await neuroApi(`/api/weekly-summary?${qs.toString()}`);
    return { content: [{ type: 'text', text: data.markdown }] };
  });

server.tool('find_knowledge_gaps',
  'Identify missing KB articles by scanning dev plans, meeting notes, and projects for "KBA" / "KB article" / "knowledge base" mentions.',
  {
    topic: z.string().optional().describe('Filter suggestions containing this substring'),
    daysBack: z.number().optional().describe('How far back to scan (default 90)'),
  },
  async ({ topic, daysBack }) => {
    const qs = new URLSearchParams();
    if (topic) qs.set('topic', topic);
    if (daysBack) qs.set('daysBack', String(daysBack));
    const data = await neuroApi(`/api/knowledge-gaps?${qs.toString()}`);
    const lines = [
      `# Knowledge Gap Suggestions`,
      `Scanned last ${data.daysBack} days. ${data.counts.uniqueTopics} unique topics from ${data.counts.planMentions + data.counts.meetingMentions + data.counts.projectMentions} mentions.`,
      `Existing KB articles in vault: ${data.counts.existingKbArticles}`,
      '',
      '## Top Suggestions',
    ];
    for (const s of (data.suggestions || []).slice(0, 15)) {
      const sources = s.sources.map(src => src.source).join(', ');
      lines.push(`- **${s.topic}** _(${s.count} mentions, sources: ${sources})_`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

server.tool('manage_kb_article',
  'Create or update a KB article in KB/{category}/. Uses a standard 6-section template if content is not supplied.',
  {
    action: z.enum(['create', 'update']),
    title: z.string().describe('Article title'),
    category: z.string().optional().describe('Category subfolder (e.g. "Feeds", "Hub", "Valuation")'),
    content: z.string().optional().describe('Full article markdown (replaces body)'),
    tags: z.array(z.string()).optional().describe('Frontmatter tags'),
    force: z.boolean().optional().describe('Overwrite existing article on create'),
  },
  async (args) => {
    const data = await neuroApi('/api/kb-article', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: `**${data.status}** — ${data.path}\n${(data.changes || []).join('\n')}` }] };
  });

// Training matrix sync is owned by the n8n "Training Matrix Sync" workflow
// which fetches NOVA /api/public/training-export and POSTs to NEURO
// /api/training/apply-matrix on a schedule. No MCP tool exposes this — there
// is no useful manual-trigger story from a chat client since the caller would
// still need NOVA data to pass through.

// ═══════════════════════════════════════════════════════
// Tools: Health
// ═══════════════════════════════════════════════════════

server.tool('get_health',
  'Apple Health from the watch: stress score against a rolling 14-day HRV baseline, plus what data has actually arrived and how fresh it is.',
  {
    days: z.number().optional().describe('Freshness window for the metric summary, in days (default 30)'),
  },
  async ({ days }) => {
    const [stress, series] = await Promise.all([
      neuroApi('/api/health/stress'),
      neuroApi(`/api/health/metrics?days=${days || 30}`),
    ]);

    const lines = ['# Health', ''];

    // The score is deliberately allowed to say "I don't know yet". Below 7 days
    // or 20 samples stress-score returns `calibrating` with a null score rather
    // than inventing a number, and repeating that here is the whole point —
    // rendering a confident figure over a thin baseline is the failure mode.
    if (stress?.status === 'calibrating') {
      lines.push(`**Stress: calibrating** — ${stress.reason || 'not enough baseline yet'}`);
    } else if (stress?.status === 'stale') {
      lines.push('**Stress: stale** — no HRV reading recently enough to score.');
    } else if (typeof stress?.score === 'number') {
      lines.push(`**Stress ${stress.score}/100** (${stress.band || 'n/a'}) — HRV ${stress.hrv}ms at ${stress.hrvAt}`);
    } else {
      lines.push('**Stress: unavailable**');
    }
    for (const c of stress?.caveats || []) lines.push(`- ⚠ ${c}`);

    lines.push('', `## Data arriving (${series.metricCount} metrics, ${series.totalSamples} samples / ${series.windowDays}d)`, '');
    if (!series.metrics?.length) {
      lines.push('Nothing in the window. The phone syncs at iOS\'s discretion, so a gap is not necessarily a fault — but nothing at all usually means the app has been force-quit.');
    } else {
      for (const m of series.metrics.slice(0, 40)) {
        const age = m.ageHours === null ? '?' : m.ageHours < 48 ? `${m.ageHours}h ago` : `${Math.round(m.ageHours / 24)}d ago`;
        lines.push(`- **${m.metric}** — ${m.samples} samples, last ${age}`);
      }
      if (series.metrics.length > 40) lines.push(`- …and ${series.metrics.length - 40} more`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ═══════════════════════════════════════════════════════
// Tools: System
// ═══════════════════════════════════════════════════════

server.tool('get_status', 'Get NEURO system status — AI, integrations, health', {}, async () => {
  const data = await neuroApi('/api/status');
  return {
    content: [{
      type: 'text',
      text: `NEURO v${data.version}, uptime: ${Math.round(data.uptime / 60)}min\nAI: ${data.ai?.mode || '?'}\nOllama: ${data.ollamaReachable ? 'OK' : 'down'}\nJira: ${data.jira?.status || '?'}\nMicrosoft: ${data.microsoft?.source || 'none'}`,
    }],
  };
});

// ── Start server ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[NEURO MCP] Server started — connected via stdio');
  console.error(`[NEURO MCP] Backend: ${NEURO_URL}`);
}

main().catch(e => {
  console.error('[NEURO MCP] Fatal:', e);
  process.exit(1);
});
