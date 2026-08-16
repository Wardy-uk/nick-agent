'use strict';

/**
 * Feature capture — the backlog gets a front door.
 *
 * `Projects/NEURO/NEURO Feature Tracker.md` is where the NEURO/SARA/NOVA backlog
 * lives, and until now the only way into it was a Claude session editing the file
 * by hand. So an idea Nick had on the train either survived until the next session
 * or it didn't. Everything else he thinks of has a capture route; the backlog is
 * the one that didn't, which is why it kept getting re-derived from handoffs.
 *
 * Append-only and surgical, like the vault-hygiene writers: one table row into one
 * section, plus the `updated:` stamp. It never rewrites a row, never renumbers, and
 * never touches the ranked sections above — those are Nick's editorial, and a
 * capture route that reorders his priorities is worse than no capture route.
 *
 * Numbering is `max(existing) + 1` rather than a count: the file already has a
 * duplicate #103, and a count would have silently minted a third.
 */

const fs = require('fs');
const path = require('path');

const TRACKER_REL = path.join('Projects', 'NEURO', 'NEURO Feature Tracker.md');

/** Where new items land. Created on first capture if it isn't there. */
const SECTION = '## Captured — raised in passing';
const SECTION_BLURB =
  'Raised from chat or Capture as they came up, rather than waiting for a session to\n' +
  'write them down. Unranked and unedited — triage moves them into the sections above.';
const TABLE_HEAD = '| # | Feature | System | Status | Notes |\n|---|---|---|---|---|';

const SYSTEMS = ['NEURO', 'SARA', 'NOVA', 'Both'];

function trackerPath() {
  if (process.env.NEURO_TRACKER_PATH) return process.env.NEURO_TRACKER_PATH;
  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vault) return null;
  return path.join(vault, TRACKER_REL);
}

/** "15 Aug" — local getters, never toISOString(). */
function stamp(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function isoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Highest item number anywhere in the file, +1. */
function nextNumber(text) {
  let max = 0;
  for (const m of text.matchAll(/^\|\s*(\d+)\s*\|/gm)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max + 1;
}

/** A table cell cannot contain a raw pipe or a newline. */
function cell(value) {
  return String(value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Bump the frontmatter `updated:` so the note doesn't claim to be older than it is. */
function restamp(text, today) {
  const end = text.indexOf('\n---', 4);
  if (!text.startsWith('---') || end === -1) return text;
  const head = text.slice(0, end);
  if (!/^updated:/m.test(head)) return text;
  return head.replace(/^updated:.*$/m, `updated: ${today}`) + text.slice(end);
}

/**
 * Bounds of the capture section — `[start, end)`, or null if it isn't there yet.
 * The section runs to the next heading of the same level, or to EOF.
 */
function sectionBounds(text) {
  const at = text.indexOf(SECTION);
  if (at === -1) return null;
  const rest = text.slice(at + SECTION.length);
  const nextHeading = rest.search(/\n## /);
  return { start: at, end: nextHeading === -1 ? text.length : at + SECTION.length + nextHeading };
}

/**
 * Insert `row` at the end of the capture section's table, creating the section
 * (above `## Related`, or at the end) the first time.
 */
function insertRow(text, row) {
  const bounds = sectionBounds(text);
  if (!bounds) {
    const block = `${SECTION}\n\n${SECTION_BLURB}\n\n${TABLE_HEAD}\n${row}\n\n---\n\n`;
    const related = text.indexOf('\n## Related');
    if (related === -1) return `${text.replace(/\s+$/, '')}\n\n---\n\n${block.replace(/\s+$/, '')}\n`;
    return `${text.slice(0, related + 1)}${block}${text.slice(related + 1)}`;
  }

  const { start: at, end: bodyEnd } = bounds;
  const body = text.slice(at, bodyEnd);
  // Land immediately after the last table row, so a trailing `---` or a note
  // under the table stays under it.
  const rows = [...body.matchAll(/^\|.*\|\s*$/gm)];
  if (!rows.length) {
    return `${text.slice(0, bodyEnd).replace(/\s+$/, '')}\n\n${TABLE_HEAD}\n${row}\n${text.slice(bodyEnd)}`;
  }
  const last = rows[rows.length - 1];
  const cut = at + last.index + last[0].length;
  return `${text.slice(0, cut)}\n${row}${text.slice(cut)}`;
}

/**
 * Capture a feature idea into the tracker.
 * Returns `{ ok, number, row, path }`, or `{ ok:false, error }` — never throws for
 * a caller's benefit, because both callers (chat tool, capture route) report the
 * reason rather than failing blind.
 */
function captureFeature({ title, notes, system, source } = {}) {
  const text = String(title || '').trim();
  if (!text) return { ok: false, error: 'title is required' };

  const file = trackerPath();
  if (!file) return { ok: false, error: 'Vault path not configured — cannot reach the tracker' };
  if (!fs.existsSync(file)) return { ok: false, error: `Tracker not found at ${file}` };

  const sys = SYSTEMS.find(s => s.toLowerCase() === String(system || '').trim().toLowerCase()) || 'NEURO';
  const today = new Date();
  const contents = fs.readFileSync(file, 'utf8');
  const number = nextNumber(contents);

  const note = cell(notes) || '_Captured with no detail — needs a sentence on why before it can be ranked._';
  const via = source ? ` (via ${cell(source)})` : '';
  const row = `| ${number} | **${cell(text)}** | ${sys} | **Captured ${stamp(today)}** | ${note}${via} |`;

  const updated = restamp(insertRow(contents, row), isoDate(today));
  fs.writeFileSync(file, updated, 'utf8');

  try { require('./vault-hooks').onVaultWrite(file, 'feature-capture'); } catch {}

  console.log(`[FeatureTracker] Captured #${number}: ${text}`);
  return { ok: true, number, row, path: file, system: sys };
}

/**
 * Parse the rows of the capture section back out (#114).
 *
 * Capture writes into the tracker from chat and from both Capture surfaces, and
 * until now nothing read it back — the only way to see what you had captured was
 * to open the file. Same built-but-unreachable shape as #96/#97, one layer down:
 * the write landed and the read had nowhere to happen.
 *
 * Scoped to the capture section ON PURPOSE. The ranked sections above it are
 * Nick's editorial and run to well over a hundred rows; listing those here would
 * make this a second, worse view of the tracker instead of an answer to "did that
 * thing I said on the train actually land". Newest first, because that is the
 * question being asked.
 *
 * Read-only, and it never throws — an empty tracker and an unreachable one are
 * different answers (#28) and both are reported as such.
 */
function listCaptured({ limit = 5 } = {}) {
  const file = trackerPath();
  if (!file) return { ok: false, error: 'Vault path not configured — cannot reach the tracker', items: [], total: 0 };
  if (!fs.existsSync(file)) return { ok: false, error: `Tracker not found at ${file}`, items: [], total: 0 };

  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }
  catch (e) { return { ok: false, error: `Could not read the tracker: ${e.message}`, items: [], total: 0 }; }

  const bounds = sectionBounds(text);
  // No section yet is not a failure — nothing has been captured. Working and
  // waiting, which is a different thing from broken.
  if (!bounds) return { ok: true, items: [], total: 0, path: file };

  const body = text.slice(bounds.start, bounds.end);
  const items = [];
  for (const line of body.split('\n')) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length < 4) continue;
    if (!/^\d+$/.test(cells[0])) continue;          // skips the header and its ---- rule
    items.push({
      number: Number(cells[0]),
      title: cells[1].replace(/\*\*/g, '').trim(),
      system: cells[2],
      status: cells[3].replace(/\*\*/g, '').trim(),
      notes: (cells[4] || '').trim(),
    });
  }

  // Newest first. Sorting by NUMBER rather than trusting file order, because
  // numbering is max+1 and the file is known to contain duplicates — but file
  // order is the tie-break, so two rows sharing a number keep their real order.
  const ordered = items.map((it, i) => ({ it, i }))
    .sort((a, b) => (b.it.number - a.it.number) || (b.i - a.i))
    .map(x => x.it);

  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 5;
  return { ok: true, items: ordered.slice(0, take), total: ordered.length, path: file };
}

module.exports = {
  captureFeature, listCaptured, nextNumber, insertRow, sectionBounds, trackerPath, SECTION, SYSTEMS,
};
