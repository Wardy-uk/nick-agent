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

/**
 * Write a captured note. Synchronous by design: the mobile sync applier relies
 * on there being no await between checking the idempotency ledger and doing the
 * work, which is what makes that ledger a real mutex in a single Node process
 * (`plaud-admin-blocks`' rule).
 *
 * Throws if the file did not land — a capture that reports success over a failed
 * write is the failure this whole area exists to prevent.
 */
function writeNote({ title, content, source = 'neuro-capture' }) {
  const text = String(content || '').trim();
  if (!text) throw new Error('content is required');

  ensureDirs();
  const slug = slugifyTitle(title);
  const filename = `${timestamp()}-${slug}.md`;
  const filePath = path.join(importsDir(), filename);

  const now = new Date().toISOString();
  const fmTitle = title ? `title: "${String(title).replace(/"/g, '\\"')}"\n` : '';
  const body = title
    ? `---\ndate: ${now}\nsource: ${source}\nstatus: unprocessed\n${fmTitle}---\n\n# ${title}\n\n${text}\n`
    : `---\ndate: ${now}\nsource: ${source}\nstatus: unprocessed\n---\n\n${text}\n`;

  fs.writeFileSync(filePath, body, 'utf-8');

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
