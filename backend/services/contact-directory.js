'use strict';

/**
 * Name → email resolution for meeting invites.
 *
 * "abdi" has to become an address before Graph will invite anyone, and there was
 * no such mapping anywhere in NEURO. Three sources, in trust order:
 *
 *   1. People/*.md frontmatter `email:` — Nick-controlled, always wins.
 *   2. Senders already seen in the triaged inbox — free, no extra Graph call.
 *   3. Graph /me/people search — the org directory (needs People.Read).
 *
 * Nothing here guesses: a name that resolves to more than one address, or to
 * none, comes back unresolved so the composer can ask rather than invite the
 * wrong person. Local sources are cached in memory for 5 minutes.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const obsidian = require('./obsidian');
const microsoft = require('./microsoft');

const CACHE_TTL = 5 * 60 * 1000;
let _cache = { at: 0, contacts: [] };

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, '').replace(/\s+/g, ' ').trim();
}

// People notes: filename is the display name, `email:` in frontmatter is the address.
function fromPeopleNotes() {
  const dir = path.join(VAULT_PATH(), 'People');
  if (!VAULT_PATH() || !fs.existsSync(dir)) return [];

  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    try {
      const fm = obsidian.parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf-8')) || {};
      const email = String(fm.email || '').trim().replace(/^["']|["']$/g, '');
      if (email && email.includes('@')) out.push({ name, email, source: 'vault' });
    } catch { /* unreadable note — skip, never fail the whole lookup */ }
  }
  return out;
}

// Everyone who has emailed Nick recently is already sitting in the triage blob.
function fromTriagedInbox() {
  let stored = [];
  try {
    stored = JSON.parse(db.getState('email_triage') || '[]');
  } catch { return []; }

  const seen = new Set();
  const out = [];
  for (const item of stored) {
    const email = String(item?.fromEmail || '').trim().toLowerCase();
    const name = String(item?.from || '').trim();
    if (!email || !email.includes('@') || !name || name === email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name, email, source: 'inbox' });
  }
  return out;
}

function localContacts() {
  if (Date.now() - _cache.at < CACHE_TTL) return _cache.contacts;

  const merged = [];
  const byEmail = new Map();
  // People notes first so they win on duplicate addresses.
  for (const c of [...fromPeopleNotes(), ...fromTriagedInbox()]) {
    const key = c.email.toLowerCase();
    if (byEmail.has(key)) continue;
    byEmail.set(key, c);
    merged.push(c);
  }

  _cache = { at: Date.now(), contacts: merged };
  return merged;
}

function invalidate() {
  _cache = { at: 0, contacts: [] };
}

/**
 * An alias from a People note, resolved to the canonical full name (#38).
 *
 * The map comes from `entities.getRoster()` rather than being re-derived here —
 * one place decides what an alias means, so the roster and the directory cannot
 * drift apart on it. It contains ONLY aliases that point at exactly one person:
 * `Chris` is claimed by both Chris Middleton and Chris Smith and so is absent,
 * which is why this can never loosen matching. What it adds is the deliberate
 * short forms a filename cannot express (`Seb`, `Nath`, `Steve R`) and the Plaud
 * mis-transcriptions (`Naomi Winkworth`).
 */
function aliasTarget(normalisedQuery) {
  try {
    const { aliases } = require('./entities').getRoster();
    return aliases.get(normalisedQuery) || null;
  } catch {
    return null; // no vault, unreadable People/ — fall through to the other tiers
  }
}

// Everyone in People/ whose FIRST name is this. Used to spot an ambiguity that
// the contact list cannot see, because it only holds people with an address.
function rosterNamesByFirstName(normalisedQuery) {
  if (!normalisedQuery || normalisedQuery.includes(' ')) return [];
  try {
    const { full } = require('./entities').getRoster();
    return full.filter((n) => normalise(n).split(' ')[0] === normalisedQuery);
  } catch {
    return [];
  }
}

// Exact full name, then first name, then "starts with" — most specific wins, and
// we never fall through to a looser tier once a tighter one has matched.
function matchLocal(query, contacts) {
  const q = normalise(query);
  if (!q) return [];

  const tiers = [
    (c) => normalise(c.name) === q,
    (c) => normalise(c.name).split(' ')[0] === q,
    (c) => normalise(c.name).split(' ').some((part) => part === q),
    (c) => normalise(c.name).startsWith(q),
    (c) => c.email.toLowerCase().split('@')[0].replace(/[._-]/g, ' ').split(' ').includes(q),
  ];

  for (const tier of tiers) {
    const hits = contacts.filter(tier);
    if (hits.length) return hits;
  }
  return [];
}

/**
 * Resolve one name.
 * → { query, status: 'resolved'|'ambiguous'|'unresolved', email?, name?, source?, candidates? }
 */
async function resolveName(query) {
  const raw = String(query || '').trim();
  if (!raw) return { query: raw, status: 'unresolved', candidates: [] };

  // Already an address — nothing to resolve.
  if (raw.includes('@')) {
    return { query: raw, status: 'resolved', name: raw, email: raw, source: 'literal' };
  }

  // Canonicalise through the alias map BEFORE matching, rather than adding an
  // alias tier to matchLocal (#38). A tier can be silently overruled: `Nath` is
  // Nathan Button's alias, Nathan Button has no `email:` so he is not in
  // contacts at all, the alias tier therefore matched nothing — and execution
  // fell through to the "starts with" tier, which happily returned Nathan
  // RUTLAND. A precise rule that degrades into a fuzzy one is worse than no rule,
  // because it is confidently wrong about which of two colleagues you meant.
  //
  // Canonicalising up front means an alias decides WHO, once, and every tier
  // below is then matching that person's real name. It also sends the right
  // name to Graph: searching the org directory for "Nath" is a guess, searching
  // for "Nathan Button" is not.
  const canonical = aliasTarget(normalise(raw));

  // A name the ROSTER knows is ambiguous must not resolve, even when only one of
  // the candidates happens to have an address. `localContacts()` is built from
  // notes carrying `email:`, so it cannot see the ambiguity at all: both Nathans
  // exist in People/, only Rutland has an address, and asking for "Nathan"
  // therefore resolved confidently to him. The contact list is the wrong place
  // to ask "how many people are called this" — the roster is.
  if (!canonical) {
    const sameFirst = rosterNamesByFirstName(normalise(raw));
    if (sameFirst.length > 1) {
      return {
        query: raw,
        status: 'ambiguous',
        candidates: sameFirst.map((name) => ({ name, source: 'vault' })),
      };
    }
  }

  const term = canonical || raw;

  let hits = matchLocal(term, localContacts());

  // Nothing locally — ask the org directory.
  if (!hits.length) {
    try {
      hits = await microsoft.searchPeople(term);
    } catch { hits = []; }
  }

  // Dedupe by address: the same person often appears in two sources.
  const seen = new Set();
  const unique = hits.filter((h) => {
    const key = String(h.email || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 1) {
    return { query: raw, status: 'resolved', ...unique[0] };
  }
  // `aliasOf` carries WHO the alias named even when no address was found, so a
  // caller can say "Nathan Button — no address on file" instead of the bare
  // "couldn't resolve Nath". Deliberately not `name`: that means "the matched
  // contact" on a resolved result, and reusing it here would let a caller read
  // an unresolved answer as a resolved one.
  const aliasOf = canonical ? { aliasOf: canonical } : {};
  if (unique.length > 1) {
    return { query: raw, status: 'ambiguous', candidates: unique.slice(0, 5), ...aliasOf };
  }
  return { query: raw, status: 'unresolved', candidates: [], ...aliasOf };
}

async function resolveNames(names = []) {
  return Promise.all(names.map(resolveName));
}

/**
 * Learn an address Nick typed in by hand, by writing it back to the People note.
 *
 * The loop this closes: the directory could not resolve a name, Nick supplied
 * the address, and NEURO threw that knowledge away the moment the action was
 * sent — so the next chase to the same person asked him again. 26 of 41 People
 * notes carry no `email:`, so "the directory could not resolve it" is the normal
 * case, not an edge one.
 *
 * Three rules, and the first is the one that would quietly corrupt the vault:
 *
 *   1. NEVER `obsidian.updateFrontmatter`. Its line-based reserialise drops list
 *      values, and People notes carry `aliases:` lists — 30 of them. Writing an
 *      address through it would silently delete the alias map that #38 just made
 *      load-bearing. This edits the single `email:` line by hand, exactly as
 *      `restampMeetingPeople` rewrites only the `people:` block.
 *   2. A hand-typed address is evidence, not gospel: it is written when the note
 *      has none, and an EXISTING address is never overwritten. Nick correcting a
 *      one-off recipient must not silently retarget every future message to that
 *      person; a genuine change is a deliberate edit to the note.
 *   3. Only ever a real person on the roster. An address typed for someone with
 *      no People note creates nothing — inventing notes is `people-gap`'s job,
 *      behind its own review step.
 *
 * Backs the file up before touching it, like every other vault write here.
 * Returns a reason rather than throwing: this runs AFTER the useful work, and a
 * bookkeeping failure must never fail the caller (#69's rule).
 */
function learnEmail(personName, email) {
  const name = String(personName || '').trim();
  const addr = String(email || '').trim();
  if (!name || !addr.includes('@')) return { ok: false, reason: 'bad-input' };

  const dir = path.join(VAULT_PATH(), 'People');
  if (!VAULT_PATH() || !fs.existsSync(dir)) return { ok: false, reason: 'no-vault' };

  // Resolve to a real note — accept an alias, refuse anything ambiguous.
  let target = null;
  try {
    const { full, aliases } = require('./entities').getRoster();
    const q = normalise(name);
    target = full.find((n) => normalise(n) === q) || aliases.get(q) || null;
  } catch { return { ok: false, reason: 'no-roster' }; }
  if (!target) return { ok: false, reason: 'no-person-note' };

  const file = path.join(dir, `${target}.md`);
  let src;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return { ok: false, reason: 'unreadable' }; }

  // Mixed CRLF/LF vault — normalise before anything line-anchored, then write
  // back with the line ending the file already used.
  const crlf = src.includes('\r\n');
  const text = src.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, reason: 'no-frontmatter' };

  const lines = fm[1].split('\n');
  const idx = lines.findIndex((l) => /^email:/.test(l));
  if (idx >= 0 && lines[idx].slice(lines[idx].indexOf(':') + 1).trim().includes('@')) {
    return { ok: false, reason: 'already-set' }; // rule 2 — never overwrite
  }

  if (idx >= 0) lines[idx] = `email: ${addr}`;
  else lines.push(`email: ${addr}`);

  const updated = text.replace(fm[0], `---\n${lines.join('\n')}\n---`);
  const out = crlf ? updated.replace(/\n/g, '\r\n') : updated;

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(VAULT_PATH(), 'Scripts', '.lint-backups', stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, `${target}.md`), src);
    fs.writeFileSync(file, out);
  } catch (e) {
    return { ok: false, reason: `write-failed: ${e.message}` };
  }

  invalidate();                                  // the address is usable immediately
  return { ok: true, person: target, email: addr };
}

module.exports = {
  resolveName,
  resolveNames,
  localContacts,
  invalidate,
  learnEmail,
};
