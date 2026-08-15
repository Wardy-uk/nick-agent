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
 * STORAGE, honestly: this wants a table — it is queried by person and by age,
 * which is what tables are for. It is in the KV store because `schema.sql` is
 * being edited by a concurrent session and a migration collision costs more
 * than the query convenience is worth today. That is the third time the KV
 * store has absorbed something table-shaped; when schema.sql frees up, this
 * should move. The set is small and bounded (things owed by ~13 people) and is
 * read and written whole, so nothing breaks in the meantime.
 */

const db = require('../db/database');

const STATE_KEY = 'waiting_on_items';

// Matches the standup's rule: three days is when a carry becomes a decision.
const STALE_DAYS = 3;

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _save(items) {
  db.setState(STATE_KEY, JSON.stringify(items));
  return items;
}

function _key(person, text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 70);
  return `${String(person || '').toLowerCase()}::${norm}`;
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

  const items = _load();
  const key = _key(person, text);
  const existing = items.find(i => i.key === key);

  if (existing) {
    existing.lastSeen = new Date().toISOString();
    existing.sightings = (existing.sightings || 1) + 1;
    // Re-opening is deliberate: if it shows up in a NEW meeting note after being
    // marked done, it evidently is not done.
    if (existing.status !== 'open' && sourcePath && sourcePath !== existing.sourcePath) {
      existing.status = 'open';
      existing.reopenedAt = existing.lastSeen;
    }
    _save(items);
    return existing;
  }

  const item = {
    key,
    person: String(person).trim(),
    text: String(text).trim(),
    sourcePath,
    sourceDate,
    status: 'open',
    askedAt: null,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    sightings: 1,
  };
  items.push(item);
  _save(items);
  return item;
}

/** Open items, oldest first — the ones that have been waiting longest matter most. */
function list({ status = 'open', person = null } = {}) {
  const items = _load()
    .filter(i => (status === 'all' ? true : i.status === status))
    .filter(i => (person ? i.person.toLowerCase() === person.toLowerCase() : true))
    .map(i => ({
      ...i,
      ageDays: _ageDays(i.firstSeen),
      stale: _ageDays(i.firstSeen) >= STALE_DAYS,
      chased: Boolean(i.askedAt),
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
  const items = _load();
  const item = items.find(i => i.key === key);
  if (!item) return null;
  item.status = status === 'dropped' ? 'dropped' : 'done';
  item.resolvedAt = new Date().toISOString();
  _save(items);
  return item;
}

/** Record that a chase went out, so it is not asked twice in a week. */
function markChased(key) {
  const items = _load();
  const item = items.find(i => i.key === key);
  if (!item) return null;
  item.askedAt = new Date().toISOString();
  item.chaseCount = (item.chaseCount || 0) + 1;
  _save(items);
  return item;
}

/**
 * Queue a chase for approval. Never sends: this goes to a direct report, and an
 * automated chase to someone who works for you reads as surveillance. Nick
 * approves every one.
 */
function queueChase(key) {
  const item = _load().find(i => i.key === key);
  if (!item) return { ok: false, error: 'No such item' };
  if (item.status !== 'open') return { ok: false, error: `Already ${item.status}` };

  const id = require('./suggestion-engine').queueAction(
    'chase_commitment',
    { waitingKey: key, person: item.person, text: item.text, sourcePath: item.sourcePath },
    `Ask ${item.person} about "${item.text.slice(0, 60)}" (${_ageDays(item.firstSeen)}d)`,
    0.8
  );
  return { ok: true, queuedActionId: id, sent: false };
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

module.exports = {
  record, list, byPerson, resolve, markChased, queueChase, buildChaseMessage,
  STALE_DAYS, _key,
};
