'use strict';

/**
 * Who works for Nick — read from `People/` frontmatter, never typed into an array.
 *
 * #13 was filed as "seed.js hardcodes a departed employee". Measured, the same
 * roster was typed out in SIX places: `team-health.TEAMS`, `email-priority.
 * DIRECT_REPORTS`, `meeting-prep-view.TEAM_MEMBERS`, `ChatPanel.detectPersonDraft`,
 * the chat SYSTEM_PROMPT, and the kiosk seed fixture. CLAUDE.md already says
 * "`People/*.md` filenames ARE the roster; nothing hardcodes a name list" —
 * `entities.getRoster()` was built on exactly that rule in August. These six
 * predate it and never moved.
 *
 * They had drifted in FOUR ways, only one of which the ticket knew about:
 *   - Arman Shazad left the business (`archived: true`, 14 Aug)
 *   - Willem Kruger moved to another team (`archived: true`)
 *   - Nathan Rutland was listed 2nd Line; the vault says 1st Line
 *   - Sebastian Broome was listed 1st Line; the vault says 2nd Line
 * The vault was RIGHT about all four. Only the code was wrong, which is the
 * whole argument for deriving it: a note gets updated when something happens to
 * a person, an array only gets updated when someone remembers it exists.
 *
 * `entities.getRoster()` is deliberately NOT enough on its own. It answers "is
 * this a name NEURO knows" across all 41 notes — which includes Nick's manager,
 * other departments and externals. "Is this one of Nick's people, and on which
 * team" is a different question and only the frontmatter answers it.
 *
 * Read-only, no DB, and every accessor degrades to empty rather than throwing —
 * this is required at module load by the chat prompt, and `npm test` runs with
 * no vault at all (#119).
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

// Same 5-minute TTL as `entities.getRoster()` for the same reason: this is hit
// per-attendee in meeting prep and per-sender in email triage.
const TTL_MS = 5 * 60 * 1000;
let _cache = { at: 0, vault: null, people: [] };

/**
 * (team, line) → the display label the UI already uses.
 *
 * A map of CATEGORIES, not of people, and that distinction is the point: a team
 * does not leave the business, so this cannot rot the way a name list does.
 * It exists only so fixing the roster does not silently rename three headings
 * in the People board.
 *
 * An unmapped combination falls back to the vault's own words rather than being
 * dropped — a new team must show up as itself, not vanish. Dropping is how a
 * roster silently under-reports, which is the bug one level up.
 */
const GROUP_LABELS = {
  'support|2nd line': '2nd Line Technical Support',
  'support|1st line': '1st Line Customer Care',
  'production|production': 'Digital Design',
};

/**
 * Minimal frontmatter read.
 *
 * Deliberately not `obsidian.parseFrontmatter`: this module is required at
 * module-load time by the chat prompt, and pulling in the whole vault service
 * for six scalar fields is a require cycle waiting to happen.
 *
 * Vault notes are mixed CRLF/LF — normalise BEFORE any line-anchored parsing or
 * `\r` (a JS line terminator) silently defeats every match (mistakes.md, 14 Aug).
 * Only scalars are read here; no consumer needs a list field.
 */
function _frontmatter(src) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    // Skip list items and continuations — a nested value is not a scalar.
    if (!line || /^[\s-]/.test(line)) continue;
    const i = line.indexOf(':');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function _truthy(v) {
  return String(v || '').trim().toLowerCase() === 'true';
}

function _groupLabel(team, line) {
  const key = `${String(team || '').trim().toLowerCase()}|${String(line || '').trim().toLowerCase()}`;
  if (GROUP_LABELS[key]) return GROUP_LABELS[key];
  const t = String(team || '').trim();
  const l = String(line || '').trim();
  if (t && l && l.toLowerCase() !== t.toLowerCase()) return `${t} — ${l}`;
  return t || l || 'Unassigned';
}

/**
 * Every People note, parsed. Cached, and keyed on the vault path so a test
 * pointing at a fixture is never served the live vault's cache.
 */
function readPeople({ force = false } = {}) {
  const vault = VAULT_PATH();
  const fresh = _cache.at && (Date.now() - _cache.at < TTL_MS) && _cache.vault === vault;
  if (!force && fresh) return _cache.people;

  let people = [];
  try {
    const dir = path.join(vault, 'People');
    people = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => {
        const name = f.slice(0, -3);
        let fm = {};
        try { fm = _frontmatter(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { /* unreadable note */ }
        return {
          name,
          role: fm.role || '',
          team: fm.team || '',
          line: fm.line || '',
          email: fm.email || '',
          status: fm.status || '',
          cadence: fm.cadence || '',
          directReport: _truthy(fm['direct-report']),
          archived: _truthy(fm.archived),
          archivedReason: fm['archived-reason'] || '',
          group: _groupLabel(fm.team, fm.line),
        };
      });
  } catch {
    // No vault (tests, or a Syncthing hiccup). Empty, never a guess — an
    // invented roster is worse than no roster.
    people = [];
  }

  _cache = { at: Date.now(), vault, people };
  return people;
}

/**
 * Nick's current direct reports.
 *
 * `archived` is the exclusion, NOT `direct-report: false` alone — Arman is
 * marked both, but the pair is what proves the note was maintained after he
 * left rather than merely never set. Measured 17 Aug: 13 live, 2 archived.
 */
function directReports() {
  return readPeople().filter(p => p.directReport && !p.archived);
}

/** Anyone who reports to Nick, including those who have left. */
function formerReports() {
  return readPeople().filter(p => p.archived && (p.directReport || p.team));
}

/** `{ 'Team label': ['Name', ...] }` over the live reports, in name order. */
function teams() {
  const out = {};
  for (const p of directReports().slice().sort((a, b) => a.name.localeCompare(b.name))) {
    (out[p.group] = out[p.group] || []).push(p.name);
  }
  return out;
}

/** Team labels only — what the board offers as filters. */
function teamNames() {
  return Object.keys(teams()).sort();
}

function isDirectReport(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  return directReports().some(p => p.name.toLowerCase() === key);
}

/**
 * First names that identify exactly one LIVE direct report.
 *
 * Same precision rule as `entities.getRoster().firstNames` and for the same
 * reason: matching a bare first name put one Lucy's 16 commitments on four
 * different Lucys (mistakes.md, 15 Aug). Ambiguity is resolved against the
 * WHOLE roster, not just the reports — "Nathan" is unusable because Nathan
 * Button exists, even though only Nathan Rutland reports to Nick.
 */
function reportFirstNames() {
  const everyone = readPeople();
  const counts = new Map();
  for (const p of everyone) {
    const first = p.name.split(/\s+/)[0].toLowerCase();
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  const out = new Map();
  for (const p of directReports()) {
    const first = p.name.split(/\s+/)[0].toLowerCase();
    if (counts.get(first) === 1) out.set(first, p.name);
  }
  return out;
}

/**
 * The roster block for the chat system prompt.
 *
 * Returns '' when the vault is unreadable, so the prompt simply omits the
 * section. Telling the model "the roster is unavailable" spends tokens on
 * nothing, and naming anyone at all would be the invented-roster failure this
 * module exists to end.
 */
function promptBlock() {
  const grouped = teams();
  const labels = Object.keys(grouped).sort();
  if (!labels.length) return '';
  return ["## Nick's direct reports"]
    .concat(labels.map(l => `${l}: ${grouped[l].join(', ')}`))
    .join('\n');
}

module.exports = {
  readPeople,
  directReports,
  formerReports,
  teams,
  teamNames,
  isDirectReport,
  reportFirstNames,
  promptBlock,
  GROUP_LABELS,
  _internals: { _frontmatter, _groupLabel, _truthy },
};
