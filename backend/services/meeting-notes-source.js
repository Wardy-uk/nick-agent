'use strict';

/**
 * Meetings Nick actually attended, evidenced by a PLAUD note in the vault.
 *
 * Nick's rule, and it is the right one: **a meeting in the diary does not mean
 * he attended it**. An accepted invite is a plan. Meetings get declined in the
 * moment, run without him, or are sat through while he works on something else,
 * and none of that is finished work. What proves both that he was there and
 * that the meeting was actually PROCESSED is the Plaud note.
 *
 * So this source is driven by the NOTE, not the calendar. The first version was
 * calendar-driven — every accepted, finished, multi-person event counted — and
 * it was wrong twice over: it counted meetings Nick never sat in, and it had a
 * timing hole that would have gone unnoticed. plaud-sync lands a note up to
 * thirty minutes AFTER the meeting, while calendar-sync only ever looks
 * forward; a calendar-time check for a note would have found nothing, never
 * looked again, and said nothing about it.
 *
 * Reading the notes instead fixes all of it, and makes the source a local vault
 * read so `collect()` needs no network at all. The note IS the evidence, which
 * is the rule every row in this ledger follows.
 *
 * The qualifying marks are what plaud-sync actually writes: `plaud_id` (or
 * `source: PLAUD`) plus `type: meeting`. Transcripts are excluded by directory
 * AND by that type check — one meeting leaves both a summary and a transcript,
 * and counting both would double every meeting Nick had.
 */

const fs = require('fs');
const path = require('path');

// Mirrors one-to-one-detect's list, which walks the same tree for the same
// reason. `transcripts` is in here as well as being filtered by `type`, because
// belt and braces on the one failure that would silently double the count.
const EXCLUDE_DIRS = new Set([
  'Archive', 'Recycle Bin', '_toDelete', '_Staging - Keep in Archive',
  'transcripts', '_transcripts', 'Vault Audit', '.lint-backups', '.git',
  '.stversions', '.stfolder',
]);

/**
 * The handful of frontmatter fields this source needs.
 *
 * Line endings are normalised FIRST. The vault is authored on Windows so most
 * notes are CRLF, and `\r` is a line terminator in a JS regex — so an anchored
 * `/^key:\s*(.*)$/` fails on every CRLF line, the parse returns nothing, and the
 * note vanishes from the scan with no error at all. one-to-one-detect learned
 * this the hard way and says so.
 */
function readFrontmatter(raw) {
  const text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

/**
 * Every Plaud meeting note dated in [from, to].
 *
 * Returns `{ rows, error }`. An unreadable vault is an ERROR, never an empty
 * list — "no meetings were held" and "the folder every Plaud note lands in is
 * missing" are different facts, and only one of them is about Nick.
 */
function collectMeetingNotes(from, to, vaultRoot = process.env.OBSIDIAN_VAULT_PATH || '') {
  if (!vaultRoot) return { rows: [], error: 'OBSIDIAN_VAULT_PATH not set' };

  const meetingsDir = path.join(vaultRoot, 'Meetings');
  if (!fs.existsSync(meetingsDir)) {
    return { rows: [], error: 'Meetings/ not found in vault' };
  }

  const rows = [];

  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      const full = path.join(dir, entry.name);
      let fm;
      try { fm = readFrontmatter(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (!fm) continue;

      const isPlaud = Boolean(fm.plaud_id) || String(fm.source || '').toUpperCase() === 'PLAUD';
      if (!isPlaud) continue;
      // The note of record, not its transcript.
      if (String(fm.type || '').toLowerCase() !== 'meeting') continue;

      const date = String(fm.date || '').slice(0, 10)
        || (entry.name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
      if (!date || date < from || date > to) continue;

      const relPath = path.relative(vaultRoot, full).replace(/\\/g, '/');
      rows.push({
        dateKey: date,
        // Midday: date-only arithmetic with no DST edge, the same choice
        // one-to-one-detect makes for exactly this reason.
        occurredAt: new Date(`${date}T12:00:00`),
        source: 'meeting',
        kind: 'meeting_held',
        text: `Meeting: ${fm.title || entry.name.replace(/\.md$/, '')}`,
        evidence: `note:${relPath}`,
        notePath: relPath,
        count: 1,
        // Keyed on the RECORDING, not the path — imports.js re-routes notes into
        // canonical folders, and a moved note must not count a second time.
        dedupeKey: `meeting:${fm.plaud_id || relPath}`,
      });
    }
  };

  walk(meetingsDir, 0);
  return { rows, error: null };
}

module.exports = { collectMeetingNotes, readFrontmatter, EXCLUDE_DIRS };
