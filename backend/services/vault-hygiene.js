/**
 * vault-hygiene.js — NEURO's ongoing vault-hygiene engine.
 *
 * Productionises the throwaway Scripts/_*.js prototypes (proven against the live
 * vault on 2026-06-29) into reusable, deterministic capabilities:
 *
 *   lint(root)                 — read-only health scan (broken links, orphans, …)
 *   contextualLinkPlan(root)   — propose [[wikilinks]] for genuine prose mentions
 *   contextualLinkApply(root)  — append idempotent "## Mentioned" blocks (backed up)
 *   aliasSuggest(root)         — propose People aliases for near-match name variants
 *
 * Design rules baked in (see the build handoff §2–§3):
 *  - Read-only by default; every mutating op backs up touched files and is idempotent.
 *  - Append-only — never overwrite or delete a note, never edit YAML frontmatter.
 *  - Match FULL NAMES only for contextual linking; bare first-names mislink.
 *  - Strip wikilinks / code / paths before matching prose.
 *  - Resolve path-form links ([[People/X|X]]) when deduping.
 *  - Skip names that map to >1 person.
 *  - Exclude generated output (Vault Audit, backups, Archive…) so scans don't self-pollute.
 *
 * Pure CommonJS, no server deps — every entry point takes the vault root, so it
 * runs both inside the NEURO backend and standalone via `node` for validation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Constants ───────────────────────────────────────────────────────────────

// Directories never scanned (handoff §2.5). Excludes generated reports + backups
// so the engine is deterministic and never links to its own output.
const EXCLUDE_DIRS = new Set([
  '.git', '.obsidian', '.trash', '.stfolder', '.stversions', '.sync', '.claude', '.lint-backups',
  'Archive', 'Templates', 'Scripts', 'Conflicts', 'node_modules', 'Vault Audit',
]);

const REPORT_REL = ['Documents', 'System', 'Vault Audit'];
const BACKUP_REL = ['Scripts', '.lint-backups'];

const STALE_DAYS = 120;

// Roots scanned for contextual linking (prose-heavy areas). Configurable.
//
// Widened 7 Sep 2026, on measurement: the original four proposed **ZERO** links
// on the live vault, because the import pipeline already links meeting notes as
// it writes them. So the "Preview contextual links" button had become a control
// that ran, succeeded, and did nothing — while 52 orphans sat in the folders it
// was not looking at. Widened it proposes 320 links across 76 notes.
const DEFAULT_CTX_ROOTS = [
  'Meetings', 'Reflections', 'Calls', 'Decision Log',
  'Areas', 'Ideas', 'Projects', 'Me', 'Documents', 'Catalogues',
];

/**
 * Roots this must NEVER write into, whoever asks.
 *
 * ⚠ Not tidiness — each one breaks something silently, and the linker appends
 * REAL PROSE (a "## Mentioned" block), which is exactly what makes both bite:
 *
 *  - `Tasks/` holds `Tasks/Outcomes/`, where an unfenced block of text is what
 *    `task-blocks.isOutcomeWritten` reads as a WRITE-UP. Linking there would
 *    release every held task in the vault and mark the work done — the
 *    empty-stub bug, arrived at from the outside.
 *  - `Notion/` holds pull-only mirrors whose change detection hashes the BODY.
 *    An appended block reads as a vault edit on the next sync and pushes back
 *    into Notion, or raises a conflict on a note nobody typed in.
 *
 * A caller naming one is REFUSED and told which, rather than silently skipped:
 * a linker that quietly ignores a folder you asked for looks like a linter that
 * found nothing there.
 */
const CTX_FORBIDDEN_ROOTS = {
  Tasks: 'outcome notes read appended prose as a write-up and would release held tasks',
  Notion: 'pull-only mirrors would push the appended block back into Notion',
};

function assertCtxRoots(roots) {
  for (const r of roots || []) {
    const head = String(r).split('/')[0];
    if (CTX_FORBIDDEN_ROOTS[head]) {
      throw new Error(`contextual linking refuses "${r}": ${CTX_FORBIDDEN_ROOTS[head]}`);
    }
  }
}

// Project/MOC keyword → link. Proven defaults; override via lint-config.json.
const DEFAULT_PROJECT_LINKS = [
  { kw: '\\bNOVA\\b', flags: 'i', link: 'MOC - NOVA' },   // case-insensitive: catches "Nova"
  { kw: '\\bNEURO\\b', flags: 'i', link: 'NEURO' },
  { kw: '\\bAttractor\\b', flags: 'i', link: 'Attractor Programme Methodology' },
  { kw: '\\b(QA System|AIQA)\\b', flags: 'i', link: 'QA System V5' },
  { kw: '\\bSupport Hub\\b', flags: 'i', link: 'Support Hub' },
];

// If a note has an unclosed ``` code fence, appended [[links]] land INSIDE the code
// block and Obsidian ignores them. Return a closing fence to prepend to any append.
function closeOpenFence(text) {
  const fences = (text.match(/^```/gm) || []).length;
  return fences % 2 === 1 ? '\n```\n' : '';
}

// Idempotency marker for the appended contextual-link block.
const CTX_MARKER = '<!-- ctx-links -->';

// ── Shared helpers ──────────────────────────────────────────────────────────

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'Scripts', 'lint-config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Recursively collect .md files, skipping EXCLUDE_DIRS and _about.md index notes.
// A machine's copy of a note is not a note.
//
// EXCLUDE_DIRS is DIRECTORIES only, so six `Microsoft Tasks.sync-conflict-….md`
// files counted as orphans on 7 Sep 2026 — a tenth of the whole orphan list was
// Syncthing losing a race with NEURO, which regenerates `Microsoft Tasks.md`
// every half hour while Syncthing replicates it.
//
// ⚠ Deliberately NARROWER than `vault-exclusions.GENERATED_FILE_PATTERNS`, which
// this does NOT adopt wholesale: that list drops real notes such as the task
// export and the 1-2-1 tracker, and dropping a note from the WALK also drops it
// from the resolve index — every inbound link to it would turn from resolved to
// broken. Both patterns here name a duplicate whose original is still present,
// so nothing can lose a link target by being skipped.
const MACHINE_COPY = [/\.sync-conflict-/i, /\.backup-/i];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '_about.md'
               && !MACHINE_COPY.some((re) => re.test(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

// `walk()` skips `_about.md` by design, so any [[_about]] link is unresolvable by
// construction — a linter defect, not a vault defect. Never counted as broken.
const ABOUT_TARGET = '_about';

// Every `Archive` folder in the tree, not just the top-level one (#81). The notes
// that produced 60 of the 69 false positives live in `Projects/Archive/90 Day Plan
// (retired 2026-08-12)/`, so a top-level-only lookup classified them as missing.
// EXCLUDE_DIRS still applies to everything else, which is what keeps `.stversions`
// and `Scripts/.lint-backups` — both full of Archive-shaped copies — out.
function collectArchiveDirs(root, acc = []) {
  if (!fs.existsSync(root)) return acc;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'Archive') { acc.push(full); continue; } // don't descend; indexed whole
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    collectArchiveDirs(full, acc);
  }
  return acc;
}

// Every .md under an archive dir. No EXCLUDE_DIRS here — everything below an
// `Archive` folder is archived, including the nested `Archive/_toDelete/Archive`.
function collectArchivedFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectArchivedFiles(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * Index of archived note basenames → path. Takes the normaliser so each caller
 * matches archive targets exactly the way it matches active ones — `lint` is
 * case-only, `fixPlan` uses the aggressive `norm`. Mixing them would let a
 * punctuation variant resolve to Archive while an active note existed.
 *
 * Values are ABSOLUTE paths, matching what `buildFixModel` has always stored —
 * `fixPlan` wraps them in `rel()` itself and `fixApply` re-joins against root.
 */
function buildArchiveIndex(root, normalise) {
  const index = new Map();
  for (const dir of collectArchiveDirs(root)) {
    for (const f of collectArchivedFiles(dir)) {
      const key = normalise(path.basename(f, '.md'));
      if (!index.has(key)) index.set(key, f);
    }
  }
  return index;
}

// Loose YAML alias parse (inline [a, b] and list forms). No deps.
function parseAliases(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const block = fm[1];
  const out = [];
  const inline = block.match(/^\s*aliases?\s*:\s*\[(.*?)\]/m);
  if (inline) {
    inline[1].split(',').forEach((a) => {
      const v = a.trim().replace(/^["']|["']$/g, '');
      if (v) out.push(v);
    });
  }
  const listHeader = block.match(/^\s*aliases?\s*:\s*$/m);
  if (listHeader) {
    const lines = block.slice(block.indexOf(listHeader[0])).split(/\r?\n/).slice(1);
    for (const line of lines) {
      const m = line.match(/^\s*-\s*(.+)$/);
      if (!m) break;
      out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return out;
}

// Outgoing [[wikilink]] targets as basenames (ignores ![[embeds]]). For the link graph.
function extractLinks(text) {
  const links = [];
  const re = /(?<!!)\[\[([^\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // ⚠ Inside a markdown TABLE the alias pipe must be escaped, so the tracker
    // writes `[[People/Abdi Mohamed\|Abdi Mohamed]]` — correct Obsidian, and a
    // naive split on `|` keeps the escape and reports `People/Abdi Mohamed\` as a
    // broken link. Measured 7 Sep 2026: 19 of the 80 reported breaks were this
    // one generated file, i.e. a quarter of the headline number was a parsing
    // artefact of a link that resolves perfectly well. Same species as #81 —
    // noise that buries the real breaks under it.
    let target = m[1].split('|')[0].split('#')[0].trim();
    if (target.endsWith(String.fromCharCode(92))) target = target.slice(0, -1).trim();
    if (!target) continue; // pure heading/block ref
    if (target.includes('/')) target = target.split('/').pop();
    links.push(target.replace(/\.md$/i, ''));
  }
  return links;
}

// Set of everything already linked in a note (basename, path-form, and display
// alias), lowercased — so we never re-propose an existing link (handoff §3.3).
function linkedSet(raw) {
  const s = new Set();
  for (const m of raw.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const inner = m[1].split('|')[0].split('#')[0].trim();
    s.add(inner.toLowerCase());
    if (inner.includes('/')) s.add(inner.split('/').pop().toLowerCase());
    const disp = m[1].includes('|') ? m[1].split('|').pop().trim() : null;
    if (disp) s.add(disp.toLowerCase());
  }
  return s;
}

// Strip everything that isn't genuine prose before matching (handoff §3.2):
// fenced/inline code, wikilinks, _(path)_ refs, and bare path.md tokens.
function cleanProse(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/_\([^)]*\)_/g, ' ')
    .replace(/\([^)]*\.md[^)]*\)/g, ' ')
    .replace(/[\w./-]+\.md\b/g, ' ');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A short context snippet around a match index, for autonomy cards.
function snippet(text, idx, len) {
  return text.slice(Math.max(0, idx - 40), idx + len + 40).replace(/\s+/g, ' ').trim();
}

// Build the People roster: FULL NAMES only (handoff §3.1), with a name→count map
// so ambiguous names mapping to >1 person are skipped (handoff §3.4).
function buildPeopleIndex(root) {
  const peopleDir = path.join(root, 'People');
  const people = [];
  const nameCount = new Map();
  if (!fs.existsSync(peopleDir)) return { people, nameCount };
  for (const f of fs.readdirSync(peopleDir)) {
    if (!f.endsWith('.md') || f === '_about.md') continue;
    const base = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(peopleDir, f), 'utf8');
    const names = [base, ...parseAliases(text)].filter((n) => n.includes(' ')); // full names only
    if (!names.length) continue;
    people.push({ base, names });
    for (const n of names) nameCount.set(n.toLowerCase(), (nameCount.get(n.toLowerCase()) || 0) + 1);
  }
  return { people, nameCount };
}

function projectMatchers(config) {
  const src = Array.isArray(config.projectLinks) && config.projectLinks.length
    ? config.projectLinks
    : DEFAULT_PROJECT_LINKS;
  return src.map((p) => ({ re: new RegExp(p.kw, p.flags || ''), link: p.link }));
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

// Compute the contextual-link proposals for one note's raw content. Returns
// [{ link, via, why }]. Shared by plan (cards) and apply so they never diverge.
function proposeContextualLinks(raw, people, nameCount, projects) {
  const body = raw.replace(/^---[\s\S]*?---/, '');
  const linked = linkedSet(raw);
  const prose = cleanProse(body);
  const props = [];
  const seen = new Set();
  for (const p of people) {
    if (linked.has(p.base.toLowerCase()) || seen.has(p.base)) continue;
    for (const nm of p.names) {
      if (nameCount.get(nm.toLowerCase()) > 1) continue;      // ambiguous → skip
      if (linked.has(nm.toLowerCase())) continue;             // already linked via alias
      const m = new RegExp('\\b' + escapeRe(nm) + '\\b', 'i').exec(prose);
      if (m) {
        const isAlias = nm.toLowerCase() !== p.base.toLowerCase();
        seen.add(p.base);
        props.push({ link: p.base, via: isAlias ? ` (alias "${nm}")` : '', why: snippet(prose, m.index, nm.length) });
        break;
      }
    }
  }
  for (const pr of projects) {
    if (seen.has(pr.link) || linked.has(pr.link.toLowerCase())) continue;
    const m = pr.re.exec(prose);
    if (m) {
      seen.add(pr.link);
      props.push({ link: pr.link, via: '', why: snippet(prose, m.index, m[0].length) });
    }
  }
  return props;
}

// ── Capability: lint (read-only) ────────────────────────────────────────────

/**
 * Read-only vault health scan. Writes a single dated report; touches nothing else.
 * @returns {{ scanned, broken, orphans, underlinkedPeople, stale, reportPath }}
 */
function lint(root, { write = true } = {}) {
  const config = loadConfig(root);
  const expectedOrphanDirs = config.expectedOrphanDirs || [];
  const staleDays = config.staleDays || STALE_DAYS;

  const files = walk(root);
  const notes = new Map();        // path -> { base, aliases, outgoing, inCount, mtime }
  const resolveIndex = new Map(); // lowercased base/alias -> path

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const base = path.basename(file, '.md');
    const aliases = parseAliases(text);
    const stat = fs.statSync(file);
    notes.set(file, { base, aliases, outgoing: extractLinks(text), inCount: 0, mtime: stat.mtime });
    resolveIndex.set(base.toLowerCase(), file);
    for (const a of aliases) resolveIndex.set(a.toLowerCase(), file);
  }

  const broken = [];
  const brokenSeen = new Set(); // dedup distinct (from → target) pairs
  // Archiving a note is correct behaviour, and lint used to report every inbound
  // link to it as a defect (#81) — 54 for `90 Day Plan`, 6 for `Evidence Register`,
  // burying the ~100 real ones. A link into the bin IS a signal ("this now points
  // at retired content"), just a different one, so it gets its own class rather
  // than being dropped.
  const archiveIndex = buildArchiveIndex(root, (s) => s.toLowerCase());
  const archivedTargets = [];

  for (const [file, n] of notes) {
    const seen = new Set();
    for (const target of n.outgoing) {
      const hit = resolveIndex.get(target.toLowerCase());
      if (hit) {
        if (hit !== file && !seen.has(hit)) { notes.get(hit).inCount += 1; seen.add(hit); }
        continue;
      }
      if (target.toLowerCase() === ABOUT_TARGET) continue; // broken by construction, not by content
      const fromRel = rel(root, file);
      const key = `${fromRel} ${target}`;
      if (brokenSeen.has(key)) continue;
      brokenSeen.add(key);
      const archived = archiveIndex.get(target.toLowerCase());
      if (archived) archivedTargets.push({ from: fromRel, target, archivePath: rel(root, archived) });
      else broken.push({ from: fromRel, target });
    }
  }

  const orphans = [];
  const underlinkedPeople = [];
  const stale = [];
  const now = Date.now();
  for (const [file, n] of notes) {
    const r = rel(root, file);
    const hasOut = n.outgoing.length > 0;
    const hasIn = n.inCount > 0;
    if (!hasOut && !hasIn && !expectedOrphanDirs.some((d) => r.startsWith(d + '/'))) orphans.push(r);
    if (r.startsWith('People/') && !hasOut) underlinkedPeople.push(r);
    const ageDays = (now - n.mtime.getTime()) / 86400000;
    if (ageDays > staleDays) stale.push({ path: r, days: Math.round(ageDays) });
  }

  orphans.sort();
  underlinkedPeople.sort();
  stale.sort((a, b) => b.days - a.days);
  broken.sort((a, b) => a.from.localeCompare(b.from));

  let reportPath = null;
  if (write) reportPath = writeLintReport(root, { scanned: notes.size, broken, archivedTargets, orphans, underlinkedPeople, stale, staleDays });

  return { scanned: notes.size, broken, archivedTargets, orphans, underlinkedPeople, stale, reportPath };
}

function writeLintReport(root, { scanned, broken, archivedTargets = [], orphans, underlinkedPeople, stale, staleDays }) {
  const today = todayStr();
  const L = [];
  L.push('---', 'type: reference', `created: ${today}`, 'tags: [vault, lint, audit]', 'author: NEURO vault-hygiene', '---');
  L.push(`# Vault Lint Report — ${today}`, '');
  L.push(`Scanned **${scanned}** notes (excluding ${[...EXCLUDE_DIRS].join(', ')}).`, '');
  L.push('| Check | Count |', '|---|---|');
  L.push(`| Broken links | ${broken.length} |`);
  L.push(`| Links to archived notes | ${archivedTargets.length} |`);
  L.push(`| Orphans (no links in or out) | ${orphans.length} |`);
  L.push(`| Under-linked People notes | ${underlinkedPeople.length} |`);
  L.push(`| Stale (> ${staleDays} days) | ${stale.length} |`, '');

  L.push('## Broken links');
  if (!broken.length) L.push('> [!success] None — every wikilink resolves.');
  else { L.push('> [!bug] These `[[targets]]` resolve to no note or alias. Fix the link or create the note.', ''); for (const b of broken) L.push(`- \`${b.from}\` → \`[[${b.target}]]\``); }
  L.push('');

  L.push('## Links to archived notes');
  if (!archivedTargets.length) L.push('> [!success] None — no link points into an Archive folder.');
  else {
    L.push('> [!info] These resolve to a note in an `Archive` folder. Not broken — archiving was deliberate — but worth knowing the link now points at retired content. Repoint it or leave it.', '');
    for (const a of archivedTargets) L.push(`- \`${a.from}\` → \`[[${a.target}]]\` — archived at \`${a.archivePath}\``);
  }
  L.push('');

  L.push('## Orphans');
  if (!orphans.length) L.push('> [!success] None.');
  else { L.push('> [!warning] Disconnected notes — no inbound or outbound links. Link them in or archive.', ''); for (const o of orphans) L.push(`- [[${path.basename(o, '.md')}]] — \`${o}\``); }
  L.push('');

  L.push('## Under-linked People');
  if (!underlinkedPeople.length) L.push('> [!success] Every People note links out.');
  else { L.push('> [!info] People notes with no outgoing links — add their team, manager, projects, meetings.', ''); for (const p of underlinkedPeople) L.push(`- [[${path.basename(p, '.md')}]] — \`${p}\``); }
  L.push('');

  L.push('## Stale');
  if (!stale.length) L.push('> [!success] Nothing past the staleness threshold.');
  else { L.push(`> [!note] Untouched > ${staleDays} days. Informational — review only if these should be live.`, ''); for (const s of stale.slice(0, 50)) L.push(`- \`${s.path}\` — ${s.days} days`); if (stale.length > 50) L.push(`- …and ${stale.length - 50} more`); }
  L.push('', '---', '_Generated by NEURO `vault-hygiene` (lint). Read-only scan; this report is the only file written._');

  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Lint Report ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return rel(root, outPath);
}

// ── Capability: contextual link — plan (read-only) ──────────────────────────

/**
 * Propose contextual [[wikilinks]] for genuine prose mentions of roster People /
 * Projects. Read-only — writes a dated cards report (unless write:false).
 * @returns {{ scanned, notesTouched, total, byRoot, perNote, reportPath }}
 */
function contextualLinkPlan(root, { roots = DEFAULT_CTX_ROOTS, write = true } = {}) {
  assertCtxRoots(roots);
  const config = loadConfig(root);
  const { people, nameCount } = buildPeopleIndex(root);
  const projects = projectMatchers(config);

  let scanned = 0;
  let total = 0;
  const byRoot = {};
  const perNote = [];

  for (const r of roots) {
    for (const file of walk(path.join(root, r))) {
      scanned++;
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.includes(CTX_MARKER)) continue; // already processed
      const props = proposeContextualLinks(raw, people, nameCount, projects);
      if (props.length) {
        total += props.length;
        byRoot[r] = (byRoot[r] || 0) + props.length;
        perNote.push({ rel: rel(root, file), props });
      }
    }
  }

  perNote.sort((a, b) => a.rel.localeCompare(b.rel));

  let reportPath = null;
  if (write) reportPath = writeCtxPlanReport(root, { scanned, total, byRoot, perNote });

  return { scanned, notesTouched: perNote.length, total, byRoot, perNote, reportPath };
}

function writeCtxPlanReport(root, { scanned, total, byRoot, perNote }) {
  const today = todayStr();
  const L = [`# Contextual-Linking Plan — DRY RUN (${today})`, ''];
  L.push(`**${total} proposed links across ${perNote.length} notes** (scanned ${scanned}). By area: ${Object.entries(byRoot).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  L.push('', 'Full names + genuine prose mentions only (wikilinks/paths/code stripped). Nothing written. Approve, then run apply.', '', '');
  for (const n of perNote) {
    L.push(`## ${n.rel}`);
    for (const x of n.props) L.push(`- **[[${x.link}]]**${x.via} — "…${x.why}…"`);
    L.push('');
  }
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Contextual Linking Plan ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return rel(root, outPath);
}

// ── Capability: contextual link — apply (append-only, backed up) ────────────

/**
 * Append an idempotent "## Mentioned" block of contextual links to each note.
 * Backs up every touched file, writes a changelog, never overwrites/deletes.
 * @param {object} opts
 * @param {string[]} [opts.only]  Restrict to these note rel-paths (approved set).
 *                                Omit to apply every proposal.
 * @returns {{ notesDone, totalLinks, backupDir, changelogPath, applied }}
 */
function contextualLinkApply(root, { roots = DEFAULT_CTX_ROOTS, only = null } = {}) {
  assertCtxRoots(roots);
  const config = loadConfig(root);
  const { people, nameCount } = buildPeopleIndex(root);
  const projects = projectMatchers(config);
  const onlySet = only ? new Set(only) : null;

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);

  const applied = [];
  let totalLinks = 0;

  for (const r of roots) {
    for (const file of walk(path.join(root, r))) {
      const relPath = rel(root, file);
      if (onlySet && !onlySet.has(relPath)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.includes(CTX_MARKER)) continue; // idempotent
      const props = proposeContextualLinks(raw, people, nameCount, projects);
      if (!props.length) continue;

      // Backup, then append-only.
      const bk = path.join(backupDir, relPath);
      ensureDir(path.dirname(bk));
      fs.copyFileSync(file, bk);

      const links = props.map((p) => p.link);
      let out = raw.endsWith('\n') ? raw : raw + '\n';
      out += closeOpenFence(raw) + `\n${CTX_MARKER}\n## Mentioned\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`;
      fs.writeFileSync(file, out, 'utf8');

      applied.push({ rel: relPath, links });
      totalLinks += links.length;
    }
  }

  const changelogPath = writeCtxApplyChangelog(root, { applied, totalLinks, backupDir });
  return { notesDone: applied.length, totalLinks, backupDir: rel(root, backupDir), changelogPath, applied };
}

function writeCtxApplyChangelog(root, { applied, totalLinks, backupDir }) {
  const today = todayStr();
  const L = [`# Contextual Links Applied — ${today}`, ''];
  L.push(`Applied **${totalLinks} links across ${applied.length} notes**. Append-only (## Mentioned block). Backups: \`${rel(root, backupDir)}\`.`, '');
  for (const a of applied) L.push(`- \`${a.rel}\` (+${a.links.length}): ${a.links.map((l) => `[[${l}]]`).join(', ')}`);
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Contextual Links Applied ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return rel(root, outPath);
}

// ── Capability: fix (plan + tiered apply) ───────────────────────────────────

// Aggressive normalisation for title matching (en/em dashes, quotes, punctuation).
const norm = (s) => s.toLowerCase()
  .replace(/[–—]/g, '-').replace(/[’‘'`]/g, "'")
  .replace(/[^a-z0-9]+/g, ' ').trim();

function bigrams(s) { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; }
function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const TIER_RANK = { skip: 0, conservative: 1, moderate: 2, aggressive: 3 };

/**
 * A stable, transport-safe handle for ONE proposed link repair.
 *
 * ⚠ It is derived from the vault, not from the plan's ORDER — an index would
 * silently name a different repair the moment a note changed between preview
 * and apply, which is the one failure a per-item pick list must not have.
 * Being content-derived, a stale pick simply matches nothing; that is reported
 * as `onlyUnmatched` rather than passing quietly as a clean, smaller run.
 */
function fixKey(fromRel, oldTarget) {
  return crypto.createHash('sha1').update(fromRel + String.fromCharCode(10) + oldTarget).digest('hex').slice(0, 12);
}

// Build the link-resolution model: active notes + a separate Archive index so we
// can tell "target only exists in Archive" apart from "missing everywhere".
function buildFixModel(root) {
  const config = loadConfig(root);
  const cfg = {
    expectedOrphanDirs: config.expectedOrphanDirs || ['Daily', 'Documents/System/SARA Import Reports'],
    fuzzyModerate: config.fuzzyModerate || 0.85,
    fuzzyAggressive: config.fuzzyAggressive || 0.70,
  };
  const active = walk(root);                                   // EXCLUDE_DIRS skips Archive

  const notes = new Map();
  const resolveIndex = new Map();    // normalized base/alias -> path (active)
  const normBaseToPaths = new Map(); // normalized base -> [active paths]

  for (const f of active) {
    const text = fs.readFileSync(f, 'utf8');
    const base = path.basename(f, '.md');
    const aliases = parseAliases(text);
    notes.set(f, { base, aliases, outgoing: extractLinks(text), inCount: 0 });
    const nb = norm(base);
    resolveIndex.set(nb, f);
    if (!normBaseToPaths.has(nb)) normBaseToPaths.set(nb, []);
    normBaseToPaths.get(nb).push(f);
    for (const a of aliases) resolveIndex.set(norm(a), f);
  }
  // Same nested-Archive discovery lint uses, with fixPlan's aggressive normaliser.
  const archiveIndex = buildArchiveIndex(root, norm);

  for (const [f, n] of notes) {
    const seen = new Set();
    for (const t of n.outgoing) {
      const hit = resolveIndex.get(norm(t));
      if (hit && hit !== f && !seen.has(hit)) { notes.get(hit).inCount++; seen.add(hit); }
    }
  }
  return { cfg, notes, resolveIndex, normBaseToPaths, archiveIndex };
}

/**
 * Classify every broken link / orphan into tiered, approvable fix actions.
 * Read-only. Writes a Fix Plan note + machine plan (Scripts/.lint-plan.json).
 */
function fixPlan(root, { write = true } = {}) {
  const { cfg, notes, resolveIndex, normBaseToPaths, archiveIndex } = buildFixModel(root);
  const activeBaseNorms = [...normBaseToPaths.keys()];

  const linkFixes = [];
  const archived = [];
  const missing = [];

  for (const [f, n] of notes) {
    const seenTargets = new Set();
    for (const t of n.outgoing) {
      const nt = norm(t);
      if (resolveIndex.has(nt)) continue;
      const dedupKey = `${rel(root, f)} ${nt}`;
      if (seenTargets.has(dedupKey)) continue;
      seenTargets.add(dedupKey);

      const exact = normBaseToPaths.get(nt);
      if (exact && exact.length === 1) {
        linkFixes.push({ key: fixKey(rel(root, f), t), from: rel(root, f), oldTarget: t, newBase: path.basename(exact[0], '.md'), sim: 1, tier: 'conservative' });
        continue;
      }
      let best = null, bestSim = 0, ties = 0;
      for (const nb of activeBaseNorms) {
        const s = dice(nt, nb);
        if (s > bestSim) { bestSim = s; best = nb; ties = 1; }
        else if (s === bestSim) ties++;
      }
      if (best && ties === 1 && bestSim >= cfg.fuzzyAggressive) {
        const cand = normBaseToPaths.get(best);
        if (cand && cand.length === 1) {
          const tier = bestSim >= cfg.fuzzyModerate ? 'moderate' : 'aggressive';
          linkFixes.push({ key: fixKey(rel(root, f), t), from: rel(root, f), oldTarget: t, newBase: path.basename(cand[0], '.md'), sim: +bestSim.toFixed(3), tier });
          continue;
        }
      }
      if (archiveIndex.has(nt)) { archived.push({ from: rel(root, f), oldTarget: t, archivePath: rel(root, archiveIndex.get(nt)) }); continue; }
      missing.push({ from: rel(root, f), oldTarget: t });
    }
  }

  const expected = [], people = [], content = [];
  for (const [f, n] of notes) {
    if (n.outgoing.length || n.inCount) continue;
    const r = rel(root, f);
    if (cfg.expectedOrphanDirs.some((d) => r.startsWith(d + '/'))) expected.push(r);
    else if (r.startsWith('People/')) people.push(r);
    else content.push(r);
  }

  const summary = {
    links: {
      conservative: linkFixes.filter((x) => x.tier === 'conservative').length,
      moderate: linkFixes.filter((x) => x.tier === 'moderate').length,
      aggressive: linkFixes.filter((x) => x.tier === 'aggressive').length,
    },
    archivedLinks: archived.length,
    archivedNotes: new Set(archived.map((a) => norm(a.oldTarget))).size,
    missing: missing.length,
    expectedOrphans: expected.length,
    peopleOrphans: people.length,
    contentOrphans: content.length,
  };

  const plan = { generated: new Date().toISOString(), cfg, summary, linkFixes, archived, missing, expected, people, content };

  let reportPath = null;
  if (write) {
    ensureDir(path.join(root, ...REPORT_REL));
    ensureDir(path.join(root, 'Scripts'));
    fs.writeFileSync(path.join(root, 'Scripts', '.lint-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    reportPath = writeFixPlanReport(root, plan);
  }
  return { ...plan, reportPath };
}

function writeFixPlanReport(root, p) {
  const s = p.summary;
  const today = todayStr();
  const ex = (arr, n = 3) => arr.slice(0, n).map((x) => `\`${x.from ? x.from + ' → [[' + x.oldTarget + ']]' : x}\``).join('; ');
  const L = [];
  L.push('---', 'type: reference', `created: ${today}`, 'tags: [vault, lint, fix-plan]', 'author: NEURO vault-hygiene', '---');
  L.push(`# Vault Fix Plan — ${today}`, '');
  L.push('Each action offers autonomy tiers. Approve per action; apply runs only the chosen tier.', '');
  L.push('## Action 1 — Broken links: repoint to matching note');
  L.push(`- **Conservative** — repoint **${s.links.conservative}** links that exactly match one active note (zero ambiguity).`);
  L.push(`- **Moderate** — Conservative + **${s.links.moderate}** more via high-confidence fuzzy match (≥${p.cfg.fuzzyModerate}).`);
  L.push(`- **Aggressive** — Moderate + **${s.links.aggressive}** more via best-guess match (≥${p.cfg.fuzzyAggressive}); higher mislink risk — review-only by default.`);
  L.push(`  - e.g. ${ex(p.linkFixes)}`, '');
  L.push('## Action 2 — Broken links to archived notes');
  L.push('- **Conservative** — report only (leave links + Archive as-is).');
  L.push(`- **Moderate / Aggressive** — restore the **${s.archivedNotes}** archived notes behind **${s.archivedLinks}** links to their active folder.`);
  L.push(`  - e.g. ${ex(p.archived)}`, '');
  L.push('## Action 3 — Expected orphans (Daily, SARA reports)');
  L.push(`- **Moderate / Aggressive** — keep the **${s.expectedOrphans}** expected orphans suppressed from reports (config).`, '');
  L.push('## Action 4 — Orphan People notes');
  L.push(`- **${s.peopleOrphans}** People notes with no links — flagged for review (auto-link deferred).`, '');
  L.push('## Action 5 — Missing link targets (exist nowhere)');
  L.push(`- **Aggressive** — create **${s.missing}** stub notes in Imports/_NeedsReview/ so links resolve.`, '');
  L.push('## Content orphans (manual)');
  L.push(`- **${s.contentOrphans}** real notes with no links in/out — listed for you to link; not auto-actioned.`, '');
  if (p.content.length) for (const c of p.content.slice(0, 50)) L.push(`  - \`${c}\``);
  L.push('', '---', '_Generated by NEURO `vault-hygiene` (fix plan). Apply per-category with chosen tiers._');
  const outPath = path.join(root, ...REPORT_REL, `Fix Plan ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return rel(root, outPath);
}

function repointInFile(root, absFile, edits, backupDir) {
  const bk = path.join(backupDir, rel(root, absFile));
  ensureDir(path.dirname(bk));
  fs.copyFileSync(absFile, bk);
  let text = fs.readFileSync(absFile, 'utf8');
  let changed = 0;
  for (const { oldTarget, newBase } of edits) {
    const re = new RegExp('\\[\\[' + escapeRe(oldTarget) + '(?=[\\]|#])', 'g');
    text = text.replace(re, () => { changed++; return '[[' + newBase; });
  }
  fs.writeFileSync(absFile, text, 'utf8');
  return changed;
}

/**
 * Apply fixes, gated per category by autonomy tier (skip|conservative|moderate|aggressive).
 * Surgical link edits / non-destructive restores only; backs up every touched file.
 * @param {object} flags  { links, archived, expected, missing }  (default each "skip")
 */
function fixApply(root, flags = {}) {
  const p = fixPlan(root, { write: false });
  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);
  const log = [`# Lint Fix Changelog — ${stamp}`, ''];
  const result = { repointed: 0, restored: 0, stubs: 0, expectedSuppressed: false };
  const touched = [];

  // Action 1 — link repoints: the union of a TIER and an explicit PICK LIST.
  //
  // The tier alone is the wrong shape for the real work. `conservative` is
  // exact-match-only and on the live vault proposes nothing at all, while
  // `aggressive` offers genuine mislinks (`NOVA_REVIEW_2026-04-27` scores 0.706
  // against `W24-2026-review`), so it must never be applied wholesale. What is
  // wanted is "the safe tier, plus these three guesses I have read" — hence
  // `only`, a list of `fixKey`s.
  //
  // ⚠ A pick is ADDITIVE and never subtractive: it widens the tier's set and
  // cannot narrow it, so nobody can pass a pick list believing it EXCLUDES the
  // repairs the tier already covers.
  // ⚠ A key matching nothing is REPORTED, never swallowed — a plan gone stale
  // under the caller must not read as a clean run that simply did less.
  const lvl = TIER_RANK[flags.links || 'skip'] || 0;
  const only = Array.isArray(flags.only) ? flags.only.filter((k) => typeof k === 'string' && k) : null;
  const onlySet = new Set(only || []);
  const picked = new Set();
  const chosen = p.linkFixes.filter((x) => {
    if (onlySet.has(x.key)) { picked.add(x.key); return true; }
    return lvl >= 1 && TIER_RANK[x.tier] <= lvl;
  });
  result.onlyUnmatched = only ? only.filter((k) => !picked.has(k)) : [];
  if (chosen.length) {
    const byFile = new Map();
    for (const x of chosen) {
      const abs = path.join(root, x.from);
      if (!byFile.has(abs)) byFile.set(abs, []);
      byFile.get(abs).push(x);
    }
    for (const [abs, edits] of byFile) { result.repointed += repointInFile(root, abs, edits, backupDir); touched.push(rel(root, abs)); }
    log.push(`## Repointed links (tier ${flags.links || 'skip'}${only ? ` + ${picked.size} picked` : ''}): ${result.repointed} across ${byFile.size} files`);
    for (const x of chosen) log.push(`- \`${x.from}\`: \`[[${x.oldTarget}]]\` → \`[[${x.newBase}]]\` (sim ${x.sim})`);
    log.push('');
  }

  // Action 3 — persist expected-orphan suppression (config already lists them; rewrite to canonicalise)
  if ((TIER_RANK[flags.expected || 'skip'] || 0) >= 2) {
    ensureDir(path.join(root, 'Scripts'));
    const cfgPath = path.join(root, 'Scripts', 'lint-config.json');
    const cfg = loadConfig(root);
    cfg.expectedOrphanDirs = p.cfg.expectedOrphanDirs;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    result.expectedSuppressed = true;
    log.push(`## Expected orphans suppressed via Scripts/lint-config.json (dirs: ${cfg.expectedOrphanDirs.join(', ')})`, '');
  }

  // Action 5 — stub missing targets (aggressive only)
  if ((TIER_RANK[flags.missing || 'skip'] || 0) >= 3) {
    const made = new Set();
    for (const m of p.missing) {
      const nb = norm(m.oldTarget);
      if (made.has(nb)) continue;
      made.add(nb);
      const dest = path.join(root, 'Imports', '_NeedsReview', m.oldTarget.replace(/[\\/:*?"<>|]/g, '-') + '.md');
      if (!fs.existsSync(dest)) {
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, `---\ntype: stub\ncreated: ${todayStr()}\nauthor: NEURO vault-hygiene\n---\n# ${m.oldTarget}\n\n> Stub created to resolve a dangling link. Fill in or merge.\n`, 'utf8');
      }
    }
    result.stubs = made.size;
    log.push(`## Created ${made.size} stub notes in Imports/_NeedsReview/`, '');
  }

  // Action 2 — restore archived target notes to active folders (non-destructive copy; never overwrite)
  if ((TIER_RANK[flags.archived || 'skip'] || 0) >= 2) {
    const ACTIVE_ROOTS = ['Meetings', 'People', 'Projects', 'Areas', 'Ideas', 'Reflections', 'Decision Log', 'Documents', 'Tasks', 'Team', 'Calls'];
    const destFor = new Map();
    for (const a of p.archived) {
      if (destFor.has(a.archivePath)) continue;
      const parts = a.archivePath.split('/');
      let idx = -1;
      for (let i = 0; i < parts.length; i++) if (ACTIVE_ROOTS.includes(parts[i])) { idx = i; break; }
      const destRel = idx >= 0 ? parts.slice(idx).join('/') : path.join('Meetings', '2026', path.basename(a.archivePath)).split(path.sep).join('/');
      destFor.set(a.archivePath, destRel);
    }
    let skipped = 0;
    for (const [archiveRel, destRel] of destFor) {
      const dest = path.join(root, destRel);
      if (fs.existsSync(dest)) { skipped++; continue; }
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, fs.readFileSync(path.join(root, archiveRel), 'utf8'), 'utf8');
      result.restored++;
      touched.push(destRel);
      log.push(`- restored \`${destRel}\``);
    }
    log.push(`## Restored ${result.restored} archived notes to active folders (${skipped} skipped: already present)`, '');
  }

  ensureDir(path.join(root, ...REPORT_REL));
  const changelogPath = path.join(root, ...REPORT_REL, `Lint Fix Changelog ${todayStr()}.md`);
  fs.writeFileSync(changelogPath, log.join('\n'), 'utf8');
  return { ...result, touched, backupDir: rel(root, backupDir), changelogPath: rel(root, changelogPath), people: p.people };
}

// ── Capability: alias suggest (read-only) ───────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return prev[n];
}

function similarity(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la === lb) return 1;
  const maxLen = Math.max(la.length, lb.length);
  return maxLen ? 1 - levenshtein(la, lb) / maxLen : 0;
}

/**
 * Scan the corpus for capitalised full-name pairs that closely match a roster
 * person but aren't an exact name/alias (e.g. "Abdi Mohammad" → Abdi Mohamed).
 * Read-only — proposes aliases for human approval; never edits frontmatter here.
 * @returns {{ suggestions, reportPath }}
 */
function aliasSuggest(root, { threshold = 0.82, write = true } = {}) {
  const { people } = buildPeopleIndex(root);
  const known = new Set();
  for (const p of people) for (const n of p.names) known.add(n.toLowerCase());

  const candidates = new Map(); // candidate -> { sample }
  const nameRe = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g;
  for (const file of walk(root)) {
    if (rel(root, file).startsWith('People/')) continue; // don't mine the roster itself
    const prose = cleanProse(fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---/, ''));
    let m;
    while ((m = nameRe.exec(prose)) !== null) {
      const cand = m[1];
      if (known.has(cand.toLowerCase())) continue;
      if (!candidates.has(cand)) candidates.set(cand, { sample: snippet(prose, m.index, cand.length) });
    }
  }

  const suggestions = [];
  for (const [cand, meta] of candidates) {
    const matches = [];
    for (const p of people) {
      let best = 0;
      for (const n of p.names) best = Math.max(best, similarity(cand, n));
      if (best >= threshold && best < 1) matches.push({ person: p.base, score: best });
    }
    if (matches.length === 1) {
      suggestions.push({ candidate: cand, person: matches[0].person, score: Number(matches[0].score.toFixed(3)), sample: meta.sample });
    }
    // matches.length > 1 → ambiguous, skip (handoff §3.4)
  }
  suggestions.sort((a, b) => b.score - a.score);

  let reportPath = null;
  if (write) reportPath = writeAliasReport(root, suggestions);

  return { suggestions, reportPath };
}

function writeAliasReport(root, suggestions) {
  const today = todayStr();
  const L = [`# Alias Suggestions — DRY RUN (${today})`, ''];
  L.push(`${suggestions.length} candidate name variants closely matching a roster person (no exact match). Human-approve before adding to \`aliases:\`.`, '');
  if (!suggestions.length) L.push('> [!success] No near-match variants found.');
  for (const s of suggestions) {
    L.push(`- **${s.candidate}** → [[${s.person}]] _(score ${s.score})_  — "…${s.sample}…"`);
  }
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Alias Suggestions ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return rel(root, outPath);
}

// ── Capability: connect orphans (append-only fallback) ──────────────────────

const HUB_MARKER = '<!-- hub-link -->';
const DAILY_NAV_MARKER = '<!-- daily-nav -->';

/**
 * Connect orphan content into the graph (a FALLBACK — prefer contextualLinkApply
 * for real density; this trades orphans for single-link leaves):
 *   A) NOVA orphans  → append "_Part of [[MOC - NOVA]]_"
 *   B) Daily notes   → append a prev/next nav chain
 * Append-only, backs up each touched file, idempotent (marker-guarded).
 */
function connectOrphans(root, { nova = true, daily = true } = {}) {
  const files = walk(root);
  const notes = new Map(), idx = new Map();
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    notes.set(f, { out: extractLinks(t), in: 0, text: t });
    idx.set(norm(path.basename(f, '.md')), f);
  }
  for (const [f, n] of notes) {
    const seen = new Set();
    for (const l of n.out) { const h = idx.get(norm(l)); if (h && h !== f && !seen.has(h)) { notes.get(h).in++; seen.add(h); } }
  }
  const isOrphan = (f) => { const n = notes.get(f); return n.out.length === 0 && n.in === 0; };

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);
  const append = (f, block) => {
    const bk = path.join(backupDir, rel(root, f));
    ensureDir(path.dirname(bk));
    fs.copyFileSync(f, bk);
    let t = notes.get(f).text;
    if (!t.endsWith('\n')) t += '\n';
    fs.writeFileSync(f, t + closeOpenFence(t) + block, 'utf8');
  };

  const log = [`# Connect Orphans Changelog — ${todayStr()}`, ''];
  let novaCount = 0, chainCount = 0;
  const touched = [];

  if (nova) {
    for (const f of files) {
      if (!rel(root, f).startsWith('Projects/NOVA/')) continue;
      if (!isOrphan(f)) continue;
      if (notes.get(f).text.includes('[[MOC - NOVA]]') || notes.get(f).text.includes(HUB_MARKER)) continue;
      append(f, `\n${HUB_MARKER}\n_Part of [[MOC - NOVA]]_\n`);
      novaCount++; touched.push(rel(root, f));
      log.push(`- NOVA link: \`${rel(root, f)}\``);
    }
  }

  if (daily) {
    const dre = /^(\d{4}-\d{2}-\d{2})\.md$/;
    const dailies = files
      .filter((f) => dre.test(path.basename(f)) && rel(root, f).startsWith('Daily/'))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    for (let i = 0; i < dailies.length; i++) {
      const f = dailies[i];
      if (notes.get(f).text.includes(DAILY_NAV_MARKER)) continue;
      const prev = i > 0 ? path.basename(dailies[i - 1], '.md') : null;
      const next = i < dailies.length - 1 ? path.basename(dailies[i + 1], '.md') : null;
      let nav;
      if (prev && next) nav = `_← [[${prev}]] | [[${next}]] →_`;
      else if (next) nav = `_[[${next}]] →_`;
      else if (prev) nav = `_← [[${prev}]]_`;
      else continue;
      append(f, `\n${DAILY_NAV_MARKER}\n${nav}\n`);
      chainCount++; touched.push(rel(root, f));
    }
  }

  log.push('', `## Linked ${novaCount} NOVA orphans to [[MOC - NOVA]]`, `## Chained ${chainCount} Daily notes (prev/next)`, '', `_Backups: \`${rel(root, backupDir)}\`. Appends only; no note overwritten or deleted._`);
  ensureDir(path.join(root, ...REPORT_REL));
  const changelogPath = path.join(root, ...REPORT_REL, `Connect Changelog ${todayStr()}.md`);
  fs.writeFileSync(changelogPath, log.join('\n'), 'utf8');
  return { nova: novaCount, daily: chainCount, touched, backupDir: rel(root, backupDir), changelogPath: rel(root, changelogPath) };
}

// ── Capability: graph config (.obsidian/graph.json) ─────────────────────────

// Canonical colour scheme by area (handoff §1.6). RGB ints are the proven 29 Jun values.
const CANONICAL_COLOR_GROUPS = [
  { query: 'path:"People/"', color: { a: 1, rgb: 3003583 } },   // teal
  { query: 'path:"Team/"', color: { a: 1, rgb: 3003583 } },     // teal
  { query: 'path:"Meetings/"', color: { a: 1, rgb: 3900150 } }, // blue
  { query: 'path:"Calls/"', color: { a: 1, rgb: 3900150 } },    // blue
  { query: 'path:"Daily/"', color: { a: 1, rgb: 2278750 } },    // green
  { query: 'path:"Ideas/"', color: { a: 1, rgb: 11032055 } },   // purple
  { query: 'path:"Reflections/"', color: { a: 1, rgb: 15485081 } }, // rose
  { query: 'path:"Decision Log/"', color: { a: 1, rgb: 15680580 } }, // red
  { query: 'path:"Projects/NOVA/"', color: { a: 1, rgb: 16347926 } }, // orange
  { query: 'path:"MOCs/"', color: { a: 1, rgb: 15119360 } },    // gold
];

/**
 * Manage .obsidian/graph.json. read returns the current config; apply backs up to
 * graph.json.bak-<date> then writes the canonical colour groups (preserving the
 * user's force/zoom settings unless overridden).
 * NOTE: Obsidian rewrites graph.json on close if the graph view is open — apply
 * while the graph is closed, or the change is lost.
 */
function graphConfig(root, { apply = false, display = {}, forces = {}, colorGroups = null } = {}) {
  const gpath = path.join(root, '.obsidian', 'graph.json');
  const current = fs.existsSync(gpath) ? JSON.parse(fs.readFileSync(gpath, 'utf8')) : {};
  if (!apply) {
    return { applied: false, colorGroups: current.colorGroups || [], config: current, warning: 'Obsidian overwrites graph.json on close if the graph view is open — close it before applying.' };
  }
  const backupPath = path.join(root, '.obsidian', `graph.json.bak-${todayStr()}`);
  if (fs.existsSync(gpath)) fs.copyFileSync(gpath, backupPath);
  const next = {
    ...current,
    colorGroups: colorGroups || CANONICAL_COLOR_GROUPS,
    ...display,
    ...forces,
  };
  fs.writeFileSync(gpath, JSON.stringify(next, null, 2), 'utf8');
  return { applied: true, backupPath: rel(root, backupPath), colorGroups: next.colorGroups, warning: 'Written. If the graph view was open in Obsidian, it may overwrite this on close — apply with the graph closed.' };
}

// ── Phase 3: nightly hygiene sweep ──────────────────────────────────────────

function frontmatterValue(text, key) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(new RegExp('^' + key + '\\s*:\\s*"?([^"\\n]+)"?', 'mi'));
  return m ? m[1].trim() : null;
}

// k-word shingles of a note's prose (for content-containment dedup).
function shingleSet(text, k = 6) {
  const words = cleanProse(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const s = new Set();
  for (let i = 0; i + k <= words.length; i++) s.add(words.slice(i, i + k).join(' '));
  return s;
}
function containment(a, b) {
  if (!a.size) return 1;
  let inB = 0;
  for (const x of a) if (b.has(x)) inB++;
  return inB / a.size;
}

/**
 * Content-safe Summary-N dedup. Groups summary notes by plaud_id (the ONLY safe
 * key — same-date "Summary N" can be DIFFERENT meetings). Keeps the richest
 * variant; archives another ONLY if ≥threshold of its word-shingles already exist
 * in a kept variant. Never merges distinct recordings; never deletes.
 */
function dedupSummaries(root, { threshold = 0.95, apply = true } = {}) {
  const byId = new Map();
  for (const f of walk(root)) {
    const rp = rel(root, f);
    if (!(rp.startsWith('Meetings/') || rp.startsWith('Plaud/'))) continue;
    const c = fs.readFileSync(f, 'utf8');
    if (/note_type\s*:\s*"?transcript/i.test(c)) continue; // transcripts aren't summary variants
    const id = frontmatterValue(c, 'plaud_id');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ f, rp, body: c.replace(/^---[\s\S]*?---/, ''), len: c.length });
  }

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, `dedup-${stamp}`);
  const archiveDir = path.join(root, 'Archive', 'Summary Duplicates');
  const dropped = [], keptUnique = [];
  for (const [, notes] of byId) {
    if (notes.length < 2) continue;
    notes.sort((a, b) => b.len - a.len);       // richest first = canonical
    const canonical = notes[0];
    const canonicalDir = path.dirname(canonical.f);
    const keep = shingleSet(canonical.body);
    for (const n of notes.slice(1)) {
      const ns = shingleSet(n.body);
      const c = containment(ns, keep);
      // Only archive a same-directory variant fully contained in the canonical —
      // never move a routed note (e.g. Meetings/1-2-1/) for a raw import copy.
      if (c >= threshold && path.dirname(n.f) === canonicalDir) {
        if (apply) {
          const bk = path.join(backupDir, path.basename(n.f));
          ensureDir(path.dirname(bk)); fs.copyFileSync(n.f, bk);
          ensureDir(archiveDir);
          let dest = path.join(archiveDir, path.basename(n.f)); let i = 2;
          while (fs.existsSync(dest)) dest = path.join(archiveDir, path.basename(n.f, '.md') + ` (${i++}).md`);
          fs.renameSync(n.f, dest);
        }
        dropped.push({ rel: n.rp, keptRel: canonical.rp, containment: +c.toFixed(3) });
      } else {
        keptUnique.push({ rel: n.rp, containment: +c.toFixed(3) });
        for (const x of ns) keep.add(x); // union — a 3rd variant contained in EITHER kept note also drops
      }
    }
  }
  return { dropped, keptUnique, archiveDir: rel(root, archiveDir) };
}

// Collect meeting/recording notes with only "Speaker N" (no roster person linked)
// into MOCs/Orphan.md — the ones only a human can name. Idempotent.
function collectUnnamedRecordings(root, { apply = true } = {}) {
  const orphanPath = path.join(root, 'MOCs', 'Orphan.md');
  const existing = fs.existsSync(orphanPath) ? fs.readFileSync(orphanPath, 'utf8') : '';
  const found = [];
  for (const root2 of ['Meetings', 'Plaud']) {
    for (const f of walk(path.join(root, root2))) {
      const rp = rel(root, f);
      const c = fs.readFileSync(f, 'utf8');
      if (!/\bSpeaker \d/.test(c)) continue;                 // has unnamed speakers
      // Skip if it already links to ANY person (full-name wikilink) or has a
      // Mentioned/Also-mentions block from contextual linking.
      if (/\[\[[A-Z][a-z]+ [A-Z][a-z]+/.test(c) || /## Mentioned|Also mentions/.test(c)) continue;
      const linkRef = rp.replace(/\.md$/, '');
      if (existing.includes(linkRef)) continue;              // already listed
      found.push(rp);
    }
  }
  if (apply && found.length) {
    let o = existing || '---\ntype: moc\ntags: [moc, orphans, review]\n---\n# Orphan — Notes to Review\n\nOwner: [[Nick Ward]]\n';
    o += `\n## Unnamed recordings (swept ${todayStr()})\n` + found.map((r) => `- [[${r.replace(/\.md$/, '')}|${path.basename(r, '.md')}]]`).join('\n') + '\n';
    fs.writeFileSync(orphanPath, o, 'utf8');
  }
  return { collected: found };
}

// Archive genuinely-empty recordings (no transcript AND no summary) — the
// readiness gate prevents new ones, this cleans any straggler.
function sweepEmptyStubs(root, { apply = true } = {}) {
  const STUB = 'No transcript returned by Plaud';
  const NOSUM = 'No summary content returned';
  const emptyIds = new Set();
  for (const f of walk(path.join(root, 'Plaud', 'Transcripts'))) {
    if (fs.readFileSync(f, 'utf8').includes(STUB)) { const id = frontmatterValue(fs.readFileSync(f, 'utf8'), 'plaud_id'); if (id) emptyIds.add(id); }
  }
  // only archive an id if its SUMMARY is also empty (else it's a real meeting awaiting transcription)
  const archiveDir = path.join(root, 'Archive', 'Empty Recordings');
  const archived = [];
  for (const f of walk(root)) {
    const c = fs.readFileSync(f, 'utf8');
    const id = frontmatterValue(c, 'plaud_id');
    if (!id || !emptyIds.has(id)) continue;
    const isTranscript = /note_type\s*:\s*"?transcript/i.test(c);
    if (!isTranscript && !c.includes(NOSUM)) { emptyIds.delete(id); } // summary has content → keep whole recording
  }
  if (apply) {
    for (const f of walk(root)) {
      const id = frontmatterValue(fs.readFileSync(f, 'utf8'), 'plaud_id');
      if (id && emptyIds.has(id)) {
        ensureDir(archiveDir);
        let dest = path.join(archiveDir, path.basename(f)); let i = 2;
        while (fs.existsSync(dest)) dest = path.join(archiveDir, path.basename(f, '.md') + ` (${i++}).md`);
        fs.renameSync(f, dest); archived.push(rel(root, f));
      }
    }
  }
  return { archived };
}

/**
 * Nightly hygiene sweep — the automated version of the manual cleanup:
 * dedup Summary-N, collect unnamed recordings, archive empty stragglers.
 * Writes a dated sweep report. All mutations are reversible (archive, not delete).
 */
function nightlySweep(root, { apply = true } = {}) {
  const dedup = dedupSummaries(root, { apply });
  const orphans = collectUnnamedRecordings(root, { apply });
  const empties = sweepEmptyStubs(root, { apply });

  const today = todayStr();
  const L = [
    '---', 'type: reference', `created: ${today}`, 'tags: [vault, hygiene, sweep]', 'author: NEURO vault-hygiene', '---',
    `# Nightly Hygiene Sweep — ${today}`, '',
    `- Summary-N duplicates archived: **${dedup.dropped.length}** (kept ${dedup.keptUnique.length} with unique content)`,
    `- Unnamed recordings collected to Orphan hub: **${orphans.collected.length}**`,
    `- Empty recordings archived: **${empties.archived.length}**`, '',
  ];
  if (dedup.dropped.length) { L.push('## Duplicate summaries archived'); for (const d of dedup.dropped) L.push(`- \`${d.rel}\` → kept \`${d.keptRel}\` (${Math.round(d.containment * 100)}% contained)`); L.push(''); }
  if (dedup.keptUnique.length) { L.push('## Kept — unique content (NOT dropped)'); for (const k of dedup.keptUnique) L.push(`- \`${k.rel}\` (${Math.round(k.containment * 100)}% overlap)`); L.push(''); }
  ensureDir(path.join(root, ...REPORT_REL));
  const outPath = path.join(root, ...REPORT_REL, `Hygiene Sweep ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf8');
  return { dedup, orphans, empties, reportPath: rel(root, outPath) };
}

// ── PLAUD "Summary" note rename ──────────────────────────────────────────────
//
// PLAUD's data_title names the summary TAB — the literal "Summary" — not the
// meeting, and it used to beat recording.name in the fallback chain. So ~101
// meeting notes were written as "<date> – Summary.md", then "Summary 3",
// "Summary 4" as same-day collisions piled up, and the vault filled with notes
// that couldn't be found by name. plaud-sync.js picks the right title going
// forward; this repairs what was already written.
//
// The true title is recoverable OFFLINE — no PLAUD API call. Every one of these
// notes carries transcript_path in frontmatter, and the transcript note's own
// frontmatter title holds the real recording name.
//
// Renaming breaks every [[wikilink]] pointing at the note, so this rewrites
// those too. That is the whole reason it isn't a one-line mv.

const PLAUD_SUMMARY_BASENAME_RE = /[–-]\s*Summary(?:\s+\d+)?$/i;

function readFrontmatterBlock(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// Mirrors buildCanonicalMeetingPath() in imports.js so a repaired name is
// byte-identical to what a fresh import would produce.
function normalisePlaudTitle(raw) {
  return String(raw || '')
    .replace(/^\d{4}-\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/^\d{2}-\d{2}[\s–-]*/u, '')
    .replace(/\b(?:-summary|-obsidian meeting template|-transcript)\b/gi, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugSegment(value, fallback = 'Meeting') {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

// Recover the meeting title without touching PLAUD: prefer the transcript
// note's frontmatter title (that IS recording.name), else de-slug its filename.
function recoverTitle(root, fm) {
  const tp = fm.transcript_path;
  if (!tp) return null;
  const full = path.join(root, tp.replace(/^\/+/, ''));
  if (fs.existsSync(full)) {
    const tfm = readFrontmatterBlock(fs.readFileSync(full, 'utf8'));
    const t = normalisePlaudTitle(tfm.title);
    if (t && !/^summary(\s+\d+)?$/i.test(t)) return t;
  }
  // Filename fallback: "2026-07-01 07-01-Performance-Review-Zoe-Rees-Workload".
  const base = path.basename(tp, '.md');
  const deslugged = normalisePlaudTitle(base.replace(/-/g, ' '));
  return deslugged && !/^summary(\s+\d+)?$/i.test(deslugged) ? deslugged : null;
}

function planPlaudSummaryRenames(root) {
  const meetingsDir = path.join(root, 'Meetings');
  const targets = walk(meetingsDir).filter((f) => {
    const base = path.basename(f, '.md');
    return PLAUD_SUMMARY_BASENAME_RE.test(base) && !/transcripts/i.test(rel(root, f));
  });

  const taken = new Set(walk(meetingsDir).map((f) => rel(root, f).toLowerCase()));
  const renames = [];
  const unresolved = [];

  for (const file of targets) {
    const relPath = rel(root, file);
    const raw = fs.readFileSync(file, 'utf8');
    const fm = readFrontmatterBlock(raw);
    const title = recoverTitle(root, fm);
    if (!title) {
      unresolved.push({ rel: relPath, reason: fm.transcript_path ? 'transcript title unusable' : 'no transcript_path' });
      continue;
    }

    const date = (fm.date || path.basename(file).slice(0, 10) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      unresolved.push({ rel: relPath, reason: 'no usable date' });
      continue;
    }

    const dir = path.dirname(relPath);
    let candidate = `${date} – ${slugSegment(title)}`;
    let target = `${dir}/${candidate}.md`;
    // Same-day collisions keep the existing " 2"/" 3" convention.
    let n = 1;
    while (taken.has(target.toLowerCase()) && target.toLowerCase() !== relPath.toLowerCase()) {
      n += 1;
      candidate = `${date} – ${slugSegment(title)} ${n}`;
      target = `${dir}/${candidate}.md`;
    }
    if (target.toLowerCase() === relPath.toLowerCase()) continue; // already correct
    taken.add(target.toLowerCase());
    taken.delete(relPath.toLowerCase());

    renames.push({
      from: relPath,
      to: target,
      fromBase: path.basename(relPath, '.md'),
      toBase: candidate,
      title,
    });
  }

  // Which files reference the old names, and how many links each.
  const byOldBase = new Map(renames.map((r) => [r.fromBase.toLowerCase(), r]));
  const linkEdits = [];
  let linkCount = 0;
  for (const file of walk(root)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('[[')) continue;
    let hits = 0;
    for (const m of raw.matchAll(/!?\[\[([^\]]+?)\]\]/g)) {
      const target = m[1].split('|')[0].split('#')[0].trim();
      if (byOldBase.has(path.basename(target).toLowerCase())) hits += 1;
    }
    if (hits) { linkEdits.push({ rel: rel(root, file), links: hits }); linkCount += hits; }
  }

  return { renames, unresolved, linkEdits, linkCount };
}

// Rewrite [[old]] -> [[new]] preserving any path prefix, |alias and #heading.
// Embeds (![[…]]) are included deliberately: the link graph elsewhere ignores
// them, but a rename breaks an embed exactly as it breaks a link.
function rewriteLinks(raw, byOldBase) {
  return raw.replace(/(!?)\[\[([^\]]+?)\]\]/g, (whole, bang, inner) => {
    const pipe = inner.indexOf('|');
    const linkPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const aliasPart = pipe === -1 ? '' : inner.slice(pipe);
    const hash = linkPart.indexOf('#');
    const pathPart = hash === -1 ? linkPart : linkPart.slice(0, hash);
    const headingPart = hash === -1 ? '' : linkPart.slice(hash);
    const trimmed = pathPart.trim();
    const hit = byOldBase.get(path.basename(trimmed).toLowerCase());
    if (!hit) return whole;
    const dir = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/') + 1) : '';
    return `${bang}[[${dir}${hit.toBase}${headingPart}${aliasPart}]]`;
  });
}

function renamePlaudSummaryNotes(root, { apply = false } = {}) {
  const plan = planPlaudSummaryRenames(root);
  const result = {
    apply,
    candidates: plan.renames.length,
    unresolved: plan.unresolved,
    linkCount: plan.linkCount,
    filesWithLinks: plan.linkEdits.length,
    renames: plan.renames,
  };
  if (!apply || !plan.renames.length) {
    result.reportPath = writePlaudRenameReport(root, result, null);
    return result;
  }

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);
  const byOldBase = new Map(plan.renames.map((r) => [r.fromBase.toLowerCase(), r]));

  // 1. Rewrite links first — while the old names still resolve, so a crash
  //    between the two steps leaves links pointing at files that still exist.
  let filesEdited = 0;
  for (const entry of plan.linkEdits) {
    const file = path.join(root, entry.rel);
    const raw = fs.readFileSync(file, 'utf8');
    const out = rewriteLinks(raw, byOldBase);
    if (out === raw) continue;
    const bk = path.join(backupDir, entry.rel);
    ensureDir(path.dirname(bk));
    fs.copyFileSync(file, bk);
    fs.writeFileSync(file, out, 'utf8');
    filesEdited += 1;
  }

  // 2. Rename the notes and correct the frontmatter title that caused this.
  let renamed = 0;
  const failures = [];
  for (const r of plan.renames) {
    const from = path.join(root, r.from);
    const to = path.join(root, r.to);
    try {
      if (!fs.existsSync(from)) { failures.push({ ...r, error: 'source missing' }); continue; }
      if (fs.existsSync(to)) { failures.push({ ...r, error: 'target exists' }); continue; }
      const bk = path.join(backupDir, r.from);
      ensureDir(path.dirname(bk));
      fs.copyFileSync(from, bk);
      const raw = fs.readFileSync(from, 'utf8');
      const fixed = raw.replace(/^(---\r?\n[\s\S]*?)^title:\s*.*$/m, (_m, head) => `${head}title: "${r.title.replace(/"/g, '\\"')}"`);
      fs.writeFileSync(from, fixed, 'utf8');
      ensureDir(path.dirname(to));
      fs.renameSync(from, to);
      renamed += 1;
    } catch (e) {
      failures.push({ ...r, error: e.message });
    }
  }

  result.renamed = renamed;
  result.filesEdited = filesEdited;
  result.failures = failures;
  result.backupDir = rel(root, backupDir);
  result.reportPath = writePlaudRenameReport(root, result, backupDir);
  return result;
}

function writePlaudRenameReport(root, result, backupDir) {
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const today = todayStr();
  const L = [`# PLAUD Summary Rename — ${today}`, ''];
  L.push(result.apply
    ? `**APPLIED.** Renamed ${result.renamed}/${result.candidates}, rewrote ${result.linkCount} links across ${result.filesEdited} files. Backups: \`${result.backupDir}\`.`
    : `**DRY RUN.** ${result.candidates} notes would be renamed; ${result.linkCount} wikilinks across ${result.filesWithLinks} files would be rewritten.`);
  L.push('');
  if (result.unresolved.length) {
    L.push(`## Unresolved (${result.unresolved.length}) — left alone`, '');
    result.unresolved.forEach((u) => L.push(`- \`${u.rel}\` — ${u.reason}`));
    L.push('');
  }
  if (result.failures && result.failures.length) {
    L.push(`## Failures (${result.failures.length})`, '');
    result.failures.forEach((f) => L.push(`- \`${f.from}\` — ${f.error}`));
    L.push('');
  }
  L.push(`## Renames (${result.renames.length})`, '');
  result.renames.forEach((r) => L.push(`- \`${r.fromBase}\` → **${r.toBase}**`));
  const outPath = path.join(dir, `PLAUD Summary Rename ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  return rel(root, outPath);
}

module.exports = {
  lint,
  planPlaudSummaryRenames,
  renamePlaudSummaryNotes,
  contextualLinkPlan,
  contextualLinkApply,
  aliasSuggest,
  fixPlan,
  fixApply,
  connectOrphans,
  graphConfig,
  dedupSummaries,
  nightlySweep,
  // exported for tests / reuse
  DEFAULT_CTX_ROOTS,
  CTX_FORBIDDEN_ROOTS,
  _internal: { walk, collectArchiveDirs, buildArchiveIndex, parseAliases, extractLinks, linkedSet, cleanProse, buildPeopleIndex, proposeContextualLinks, similarity, norm, dice, EXCLUDE_DIRS },
};
