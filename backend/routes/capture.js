const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function getImportsDir() {
  return path.join(process.env.OBSIDIAN_VAULT_PATH || '', 'Imports');
}

function getFilesDir() {
  return path.join(getImportsDir(), 'Files');
}

function ensureDirs() {
  const imports = getImportsDir();
  const files = getFilesDir();
  if (!fs.existsSync(imports)) fs.mkdirSync(imports, { recursive: true });
  if (!fs.existsSync(files)) fs.mkdirSync(files, { recursive: true });
}

function timestamp() {
  const d = new Date();
  return d.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
}

function frontmatter(title) {
  const now = new Date().toISOString();
  let fm = `---\ndate: ${now}\nsource: neuro-capture\nstatus: unprocessed\n`;
  if (title) fm += `title: "${title.replace(/"/g, '\\"')}"\n`;
  fm += '---\n\n';
  return fm;
}

// Multer config — store in memory, enforce size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// POST /api/capture/note — quick text capture
router.post('/note', (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    ensureDirs();
    const slug = (title || 'note').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 40).trim().replace(/\s+/g, '-');
    const filename = `${timestamp()}-${slug}.md`;
    const filePath = path.join(getImportsDir(), filename);

    const body = title
      ? `${frontmatter(title)}# ${title}\n\n${content.trim()}\n`
      : `${frontmatter(null)}${content.trim()}\n`;

    fs.writeFileSync(filePath, body, 'utf-8');

    // Verify the file actually landed
    if (!fs.existsSync(filePath)) {
      console.error(`[Capture] VERIFICATION FAILED — file not found after write: ${filePath}`);
      try {
        require('../services/webpush').sendToAll(
          'NEURO — Capture Failed',
          `Note "${(title || content.substring(0, 30))}" did not save. Check vault path.`,
          { type: 'capture_failed' }
        ).catch(() => {});
      } catch {}
      return res.status(500).json({ error: 'File write verification failed' });
    }

    const written = fs.readFileSync(filePath, 'utf-8');
    if (written.length < 10) {
      console.error(`[Capture] VERIFICATION FAILED — file too small: ${written.length} bytes`);
    }

    console.log(`[Capture] Note saved and verified: ${filename} (${written.length} bytes)`);
    res.json({ success: true, path: filePath, filename, verified: true });
    try { require('../services/activity').trackCapture('note'); } catch {}
    // Trigger vault hooks (embedding + entity extraction + working memory invalidation)
    try { require('../services/vault-hooks').onVaultWrite(filePath, 'capture-note'); } catch {}
  } catch (e) {
    console.error('[Capture] Note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/capture/todo — quick todo capture, appends to Master Todo.md inbox section
router.post('/todo', (req, res) => {
  const { text, priority } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    obsidian.addTodoToMasterList(text, { priority, trigger: 'capture-todo' });
    console.log(`[Capture] Todo saved: ${text.trim()}`);
    res.json({ success: true, text: text.trim() });
    try { require('../services/activity').trackCapture('todo'); } catch {}
  } catch (e) {
    console.error('[Capture] Todo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/capture/photo — image upload (camera or gallery)
router.post('/photo', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    ensureDirs();
    const ts = timestamp();
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `${ts}-photo${ext}`;
    const filePath = path.join(getFilesDir(), filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // Also create a markdown note linking the image
    const mdFilename = `${ts}-photo-capture.md`;
    const mdPath = path.join(getImportsDir(), mdFilename);
    const mdContent = `${frontmatter('Photo capture')}![[Files/${filename}]]\n`;
    fs.writeFileSync(mdPath, mdContent, 'utf-8');

    console.log(`[Capture] Photo saved: ${filename}`);
    res.json({ success: true, path: filePath, filename });
    try { require('../services/vault-hooks').onVaultWrite(mdPath, 'capture-photo'); } catch {}
  } catch (e) {
    console.error('[Capture] Photo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/capture/file — any file upload
router.post('/file', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    ensureDirs();
    const ts = timestamp();
    const ext = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 40).trim().replace(/\s+/g, '-');
    const filename = `${ts}-${baseName}${ext}`;
    const filePath = path.join(getFilesDir(), filename);

    fs.writeFileSync(filePath, req.file.buffer);

    // Create a markdown note linking the file
    const mdFilename = `${ts}-file-capture.md`;
    const mdPath = path.join(getImportsDir(), mdFilename);
    const mdContent = `${frontmatter(req.file.originalname)}Attached file: [[Files/${filename}]]\n\nOriginal name: ${req.file.originalname}\nSize: ${(req.file.size / 1024).toFixed(1)} KB\n`;
    fs.writeFileSync(mdPath, mdContent, 'utf-8');

    console.log(`[Capture] File saved: ${filename}`);
    res.json({ success: true, path: filePath, filename });
    try { require('../services/vault-hooks').onVaultWrite(mdPath, 'capture-file'); } catch {}
  } catch (e) {
    console.error('[Capture] File error:', e);
    res.status(500).json({ error: e.message });
  }
});

function listMdFilesRecursive(dir, maxDepth = 2, depth = 0) {
  if (depth > maxDepth) return [];
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < maxDepth) {
      results.push(...listMdFilesRecursive(fullPath, maxDepth, depth + 1));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// GET /api/capture/recent — last 20 items captured (from Imports/ md files, newest first)
router.get('/recent', (req, res) => {
  try {
    const importsDir = getImportsDir();
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
    if (!fs.existsSync(importsDir)) return res.json({ items: [] });

    const files = listMdFilesRecursive(importsDir, 2)
      .map(fullPath => {
        const stats = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const preview = content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 120).trim();
        const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
        const relativePath = path.relative(vaultPath, fullPath).replace(/\\/g, '/');
        return {
          filename: path.basename(fullPath),
          relativePath,
          title: titleMatch ? titleMatch[1] : null,
          preview,
          modified: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, 20);

    res.json({ items: files });
  } catch (e) {
    console.error('[Capture] Recent error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/capture/health — verify capture system is working
router.get('/health', (req, res) => {
  try {
    const importsDir = getImportsDir();
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
    const dirExists = fs.existsSync(importsDir);
    const vaultExists = fs.existsSync(vaultPath);
    const writable = dirExists && (() => {
      try {
        const testFile = path.join(importsDir, '.neuro-health-check');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        return true;
      } catch { return false; }
    })();

    const healthy = vaultExists && dirExists && writable;
    if (!healthy) {
      console.error(`[Capture] Health check FAILED — vault:${vaultExists} imports:${dirExists} writable:${writable}`);
    }

    res.json({
      healthy,
      vault: vaultExists,
      importsDir: dirExists,
      writable,
      vaultPath: vaultPath ? '(configured)' : '(not set)'
    });
  } catch (e) {
    res.status(500).json({ healthy: false, error: e.message });
  }
});

// Multer error handler (file too large, etc.)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large — 10MB maximum' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
