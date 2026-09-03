'use strict';

/**
 * 1-2-1 write-back — what NOVA agreed, written into the vault.
 *
 * The other half of `nova-121-sync`. That pushes bookings out to NOVA so the 1-2-1 gets
 * prepped; this brings the finished conversation back so the People card, the actions and
 * the tracker know it happened. Until it existed the loop dead-ended in NOVA's
 * `agent_121_actions` table: commitments made in a 1-2-1 were invisible to the vault, to
 * `find_action_items`, and to Nick everywhere except one screen.
 *
 * NEURO does the writing, not NOVA. NOVA prod runs on BYM-AAPP01 and cannot see the
 * vault at all — it lives on Nick's machine and the Pi over Syncthing — and NEURO already
 * owns every vault-mutation path plus the nightly tracker regeneration. A second writer
 * to files NEURO rewrites each night is a race with no upside.
 *
 * Three rules, all borrowed from what this repo already learned the hard way:
 *
 *  - `last-1-2-1` moves ONLY on evidence the meeting happened. The vault's own detector
 *    uses a written-up note; NOVA's `completed_at` is the same standard reached a
 *    different way — Nick sat in the click-through and finished it. A booking that simply
 *    passed still reads as `unwritten`, which is correct.
 *  - SURGICAL, between markers, like the tracker and vault-hygiene. Only the generated
 *    actions block is touched; everything else on the card is Nick's editorial.
 *  - DRY-RUN BY DEFAULT, backing up every file it writes.
 *
 * Idempotent by NOVA action id. The watermark makes a re-run cheap, but correctness does
 * not depend on it: re-processing the same session writes nothing new.
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/database');
const nova = require('./nova-client');

const STATE_KEY = 'nova_121_writeback_since';
const BACKUP_REL = 'Scripts/.lint-backups';

const START = '<!-- neuro:1-2-1-actions -->';
const END = '<!-- /neuro:1-2-1-actions -->';

/** How far back a first run reaches when there is no watermark yet. */
const COLD_START_DAYS = 120;

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

/** Today, local. Never toISOString() — the Pi may run UTC (see CLAUDE.md). */
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return todayStr(d);
}

/** `YYYY-MM-DD`, and nothing else. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * NOVA's date, as an ISO date, or null.
 *
 * ⚠ NOVA answers with TWO different things and only one of them is a date.
 * `scheduledDate` is `"2026-08-18"`; `completedAt` is a DISPLAY string —
 * `"Tue Aug 18"` — with no year in it at all. That distinction is the whole of
 * the 5-night outage this guards: the watermark took `max(completedAt)`, which
 * compares as a string, so `"Tue Aug 18" > "2026-05-27"` (T beats 2) and the
 * display string was stored as the next `since`. NOVA's `/121/completed`
 * requires `YYYY-MM-DD` and 400s on anything else, and the failure happens
 * BEFORE any session is processed, so it could never clear itself — five nights
 * of stranded commitments and a wedged key that only a hand-edit would free.
 *
 * A display string is REFUSED rather than parsed. The year is genuinely not in
 * it, and guessing one is how a watermark lands in the wrong year and silently
 * skips a fortnight of sessions — or writes a wrong `last-1-2-1` onto a real
 * person's card. Refusing costs nothing, because `scheduledDate` beside it is
 * already ISO and re-processing a session is a no-op by construction (the
 * `<!-- nova:id -->` dedupe).
 *
 * Pure — no clock, no I/O — so the rule pins without NOVA or a database.
 */
function toIsoDate(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // A full ISO timestamp is a date with time attached; take the date part.
  const stamp = raw.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  const candidate = stamp ? stamp[1] : raw;
  const m = candidate.match(ISO_DATE_RE);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  // Rejects 2026-02-31 rather than rolling it into March.
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return null;
  return candidate;
}

/**
 * The date a session was held, as a real date or nothing.
 *
 * `completedAt` first because finishing the click-through is the evidence the
 * conversation happened, but it is the display string, so in practice
 * `scheduledDate` is what answers. Null when neither is a date: `last-1-2-1` is
 * read back by `one-to-one-detect` and compared, and a card carrying
 * `last-1-2-1: Tue Aug 18` is worse than one carrying nothing.
 */
function sessionDate(session = {}) {
  return toIsoDate(session.completedAt) || toIsoDate(session.scheduledDate);
}

/**
 * Render one action as an Obsidian task line.
 *
 * The `👤` / `📅` markers are what `action-items.parseActionLine` already reads, so these
 * land in `find_action_items` with no parser change. The trailing comment carries NOVA's
 * action id: it is what makes a re-run a no-op, and it survives Nick editing the text,
 * which a text-match dedupe would not.
 */
function renderAction(action, personName) {
  const bits = [`- [ ] ${String(action.description || '').replace(/\r?\n/g, ' ').trim()}`];
  // Owner defaults to the person whose card this is — an unowned action on someone's
  // 1-2-1 card is theirs, and leaving the marker off would hide it from a person filter.
  const owner = (action.owner || '').trim() || personName;
  bits.push(`👤 [[People/${owner}|${owner}]]`);
  if (action.dueDate) bits.push(`📅 ${action.dueDate}`);
  bits.push(`<!-- nova:${action.id} -->`);
  return bits.join(' ');
}

/**
 * Is this action Nick's rather than the team member's?
 *
 * The extractor records the owner in the words the conversation used, so this has to
 * tolerate "Nick", "Nick Ward" and "nick ward". An UNOWNED action defaults to the team
 * member — it is their 1-2-1 and their card, and mis-filing one of their commitments as
 * Nick's would take it off the list they are held to.
 */
function isNick(owner) {
  return /^nick(\s+ward)?$/i.test(String(owner || '').trim());
}

/** NOVA action ids already written into this note, in any form. */
function existingIds(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/<!--\s*nova:(\d+)\s*-->/g)) ids.add(Number(m[1]));
  return ids;
}

/**
 * Splice the actions block into a People note.
 *
 * Pure, so the marker handling is testable without a vault — the same split as the
 * tracker's `spliceTable`. Returns null when nothing changes, so an unchanged run writes
 * no file and does not churn the mtime (the #78 lesson: a churned mtime drags the note
 * into every "recently modified" scan).
 *
 * Appends INSIDE the existing block rather than replacing it: a carried-over action from
 * three 1-2-1s ago is still owed, and regenerating the block from only the newest session
 * would quietly drop it.
 */
function spliceActions(source, lines) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  if (!lines.length) return null;

  const s = text.indexOf(START);
  const e = text.indexOf(END);

  let next;
  if (s !== -1 && e !== -1 && e > s) {
    const body = text.slice(s + START.length, e).replace(/\s+$/, '');
    next = text.slice(0, s) + `${START}${body}\n${lines.join('\n')}\n` + text.slice(e);
  } else {
    const block = [
      '',
      '## 1-2-1 Actions',
      '',
      '*Agreed in NOVA and written here by NEURO. Tick them off wherever you like —*',
      '*nothing rewrites a line once it exists.*',
      '',
      START,
      ...lines,
      END,
      '',
    ].join('\n');
    // After the frontmatter, before the first heading: actions are the thing to see on
    // opening the card, not something to scroll a dataview block to reach.
    const fm = text.match(/^---\n[\s\S]*?\n---\n/);
    if (fm) next = text.slice(0, fm[0].length) + block + text.slice(fm[0].length);
    else next = block + text;
  }

  next = next.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n');
  return next === text ? null : next;
}

function backup(absPath, stamp) {
  try {
    const dir = path.join(VAULT_PATH(), BACKUP_REL, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(absPath, path.join(dir, path.basename(absPath)));
    return `${BACKUP_REL}/${stamp}/${path.basename(absPath)}`;
  } catch {
    return null;
  }
}

/**
 * Pull completed 1-2-1s from NOVA and write them into the vault.
 *
 * Dry-run by default: `apply: true` is what writes. The watermark only advances on an
 * applied run that had no failures — a partial run that moved it would skip whatever it
 * had just failed to write, permanently.
 */
async function writeBack({ apply = false, since = null } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { ok: false, error: 'OBSIDIAN_VAULT_PATH not configured' };
  if (!nova.isConfigured()) {
    return { ok: false, error: 'NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }

  // ⚠ A stored watermark that is not a date is IGNORED, not sent. This is the
  // self-heal: the wedged key held the literal string "Wed May 27", NOVA 400s on
  // it before reading a single session, and nothing in the run could ever move
  // it on. Falling back to the cold start reprocesses at worst — which writes
  // nothing new, because every action carries its NOVA id.
  const stored = db.getState(STATE_KEY);
  const storedIso = toIsoDate(stored);
  const rejectedWatermark = stored && !storedIso ? String(stored) : null;
  if (rejectedWatermark) {
    console.warn(`[121-writeback] stored watermark "${rejectedWatermark}" is not a date — ignoring it and reaching back ${COLD_START_DAYS} days`);
  }
  const from = toIsoDate(since) || storedIso || daysAgoStr(COLD_START_DAYS);

  let payload;
  try {
    payload = await nova.get121Completed({ since: from });
  } catch (e) {
    return { ok: false, error: `Could not read completed 1-2-1s from NOVA: ${e.message}` };
  }

  const sessions = payload?.sessions || [];
  const stamp = `${todayStr()}-121-writeback`;
  const results = { people: [], skipped: [], failed: [] };

  for (const session of sessions) {
    const name = session.agentName;
    const abs = path.join(vault, 'People', `${name}.md`);
    if (!fs.existsSync(abs)) {
      // A NOVA agent with no People note. Roster drift, reported rather than created —
      // inventing a card for a name we cannot verify is how the wrong spelling sticks.
      results.skipped.push({ person: name, reason: 'no People note' });
      continue;
    }

    let source;
    try { source = fs.readFileSync(abs, 'utf-8'); } catch (e) {
      results.failed.push({ person: name, error: e.message });
      continue;
    }

    const already = existingIds(source);
    const fresh = (session.actions || []).filter((a) => !already.has(Number(a.id)));

    // Split by who took it on. Nick's own commitments from a 1-2-1 are HIS tasks and
    // belong in the task store with everything else he owes — not as a checkbox on
    // somebody else's People card, where he would never look for them. This is the half
    // that `action-candidates` used to catch by scanning the note itself; now that the
    // 1-2-1 is extracted once in NOVA, this is the only route his actions have.
    const mine = fresh.filter((a) => isNick(a.owner));
    const theirs = fresh.filter((a) => !isNick(a.owner));
    const lines = theirs.map((a) => renderAction(a, name));
    const next = spliceActions(source, lines);

    const held = sessionDate(session);
    const entry = {
      person: name,
      sessionId: session.sessionId,
      lastHeld: held,
      newActions: theirs.length,
      myActions: mine.length,
      alreadyPresent: (session.actions || []).length - fresh.length,
    };

    if (!apply) { results.people.push({ ...entry, dryRun: true }); continue; }

    try {
      if (next) {
        backup(abs, stamp);
        fs.writeFileSync(abs, next, 'utf-8');
      }
      // Frontmatter last, and separately: the actions are the payload, the dates are
      // bookkeeping, and a failure to write one should not silently lose the other.
      //
      // `1-2-1-booked` is cleared because the booking is now SPENT — leaving it would
      // keep the card claiming a meeting is in the diary that has already happened.
      //
      // ⚠ `last121` is only written when the session HAS a real date. NOVA's
      // `completedAt` is a display string, and stamping `last-1-2-1: Tue Aug 18`
      // onto a People card breaks every reader that compares that field to a
      // date. The booking is cleared either way — the meeting demonstrably
      // happened, whatever NOVA could tell us about when.
      const dates = held ? { last121: held, booked121: '' } : { booked121: '' };
      require('./obsidian').updatePersonNote(name, dates);

      // Nick's own actions become tasks. `task-store` dedupes on normalised text with a
      // UNIQUE key, so a re-run — or the same commitment repeated in the next 1-2-1 —
      // folds into the existing task rather than duplicating it.
      for (const a of mine) {
        try {
          require('./task-store').createTask({
            text: a.description,
            due_date: a.dueDate || null,
            // Said out loud to a direct report in a 1-2-1 they were sitting in:
            // the single clearest "somebody is expecting this" in the system, and
            // until now the single largest source of UNCLASSIFIED tasks — which
            // the weekly risk report going to Chris cannot count, and which the
            // VANTAGE radar then reports back as "treat the commitment figure as
            // a floor". Passed EXPLICITLY, so it is a decision rather than a
            // proposal with a trailing '?': there is nothing to hedge about.
            source: 'nova-121',
            origin: 'commitment',
            // `origin_path` is the provenance field task-store actually reads — a task
            // with no backlink is one Nick cannot place in three weeks' time. Points at
            // the People note, which is where that 1-2-1's record lives.
            origin_path: `People/${name}.md`,
          });
        } catch (e) {
          results.failed.push({ person: name, error: `task "${a.description}": ${e.message}` });
        }
      }
      results.people.push(entry);
    } catch (e) {
      results.failed.push({ person: name, error: e.message });
    }
  }

  if (apply && !results.failed.length && sessions.length) {
    // Watermark on the newest session we actually processed, not on today: a session
    // completed later in the run would otherwise be skipped next time.
    //
    // ⚠ Only sessions with a REAL date can move it, and it can only ever move
    // forward. A session NOVA could not date leaves the watermark where it is —
    // re-reading a day costs one no-op pass, and writing something that is not a
    // date is what took this offline for five nights.
    const newest = sessions.reduce((max, s) => {
      const iso = sessionDate(s);
      return iso && iso > max ? iso : max;
    }, from);
    if (toIsoDate(newest)) db.setState(STATE_KEY, newest);
  }

  // The tracker reads People frontmatter, so it regenerates AFTER the dates move —
  // otherwise the table would show the state from before this run every time.
  let tracker = null;
  if (apply && results.people.length) {
    try {
      tracker = require('./one-to-one-tracker').render({ apply: true });
    } catch (e) {
      tracker = { ok: false, error: e.message };
    }
  }

  return { ok: true, dryRun: !apply, since: from, sessions: sessions.length, ...results, tracker };
}

module.exports = {
  writeBack,
  spliceActions,
  renderAction,
  existingIds,
  toIsoDate,
  sessionDate,
  STATE_KEY,
  START,
  END,
  _internals: { todayStr, daysAgoStr },
};
