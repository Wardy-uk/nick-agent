'use strict';

// The vault side: walking, hashing, and the small amount of frontmatter these
// notes carry.
//
// ⚠ Frontmatter is handled here rather than via obsidian.js's `updateFrontmatter`
// deliberately. That helper's line-based reserialise silently DROPS YAML list
// values (the reason `restampMeetingPeople` hand-writes its block), and a synced
// note routinely carries `tags:` or `people:` lists that Nick or the import
// pipeline put there. Losing them on every pull would be invisible and permanent.
// This writer only ever rewrites the keys it owns and copies every other line
// through untouched.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Keys this sync owns. Everything else in the frontmatter is passed through.
const OWNED_KEYS = ['notion_page_id', 'notion_last_edited', 'notion_synced', 'source'];

/** Windows-illegal characters, plus the ones Obsidian treats as link syntax. */
function safeFileName(title) {
  const name = String(title || '')
    // Windows-illegal only. Spaces are KEPT — this vault is full of them
    // ("Master Todo.md"), and hyphenating them would make every synced note
    // look unlike every hand-written one.
    .replace(/[<>:"/\\|?*]/g, '-')
    // Obsidian link/tag syntax, stripped so a page title cannot produce a
    // filename that re-parses as a link.
    .replace(/[[\]#^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return name || 'Untitled';
}

/**
 * Content hash — the ONLY evidence that the vault side changed.
 *
 * ⚠ Computed over the BODY, with our own frontmatter keys stripped. The sync
 * writes `notion_last_edited` and `notion_synced` into the file itself, so
 * hashing the whole file would make every pull change the hash, which the next
 * pass reads as a vault edit and pushes straight back — a two-system loop that
 * never settles. Same species as the mtime trap in reconcile.js.
 *
 * Line endings are normalised because vault notes are mixed CRLF/LF (Syncthing
 * plus two editors), and a bare `\r` difference is not an edit.
 */
function contentHash(body) {
  const normalised = String(body).replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 32);
}

function parseNote(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatterLines: [], data: {}, body: text.replace(/^\n+/, '') };

  const frontmatterLines = match[1].split('\n');
  const data = {};
  for (const line of frontmatterLines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    // A list value's items are indented, so they never match and the key keeps
    // its (empty) scalar — which is fine, because we only READ our own keys.
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatterLines, data, body: text.slice(match[0].length).replace(/^\n+/, '') };
}

/** Rewrite only OWNED_KEYS, preserving every other frontmatter line verbatim. */
function serialiseNote({ frontmatterLines = [], body = '' }, updates = {}) {
  const kept = [];
  let skippingList = false;
  for (const line of frontmatterLines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):/);
    if (kv) skippingList = OWNED_KEYS.includes(kv[1]);
    else if (skippingList && /^\s+\S/.test(line)) continue; // an owned key's list body
    else skippingList = false;
    if (!skippingList) kept.push(line);
  }
  const owned = Object.entries(updates)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);

  const frontmatter = [...owned, ...kept.filter((l) => l.trim())];
  return `---\n${frontmatter.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

function readNote(absolute) {
  if (!fs.existsSync(absolute)) return null;
  const parsed = parseNote(fs.readFileSync(absolute, 'utf8'));
  return { ...parsed, hash: contentHash(parsed.body) };
}

function writeNote(absolute, content) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

/** Every `.md` under `folder`, vault-relative, forward slashes. */
function listNotes(root, folder) {
  const start = path.join(root, folder);
  if (!fs.existsSync(start)) return [];
  const out = [];
  const walk = (absolute, relative) => {
    let entries = [];
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { walk(path.join(absolute, entry.name), rel); continue; }
      if (!entry.name.endsWith('.md')) continue;
      // A conflict copy is not a note anyone means to publish.
      if (/\.sync-conflict-/i.test(entry.name)) continue;
      // ⚠ `_about.md` is this vault's convention for "what this folder is for"
      // (Areas/, MOCs/, Tasks/ all have one). It describes the FOLDER to someone
      // browsing the vault and says nothing to a reader of the published page —
      // MOCs/_about.md went to Notion as "Navigation hubs that link related notes
      // across folders", which is noise in a tree meant to answer "who I am and
      // what I do".
      if (entry.name.toLowerCase() === '_about.md') continue;
      out.push(rel);
    }
  };
  walk(start, folder);
  return out;
}

/**
 * Where a conflict copy goes.
 *
 * ⚠ The `.sync-conflict-` infix is chosen, not decorative: it is already in
 * `vault-exclusions.GENERATED_FILE_PATTERNS`, so a conflict copy is kept out of
 * embeddings and entity extraction for free — and it is the shape Syncthing
 * already writes in this vault, so Nick has seen it before and knows what it
 * means. Adding a new pattern would have been the obvious move and would have
 * fed both halves of every conflict into the retrieval index.
 */
function conflictPath(notePath, now) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return notePath.replace(/\.md$/, `.sync-conflict-notion-${stamp}.md`);
}

module.exports = {
  OWNED_KEYS,
  safeFileName,
  contentHash,
  parseNote,
  serialiseNote,
  readNote,
  writeNote,
  listNotes,
  conflictPath,
};
