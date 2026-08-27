'use strict';

/**
 * Who is off, read from NOVA's People HR sync.
 *
 * NEURO went quiet on a day off only when Nick pressed a button. NOVA has known
 * the real answer all along — People HR is synced into `agent_availability`
 * daily and Nick is in it (AgentId 24). Leave should be READ, not declared: the
 * same rule that already governs who reports to him and when his 1-2-1s
 * happened, applied one step later.
 *
 * ⚠ THIS IS A COMPLEMENT TO THE MANUAL FLAG, NOT A REPLACEMENT. People HR's
 * GetHolidayDetail returns APPROVED leave only, so an absence booked for
 * tomorrow and still awaiting a manager is legitimately not in this feed —
 * measured on the day this was built, Nick had exactly that. The 🌴 button also
 * covers same-day decisions and works with NOVA or the network down.
 *
 * SHAPE, and why: `nudgeSuppression()` is SYNCHRONOUS and is called by seven
 * trigger functions, so this must never do I/O on that path. `refresh()` is
 * async and scheduled; `snapshot()` is a synchronous read of the cached blob.
 * That is the `working-days` pattern — live → cache → nothing, with the source
 * always named — and for the same reason: the thing asking cannot wait.
 */

const db = require('../db/database');

const CACHE_KEY = 'team_availability';
const WINDOW_DAYS = 14;

// Beyond this the cached copy is reported as stale. It is not discarded — a
// week-old answer about who booked leave is still far better than none, and
// leave is booked in advance rather than minute to minute.
const STALE_HOURS = 12;

/**
 * Which roster row is Nick.
 *
 * An explicit id is preferred and is what should be configured: `NOVA_AGENT_ID`
 * (his is 24). Falling back to a NAME match is deliberate but second — the
 * roster is small and full names are unambiguous in it, whereas an id typed
 * into an env file is the kind of thing that silently rots when someone is
 * re-created in the HR system. Whichever answered is reported, never assumed.
 */
function selfMatcher() {
  const id = Number(process.env.NOVA_AGENT_ID);
  if (Number.isInteger(id) && id > 0) return { by: 'id', id, name: null };
  const name = (process.env.NOVA_AGENT_NAME || 'Nick Ward').trim();
  return { by: 'name', id: null, name };
}

/** Is this roster entry Nick? Pure. */
function isSelf(row, matcher) {
  if (!row) return false;
  if (matcher.by === 'id') return Number(row.rosterId) === matcher.id;
  return String(row.name || '').trim().toLowerCase() === matcher.name.toLowerCase();
}

/**
 * Pull from NOVA and cache. Never throws — a failed refresh leaves the previous
 * copy in place, which is the whole point of caching it.
 */
/**
 * One bridge GET.
 *
 * ⚠ This SHOULD be `microsoft.novaBridgeFetch`, which already does the health
 * tracking and the nested-error detection. It is not exported — a one-line
 * addition to that module's `module.exports` — and `microsoft.js` was held by a
 * concurrent session when this shipped, so committing the fix would have swept
 * 91 lines of someone else's unfinished Planner work into this change. That has
 * gone wrong here before, twice. Switch to the shared helper once the export
 * lands; see the handoff.
 *
 * Kept deliberately thin so there is as little as possible to converge later.
 */
async function bridgeGet(path, params = {}) {
  const baseUrl = process.env.NOVA_BRIDGE_URL;
  const secret = process.env.NOVA_BRIDGE_SECRET;
  if (!baseUrl || !secret) return null;

  const url = new URL(`/api/neuro-bridge${path}`, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { 'x-neuro-bridge-secret': secret },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    // 401/404 means the request fell past the bridge router into NOVA's own
    // app auth — the path is not deployed, which is a different thing from a
    // bad call and is worth saying out loud.
    const unsupported = res.status === 401 || res.status === 404;
    console.warn(`[TeamAvailability] ${path} returned ${res.status}`
      + (unsupported ? ' — NOVA does not serve this path' : ''));
    return null;
  }
  const json = await res.json();
  if (!json.ok) {
    console.warn(`[TeamAvailability] ${path} reported failure:`, json.error || 'unknown');
    return null;
  }
  // Every bridge route nests its payload under `data`. Returning it top-level
  // is a real bug that has already cost one round trip here.
  return json.data ?? null;
}

async function refresh({ days = WINDOW_DAYS } = {}) {
  let payload = null;
  try {
    payload = await bridgeGet('/availability', { days });
  } catch (e) {
    console.warn('[TeamAvailability] Bridge call threw:', e.message);
  }

  // `novaBridgeFetch` returns null for every failure mode, INCLUDING the 401
  // that means NOVA has not deployed the route yet. Keeping the old copy is
  // right; overwriting it with an empty one would turn "we could not ask" into
  // "nobody is off", which is the one thing this must never do.
  if (!payload || !Array.isArray(payload.absences)) {
    const kept = snapshot();
    console.warn('[TeamAvailability] Refresh failed — keeping the previous copy'
      + (kept.fetchedAt ? ` (from ${kept.fetchedAt})` : ' (there is none)'));
    return { ok: false, kept: Boolean(kept.fetchedAt) };
  }

  const blob = {
    fetchedAt: new Date().toISOString(),
    from: payload.from || null,
    to: payload.to || null,
    rosterCount: payload.rosterCount ?? 0,
    roster: payload.roster || [],
    absences: payload.absences || [],
  };
  db.setState(CACHE_KEY, JSON.stringify(blob));
  console.log(`[TeamAvailability] ${blob.absences.length} absence day(s) across ${blob.rosterCount} agents`);
  return { ok: true, ...blob };
}

/** The cached blob. SYNCHRONOUS — the nudge path cannot wait on I/O. */
function snapshot(now = new Date()) {
  let blob = null;
  try { blob = JSON.parse(db.getState(CACHE_KEY) || 'null'); } catch { /* corrupt reads as absent */ }
  if (!blob || !blob.fetchedAt) {
    return { known: false, reason: 'never fetched', fetchedAt: null, absences: [], roster: [], rosterCount: 0 };
  }
  const ageHours = (now.getTime() - new Date(blob.fetchedAt).getTime()) / 3600000;
  return {
    // `known` says only that we HAVE an answer, never that it is fresh — a
    // caller that wants to insist on freshness reads `stale`.
    known: true,
    stale: ageHours > STALE_HOURS,
    ageHours: Math.round(ageHours * 10) / 10,
    ...blob,
  };
}

/**
 * Is Nick booked off on this date? PURE — takes the snapshot and the date, so
 * the decision that licenses SILENCE pins without a network or a clock.
 *
 * Returns a reason-bearing object rather than a boolean. "We could not ask" and
 * "he is working" are different facts, and a caller deciding whether to go
 * quiet must be able to tell them apart.
 */
function selfAbsenceOn(dateStr, snap, matcher = selfMatcher()) {
  if (!snap || !snap.known) return { off: false, known: false, reason: snap?.reason || 'no data' };

  // An empty roster is a BROKEN roster, not a free team. Saying "not off" from
  // it is technically true and practically a lie about what was checked.
  if (!snap.rosterCount) return { off: false, known: false, reason: 'roster empty' };

  const me = (snap.roster || []).find(r => isSelf(r, matcher));
  if (!me) {
    return { off: false, known: false, reason: `not in the NOVA roster (matched by ${matcher.by})` };
  }
  // No People HR id means this person never syncs and simply always looks
  // available — an absence of evidence that reads exactly like presence.
  if (me.syncable === false) {
    return { off: false, known: false, reason: 'no People HR id — absences never sync for this agent' };
  }

  const hit = (snap.absences || []).find(a => a.date === dateStr && Number(a.rosterId) === Number(me.rosterId));
  if (!hit) return { off: false, known: true, reason: 'no booked absence', rosterId: me.rosterId };

  return {
    off: true,
    known: true,
    rosterId: me.rosterId,
    status: hit.status,
    // The words People HR holds ("Annual Leave", "performing at a festival"),
    // so the log and the banner can say why rather than asserting a bare state.
    detail: hit.reason || null,
    setBy: hit.setBy || 'peoplehr',
  };
}

/** Everyone else who is off on a date — meeting prep, 1-2-1 booking, planning. */
function othersOff(dateStr, snap, matcher = selfMatcher()) {
  if (!snap?.known) return [];
  const me = (snap.roster || []).find(r => isSelf(r, matcher));
  const byId = new Map((snap.roster || []).map(r => [Number(r.rosterId), r]));
  return (snap.absences || [])
    .filter(a => a.date === dateStr && (!me || Number(a.rosterId) !== Number(me.rosterId)))
    .map(a => ({
      name: a.name || byId.get(Number(a.rosterId))?.name || `Agent ${a.rosterId}`,
      status: a.status,
      reason: a.reason || null,
    }));
}

/** What the panel and the log should say about where this came from. */
function status(now = new Date()) {
  const snap = snapshot(now);
  const matcher = selfMatcher();
  return {
    configured: Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET),
    matchedBy: matcher.by,
    known: snap.known,
    stale: snap.stale ?? null,
    fetchedAt: snap.fetchedAt,
    ageHours: snap.ageHours ?? null,
    rosterCount: snap.rosterCount,
    absenceDays: (snap.absences || []).length,
  };
}

module.exports = {
  WINDOW_DAYS,
  STALE_HOURS,
  refresh,
  snapshot,
  status,
  // pure, and the half worth pinning
  selfAbsenceOn,
  othersOff,
  isSelf,
  selfMatcher,
};
