'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// The person roster is the People/ folder — filenames are the display names.
// It used to be a hardcoded array of 20, which capped detection at whoever was
// on it the day it was typed and went stale the moment a note was added.
// Cached for 5 minutes because this runs once per note in the nightly sweep.
const ROSTER_TTL_MS = 5 * 60 * 1000;
let _roster = { at: 0, full: [], firstNames: new Map(), aliases: new Map() };

/**
 * Read an `aliases:` list out of a note's frontmatter.
 *
 * Deliberately not `obsidian.parseFrontmatter` — that returns `""` for a YAML
 * block list, the same line-based-reserialise blind spot that makes
 * `updateFrontmatter` drop list values. So reading `fm.aliases` gives an empty
 * string for all 30 notes that have one, and "wire aliases in" is a silent
 * no-op. Handles both forms the vault actually contains: an inline `[a, b]` and
 * a block list of `- ` lines.
 *
 * Vault notes are mixed CRLF/LF, so normalise before any line-anchored parsing.
 */
function readAliases(src) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const lines = fm[1].split('\n');
  const idx = lines.findIndex(l => /^aliases:/.test(l));
  if (idx < 0) return [];

  const strip = s => s.trim().replace(/^["']|["']$/g, '').trim();
  const out = [];

  const inline = lines[idx].slice(lines[idx].indexOf(':') + 1).trim();
  if (inline && inline !== '[]') {
    for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
      const v = strip(part);
      if (v) out.push(v);
    }
  }
  for (let j = idx + 1; j < lines.length; j++) {
    if (/^\s*-\s+/.test(lines[j])) {
      const v = strip(lines[j].replace(/^\s*-\s+/, ''));
      if (v) out.push(v);
    } else if (/^\S/.test(lines[j])) {
      break; // next frontmatter key
    }
  }
  return out;
}

function getRoster() {
  if (_roster.at && Date.now() - _roster.at < ROSTER_TTL_MS) return _roster;

  const dir = path.join(VAULT_PATH, 'People');
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.slice(0, -3));
  } catch { names = []; }

  // A first name is only usable when it points at exactly one person — "Nathan"
  // is both Button and Rutland, and guessing writes a backlink onto the wrong
  // person's page. Same precision rule vault-hygiene uses.
  const counts = new Map();
  for (const n of names) {
    const first = n.split(/\s+/)[0].toLowerCase();
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  const firstNames = new Map();
  for (const n of names) {
    const first = n.split(/\s+/)[0].toLowerCase();
    if (counts.get(first) === 1 && first !== n.toLowerCase()) firstNames.set(first, n);
  }

  // Aliases (#38). The ticket expected these to RESCUE the ambiguous first
  // names — `nathan`, `andrea`, `chris`. Measured against the live vault, they
  // do the opposite: `Chris` is listed as an alias on BOTH Chris Middleton and
  // Chris Smith, and `Nathan` on both Nathans. The file does not disambiguate
  // those names, it asserts them twice. Trusting it would re-create the bug
  // `firstNames` exists to prevent — one Lucy's commitments landing on four
  // different Lucys.
  //
  // So an alias earns the same test a first name gets: it is an identifier only
  // when it points at exactly ONE person. Three ways it can fail, and the
  // second is the one the ticket missed:
  //   1. two people claim it            (`Chris`, `Nathan`)
  //   2. it is a first name the ROSTER already finds ambiguous (`Andrea` — only
  //      Andrea Melisa lists it, but Andrea Glykofrydis exists, so counting
  //      alias claims alone would resolve it and the bare first name would not)
  //   3. it is somebody else's full name
  //
  // What survives is the part that was always the real value: the deliberate
  // ones a filename cannot express — `Seb`, `Nath`, `Ben M`, `Chris S`,
  // `Steve R` — and the mis-transcriptions Plaud leaves behind, `Abdi Mohammad`
  // and `Naomi Winkworth` (which is #39's phantom person, already mapped to the
  // real Naomi Wentworth in the vault).
  const fullLower = new Set(names.map(n => n.toLowerCase()));
  const claims = new Map(); // alias-lower -> Set of full names claiming it
  for (const n of names) {
    let list = [];
    try { list = readAliases(fs.readFileSync(path.join(dir, `${n}.md`), 'utf-8')); }
    catch { continue; } // unreadable note — skip, never fail the whole roster
    for (const a of list) {
      const key = a.toLowerCase();
      if (!key) continue;
      if (!claims.has(key)) claims.set(key, new Set());
      claims.get(key).add(n);
    }
  }
  const aliases = new Map();
  for (const [key, owners] of claims) {
    if (owners.size !== 1) continue;                 // 1
    if ((counts.get(key) || 0) > 1) continue;        // 2
    const owner = [...owners][0];
    if (fullLower.has(key) && key !== owner.toLowerCase()) continue; // 3
    if (key === owner.toLowerCase()) continue;       // an alias equal to the name adds nothing
    aliases.set(key, owner);
  }

  _roster = { at: Date.now(), full: names, firstNames, aliases };
  return _roster;
}

// Whole-word containment. `includes()` fired "Liam" inside "William" and "Paul"
// inside "Pauline"; \b alone breaks on names like Norman-Swift.
function mentionsName(haystackLower, needleLower) {
  const escaped = needleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(haystackLower);
}

/**
 * Extract entities from text using pattern matching.
 * Fast, local, no API calls — runs on every capture.
 */
function extractEntities(text) {
  const entities = { people: [], tasks: [], decisions: [], mentions: [] };
  const lower = text.toLowerCase();

  // People — full name always, first name only when it's unambiguous.
  // Stores the FULL name: person-detail looks mentions up by full name against
  // an exact-match query, so storing "Hope" meant "Hope Goodall" never matched.
  const roster = getRoster();
  for (const person of roster.full) {
    if (mentionsName(lower, person.toLowerCase()) && !entities.people.includes(person)) {
      entities.people.push(person);
    }
  }
  for (const [first, person] of roster.firstNames) {
    if (entities.people.includes(person)) continue;
    if (mentionsName(lower, first)) entities.people.push(person);
  }
  // Aliases last, and only the unambiguous ones — see getRoster. This is what
  // catches "Seb", "Nath" and the Plaud mis-transcriptions ("Naomi Winkworth"),
  // none of which any filename-derived rule can reach. Stores the FULL name, so
  // a mention resolves onto the real person's page.
  for (const [alias, person] of roster.aliases) {
    if (entities.people.includes(person)) continue;
    if (mentionsName(lower, alias)) entities.people.push(person);
  }

  // Tasks — lines that look like action items
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Checkbox items
    if (/^-?\s*\[\s?\]\s+/.test(trimmed)) {
      entities.tasks.push(trimmed.replace(/^-?\s*\[\s?\]\s+/, '').substring(0, 200));
    }
    // Action language
    if (/^(action|todo|task|follow.?up|reminder)[:\s]/i.test(trimmed)) {
      entities.tasks.push(trimmed.replace(/^(action|todo|task|follow.?up|reminder)[:\s]+/i, '').substring(0, 200));
    }
  }

  // Decisions — explicit markers or decision language
  const decisionPatterns = [
    /\[DECISION[:\]]\s*(.+?)(?:\n|$)/gi,
    /decided (?:to |that )(.+?)(?:\.|$)/gi,
    /decision[:\s]+(.+?)(?:\.|$)/gi,
    /agreed (?:to |that )(.+?)(?:\.|$)/gi,
  ];
  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const d = match[1].trim();
      if (d.length > 5 && d.length < 300) {
        entities.decisions.push(d);
      }
    }
  }

  // Wiki-link mentions [[Note Name]]
  const wikiLinks = text.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const m of wikiLinks) {
    entities.mentions.push(m[1]);
  }

  // Jira ticket references
  const tickets = text.matchAll(/\b([A-Z]{2,}-\d+)\b/g);
  for (const m of tickets) {
    if (!entities.mentions.includes(m[1])) {
      entities.mentions.push(m[1]);
    }
  }

  return entities;
}

/**
 * Process a note — extract entities and save to DB, create links.
 */
function processNote(relativePath) {
  if (!VAULT_PATH) return null;
  const fullPath = path.join(VAULT_PATH, relativePath);
  if (!fs.existsSync(fullPath)) return null;

  let content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); }
  catch { return null; }

  const body = content.replace(/^---[\s\S]*?---\n*/, '');
  if (body.trim().length < 10) return null;

  const entities = extractEntities(body);

  // Clear old entities and links for this path
  db.deleteEntitiesForPath(relativePath);
  db.deleteLinksForPath(relativePath);

  // Save extracted entities
  for (const person of entities.people) {
    db.saveEntity(relativePath, 'person', person, null);
    db.saveLink(relativePath, `People/${person}.md`, person, 'mentions-person');
  }

  for (const task of entities.tasks) {
    db.saveEntity(relativePath, 'task', task, null);
  }

  for (const decision of entities.decisions) {
    db.saveEntity(relativePath, 'decision', decision, null);
  }

  for (const mention of entities.mentions) {
    db.saveEntity(relativePath, 'mention', mention, null);
    // If it looks like a vault path, create a link
    if (!mention.includes('-') || mention.includes('/')) {
      db.saveLink(relativePath, `${mention}.md`, mention, 'wiki-link');
    } else {
      db.saveLink(relativePath, null, mention, 'reference');
    }
  }

  const total = entities.people.length + entities.tasks.length + entities.decisions.length + entities.mentions.length;
  return { relativePath, entities, total };
}

/**
 * Get all notes that mention a person.
 */
function getMentionsOf(personName) {
  const rows = db.getEntitiesByValue(personName);

  // Rows written before the full-name switch hold the first name only. Fold them
  // in where that first name is unambiguous, so person pages aren't blank until
  // the nightly sweep has re-walked every note.
  const first = String(personName || '').split(/\s+/)[0];
  if (first && first !== personName && getRoster().firstNames.get(first.toLowerCase()) === personName) {
    rows.push(...db.getEntitiesByValue(first));
  }

  const paths = rows.filter(e => e.entity_type === 'person').map(e => e.source_path);
  return [...new Set(paths)];
}

/**
 * Get orphan notes — captured notes with no entities extracted and not linked from anywhere.
 */
function getOrphans(daysBack = 7) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const importsDir = path.join(VAULT_PATH, 'Imports');
  if (!fs.existsSync(importsDir)) return [];

  const orphans = [];

  function walk(dir, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        let stat;
        try { stat = fs.statSync(fullPath); }
        catch { continue; }
        if (stat.mtime < cutoff) continue; // older than window

        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        const entities = db.getEntitiesForPath(relativePath);
        const backlinks = db.getBacklinks(relativePath);

        // Orphan = no entities extracted AND no backlinks AND still in Imports
        if (entities.length === 0 && backlinks.length === 0) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const body = content.replace(/^---[\s\S]*?---\n*/, '');
          orphans.push({
            path: relativePath,
            name: entry.name.replace('.md', ''),
            preview: body.substring(0, 120).trim(),
            modified: stat.mtime.toISOString()
          });
        }
      }
    }
  }

  walk(importsDir, 0);
  orphans.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return orphans;
}

/**
 * Drop entity rows for paths the exclude list now keeps out.
 *
 * Skipping them on the walk stops NEW rows; it does nothing about the ones
 * already stored, and nothing else ever deletes them — so without this the
 * export note and the MoSCoW worksheets would keep out-ranking real meetings on
 * every person page indefinitely. Runs at the head of the nightly sweep.
 */
function pruneExcludedEntities() {
  const exclusions = require('./vault-exclusions');
  let pruned = 0;
  const rows = db.all('SELECT DISTINCT source_path FROM extracted_entities');
  for (const row of rows) {
    if (!exclusions.isExcludedPath(row.source_path)) continue;
    db.deleteEntitiesForPath(row.source_path);
    pruned++;
  }
  if (pruned) console.log(`[Entities] Pruned ${pruned} generated/archived files from mentions`);
  return { pruned };
}

/**
 * Batch process — run entity extraction on all recent notes.
 */
function processRecentNotes(daysBack = 7) {
  if (!VAULT_PATH) return { processed: 0 };
  const { pruned } = pruneExcludedEntities();
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const exclusions = require('./vault-exclusions');
  let processed = 0;

  function walk(dir, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclusions.isExcludedDir(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.md')) {
        // Unguarded, this threw ENOENT on a note moved by another automation
        // mid-walk and aborted the WHOLE nightly extraction — one moved file
        // cost a full run. Skip the file, keep the run.
        let stat;
        try { stat = fs.statSync(fullPath); }
        catch { continue; }
        if (stat.mtime < cutoff) continue;

        const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
        // Generated files name everyone — the task export, Master Todo and the
        // MoSCoW worksheets between them put four rows above every real meeting
        // on a person's page, because mentions rank by extracted_at.
        if (exclusions.isExcludedPath(relativePath)) continue;
        const result = processNote(relativePath);
        if (result && result.total > 0) processed++;
      }
    }
  }

  walk(VAULT_PATH, 0);
  return { processed, pruned };
}

module.exports = { extractEntities, processNote, getMentionsOf, getOrphans, processRecentNotes, pruneExcludedEntities, getRoster, readAliases };
