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

module.exports = {
  writeNote,
  relativePath,
  ensureDirs,
  timestamp,
  slugifyTitle,
  importsDir,
  filesDir,
};
