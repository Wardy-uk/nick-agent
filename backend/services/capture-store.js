'use strict';

/**
 * capture-store — the ONE place a captured note becomes a file in the vault.
 *
 * This was a private function inside `routes/capture.js`. It is a service now
 * because Phase 2 gives capture a second front door (the mobile outbox), and two
 * copies of "how a capture is written" is exactly how one of them quietly stops
 * matching the other. The route keeps its behaviour; it just no longer owns the
 * knowledge.
 *
 * Nothing here logs the captured TEXT — a capture is often the most sensitive
 * thing on the device, and a log line is the easiest place to leak it.
 */

const fs = require('fs');
const path = require('path');

function importsDir() {
  return path.join(process.env.OBSIDIAN_VAULT_PATH || '', 'Imports');
}

function filesDir() {
  return path.join(importsDir(), 'Files');
}

function ensureDirs() {
  const imports = importsDir();
  const files = filesDir();
  if (!fs.existsSync(imports)) fs.mkdirSync(imports, { recursive: true });
  if (!fs.existsSync(files)) fs.mkdirSync(files, { recursive: true });
}

function timestamp() {
  const d = new Date();
  return d.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
}

function slugifyTitle(title) {
  return (title || 'note')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .substring(0, 40)
    .trim()
    .replace(/\s+/g, '-');
}

// How many suffixed names to try before giving up. A capture is worth a hundred
// attempts; a thousand would mean something else is wrong and the honest move is
// to refuse loudly rather than spin.
const MAX_NAME_ATTEMPTS = 100;

/**
 * Write a captured note. Synchronous by design: the mobile sync applier relies
 * on there being no await between checking the idempotency ledger and doing the
 * work, which is what makes that ledger a real mutex in a single Node process
 * (`plaud-admin-blocks`' rule).
 *
 * Throws if the file did not land — a capture that reports success over a failed
 * write is the failure this whole area exists to prevent.
 *
 * ⚠ THE FILENAME IS ONLY UNIQUE TO THE SECOND, so two captures made inside one
 * second collided and the second SILENTLY OVERWROTE the first. Both were then
 * reported saved, and the ledger acknowledged both as applied against the same
 * canonical id — a destroyed capture, indistinguishable from a saved one. It was
 * always reachable from the web route (two quick captures), and the outbox made
 * it ordinary: a queue drained after a train journey replays several notes into
 * the same tick of the clock.
 *
 * The guard is the `wx` flag — O_CREAT|O_EXCL, refused by the OS if the path
 * exists — NOT an `existsSync` check followed by a write, which is a race with a
 * gap in the middle. On EEXIST it suffixes and tries again, so a collision costs
 * a `-2` on the filename and never a note. Suffixing only on an actual collision
 * keeps the ordinary filename clean, which matters because these are read by a
 * human in Obsidian.
 */
function writeNote({ title, content, source = 'neuro-capture' }) {
  const text = String(content || '').trim();
  if (!text) throw new Error('content is required');

  ensureDirs();
  const slug = slugifyTitle(title);
  const stamp = timestamp();

  const now = new Date().toISOString();
  const fmTitle = title ? `title: "${String(title).replace(/"/g, '\\"')}"\n` : '';
  const body = title
    ? `---\ndate: ${now}\nsource: ${source}\nstatus: unprocessed\n${fmTitle}---\n\n# ${title}\n\n${text}\n`
    : `---\ndate: ${now}\nsource: ${source}\nstatus: unprocessed\n---\n\n${text}\n`;

  let filename = null;
  let filePath = null;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stamp}-${slug}.md` : `${stamp}-${slug}-${attempt}.md`;
    const candidatePath = path.join(importsDir(), candidate);
    try {
      fs.writeFileSync(candidatePath, body, { encoding: 'utf-8', flag: 'wx' });
      filename = candidate;
      filePath = candidatePath;
      break;
    } catch (e) {
      // Only a name clash is retryable. A permissions error or a missing vault
      // must surface as itself rather than being retried a hundred times and
      // reported as "could not find a free name".
      if (e.code !== 'EEXIST') throw e;
    }
  }

  if (!filePath) {
    throw new Error(`Could not find a free filename for this capture after ${MAX_NAME_ATTEMPTS} attempts`);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('File write verification failed');
  }

  const written = fs.readFileSync(filePath, 'utf-8');
  return { filePath, filename, written };
}

/** Vault-relative path, forward-slashed — the id a mobile client can hold onto. */
function relativePath(filePath) {
  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vault) return filePath;
  return path.relative(vault, filePath).replace(/\\/g, '/');
}


// ── Obsidian-first task capture ──────────────────────────────────────────────
//
// A captured todo used to be DB-first: `POST /api/capture/todo` created a task
// row and the vault heard about it up to an hour later, via the regenerated
// `Tasks/NEURO Tasks (export).md`. That export is a read-only projection —
// nothing parses it back — so between the capture and the next export there was
// no durable Obsidian record of the thought at all. Obsidian is the vault and
// the durable memory; the task table is the operational projection of it.
//
// So the vault gets its record FIRST, and the capture reports honestly which
// halves landed.
//
// ⚠ APPEND-ONLY, and never into the generated export. Editing a file that is
// rewritten wholesale on every task change would destroy the record on the next
// export — the same class of loss as `ms-push-queue`'s reappearing task. One
// monthly log keeps the vault readable (one file a month, not 90 stubs) and an
// append is a single small write, so two concurrent captures interleave lines
// rather than overwriting each other the way `writeNote`'s per-second filename
// once did.
//
// The task id is written INTO the line as an HTML comment (invisible in
// Obsidian, the same marker `task-export` uses) and the log's path is written
// back onto the task row as `origin_path`, so provenance is traceable in both
// directions.

const TASK_CAPTURE_DIR = 'Tasks/Captured';

/** `Tasks/Captured/Task Captures YYYY-MM.md` — vault-relative. PURE. */
function taskCaptureRelativePath(now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `${TASK_CAPTURE_DIR}/Task Captures ${month}.md`;
}

// Written once, when the month's file is created. It says what the file IS,
// because a note in the vault with no explanation of where it came from is a
// note Nick has to reverse-engineer months later.
function taskCaptureHeader(month) {
  return [
    '---',
    'type: task-capture-log',
    'source: neuro',
    'tags: [tasks, neuro, capture]',
    '---',
    '',
    `# Task captures — ${month}`,
    '',
    '> **Append-only.** Every task captured through NEURO is written here the',
    '> moment it is captured, before the task row exists. This file is the',
    '> durable record; the NEURO task table is the operational projection of it,',
    '> and [[Tasks/NEURO Tasks (export)]] is a generated read-only view of that',
    '> table. Nothing parses this file back, so notes you add here are safe —',
    '> but they will not change a task.',
    '',
  ].join('\n');
}

/**
 * Record a captured task in the vault. Append-only, synchronous, and it THROWS
 * rather than returning a soft failure — the caller decides what a vault miss
 * means, and a silent one would be exactly the "captured" that is not captured.
 *
 * `taskId` is optional because the vault write happens FIRST: the line is
 * stamped afterwards by `stampTaskCaptureId` once the row exists. Writing the
 * vault second would mean a crash between the two loses the thought entirely,
 * which is the direction that costs the most.
 */
function appendTaskCapture({ text, source = 'capture', capturedAt = new Date(), captureId = null }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('text is required');

  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vault) throw new Error('vault path is not configured');

  const relative = taskCaptureRelativePath(capturedAt);
  const full = path.join(vault, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  if (!fs.existsSync(full)) {
    const month = relative.slice(-10, -3);
    // `wx` so two captures racing to create the month's file cannot have one
    // truncate the other's header-plus-line. On EEXIST the other side won and
    // the append below is correct either way.
    try {
      fs.writeFileSync(full, taskCaptureHeader(month), { encoding: 'utf-8', flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  const marker = captureId ? ` <!--neuro-capture:${captureId}-->` : '';
  const stamp = capturedAt.toISOString();
  const line = `- [ ] ${body}  ·  captured ${stamp} · ${source}${marker}\n`;
  fs.appendFileSync(full, line, 'utf-8');

  return { relativePath: relative, filePath: full, line: line.trimEnd() };
}

/**
 * Stamp the task id onto the line just appended, so the vault record and the
 * task row point at each other.
 *
 * Matched on the capture id, never on the text: two captures of the same words
 * are two lines, and matching on text would stamp whichever one came first.
 * Failing here costs the back-link and nothing else, so it never throws — the
 * record is already durable, which was the point.
 */
function stampTaskCaptureId(relative, captureId, taskId) {
  if (!relative || !captureId || taskId == null) return false;
  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  const full = path.join(vault, relative);
  try {
    const content = fs.readFileSync(full, 'utf-8');
    const needle = `<!--neuro-capture:${captureId}-->`;
    if (!content.includes(needle)) return false;
    fs.writeFileSync(full, content.replace(needle, `${needle}<!--neuro-task:${taskId}-->`), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  writeNote,
  appendTaskCapture,
  stampTaskCaptureId,
  taskCaptureRelativePath,
  TASK_CAPTURE_DIR,
  relativePath,
  ensureDirs,
  timestamp,
  slugifyTitle,
  importsDir,
  filesDir,
};
