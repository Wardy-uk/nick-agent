'use strict';

/**
 * Waiting on — what other people owe Nick.
 *
 * `standup-accountability` tracks what NICK carries. Nothing tracked the other
 * direction, and it was not for want of data: `action-candidates` already
 * detected "Abdi to send the SLA figures" in a meeting note, matched Abdi
 * against the People index, and then did `if (owner === 'others') continue` —
 * recognised the commitment and discarded it, name and all.
 *
 * With 13 reports, the things you are waiting on are most of what a Head of
 * Support actually has to hold in their head, so this is the gap that most
 * looks like the job.
 *
 * STORAGE: the `waiting_on` table since 15 Aug. It began in the agent_state KV
 * blob only because `schema.sql` was held by a concurrent session; it moved as
 * soon as that freed, because the chasing UI filters, sorts and — the deciding
 * one — SNOOZES, which is a per-item date a single blob had nowhere to put.
 * `migrateFromState()` lifts the KV copy in once and leaves it behind as a
 * rollback path.
 */

const db = require('../db/database');

const STATE_KEY = 'waiting_on_items';

// Matches the standup's rule: three days is when a carry becomes a decision.
const STALE_DAYS = 3;

/**
 * Storage moved from the agent_state KV blob to a real table on 15 Aug. The KV
 * row is deliberately LEFT IN PLACE as a rollback copy — it cost nothing to keep
 * and it holds the 287-item backfill that took a pass over 232 meeting notes.
 *
 * Row shape is snake_case in SQL and camelCase in JS; _fromRow/_toRow are the
 * only places that know, so the rest of the service reads exactly as it did.
 */
function _fromRow(r) {
  if (!r) return null;
  return {
    key: r.key,
    person: r.person,
    personFull: r.person_full,
    text: r.text,
    sourcePath: r.source_path,
    sourceDate: r.source_date,
    status: r.status,
    askedAt: r.asked_at,
    chaseCount: r.chase_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    sightings: r.sightings,
    reopenedAt: r.reopened_at,
    resolvedAt: r.resolved_at,
    snoozedUntil: r.snoozed_until,
  };
}

function _get(key) {
  return _fromRow(db.get('SELECT * FROM waiting_on WHERE key = ?', [key]));
}

function _all() {
  return db.all('SELECT * FROM waiting_on', []).map(_fromRow);
}

function _upsert(item) {
  db.run(
    `INSERT INTO waiting_on
       (key, person, person_full, text, source_path, source_date, status, asked_at,
        chase_count, first_seen, last_seen, sightings, reopened_at, resolved_at, snoozed_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       person = excluded.person, person_full = excluded.person_full,
       text = excluded.text, source_path = excluded.source_path,
       source_date = excluded.source_date, status = excluded.status,
       asked_at = excluded.asked_at, chase_count = excluded.chase_count,
       last_seen = excluded.last_seen, sightings = excluded.sightings,
       reopened_at = excluded.reopened_at, resolved_at = excluded.resolved_at,
       snoozed_until = excluded.snoozed_until`,
    [
      item.key, item.person, item.personFull ?? null, item.text,
      item.sourcePath ?? null, item.sourceDate ?? null, item.status ?? 'open',
      item.askedAt ?? null, item.chaseCount ?? 0, item.firstSeen, item.lastSeen,
      item.sightings ?? 1, item.reopenedAt ?? null, item.resolvedAt ?? null,
      item.snoozedUntil ?? null,
    ],
  );
  return item;
}

/**
 * One-time lift of the KV blob into the table. Idempotent by construction — it
 * only runs when the table is empty — and it never deletes the KV copy, so a
 * bad migration is recoverable by reverting the code alone.
 */
function migrateFromState() {
  const already = db.get('SELECT COUNT(*) AS n FROM waiting_on', []);
  if ((already?.n ?? 0) > 0) return { migrated: 0, reason: 'table already populated' };

  let items = [];
  try {
    const raw = db.getState(STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    return { migrated: 0, reason: 'KV blob unreadable' };
  }
  if (!items.length) return { migrated: 0, reason: 'nothing in KV' };

  let migrated = 0;
  for (const i of items) {
    if (!i?.key || !i?.person || !i?.text) continue;   // skip anything malformed
    _upsert({
      ...i,
      firstSeen: i.firstSeen || i.lastSeen || new Date().toISOString(),
      lastSeen: i.lastSeen || i.firstSeen || new Date().toISOString(),
    });
    migrated++;
  }
  console.log(`[waiting-on] migrated ${migrated} items from the KV store into waiting_on`);
  return { migrated, reason: 'ok' };
}

/**
 * Canonical person for grouping. Meeting notes name the same colleague both
 * ways — "Chris to confirm" and "Chris Middleton to confirm" — which produced
 * two separate entries for one person, and so two separate answers to "what am
 * I waiting on from Chris?".
 *
 * First name wins because that is what the People index is keyed on. Two people
 * sharing a first name would merge; with 13 reports that is a trade worth making
 * for a list that is actually readable, and the full name is kept for display.
 */
function _canonicalPerson(person) {
  const raw = String(person || '').trim().replace(/(?:’s|'s)$/, '');
  const first = raw.split(/\s+/)[0] || raw;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function _key(person, text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 70);
  return `${String(person || '').toLowerCase()}::${norm}`;
}

/** "2026-06-30" → an ISO timestamp, or null if it is not a usable date. */
function _sourceDateToIso(sourceDate) {
  if (!sourceDate) return null;
  const m = String(sourceDate).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T09:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  // A note dated in the future is a typo, not a commitment made tomorrow.
  return d.getTime() > Date.now() ? null : d.toISOString();
}

function _ageDays(iso) {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86400000);
}

/**
 * Record a commitment someone else made. Folds on the dedupe key rather than
 * duplicating, so the same action appearing in a follow-up note updates the
 * sighting instead of creating a second row — the same rule the task store uses.
 */
function record({ person, text, sourcePath = null, sourceDate = null }) {
  if (!person || !String(text || '').trim()) return null;

  const canonical = _canonicalPerson(person);
  const key = _key(canonical, text);
  const existing = _get(key);

  if (existing) {
    existing.lastSeen = new Date().toISOString();
    existing.sightings = (existing.sightings || 1) + 1;
    // Re-opening is deliberate: if it shows up in a NEW meeting note after being
    // marked done, it evidently is not done.
    if (existing.status !== 'open' && sourcePath && sourcePath !== existing.sourcePath) {
      existing.status = 'open';
      existing.reopenedAt = existing.lastSeen;
      existing.resolvedAt = null;
      // A commitment that has resurfaced is not still snoozed.
      existing.snoozedUntil = null;
    }
    _upsert(existing);
    return existing;
  }

  const now = new Date().toISOString();
  const item = {
    key,
    person: canonical,
    // Kept for display where the note was specific.
    personFull: String(person).trim() !== canonical ? String(person).trim() : null,
    text: String(text).trim(),
    sourcePath,
    sourceDate,
    status: 'open',
    askedAt: null,
    // Dated from the MEETING, not from when this row was written. A backfill
    // over four months of notes otherwise stamps everything with today and
    // reports a commitment made in June as nought days old — which breaks the
    // only two things this list is sorted and filtered by.
    firstSeen: _sourceDateToIso(sourceDate) || now,
    lastSeen: now,
    sightings: 1,
    chaseCount: 0,
    snoozedUntil: null,
  };
  _upsert(item);
  return item;
}

/** Open items, oldest first — the ones that have been waiting longest matter most. */
function list({ status = 'open', person = null } = {}) {
  const now = Date.now();
  const items = _all()
    .filter(i => (status === 'all' ? true : i.status === status))
    .filter(i => (person ? i.person.toLowerCase() === person.toLowerCase() : true))
    .map(i => ({
      ...i,
      ageDays: _ageDays(i.firstSeen),
      stale: _ageDays(i.firstSeen) >= STALE_DAYS,
      chased: Boolean(i.askedAt),
      snoozed: Boolean(i.snoozedUntil) && new Date(i.snoozedUntil).getTime() > now,
    }));
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items;
}

/** Grouped by person — how you actually think about it before a 1-2-1. */
function byPerson() {
  const groups = new Map();
  for (const item of list({ status: 'open' })) {
    if (!groups.has(item.person)) groups.set(item.person, []);
    groups.get(item.person).push(item);
  }
  return [...groups.entries()]
    .map(([person, items]) => ({
      person,
      count: items.length,
      oldestDays: items[0].ageDays,
      items,
    }))
    .sort((a, b) => b.oldestDays - a.oldestDays);
}

function resolve(key, status = 'done') {
  const item = _get(key);
  if (!item) return null;
  item.status = status === 'dropped' ? 'dropped' : 'done';
  item.resolvedAt = new Date().toISOString();
  _upsert(item);
  return item;
}

/**
 * Hide until a date — "they said next Friday". Distinct from resolving: the
 * commitment is still outstanding and still ages, it just stops being asked
 * about. Clearing is passing no date.
 */
function snooze(key, until = null) {
  const item = _get(key);
  if (!item) return null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('until must be YYYY-MM-DD');
  item.snoozedUntil = until ? new Date(`${until}T09:00:00`).toISOString() : null;
  _upsert(item);
  return item;
}

/** Record that a chase went out, so it is not asked twice in a week. */
function markChased(key) {
  const item = _get(key);
  if (!item) return null;
  item.askedAt = new Date().toISOString();
  item.chaseCount = (item.chaseCount || 0) + 1;
  _upsert(item);
  return item;
}

/**
 * Queue a chase for approval. Never sends: this goes to a direct report, and an
 * automated chase to someone who works for you reads as surveillance. Nick
 * approves every one.
 */
async function queueChase(key) {
  const item = _get(key);
  if (!item) return { ok: false, error: 'No such item' };
  if (item.status !== 'open') return { ok: false, error: `Already ${item.status}` };

  // Resolve the address HERE rather than at send time, so the approval screen
  // can show who it is actually going to. An address discovered only inside the
  // executor is an address nobody ever saw before the email left. A failure to
  // resolve is stored too, not thrown — it becomes a visible "set an address"
  // on the card instead of an approve that silently does nothing.
  let to = null;
  try {
    const r = await require('./contact-directory').resolveName(item.person);
    to = {
      email: r?.status === 'resolved' ? r.email : null,
      status: r?.status || 'unresolved',
      source: r?.status === 'resolved' ? 'directory' : null,
    };
  } catch (e) {
    to = { email: null, status: 'lookup-failed', source: null, error: e.message };
  }

  // The words are built HERE too, at queue time, and stored on the action — the
  // executor already prefers `payload.body` over rebuilding. That means the
  // approval screen can show the exact text that will be sent rather than a
  // client-side reconstruction of it, which would be free to drift from the
  // template. You approve what you read.
  const id = require('./suggestion-engine').queueAction(
    'chase_commitment',
    {
      waitingKey: key,
      person: item.person,
      text: item.text,
      sourcePath: item.sourcePath,
      body: buildChaseMessage(item),
      to,
    },
    `Ask ${item.person} about "${item.text.slice(0, 60)}" (${_ageDays(item.firstSeen)}d)`,
    0.8
  );
  return { ok: true, queuedActionId: id, sent: false, to };
}

// Deliberately loose. This is a human typing a colleague's address they already
// know, not a signup form — the job is to catch a slip, not to adjudicate RFC
// 5322. Graph rejects anything genuinely malformed.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Point a queued chase at a different address before it is approved.
 *
 * The directory resolves a first name and can be wrong or ambiguous, and the
 * only person who knows which Chris is which is Nick. An override is recorded
 * as `source: 'manual'` so the executor can tell a chosen address from a guessed
 * one — a guess still has to clear the `resolved` gate, a choice does not.
 *
 * Scoped to chase_commitment on purpose: `/api/actions/:id/approve` stays a
 * plain approve, with no general "edit any pending action's payload" door.
 */
function setChaseRecipient(actionId, email) {
  const action = db.getSaraAction(parseInt(actionId, 10));
  if (!action) return { ok: false, error: 'No such action' };
  if (action.type !== 'chase_commitment') return { ok: false, error: `That is a ${action.type}, not a chase` };
  if (action.status !== 'pending') return { ok: false, error: `Already ${action.status}` };

  const clean = String(email || '').trim();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: 'That does not look like an email address' };

  const payload = { ...action.payload, to: { email: clean, status: 'resolved', source: 'manual' } };
  if (!db.updateSaraActionPayload(action.id, payload)) {
    return { ok: false, error: 'Could not update — it may have just been approved' };
  }

  // Feedback loop: remember the address so the next chase to this person does
  // not ask again. 26 of 41 People notes carry no `email:`, so being asked is
  // the normal case. Runs AFTER the payload is safely stored and is never
  // allowed to fail the override — the useful work is already done, and a vault
  // write failing must not read to Nick as "your correction didn't save" (#69).
  // `learnEmail` writes only when the note has no address; it never overwrites
  // one, so a one-off recipient cannot silently retarget future messages.
  //
  // Note `payload.person` is the CANONICAL FIRST NAME — that is all `waiting_on`
  // stores. `learnEmail` accepts it only when it maps to exactly one person, so
  // "Heidi" learns and "Chris" does not. That is the right way round: the
  // ambiguous ones are precisely where writing to the wrong colleague's note
  // would be worst, and they are also the ones Nick is most often correcting.
  let learned = null;
  try {
    const person = action.payload?.person;
    if (person) {
      const r = require('./contact-directory').learnEmail(person, clean);
      if (r.ok) learned = r.person;
    }
  } catch { /* bookkeeping only */ }

  return { ok: true, to: payload.to, ...(learned ? { learned } : {}) };
}

/**
 * Choose email or a Teams DM for a queued chase (Q9 — email ships, Teams is a
 * preference layered on). Only ever a preference: if Teams cannot deliver at
 * approval time the executor falls back to email and says so, because the point
 * is that the person gets asked.
 */
function setChaseChannel(actionId, channel) {
  const want = String(channel || '').toLowerCase();
  if (!['email', 'teams'].includes(want)) return { ok: false, error: 'channel must be email or teams' };

  const action = db.getSaraAction(parseInt(actionId, 10));
  if (!action) return { ok: false, error: 'No such action' };
  if (action.type !== 'chase_commitment') return { ok: false, error: `That is a ${action.type}, not a chase` };
  if (action.status !== 'pending') return { ok: false, error: `Already ${action.status}` };

  const payload = { ...action.payload, channel: want };
  if (!db.updateSaraActionPayload(action.id, payload)) {
    return { ok: false, error: 'Could not update — it may have just been approved' };
  }
  return { ok: true, channel: want };
}

/**
 * The words. Asks rather than demands, gives the out, and never implies the
 * person has failed — same rule as the nudges and the agenda chaser. A chase
 * that lands as an accusation costs more than the update is worth.
 */
function buildChaseMessage(item) {
  const first = String(item.person || '').split(' ')[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    `Just picking up on "${item.text}" from ${item.sourceDate || 'our last catch-up'} — where has that got to?`,
    '',
    `No rush if it's moved down the list, just let me know and I'll stop chasing it.`,
    '',
    'Nick',
  ].join('\n');
}

/**
 * Populate from meeting notes already on disk.
 *
 * Needed because the live path only fires for notes that are new or changed:
 * `action-candidates` skips anything whose content hash it has already
 * reviewed, so every historical note is invisible to it. Without this, the
 * feature starts empty and only learns about commitments made from today —
 * which is the least useful day to start.
 *
 * Reads only. `extractMeetingActions` records waiting-on items as a side
 * effect; the task-candidate half is not touched, so this cannot promote
 * anything into the task list or the approval queue.
 */
function backfill({ days = 120, limit = 500 } = {}) {
  const fs = require('fs');
  const path = require('path');

  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return { scanned: 0, reason: 'no vault path' };

  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return { scanned: 0, reason: 'no Meetings directory' };

  const cutoff = Date.now() - days * 86400000;
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4 || files.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith('.md')) continue;
      // Transcripts are raw speech — the action extractor is tuned for the
      // structured "## Next Arrangements" blocks in summaries, not for prose.
      if (full.toLowerCase().includes('transcript')) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
      } catch { continue; }
      files.push(full);
    }
  };
  try { walk(meetingsDir); } catch (e) {
    return { scanned: 0, reason: e.message };
  }

  const before = list({ status: 'all' }).length;
  let scanned = 0;
  const extract = require('./action-candidates').extractMeetingActions;

  for (const full of files) {
    try {
      const text = fs.readFileSync(full, 'utf-8');
      const relativePath = path.relative(vault, full).replace(/\\/g, '/');
      extract(text, relativePath);
      scanned++;
    } catch (e) {
      console.warn('[WaitingOn] Backfill skipped', full, e.message);
    }
  }

  const after = list({ status: 'all' }).length;
  console.log(`[WaitingOn] Backfill: ${scanned} note(s), ${after - before} new item(s)`);
  return { scanned, added: after - before, total: after };
}

module.exports = {
  record, list, byPerson, resolve, snooze, markChased, queueChase, setChaseRecipient, setChaseChannel,
  buildChaseMessage, backfill, migrateFromState, STALE_DAYS, _key,
};
