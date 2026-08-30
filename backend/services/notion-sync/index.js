'use strict';

// The orchestrator: walk each mapping, ask reconcile.js what should happen to
// every note, and apply it. All the judgement lives in reconcile.js and
// blocks.js; this file is the I/O and the guards around it.

const path = require('path');
const fs = require('fs');
const db = require('../../db/database');
const config = require('./config');
const notion = require('./notion-api');
const blocks = require('./blocks');
const vault = require('./vault');
const { ACTIONS, decide } = require('./reconcile');

const STATE_KEY = 'notion_sync_state';
const LOCK_KEY = 'notion_sync_lock';
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_PAGES_PER_RUN = Number(process.env.NOTION_SYNC_MAX_PAGES || 300);

function vaultRoot() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

// ── State ───────────────────────────────────────────────────────────────────
// One record per paired note, keyed by Notion page id. Carries the `keep` stash
// (the unsupported blocks a push must put back) — see blocks.js.

function loadState() {
  const raw = db.getState(STATE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch {
    console.error('[notion-sync] state blob unparseable; every note will be treated as unseen');
    return {};
  }
}

function saveState(state) {
  db.setState(STATE_KEY, JSON.stringify(state));
}

// ── Lock ────────────────────────────────────────────────────────────────────
//
// ⚠ Not optional, and the reason is on the record twice already: plaud-admin-blocks
// created 52 calendar events where 27 were wanted because a scheduled pass and a
// manual one overlapped, each planning against a ledger only written at the END
// of a run. This has the identical shape — a cron every few minutes plus a
// "Sync now" button — and the duplicate here is a duplicate Notion PAGE.
//
// Synchronous read-modify-write with no `await` between the two halves: both
// contenders are in one Node process and better-sqlite3 is synchronous, so this
// genuinely cannot interleave. It is a real mutex here and would NOT be safe
// across processes.
function acquireLock() {
  const now = Date.now();
  const held = Number(db.getState(LOCK_KEY) || 0);
  if (held && now - held < LOCK_STALE_MS) return false;
  db.setState(LOCK_KEY, String(now));
  return true;
}

function releaseLock() {
  db.setState(LOCK_KEY, '0');
}

// ── Reading each side ───────────────────────────────────────────────────────

/**
 * The Notion page tree under `rootPageId`, flattened to note-shaped records.
 *
 * A child page becomes a note AND a folder: `Handbook.md` beside `Handbook/`,
 * matching how the D&D exporter already lays out this vault. The root page maps
 * to the mapping's folder itself and is not written as a note — it is the
 * container Nick chose, not content.
 */
async function readNotionTree(rootPageId, folder, { depth = 0, out = [], seen = new Set() } = {}) {
  if (seen.has(rootPageId) || out.length >= MAX_PAGES_PER_RUN || depth > 4) return out;
  seen.add(rootPageId);

  const children = await notion.getBlockTree(rootPageId, { maxDepth: 0 });
  for (const block of children) {
    if (block.type !== 'child_page') continue;
    const title = block.child_page?.title || 'Untitled';
    const name = vault.safeFileName(title);
    const page = await notion.getPage(block.id).catch((error) => {
      console.warn(`[notion-sync] could not read page ${block.id}: ${error.message}`);
      return null;
    });
    if (!page) continue;

    out.push({
      id: block.id,
      title,
      lastEdited: page.last_edited_time,
      archived: Boolean(page.archived || page.in_trash),
      relPath: `${folder}/${name}.md`,
    });
    await readNotionTree(block.id, `${folder}/${name}`, { depth: depth + 1, out, seen });
  }
  return out;
}

// ── Applying a decision ─────────────────────────────────────────────────────

async function pullPage(page, absolute, state, now) {
  const tree = await notion.getBlockTree(page.id);
  const { markdown, keep } = blocks.blocksToMarkdown(tree);

  const existing = vault.readNote(absolute);
  const content = vault.serialiseNote(
    { frontmatterLines: existing?.frontmatterLines || [], body: markdown },
    {
      source: 'notion-sync',
      notion_page_id: page.id,
      notion_last_edited: page.lastEdited,
      notion_synced: now.toISOString(),
    },
  );
  vault.writeNote(absolute, content);

  state[page.id] = {
    vaultPath: path.relative(vaultRoot(), absolute).replace(/\\/g, '/'),
    vaultHash: vault.contentHash(markdown),
    notionLastEdited: page.lastEdited,
    keep,
    syncedAt: now.toISOString(),
  };
}

async function pushNote(page, absolute, note, state, now) {
  // ⚠ The push guard. `replaceChildren` deletes the page body, which is only
  // safe because we have just proved Notion has not moved since our last pull —
  // so everything being deleted is content we already hold a copy of. Re-read
  // live rather than trusting the listing, which may be seconds old.
  const live = await notion.getPage(page.id);
  const record = state[page.id];
  if (record && live.last_edited_time !== record.notionLastEdited) {
    return { skipped: 'Notion moved while the sync was running; left for the next pass' };
  }

  // Throws if a keep marker has no stashed block — fail closed rather than
  // silently deleting a block we promised to preserve.
  const body = blocks.markdownToBlocks(note.body, { keep: record?.keep || [] });

  await notion.replaceChildren(page.id, body);
  const after = await notion.getPage(page.id);

  state[page.id] = {
    vaultPath: path.relative(vaultRoot(), absolute).replace(/\\/g, '/'),
    vaultHash: note.hash,
    notionLastEdited: after.last_edited_time,
    keep: record?.keep || [],
    syncedAt: now.toISOString(),
  };
  return { skipped: null };
}

async function createInNotion(parentPageId, absolute, note, relPath, state, now) {
  const title = path.basename(relPath, '.md');
  const body = blocks.markdownToBlocks(note.body, { keep: [], strict: false });
  const page = await notion.createPage({ parentPageId, title, blocks: body });

  // Stamp the id back, or the next pass sees an unpaired file and creates a
  // SECOND page for it — every run, forever.
  vault.writeNote(absolute, vault.serialiseNote(note, {
    source: 'notion-sync',
    notion_page_id: page.id,
    notion_last_edited: page.last_edited_time,
    notion_synced: now.toISOString(),
  }));

  state[page.id] = {
    vaultPath: relPath,
    vaultHash: note.hash,
    notionLastEdited: page.last_edited_time,
    keep: [],
    syncedAt: now.toISOString(),
  };
  return page;
}

function writeConflictCopy(absolute, page, tree, now) {
  const { markdown } = blocks.blocksToMarkdown(tree);
  const target = vault.conflictPath(absolute, now);
  vault.writeNote(target, vault.serialiseNote(
    { frontmatterLines: [], body: `> [!warning] Notion's version, kept for comparison. Your vault copy was left untouched.\n\n${markdown}` },
    { source: 'notion-sync-conflict', notion_page_id: page.id, notion_last_edited: page.lastEdited },
  ));
  return path.basename(target);
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Sync every enabled mapping.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun]  Decide everything, write nothing anywhere.
 * @returns {Promise<object>} a report — counts, per-note actions, and `gaps`.
 */
async function run({ dryRun = false } = {}) {
  const now = new Date();
  const report = {
    ranAt: now.toISOString(),
    dryRun,
    mappings: [],
    counts: { pulled: 0, pushed: 0, created: 0, conflicts: 0, skipped: 0, unchanged: 0 },
    gaps: [],
    ok: true,
  };

  if (!notion.isConfigured()) {
    report.ok = false;
    report.gaps.push('NOTION_TOKEN is not set — nothing was synced.');
    return report;
  }
  const root = vaultRoot();
  if (!root || !fs.existsSync(root)) {
    // ⚠ An unreadable vault must never look like an empty one: every note would
    // decide ORPHAN_NOTION and, worse, a push-capable mapping would read the
    // whole folder as deleted. Refuse the run.
    report.ok = false;
    report.gaps.push('The vault is not readable — refusing to sync rather than treating it as empty.');
    return report;
  }

  const mappings = config.enabled();
  if (!mappings.length) {
    report.gaps.push('No mappings are configured or enabled.');
    return report;
  }

  if (!dryRun && !acquireLock()) {
    report.ok = false;
    report.gaps.push('Another sync is already running.');
    return report;
  }

  const state = loadState();
  try {
    for (const mapping of mappings) {
      const summary = { id: mapping.id, folder: mapping.vaultFolder, mode: mapping.mode, notes: [], error: null };
      report.mappings.push(summary);

      let pages;
      try {
        pages = await readNotionTree(mapping.notionPageId, mapping.vaultFolder);
      } catch (error) {
        // A mapping that cannot be read is a GAP, never an empty tree — an empty
        // tree would orphan or delete-side every note under it.
        summary.error = error.message;
        report.gaps.push(`${mapping.vaultFolder}: could not read Notion (${error.message})`);
        report.ok = false;
        continue;
      }

      const byId = new Map(pages.map((p) => [p.id, p]));
      const vaultNotes = vault.listNotes(root, mapping.vaultFolder);

      // Pair vault files to pages by the id in their frontmatter — the path is a
      // fallback only, since a page renamed in Notion moves its file.
      const pairedIds = new Set();
      const unpairedFiles = [];
      for (const relPath of vaultNotes) {
        const note = vault.readNote(path.join(root, relPath));
        if (!note) continue;
        const id = note.data.notion_page_id;
        if (id && byId.has(id)) { pairedIds.add(id); note._page = byId.get(id); }
        else if (id) { note._page = null; note._knownId = id; }
        else { unpairedFiles.push({ relPath, note }); continue; }
        note._relPath = relPath;
        unpairedFiles.push({ relPath, note, paired: true });
      }

      const work = [];
      for (const { relPath, note } of unpairedFiles) {
        const id = note.data.notion_page_id || null;
        const page = id ? byId.get(id) || null : null;
        work.push({ relPath, note, page, last: id ? state[id] : null });
      }
      // Pages with no vault file at all.
      for (const page of pages) {
        if (pairedIds.has(page.id)) continue;
        if (work.some((w) => w.page?.id === page.id)) continue;
        work.push({ relPath: page.relPath, note: null, page, last: state[page.id] || null });
      }

      for (const item of work) {
        const absolute = path.join(root, item.relPath);
        const { action, reason } = decide({
          vault: item.note ? { hash: item.note.hash, path: item.relPath } : null,
          notion: item.page,
          last: item.last,
          mode: mapping.mode,
        });

        const entry = { path: item.relPath, action, reason };
        summary.notes.push(entry);

        if (action === ACTIONS.NOOP) { report.counts.unchanged += 1; continue; }
        if (action === ACTIONS.SKIP) { report.counts.skipped += 1; continue; }
        if (action === ACTIONS.ORPHAN_VAULT || action === ACTIONS.ORPHAN_NOTION) {
          // Reported, never actioned. Nothing is ever deleted on either side.
          report.counts.skipped += 1;
          continue;
        }
        if (dryRun) continue;

        try {
          if (action === ACTIONS.PULL || action === ACTIONS.CREATE_IN_VAULT) {
            await pullPage(item.page, absolute, state, now);
            report.counts[action === ACTIONS.PULL ? 'pulled' : 'created'] += 1;
          } else if (action === ACTIONS.PUSH) {
            const { skipped } = await pushNote(item.page, absolute, item.note, state, now);
            if (skipped) { entry.reason = skipped; report.counts.skipped += 1; }
            else report.counts.pushed += 1;
          } else if (action === ACTIONS.CREATE_IN_NOTION) {
            await createInNotion(mapping.notionPageId, absolute, item.note, item.relPath, state, now);
            report.counts.created += 1;
          } else if (action === ACTIONS.CONFLICT) {
            const tree = await notion.getBlockTree(item.page.id);
            entry.conflictCopy = writeConflictCopy(absolute, item.page, tree, now);
            report.counts.conflicts += 1;
          }
          saveState(state); // per note, not batched at the end — see the lock note.
        } catch (error) {
          entry.action = 'error';
          entry.reason = error.message;
          report.gaps.push(`${item.relPath}: ${error.message}`);
          report.ok = false;
        }
      }
    }
  } finally {
    if (!dryRun) { saveState(state); releaseLock(); }
  }

  db.setState('notion_sync_last_run', JSON.stringify({
    at: report.ranAt, ok: report.ok, counts: report.counts, gaps: report.gaps.slice(0, 10),
  }));
  return report;
}

function lastRun() {
  const raw = db.getState('notion_sync_last_run');
  if (!raw) return { known: false, reason: 'never run' };
  try { return { known: true, ...JSON.parse(raw) }; }
  catch { return { known: false, reason: 'last-run record unreadable' }; }
}

/** Clear the pairing record for a note so the next pass re-pairs it from scratch. */
function forget(notionPageId) {
  const state = loadState();
  if (!state[notionPageId]) return false;
  delete state[notionPageId];
  saveState(state);
  return true;
}

module.exports = { run, lastRun, forget, loadState, STATE_KEY, LOCK_KEY };
