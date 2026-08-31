'use strict';

/**
 * Catalogues — lists of things Nick owns, keeps or has in.
 *
 * Nick, 31 Aug 2026: the fridge is not a fridge feature. *"This should be a more
 * generalised cataloguing tool, and this functionality needs to be in NEURO for
 * me as well — for example I might want to catalogue my vinyl collection, or my
 * hiking equipment."*
 *
 * So: one engine, many catalogues. The kitchen is the first instance and gets no
 * special code — VESTA's meal suggestions read a catalogue like anything else.
 *
 * ── Where they live, and why ────────────────────────────────────────────────
 * One markdown file per catalogue under `Catalogues/` in the vault. Not a table:
 * it has to be editable from Obsidian on the sofa, it wants to sit where NEURO
 * already indexes, syncs and backs it up, and the Notion sync can pick it up
 * later with nothing new built. A vinyl collection is exactly the sort of thing
 * that outlives the app that made it, and markdown outlives everything here.
 *
 * ── SELF-DESCRIBING, not configured ─────────────────────────────────────────
 * A catalogue declares its own sections and whether it is shared, in its own
 * frontmatter. There is no registry to keep in step:
 *
 *     ---
 *     type: catalogue
 *     sections: [Fridge, Freezer, Cupboard]
 *     shared: true
 *     ---
 *
 * That is the same rule as *who reports to Nick is READ, not typed* — a separate
 * config listing catalogues would drift the first time he made one by hand in
 * Obsidian, which is exactly how he WILL make most of them.
 *
 * ⚠ `shared` is what VESTA can see, and it DEFAULTS FALSE. A catalogue is
 * private unless it says otherwise, because the failure directions are not
 * symmetric: a private list nobody can see is an inconvenience, and a shared one
 * he did not mean to share is on the public internet.
 *
 * ⚠ Anything the parser does not understand is PRESERVED, never dropped. These
 * are files two people will type into by hand, and a writer that silently
 * discards a line it did not expect eats a note.
 *
 * PURE where it judges: `parse`, `render`, `slugFor` and `sectionsOf` take plain
 * data, so the file format pins without a vault.
 *
 * CommonJS — NEURO backend convention.
 */

const fs = require('fs');
const path = require('path');

const DIR = 'Catalogues';
const DEFAULT_SECTIONS = ['Items'];
// ⚠ `render` writes this under a section with nothing in it. `parse` must skip
// it, because it is the writer's OWN output and not something anybody typed —
// left as an unrecognised line it is PRESERVED into `trailing`, re-rendered
// underneath the sections, and read back again on the next save. Every write
// then adds one more copy, for ever, to any catalogue with an empty section —
// which every newly created catalogue is. Same shape as the outcome-note fence:
// a placeholder the system wrote must never read back as user content.
const EMPTY_MARK = '*(empty)*';
const MAX_NAME = 120;

// ── Pure ─────────────────────────────────────────────────────────────────────

/** A catalogue's file-safe id. PURE. */
function slugFor(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function _sectionKey(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * Parse a catalogue file. PURE.
 *
 * Returns `{ title, sections, shared, order, items, preamble, trailing }` where
 * `items` is keyed by lower-cased section name and `order` preserves the
 * declared section order for rendering.
 */
function parse(markdown = '', { fallbackTitle = 'Catalogue' } = {}) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  let title = fallbackTitle;
  let shared = false;
  let declared = null;
  const preamble = [];
  const trailing = [];

  // ── Frontmatter ───────────────────────────────────────────────────────────
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') {
      const m = /^([a-zA-Z_-]+):\s*(.*)$/.exec(lines[i]);
      if (m) {
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'sections') {
          declared = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(x => x.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else if (key === 'shared') {
          // ⚠ Only a literal `true` shares it. Anything else — absent, blank,
          // "yes", a typo — stays private. Fail closed.
          shared = value.toLowerCase() === 'true';
        } else if (key === 'title') {
          title = value || fallbackTitle;
        }
      }
      i += 1;
    }
    i += 1;
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  const items = {};
  const order = [];
  const ensure = (name) => {
    const key = _sectionKey(name);
    if (!items[key]) { items[key] = []; order.push(name.trim()); }
    return key;
  };
  for (const s of (declared || DEFAULT_SECTIONS)) ensure(s);

  let current = null;
  for (; i < lines.length; i += 1) {
    const raw = lines[i];

    const h1 = /^#\s+(.+?)\s*$/.exec(raw);
    if (h1) { if (title === fallbackTitle) title = h1[1].trim(); continue; }

    const h2 = /^##\s+(.+?)\s*$/.exec(raw);
    if (h2) { current = ensure(h2[1]); continue; }

    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (current && item) {
      const body = item[1];
      const added = /<!--\s*c:(\d{4}-\d{2}-\d{2})\s*-->/.exec(body);
      const name = body.replace(/<!--.*?-->/g, '').replace(/^\[[ x]\]\s*/i, '').trim();
      if (name) items[current].push({ name, added: added ? added[1] : null });
      continue;
    }

    if (!raw.trim()) continue;
    if (raw.trim() === EMPTY_MARK) continue;
    // Anything else is kept verbatim, above the sections if it came first.
    (current ? trailing : preamble).push(raw);
  }

  return { title, shared, sections: order, items, preamble, trailing };
}

/** Render back to markdown. PURE, and STABLE — parse → render → parse returns
 *  the same thing, which is what stops a file nobody edited churning on save. */
function render(cat = {}, { today = null } = {}) {
  const sections = cat.sections && cat.sections.length ? cat.sections : DEFAULT_SECTIONS;
  const out = [
    '---',
    'type: catalogue',
    `title: ${cat.title || 'Catalogue'}`,
    `sections: [${sections.join(', ')}]`,
    `shared: ${cat.shared === true}`,
    `updated: ${today || _today()}`,
    '---',
    '',
    `# ${cat.title || 'Catalogue'}`,
    '',
  ];

  if (cat.preamble && cat.preamble.length) out.push(...cat.preamble, '');

  for (const section of sections) {
    const list = (cat.items || {})[_sectionKey(section)] || [];
    out.push(`## ${section}`, '');
    if (!list.length) {
      out.push(EMPTY_MARK, '');
      continue;
    }
    for (const it of list) out.push(`- ${it.name}${it.added ? ` <!--c:${it.added}-->` : ''}`);
    out.push('');
  }

  if (cat.trailing && cat.trailing.length) out.push(...cat.trailing, '');
  return out.join('\n');
}

function _today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function counts(cat) {
  const items = (cat && cat.items) || {};
  return Object.values(items).reduce((n, list) => n + list.length, 0);
}

// ── Reading and writing ──────────────────────────────────────────────────────

function _dir() {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  return root ? path.join(root, DIR) : null;
}

function _fileFor(slug) {
  const dir = _dir();
  if (!dir) return null;
  // ⚠ The slug is caller-supplied and is normalised to `[a-z0-9-]` before it
  // ever touches the filesystem, so `../` cannot appear in it. Checked again
  // here rather than trusted from the route — `read_note`'s rule.
  const safe = slugFor(slug);
  if (!safe) return null;
  return path.join(dir, `${safe}.md`);
}

/** Every catalogue, as summaries. Never throws — an unreadable vault reports
 *  itself rather than looking like a person who owns nothing. */
function list() {
  const dir = _dir();
  if (!dir) return { ok: false, why: 'no vault configured', catalogues: [] };
  try {
    if (!fs.existsSync(dir)) return { ok: true, catalogues: [] };
    const out = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.replace(/\.md$/, '');
      try {
        const cat = parse(fs.readFileSync(path.join(dir, file), 'utf-8'), { fallbackTitle: slug });
        out.push({
          slug,
          title: cat.title,
          shared: cat.shared,
          sections: cat.sections,
          count: counts(cat),
        });
      } catch (e) {
        // One malformed file must not hide the rest.
        out.push({ slug, title: slug, error: e.message });
      }
    }
    return { ok: true, catalogues: out.sort((a, b) => a.title.localeCompare(b.title)) };
  } catch (e) {
    return { ok: false, why: e.message, catalogues: [] };
  }
}

function read(slug) {
  const file = _fileFor(slug);
  if (!file) return { ok: false, why: 'no vault configured, or an unusable name' };
  try {
    if (!fs.existsSync(file)) return { ok: false, why: 'no such catalogue', notFound: true };
    return { ok: true, slug: slugFor(slug), cat: parse(fs.readFileSync(file, 'utf-8'), { fallbackTitle: slug }) };
  } catch (e) {
    // ⚠ Unreadable is NOT empty. An empty freezer and an unmounted disk must
    // never render alike, or somebody shops for food that is already in.
    return { ok: false, why: e.message };
  }
}

function write(slug, cat) {
  const file = _fileFor(slug);
  if (!file) return { ok: false, why: 'no vault configured, or an unusable name' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, render(cat), 'utf-8');
    try { require('./vault-hooks').onVaultWrite(file, 'catalogue'); } catch { /* not fatal */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

function create({ title, sections = null, shared = false } = {}) {
  const clean = String(title || '').trim().slice(0, 60);
  if (!clean) return { ok: false, why: 'a name is required' };
  const slug = slugFor(clean);
  if (!slug) return { ok: false, why: 'that name has no usable characters' };

  const existing = read(slug);
  if (existing.ok) return { ok: false, why: 'a catalogue with that name already exists' };

  const cat = {
    title: clean,
    shared: shared === true,
    sections: Array.isArray(sections) && sections.length
      ? sections.map(s => String(s).trim()).filter(Boolean)
      : [...DEFAULT_SECTIONS],
    items: {},
    preamble: [],
    trailing: [],
  };
  for (const s of cat.sections) cat.items[_sectionKey(s)] = [];

  const written = write(slug, cat);
  if (!written.ok) return { ok: false, why: written.why };
  return { ok: true, slug, cat };
}

function addItem(slug, section, name) {
  const found = read(slug);
  if (!found.ok) return { ok: false, why: found.why, notFound: found.notFound };

  const cat = found.cat;
  const key = _sectionKey(section || cat.sections[0]);
  if (!cat.items[key]) {
    return { ok: false, why: `"${section}" is not a section of ${cat.title}` };
  }

  const clean = String(name || '').trim().slice(0, MAX_NAME);
  if (!clean) return { ok: false, why: 'no item given' };

  // Same wording twice is one item — two people will both add milk.
  if (cat.items[key].some(i => i.name.toLowerCase() === clean.toLowerCase())) {
    return { ok: true, already: true, cat };
  }
  cat.items[key].push({ name: clean, added: _today() });

  const written = write(slug, cat);
  if (!written.ok) return { ok: false, why: written.why };
  return { ok: true, cat };
}

function removeItem(slug, section, name) {
  const found = read(slug);
  if (!found.ok) return { ok: false, why: found.why, notFound: found.notFound };

  const cat = found.cat;
  const key = _sectionKey(section || cat.sections[0]);
  if (!cat.items[key]) return { ok: false, why: `"${section}" is not a section of ${cat.title}` };

  const target = String(name || '').trim().toLowerCase();
  const before = cat.items[key].length;
  cat.items[key] = cat.items[key].filter(i => i.name.toLowerCase() !== target);
  if (cat.items[key].length === before) return { ok: false, why: 'not found', notFound: true };

  const written = write(slug, cat);
  if (!written.ok) return { ok: false, why: written.why };
  return { ok: true, cat };
}

module.exports = {
  // pure
  parse,
  render,
  slugFor,
  counts,
  // stateful
  list,
  read,
  write,
  create,
  addItem,
  removeItem,
  // constants
  DIR,
  DEFAULT_SECTIONS,
  MAX_NAME,
};
