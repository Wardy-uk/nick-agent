const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// The note writer lives in a service now — the mobile outbox is a second front
// door onto the same act, and two copies of "how a capture is written" is how
// one of them quietly stops matching the other.
const captureStore = require('../services/capture-store');
const getImportsDir = captureStore.importsDir;
const getFilesDir = captureStore.filesDir;
const ensureDirs = captureStore.ensureDirs;
const timestamp = captureStore.timestamp;

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

const writeCapturedNote = captureStore.writeNote;

// POST /api/capture/note — quick text capture
router.post('/note', (req, res) => {
  const { title, content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const { filePath, filename, written } = writeCapturedNote({ title, content });

    // Verify the file actually landed
    if (!fs.existsSync(filePath)) {
      console.error(`[Capture] VERIFICATION FAILED — file not found after write: ${filePath}`);
      try {
        require('../services/webpush').sendToAll(
          'SARA — Capture failed',
          `Note "${(title || content.substring(0, 30))}" did not save. Check vault path.`,
          { type: 'capture_failed' }
        ).catch(() => {});
      } catch {}
      return res.status(500).json({ error: 'File write verification failed' });
    }

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

// POST /api/capture/siri-note — Apple Watch / Siri Shortcut capture
// Accepts a simple text payload and returns a short spoken confirmation.
router.post('/siri-note', (req, res) => {
  const note = (req.body.note || req.body.content || req.body.text || '').trim();
  const title = (req.body.title || '').trim() || 'Watch note';
  const source = 'sara-watch-siri';

  if (!note) {
    return res.status(400).json({
      ok: false,
      error: 'note is required',
      spokenText: 'I did not catch a note to save.'
    });
  }

  try {
    const { filePath, filename, written } = writeCapturedNote({ title, content: note, source });

    if (written.length < 10) {
      console.error(`[Capture] Siri note unusually small: ${written.length} bytes`);
    }

    console.log(`[Capture] Siri note saved: ${filename} (${written.length} bytes)`);
    res.json({
      ok: true,
      filename,
      path: filePath,
      spokenText: 'Saved to SARA.',
      preview: note.slice(0, 120)
    });

    try { require('../services/activity').trackCapture('note'); } catch {}
    try { require('../services/vault-hooks').onVaultWrite(filePath, 'capture-siri-note'); } catch {}
  } catch (e) {
    console.error('[Capture] Siri note error:', e);
    res.status(500).json({
      ok: false,
      error: e.message,
      spokenText: 'I could not save that note to SARA.'
    });
  }
});

// POST /api/capture/todo — quick todo capture. Routes 1 (Watch/Siri) and 2 (NEURO
// direct) both land here.
//
// ── Obsidian first (Phase 4) ────────────────────────────────────────────────
// This used to be DB-first: a task row, and no durable vault record until the
// hourly export regenerated `Tasks/NEURO Tasks (export).md` — a read-only
// projection nothing reads back. So for up to an hour the only copy of the
// thought lived in a SQLite file the vault knows nothing about.
//
// Now the vault record is written FIRST and the task row second, and the
// response says which halves landed. The order matters in one direction only:
// a crash between the two must lose the task row (recoverable — the words are
// on disk in Obsidian) and never the words.
//
// ⚠ A vault miss does NOT fail the capture, and that is deliberate. A dev box
// with no `OBSIDIAN_VAULT_PATH`, or a Syncthing mount that has gone away, would
// otherwise refuse every capture — and refusing a capture is the one failure
// this whole area exists to prevent. What it must never do is claim a vault
// record it does not have, so `vault.written` is reported honestly and the
// client says so in words. The only 500 is when NEITHER half landed.
router.post('/todo', (req, res) => {
  const { text, priority, moscow, due, source } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Generated before either write, so the vault line and the task row can be
  // tied together afterwards without matching on text — two captures of the
  // same words are two captures.
  const captureId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  let vault = { written: false, why: 'not attempted' };
  let vaultRecord = null;
  try {
    vaultRecord = captureStore.appendTaskCapture({
      text: text.trim(),
      source: source || 'capture',
      captureId,
    });
    vault = { written: true, path: vaultRecord.relativePath };
  } catch (e) {
    console.error('[Capture] Todo vault record FAILED:', e.message);
    vault = { written: false, why: e.message };
  }

  try {
    const taskStore = require('../services/task-store');
    const { id, created, task } = taskStore.createTask({
      text,
      priority,
      moscow,
      due_date: due || null,
      source: source || 'capture',
      // Provenance the other way: the task points back at the line in the vault.
      origin_path: vaultRecord ? vaultRecord.relativePath : null,
    });
    if (vaultRecord) captureStore.stampTaskCaptureId(vaultRecord.relativePath, captureId, id);
    console.log(`[Capture] Todo ${created ? 'created' : 'folded into'} task #${id} (vault: ${vault.written ? 'yes' : 'no'})`);
    res.json({
      success: true,
      taskId: id,
      created,
      text: task.text,
      captureId,
      vault,
      // What the UI is allowed to SAY happened, per step, rather than one word
      // covering two writes that can fail independently.
      steps: {
        vault: vault.written ? 'saved' : 'failed',
        task: created ? 'created' : 'folded-into-existing',
      },
    });
    try { require('../services/activity').trackCapture('todo'); } catch {}
    if (vaultRecord) {
      try { require('../services/vault-hooks').onVaultWrite(vaultRecord.filePath, 'capture-todo'); } catch {}
    }
  } catch (e) {
    console.error('[Capture] Todo error:', e);
    // The vault half may still have landed. Saying "failed" over a thought that
    // IS on disk sends Nick to retype something already saved, so the honest
    // answer is a partial one — and only a total miss is a 500.
    if (vault.written) {
      return res.status(207).json({
        success: false,
        partial: true,
        captureId,
        vault,
        steps: { vault: 'saved', task: 'failed' },
        error: e.message,
      });
    }
    res.status(500).json({ success: false, vault, steps: { vault: 'failed', task: 'failed' }, error: e.message });
  }
});

// POST /api/capture/feature — a NEURO/SARA/NOVA idea straight into the backlog.
// Deliberately NOT a todo: the tracker is where the backlog is ranked and triaged,
// and a feature idea sitting in the task list is one nobody reads next to the other 92.
router.post('/feature', (req, res) => {
  const { title, notes, system, source } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const result = require('../services/feature-tracker').captureFeature({
      title,
      notes,
      system,
      source: source || 'Capture',
    });
    if (!result.ok) return res.status(500).json({ error: result.error });

    res.json({ success: true, number: result.number, system: result.system });
    try { require('../services/activity').trackCapture('note'); } catch {}
  } catch (e) {
    console.error('[Capture] Feature error:', e);
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
