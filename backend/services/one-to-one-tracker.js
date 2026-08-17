'use strict';

/**
 * `Areas/1-2-1 Tracker.md` — generated, not hand-maintained (#31).
 *
 * The tracker called itself "single source of truth for 1-2-1 cadence" and
 * "read by Morning Standup". Both were false: nothing in NEURO has ever parsed
 * it, and it had been frozen since `last-reviewed: 2026-04-02` — every Next Due
 * four months past, and still listing Arman (left the business) and Willem
 * (moved teams). Its disagreement with the People notes is what started the
 * 14 Aug audit in the first place.
 *
 * `one-to-one-detect` now derives the dates from the meeting notes, so the
 * table is rendered from that rather than typed. Leaving a hand-maintained copy
 * alive beside a derived one is how the original problem happened.
 *
 * Three rules, all borrowed from things this repo already learned:
 *
 *  - SURGICAL, between markers, like vault-hygiene's `<!-- ctx-links -->`. Only
 *    the table is generated. Cadence Rules, the Status Key, "How to use this",
 *    Open Actions and Related are Nick's editorial and are never touched —
 *    same rule as `feature-tracker` never reordering the ranked sections.
 *  - It renders only what NEURO can KNOW. The old table had "Invite Sent?" and
 *    "PeopleHR Updated?" columns; NEURO has no view of either, and generating
 *    them as ❌ would state a fact it has not checked. They are dropped, and the
 *    file says so rather than quietly losing them.
 *  - DRY-RUN BY DEFAULT, backing up every touched file, like every other
 *    mutating vault path here.
 *
 * `buildTable` is pure and takes plain objects, so the rendering is testable
 * without a vault — the same split as `pi-health.assess()` and `cadenceState()`.
 */

const fs = require('fs');
const path = require('path');

const teamRoster = require('./team-roster');
const detect = require('./one-to-one-detect');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
const TRACKER_REL = 'Areas/1-2-1 Tracker.md';
const BACKUP_REL = 'Scripts/.lint-backups';

const START = '<!-- neuro:1-2-1-tracker -->';
const END = '<!-- /neuro:1-2-1-tracker -->';

/** Today, local. Never toISOString() — the Pi may run UTC (see CLAUDE.md). */
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// What each cadenceState means to a human reading the table. The words come
// from the state machine rather than being re-derived, so the tracker, the
// board and the nudge cannot drift apart on what "overdue" means.
const STATE_LABEL = {
  booked: (s) => `📅 Booked ${s.booked}`,
  unwritten: (s) => `✍️ Held ${s.booked}, not written up`,
  overdue: (s) => `⚠️ Overdue by ${s.daysOverdue}d`,
  'due-soon': (s) => `⏳ Due in ${s.daysUntil}d`,
  ok: (s) => (s.nextDue ? `✅ Due ${s.nextDue}` : '—'),
};

function _escapeCell(v) {
  // A role or note containing a pipe would silently break the table row.
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Render the tracker table.
 *
 * Pure: takes people already read and a date, returns markdown. `people` are
 * `team-roster` shapes; ordering is worst-first so the table opens on whoever
 * has waited longest, matching how the board ranks.
 */
function buildTable(people, today = todayStr()) {
  const rows = (people || []).map(p => {
    const bookable = String(p.cadence || '').toLowerCase() !== 'none'
      && String(p.cadence || '').toLowerCase() !== 'n/a'
      && Boolean(p.cadence);
    const state = detect.cadenceState({
      lastHeld: p.last121 || null,
      nextDue: p.next121Due || null,
      booked: p.booked121 || null,
      bookable,
    }, today);
    return { person: p, state, bookable };
  });

  // Worst first: overdue (longest), then unwritten, due-soon, booked, ok.
  const RANK = { overdue: 0, unwritten: 1, 'due-soon': 2, booked: 3, ok: 4 };
  rows.sort((a, b) => {
    const r = (RANK[a.state.state] ?? 9) - (RANK[b.state.state] ?? 9);
    if (r !== 0) return r;
    if (a.state.state === 'overdue') return (b.state.daysOverdue || 0) - (a.state.daysOverdue || 0);
    return a.person.name.localeCompare(b.person.name);
  });

  const lines = [
    '| Person | Team | Cadence | Last 1-2-1 | Next Due | State |',
    '|--------|------|---------|------------|----------|-------|',
  ];
  for (const { person, state, bookable } of rows) {
    const label = bookable
      ? (STATE_LABEL[state.state] || STATE_LABEL.ok)(state)
      : `— ${_escapeCell(person.status) || 'no cadence'}`;
    lines.push([
      `[[People/${person.name}\\|${person.name}]]`,
      _escapeCell(person.group),
      _escapeCell(person.cadence || '—'),
      _escapeCell(person.last121 || '—'),
      _escapeCell(person.next121Due || '—'),
      label,
    ].map(c => ` ${c} `).join('|').replace(/^/, '|') + '|');
  }

  if (!rows.length) {
    // Never render an empty table that looks like "nobody reports to Nick".
    lines.length = 0;
    lines.push('> ⚠️ No direct reports could be read from `People/`. This is a', '> read failure, not an empty team — the table below was left unwritten.');
  }

  const counts = rows.reduce((acc, r) => {
    acc[r.state.state] = (acc[r.state.state] || 0) + 1;
    return acc;
  }, {});
  const summary = ['overdue', 'unwritten', 'due-soon', 'booked']
    .filter(k => counts[k])
    .map(k => `${counts[k]} ${k}`)
    .join(', ');

  return [
    START,
    '',
    `*Generated by NEURO on ${today} from \`People/\` frontmatter and the meeting notes.*`,
    '*Do not edit this table by hand — it is rewritten nightly and your changes will be lost.*',
    summary ? `*${rows.length} reports — ${summary}.*` : `*${rows.length} reports — all on track.*`,
    '',
    ...lines,
    '',
    END,
  ].join('\n');
}

function _backup(absPath, stamp) {
  try {
    const dir = path.join(VAULT_PATH(), BACKUP_REL, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(absPath, path.join(dir, path.basename(absPath)));
    return `${BACKUP_REL}/${stamp}/${path.basename(absPath)}`;
  } catch (e) {
    return null;
  }
}

/**
 * Splice the generated table into the existing note.
 *
 * Pure so the marker handling is testable. On a first run — no markers yet —
 * the block replaces the legacy `## Tracker` table and nothing else. Returns
 * null when there is nothing to change, so an unchanged run writes no file and
 * does not churn the mtime (which would drag the note into every "recently
 * modified" scan, the #78 lesson).
 */
function spliceTable(source, table) {
  const text = String(source || '').replace(/\r\n/g, '\n');

  let next;
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    next = text.slice(0, s) + table + text.slice(e + END.length);
  } else {
    // First run: replace the legacy table under `## Tracker`, which runs until
    // the next heading or `---` rule. Anchored on the heading rather than on
    // "the first table" — Cadence Rules is also a table and comes first.
    const m = text.match(/^##\s+Tracker\s*$/m);
    if (!m) return null;
    const from = m.index + m[0].length;
    const rest = text.slice(from);
    const stop = rest.search(/^(?:##\s|---\s*$)/m);
    const tail = stop === -1 ? '' : rest.slice(stop);
    next = `${text.slice(0, from)}\n\n${table}\n\n${tail}`;
  }

  next = next.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n');
  return next === text ? null : next;
}

/**
 * Regenerate the tracker.
 *
 * Dry-run by default: `apply: true` is what writes. Mirrors every other
 * mutating vault path here (vault-hygiene, restamp-people, the migration).
 */
function render({ apply = false, today = todayStr() } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { ok: false, error: 'OBSIDIAN_VAULT_PATH not configured' };

  const people = teamRoster.directReports();
  if (!people.length) {
    // Refuse rather than write a table saying Nick has no reports. A read
    // failure and an empty team are different facts.
    return { ok: false, error: 'No direct reports readable from People/ — refusing to write an empty tracker' };
  }

  const abs = path.join(vault, TRACKER_REL);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    return { ok: false, error: `Cannot read ${TRACKER_REL}: ${e.message}` };
  }

  const table = buildTable(people, today);
  const next = spliceTable(source, table);
  if (next === null) {
    return { ok: true, changed: false, people: people.length, reason: 'already current, or no ## Tracker heading to replace' };
  }

  if (!apply) {
    return { ok: true, changed: true, dryRun: true, people: people.length, preview: table };
  }

  const stamp = `${today}-121-tracker`;
  const backup = _backup(abs, stamp);
  fs.writeFileSync(abs, next, 'utf-8');
  return { ok: true, changed: true, dryRun: false, people: people.length, backup, path: TRACKER_REL };
}

module.exports = {
  render,
  buildTable,
  spliceTable,
  TRACKER_REL,
  START,
  END,
  _internals: { todayStr, _escapeCell },
};
