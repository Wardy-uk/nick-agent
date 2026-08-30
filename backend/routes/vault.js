const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// API key auth — required for all vault access (read and write).
// Accepts via header (X-Api-Key) or query param (api_key).
// VAULT_API_KEY must be set in .env — if unset, all vault access is blocked.
function requireApiKey(req, res, next) {
  const expected = process.env.VAULT_API_KEY;
  if (!expected) {
    console.error('[Vault] VAULT_API_KEY not configured — blocking all vault access');
    return res.status(503).json({ error: 'Vault API key not configured on server' });
  }
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized — valid API key required' });
  }
  next();
}

router.use(requireApiKey);

// Resolve and validate path stays within vault
function safePath(relativePath) {
  if (relativePath === undefined || relativePath === null) return null;
  const resolved = path.resolve(VAULT_PATH, relativePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) return null; // path traversal guard
  return resolved;
}

// GET /api/vault/read?path=relative/path.md
router.get('/read', (req, res) => {
  const filePath = safePath(req.query.path);
  if (!filePath) return res.status(400).json({ error: 'Invalid or missing path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found', path: req.query.path });
  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ path: req.query.path, content });
});

// POST /api/vault/write  { path: "relative/path.md", content: "..." }
router.post('/write', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const filePath = safePath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  try { require('../services/vault-hooks').onVaultWrite(filePath, 'vault-api-write'); } catch {}
  res.json({ success: true, path: relPath });
});

// POST /api/vault/append  { path: "relative/path.md", content: "..." }
router.post('/append', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || !content) return res.status(400).json({ error: 'path and content required' });
  const filePath = safePath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, existing + content, 'utf-8');
  try { require('../services/vault-hooks').onVaultWrite(filePath, 'vault-api-append'); } catch {}
  res.json({ success: true, path: relPath });
});

// GET /api/vault/list?dir=relative/dir
router.get('/list', (req, res) => {
  const dirPath = safePath(req.query.dir || '');
  if (!dirPath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Directory not found' });
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file'
  }));
  res.json({ dir: req.query.dir || '', files });
});

/**
 * GET /api/vault/search?query=term&dir=optional/subdir
 *
 * ⚠ This used to be a THIRD substring walker with its own copy of every bug
 * `services/retrieval.js` had: depth capped at 4 (so `Meetings/YYYY/MM/` was
 * the deepest thing reachable), an early stop at 20 results in filesystem
 * order, no ranking, and no semantic arm at all. It is what the MCP
 * `search_vault` tool calls, so every external Claude Code session searching
 * this vault was getting the crudest of the three answers — and could not tell,
 * because a substring walk always returns something.
 *
 * It is the unified retrieval now. `dir` becomes a `folder:` scope, which is
 * enforced after every source and again after fusion.
 *
 * The response keeps `matches` alongside `excerpts`: `VaultBrowser` renders
 * `matches[].text` and the MCP tool reads either, so changing the shape would
 * have emptied a working screen to tidy a payload.
 */
router.get('/search', async (req, res) => {
  const { query, dir } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  // Still resolved, purely to refuse a traversal attempt before it becomes a
  // scope. The walk itself no longer takes a directory.
  const searchDir = safePath(dir || '');
  if (!searchDir) return res.status(400).json({ error: 'Invalid path' });

  try {
    const scopeDir = String(dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const { results, health } = await require('../services/retrieval').searchWithHealth(String(query), {
      maxResults: 20,
      scope: scopeDir ? `folder:${scopeDir}` : undefined,
    });

    res.json({
      query,
      results: results.map(r => ({
        path: r.path,
        name: r.name,
        // `line` is null rather than invented: the unified search scores whole
        // notes and reports the passages it matched, and a fabricated line
        // number is worse than none on a screen that offers to jump to it.
        matches: (r.excerpts || []).slice(0, 3).map(text => ({ line: null, text })),
        excerpts: r.excerpts || [],
        score: r.score,
        ...(r.indexIncomplete ? { indexIncomplete: true } : {}),
      })),
      // Carried so no caller has to guess why a result set is thin. "Nothing
      // matched" and "half the search was unavailable" are different facts.
      health,
    });
  } catch (e) {
    console.error('[Vault] search failed:', e.message);
    // An error is NOT an empty vault.
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault/search/temporal?query=X&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/search/temporal', async (req, res) => {
  const { query, from, to, limit = 5 } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const results = [];
  const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'Imports']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= parseInt(limit) * 3) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const modified = new Date(stat.mtime);
        if (modified < fromDate || modified > toDate) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.toLowerCase().includes(query.toLowerCase())) continue;

        const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const body = content.replace(/^---[\s\S]*?---\n*/, '');
        const lines = body.split('\n');
        const excerpts = [];
        for (let i = 0; i < lines.length && excerpts.length < 2; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            excerpts.push(lines[i].substring(0, 200));
          }
        }
        results.push({
          path: relPath,
          name: entry.name.replace('.md', ''),
          modified: stat.mtime,
          excerpts
        });
      }
    }
  }

  walk(VAULT_PATH, 0);
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  res.json({ results: results.slice(0, parseInt(limit)), from: fromDate, to: toDate });
});

// POST /api/vault/export-docx — create a Word doc from markdown content
router.post('/export-docx', async (req, res) => {
  const { content, filename, subdir } = req.body;
  if (!content || !filename) {
    return res.status(400).json({ error: 'content and filename required' });
  }

  const safeName = filename.replace(/[^a-z0-9\s\-_]/gi, '').trim() || 'export';
  const docxName = safeName.endsWith('.docx') ? safeName : `${safeName}.docx`;

  const targetDir = safePath(subdir || 'Exports');
  if (!targetDir) return res.status(400).json({ error: 'Invalid export path' });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, docxName);

  const mdContent = `---\ntype: export\nexported: ${new Date().toISOString()}\noriginal_format: docx\n---\n\n${content}`;
  const mdPath = path.join(targetDir, docxName.replace('.docx', '.md'));
  fs.writeFileSync(mdPath, mdContent, 'utf-8');

  const relPath = path.relative(VAULT_PATH, mdPath).replace(/\\/g, '/');

  // Try Pandoc conversion if available
  const { execFileSync } = require('child_process');
  let converted = false;
  try {
    execFileSync('pandoc', [mdPath, '-o', targetPath, '--from', 'markdown'], { timeout: 10000 });
    converted = true;
    console.log(`[Vault] Pandoc converted to docx: ${targetPath}`);
  } catch {
    console.log('[Vault] Pandoc not available — saved as markdown');
  }

  res.json({
    ok: true,
    path: relPath,
    docxPath: converted ? path.relative(VAULT_PATH, targetPath).replace(/\\/g, '/') : null,
    filename: docxName,
    converted,
    vaultUrl: `/vault?open=${encodeURIComponent(relPath)}`
  });
});

// GET /api/vault/related?path=relative/path&limit=3
router.get('/related', async (req, res) => {
  try {
    const { path: notePath, limit = 3 } = req.query;
    if (!notePath) return res.status(400).json({ error: 'path required' });

    const fullPath = safePath(notePath);
    if (!fullPath) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const body = content.replace(/^---[\s\S]*?---\n*/, '').substring(0, 500);

    const obsidian = require('../services/obsidian');
    const results = await obsidian.searchVaultSemantic(body, parseInt(limit) + 1);

    // Exclude the note itself from results
    const related = (results || [])
      .filter(r => r.path !== notePath)
      .slice(0, parseInt(limit));

    res.json({ related });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/vault/delete — delete a vault note
router.delete('/delete', (req, res) => {
  const { path: relPath } = req.query;
  if (!relPath) return res.status(400).json({ error: 'path required' });

  const filePath = safePath(relPath);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  if (fs.statSync(filePath).isDirectory()) {
    return res.status(400).json({ error: 'Cannot delete directories' });
  }

  try {
    fs.unlinkSync(filePath);

    try { require('../db/database').deleteEmbedding(relPath); } catch {}
    try { require('../db/database').deleteEntitiesForPath(relPath); } catch {}
    try { require('../db/database').deleteLinksForPath(relPath); } catch {}

    console.log(`[Vault] Deleted: ${relPath}`);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault/backlinks?path=relative/path
router.get('/backlinks', async (req, res) => {
  try {
    const { path: notePath } = req.query;
    if (!notePath) return res.status(400).json({ error: 'path required' });

    const db = require('../db/database');
    const backlinks = db.getBacklinks(notePath);

    // Also search entity mentions by note name
    const noteName = path.basename(notePath, '.md');
    const entityMentions = db.getEntitiesByValue(noteName);

    // Combine and deduplicate
    const seen = new Set();
    const combined = [];

    for (const link of backlinks) {
      if (!seen.has(link.source_path)) {
        seen.add(link.source_path);
        combined.push({ path: link.source_path, type: link.link_type });
      }
    }

    for (const entity of entityMentions) {
      if (!seen.has(entity.source_path)) {
        seen.add(entity.source_path);
        combined.push({ path: entity.source_path, type: 'mention' });
      }
    }

    const enriched = combined.slice(0, 10).map(item => ({
      ...item,
      name: path.basename(item.path, '.md')
    }));

    res.json({ backlinks: enriched, total: combined.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault/mentions?person=Name
router.get('/mentions', (req, res) => {
  const { person } = req.query;
  if (!person) return res.status(400).json({ error: 'person required' });
  try {
    const entities = require('../services/entities');
    const paths = entities.getMentionsOf(person);
    res.json({ person, mentions: paths });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vault/orphans?days=7
router.get('/orphans', (req, res) => {
  try {
    const entities = require('../services/entities');
    const orphans = entities.getOrphans(parseInt(req.query.days) || 7);
    res.json({ orphans, count: orphans.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vault/person-doc — generate a structured document from person context
router.post('/person-doc', (req, res) => {
  const { personName, docType, content } = req.body;
  if (!personName || !content) {
    return res.status(400).json({ error: 'personName and content required' });
  }

  const VALID_TYPES = ['performance-review', 'pip', '1-2-1-summary', 'feedback', 'general'];
  const type = VALID_TYPES.includes(docType) ? docType : 'general';

  const safeName = personName.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `${dateStr}-${safeName.replace(/\s+/g, '-')}-${type}.md`;

  const targetDir = safePath('People/Documents');
  if (!targetDir) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const filePath = path.join(targetDir, filename);
  const titleCase = type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const fileContent = `---\ntype: ${type}\nperson: ${safeName}\ndate: ${dateStr}\nsource: neuro-chat\n---\n\n# ${titleCase} — ${safeName}\n\n*Generated ${new Date().toLocaleString('en-GB')}*\n\n${content}\n`;

  fs.writeFileSync(filePath, fileContent, 'utf-8');

  const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');

  // Trigger entity extraction, embedding, and tracking
  try {
    require('../services/embeddings').embedVaultFile(relPath, filePath).catch(() => {});
    require('../services/entities').processNote(relPath);
  } catch {}
  try { require('../services/activity').trackVaultWrite('person-doc'); } catch {}

  res.json({ ok: true, path: relPath, filename });
});

module.exports = router;
