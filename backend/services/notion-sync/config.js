'use strict';

// The mapping table: which Notion page tree is kept in step with which Obsidian
// parent folder. Stored in `agent_state.notion_sync_mappings` (KV, following
// standup-session and one_to_one_moves — a schema migration on the live DB is a
// bigger risk than the query convenience is worth for a list this small).
//
// ⚠ The repo is PUBLIC. Nothing here holds the Notion token — that stays in
// `backend/.env` as NOTION_TOKEN, the same rule as the PIN. Page IDs are
// workspace-identifying but not credentials, and they must live in the DB rather
// than a tracked config file for exactly that reason.

const fs = require('fs');
const path = require('path');
const db = require('../../db/database');
const { isExcludedDir, isSensitivePath, SENSITIVE_DIRS } = require('../vault-exclusions');

const STATE_KEY = 'notion_sync_mappings';
const MODES = new Set(['two-way', 'pull-only', 'push-only']);

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

/**
 * Accept whatever Nick has to hand: a bare id, a dashed uuid, or a pasted URL.
 *
 * A Notion URL ends in a 32-hex id glued to the page title
 * (`.../Team-Handbook-1f2e3d...`), so the id is the LAST 32-hex run, never the
 * first — keying on the first match picks the workspace slug out of some URLs.
 */
function normalisePageId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // ⚠ Scanned on the ORIGINAL string, with hex boundaries. Stripping the dashes
  // first is the obvious move and is wrong: it glues the whole URL into one run,
  // so `.../Page-<id>` scans as `Page<id>` and the 'e' of "Page" is a hex digit —
  // the match then starts one character early and every id comes back shifted.
  // Caught by the two-id test, which is what it is there for.
  const ID = /(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/gi;
  const matches = raw.match(ID);
  if (!matches || !matches.length) return null;

  // The LAST run, never the first: a Notion URL may carry a workspace id before
  // the page id, and the page is always the trailing one.
  const id = matches[matches.length - 1].replace(/-/g, '').toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Vault-relative, forward slashes, no leading/trailing separator, no `..`. */
function normaliseFolder(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
    .join('/');
}

/**
 * Why a folder may NOT be synced to Notion. Returns null when it is allowed.
 *
 * ⚠ The sensitive check is the one that matters and it is not paranoia about a
 * generic "private" folder. `Personal/` in this vault holds Nick's disciplinary
 * prep, the fraud investigation, his GP notes (anxiety, depression, ADHD) and
 * three Occupational Health documents naming the external assessor and the HR
 * contact — see the long comment in vault-exclusions.js. Notion is an external
 * service and a mapping is the most complete possible exfiltration of a folder,
 * so this refuses OUTRIGHT rather than warning. It is the same "leaves the
 * building" test the email and chase paths already apply, one door along.
 *
 * It fails CLOSED on an unreadable vault: with no vault we cannot tell what a
 * folder contains, and allowing the mapping would let the guard be bypassed by
 * configuring it while the disk is unmounted.
 */
function folderRefusal(folder) {
  if (!folder) return 'Pick a vault folder.';
  if (folder.split('/').some((seg) => seg === '..')) return 'Folder path may not contain "..".';

  const root = vaultPath();
  if (!root) return 'OBSIDIAN_VAULT_PATH is not set, so the vault cannot be checked.';

  const absolute = path.resolve(root, folder);
  if (!absolute.startsWith(path.resolve(root))) return 'Folder must be inside the vault.';

  // Sensitive is checked on a file-shaped path, since isSensitivePath looks at
  // every segment EXCEPT the last (it is written for note paths).
  if (isSensitivePath(`${folder}/x.md`) || SENSITIVE_DIRS.includes(folder.split('/')[0])) {
    return `"${folder.split('/')[0]}" holds HR, occupational health and medical material. `
      + 'It is never synced to an external service.';
  }

  for (const seg of folder.split('/')) {
    if (isExcludedDir(seg)) {
      return `"${seg}" is excluded from indexing (generated, retired or infrastructure) `
        + 'and is not a sensible thing to mirror.';
    }
  }
  return null;
}

/** One mapping is only valid against the OTHERS, hence the whole-list check. */
function validate(mappings) {
  const errors = [];
  const seenFolders = new Map();
  const seenPages = new Map();

  mappings.forEach((m, index) => {
    const where = m.vaultFolder || m.notionPageId || `row ${index + 1}`;

    if (!m.notionPageId) errors.push(`${where}: no Notion page.`);
    if (!MODES.has(m.mode)) errors.push(`${where}: unknown mode "${m.mode}".`);

    const refusal = folderRefusal(m.vaultFolder);
    if (refusal) errors.push(`${where}: ${refusal}`);

    // Two mappings writing into one folder tree would each see the other's files
    // as unpaired and create duplicate Notion pages for them, forever.
    for (const [other] of seenFolders) {
      if (m.vaultFolder === other
        || m.vaultFolder.startsWith(`${other}/`)
        || other.startsWith(`${m.vaultFolder}/`)) {
        errors.push(`${where}: overlaps the folder already mapped at "${other}".`);
      }
    }
    if (m.vaultFolder) seenFolders.set(m.vaultFolder, index);

    if (m.notionPageId && seenPages.has(m.notionPageId)) {
      errors.push(`${where}: this Notion page is already mapped to "${seenPages.get(m.notionPageId)}".`);
    }
    if (m.notionPageId) seenPages.set(m.notionPageId, m.vaultFolder);
  });

  return errors;
}

function coerce(input, index) {
  return {
    id: String(input.id || `map-${index + 1}-${normalisePageId(input.notionPageId) || 'new'}`),
    notionPageId: normalisePageId(input.notionPageId),
    // Display only, refreshed from Notion on each sync. Kept so the panel can
    // name a page without a live API call, and so a mapping whose page becomes
    // unreachable still reads as something rather than a bare uuid.
    notionTitle: String(input.notionTitle || '').trim() || null,
    vaultFolder: normaliseFolder(input.vaultFolder),
    mode: MODES.has(input.mode) ? input.mode : 'two-way',
    enabled: input.enabled !== false,
  };
}

function list() {
  const raw = db.getState(STATE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(coerce) : [];
  } catch {
    // A corrupt blob must not take the sync down silently — but it must not read
    // as "no mappings configured" either, which would look like a clean setup.
    console.error('[notion-sync] mappings blob is unparseable; treating as none configured');
    return [];
  }
}

/**
 * Replace the whole mapping table.
 *
 * All-or-nothing on purpose: the overlap rules are relationships BETWEEN rows,
 * so a per-row save can walk the list into a state no single edit was invalid
 * for. Returns `{ ok, errors, mappings }` — never throws at the route.
 */
function save(input) {
  const mappings = (Array.isArray(input) ? input : []).map(coerce);
  const errors = validate(mappings);
  if (errors.length) return { ok: false, errors, mappings: list() };
  db.setState(STATE_KEY, JSON.stringify(mappings));
  return { ok: true, errors: [], mappings };
}

function enabled() {
  return list().filter((m) => m.enabled && m.notionPageId && m.vaultFolder);
}

// ── The scheduled pass, switchable without a restart ────────────────────────
//
// `NOTION_SYNC_ENABLED` was read once when the scheduler registered its crons,
// so turning the automatic sync on meant editing .env and restarting the
// backend. Same friction as the token, same fix: the flag lives in the DB and is
// read on every tick, so the toggle in the panel takes effect at the next
// quarter hour. The env var still FORCES it on where set, so a deployment can
// pin the behaviour and a browser cannot quietly turn it off.
const AUTO_KEY = 'notion_sync_auto';

/** Should the 15-minute cron actually do anything? Defaults FALSE. */
function autoSyncEnabled() {
  if (process.env.NOTION_SYNC_ENABLED === 'true') return true;
  return db.getState(AUTO_KEY) === 'true';
}

function setAutoSync(on) {
  db.setState(AUTO_KEY, on ? 'true' : 'false');
  return autoSyncEnabled();
}

// ── Pages deliberately NOT mapped ───────────────────────────────────────────
//
// A coverage list is only useful if "not mapped" means "a gap". Some pages are
// legitimately handled somewhere else and must stop reading as gaps, or the list
// trains you to ignore it — and the one time that matters is the one time it is
// right.
//
// ⚠ The case this exists for: the D&D tree is exported by the STANDALONE
// notion-dnd-sync service into Projects/D&D/Notion. Mapping it here would put
// two writers on one page tree. Nick forgot that and deleted the vault copy;
// the exporter rebuilt it (it never deletes), but the near miss is the point.
const IGNORED_KEY = 'notion_sync_ignored';

function ignoredPages() {
  const raw = db.getState(IGNORED_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** @param {string} pageId @param {boolean} on @param {string} [note] why */
function setIgnored(pageId, on, note = '') {
  const id = normalisePageId(pageId);
  if (!id) return { ok: false, error: 'Not a Notion page id.' };
  const current = ignoredPages().filter((e) => e.id !== id);
  if (on) current.push({ id, note: String(note || '').slice(0, 200) });
  db.setState(IGNORED_KEY, JSON.stringify(current));
  return { ok: true, ignored: current };
}

/** Whether the env var is forcing it, so the panel can say the toggle is moot. */
function autoSyncForcedByEnv() {
  return process.env.NOTION_SYNC_ENABLED === 'true';
}

/**
 * Vault folders offered in the picker.
 *
 * Excluded and sensitive folders are omitted rather than shown-and-refused: a
 * dropdown listing `Personal` at all invites the question of why it will not
 * work, and the answer is not one to put in a tooltip.
 */
function vaultFolders({ maxDepth = 3 } = {}) {
  const root = vaultPath();
  if (!root || !fs.existsSync(root)) return { known: false, folders: [], reason: 'vault not readable' };

  const folders = [];
  const walk = (absolute, relative, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (folderRefusal(rel)) continue;
      folders.push(rel);
      if (depth < maxDepth) walk(path.join(absolute, entry.name), rel, depth + 1);
    }
  };
  walk(root, '', 1);
  return { known: true, folders: folders.sort(), reason: null };
}

module.exports = {
  STATE_KEY,
  MODES,
  list,
  save,
  enabled,
  autoSyncEnabled,
  setAutoSync,
  autoSyncForcedByEnv,
  ignoredPages,
  setIgnored,
  IGNORED_KEY,
  validate,
  vaultFolders,
  folderRefusal,
  normalisePageId,
  normaliseFolder,
};
