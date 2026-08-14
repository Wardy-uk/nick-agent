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

  let hits = matchLocal(raw, localContacts());

  // Nothing locally — ask the org directory.
  if (!hits.length) {
    try {
      hits = await microsoft.searchPeople(raw);
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
  if (unique.length > 1) {
    return { query: raw, status: 'ambiguous', candidates: unique.slice(0, 5) };
  }
  return { query: raw, status: 'unresolved', candidates: [] };
}

async function resolveNames(names = []) {
  return Promise.all(names.map(resolveName));
}

module.exports = {
  resolveName,
  resolveNames,
  localContacts,
  invalidate,
};
