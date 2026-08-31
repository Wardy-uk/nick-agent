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

/**
 * Resolve a caller-supplied path and prove it is inside the vault.
 *
 * ⚠ THE BUG THIS REPLACES: `resolved.startsWith(path.resolve(VAULT_PATH))` is a
 * STRING prefix test, and a sibling directory shares the prefix. With the vault
 * at `C:\Vault`, the path `../Vault-old/secret.md` resolves to
 * `C:\Vault-old\secret.md`, which starts with `C:\Vault` — so it passed, and
 * every route that reads, writes, appends, lists or DELETES did so outside the
 * vault. `C:\Vault-backup`, `C:\Vault Personal` and `/home/nickw/nuero-vault-old`
 * are all the same hole. Nick's vault has a `Personal/` folder holding
 * disciplinary prep, a fraud investigation and OH documents; a sibling copy of
 * it is exactly the thing this must not hand out.
 *
 * The fix is to ask the path library rather than the string: `path.relative`
 * from the root is `..` or starts with `..<sep>` for anything outside, and is
 * absolute when the two are on different drives.
 *
 * Returns the absolute path, or null. Null is a REFUSAL — every caller already
 * turns it into a 400, and none of them may treat it as "use the root".
 */
function safePath(relativePath) {
  if (relativePath === undefined || relativePath === null) return null;
  if (typeof relativePath !== 'string') return null;
  // A NUL byte truncates a path inside some native calls — refuse outright.
  if (relativePath.includes('\0')) return null;

  // ⚠ No vault, no answer. Without this the whole thing resolves against the
  // process working directory, which is how the capture drop-box came to write
  // into the repository — the same class of bug, one service along.
  if (!VAULT_PATH) return null;
  let root;
  try {
    root = fs.realpathSync(path.resolve(VAULT_PATH));
  } catch {
    // The vault root is missing or unreadable. Refusing is the only honest
    // answer; guessing would operate on a path nobody has verified.
    return null;
  }

  const resolved = path.resolve(root, relativePath);
  if (!isInside(root, resolved)) return null;

  // ── Symlink escape ────────────────────────────────────────────────────────
  // If the target already exists, resolve it for real: a symlink INSIDE the
  // vault pointing outside it passes every textual test there is. A path that
  // does not exist yet is legitimate (this is how a new note is created), so
  // only the deepest existing ancestor is checked — which is what stops a new
  // file being created *through* an escaping link.
  const realTarget = realpathDeepest(resolved);
  if (realTarget && !isInside(root, realTarget)) return null;

  return resolved;
}

/** Is `target` the root itself, or inside it? PURE. */
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;                       // the vault root itself
  if (rel === '..') return false;
  if (rel.startsWith('..' + path.sep)) return false;
  if (rel.startsWith('../')) return false;           // belt and braces on win32
  if (path.isAbsolute(rel)) return false;            // different drive/UNC root
  return true;
}

/**
 * `realpath` of the deepest part of this path that actually exists.
 *
 * Returns null when nothing along it exists yet — which is not a failure, it is
 * a new file. Never throws.
 */
function realpathDeepest(target) {
  let current = target;
  for (let i = 0; i < 64; i++) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (!parent || parent === current) return null;
      current = parent;
    }
  }
  return null;
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

/**
 * GET /api/vault/search/temporal?query=X&from=YYYY-MM-DD&to=YYYY-MM-DD&dir=optional
 *
 * ⚠ This was the LAST bespoke walker in the codebase, and it carried every bug
 * `/api/vault/search` was rebuilt to remove: depth capped at 4 (so a note in
 * `Meetings/2026/08/deep/` was unreachable while looking perfectly searchable),
 * an early stop at `limit * 3` in raw filesystem order, no ranking, no semantic
 * arm, no scope, and — the one that matters most here — no way for a caller to
 * tell a complete answer from a partial one. A date-bounded search is exactly
 * where a thin answer gets read as "nothing happened that week".
 *
 * It is the unified retrieval now. `dir` becomes a `folder:` scope, enforced
 * after every source and again after fusion, so temporal results obey the same
 * scope guarantee ordinary search does.
 */
router.get('/search/temporal', async (req, res) => {
  const { query, from, to, limit = 5, dir } = req.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  // Still resolved, purely to refuse a traversal attempt before it becomes a
  // scope. The walk itself no longer takes a directory.
  const searchDir = safePath(dir || '');
  if (!searchDir) return res.status(400).json({ error: 'Invalid path' });

  // ⚠ Validate BEFORE searching. `new Date('lastweek')` is Invalid Date, every
  // comparison against it is false, and the old code fed it straight into the
  // filter — so a typo'd bound silently searched all of time and returned the
  // answer labelled as a date range. A bad date is a 400, never a wider search.
  const retrieval = require('../services/retrieval');
  const range = retrieval.parseDateRange({ from, to });
  if (!range.ok) {
    return res.status(400).json({ error: range.error, field: range.field });
  }
  const maxResults = Math.max(1, Math.min(parseInt(limit, 10) || 5, 100));

  try {
    const scopeDir = String(dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const { results, health } = await retrieval.searchWithHealth(String(query), {
      maxResults,
      from: range.from,
      to: range.to,
      scope: scopeDir ? `folder:${scopeDir}` : undefined,
    });

    res.json({
      query,
      results: results.map(r => ({
        path: r.path,
        name: r.name,
        modified: r.modified || null,
        // `line` is null rather than invented — same rule as `/search`.
        matches: (r.excerpts || []).slice(0, 3).map(text => ({ line: null, text })),
        excerpts: r.excerpts || [],
        score: r.score,
        ...(r.indexIncomplete ? { indexIncomplete: true } : {}),
      })),
      // Normalised, so the caller can see exactly which window was searched —
      // including that a date-only `to` means the END of that day.
      from: range.fromIso,
      to: range.toIso,
      range: {
        from: range.fromIso,
        to: range.toIso,
        fromDefaulted: range.fromDefaulted,
        toDefaulted: range.toDefaulted,
      },
      // Carried for the same reason `/search` carries it: a short list inside a
      // date range is the single easiest result in NEURO to misread as proof.
      health,
    });
  } catch (e) {
    console.error('[Vault] temporal search failed:', e.message);
    // An error is NOT an empty week.
    res.status(500).json({ error: e.message });
  }
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

  // The filename is already stripped of separators above, but it is joined onto
  // a caller-supplied directory — so the join goes back through the guard
  // rather than being trusted because its two halves looked fine apart.
  const targetPath = safePath(path.join(targetDir, docxName));
  const mdPath = safePath(path.join(targetDir, docxName.replace('.docx', '.md')));
  if (!targetPath || !mdPath) return res.status(400).json({ error: 'Invalid export path' });

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const mdContent = `---\ntype: export\nexported: ${new Date().toISOString()}\noriginal_format: docx\n---\n\n${content}`;
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

  const filePath = safePath(path.join(targetDir, filename));
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
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
// Exported for tests: containment is the security boundary of this whole
// router, and it is worth asserting directly rather than only through eight
// routes that happen to call it.
module.exports._safePath = safePath;
module.exports._isInside = isInside;
