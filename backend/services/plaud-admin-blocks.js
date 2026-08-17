'use strict';

/**
 * Plaud admin blocks — five minutes after every real meeting to write it up.
 *
 * Nick's rule (17 Aug 2026): every meeting he CREATED or ACCEPTED gets a 5-minute
 * block afterwards carrying "process and update Plaud meeting for [title]". Back
 * to back meetings push the block to the first slot that is actually free.
 *
 * ── What counts as a meeting ────────────────────────────────────────────────
 * The load-bearing filter is Nick's own: a meeting has OTHER PEOPLE in it. Half
 * his diary is time he has blocked out for specific work, and a focus block has
 * no Plaud recording to process, so a 5-minute admin block after one is pure
 * noise on a calendar that is already the problem. `attendeesOther()` is the
 * test, and it is measured against the signed-in address rather than a count:
 * Graph lists the organiser among the attendees on some events and not others,
 * so `attendees.length >= 2` is true for a solo block roughly at random.
 *
 * ── Failing closed ──────────────────────────────────────────────────────────
 * "Created or accepted" is `isOrganizer` / `responseStatus`, and BOTH are null
 * when the calendar came from the NOVA bridge rather than Graph (the bridge has
 * no route that returns them). Unknown is treated as NOT qualifying. The cost of
 * failing closed is a missing block Nick can add himself; the cost of failing
 * open is admin blocks after meetings he declined, which is the failure that
 * makes someone turn the whole thing off.
 *
 * ── Why a ledger, not a calendar scan ───────────────────────────────────────
 * The obvious idempotency check is "does a block already exist after this
 * meeting" — read straight off the same event list, no state to keep. It is
 * wrong in one direction that matters: Nick deleting a block is a DECISION, and
 * a calendar scan would recreate it on the next pass, forever, with no way to
 * refuse it. So a handled meeting is recorded in `agent_state.plaud_admin_blocks`
 * and never revisited. The ledger is keyed on the Graph event id, which for a
 * recurring meeting is per-OCCURRENCE — so a weekly gets a block each week,
 * which is correct (each occurrence is a separate write-up) and is also the
 * setting most likely to want tuning. See SKIP_SUBJECTS.
 *
 * Read-only by default: `plan()` never writes anything, and `apply()` is what
 * creates. The scheduler hook is gated on PLAUD_ADMIN_BLOCKS_ENABLED.
 */

const db = require('../db/database');
const workingDays = require('./working-days');

const BLOCK_MINUTES = 5;
const SUBJECT_PREFIX = 'Plaud admin — ';
/** In the body, so our own blocks are identifiable even if the subject is edited. */
const BLOCK_MARKER = '<!-- neuro:plaud-admin -->';

const WINDOW_DAYS = 14;
/** Search step and day bounds for placing the block, in minutes from midnight. */
const STEP_MIN = 5;
const DAY_START_MIN = 8 * 60;
const DAY_END_MIN = 18 * 60;
/** How far forward a block may spill when the rest of the day is solid. */
const MAX_SPILL_DAYS = 3;

/**
 * A cap on a single run, loud when it bites. A pass proposing eighty blocks has
 * failed regardless of whether each one is individually defensible — that is the
 * #78 lesson, and here each item is a real calendar event.
 */
const MAX_CREATE_PER_RUN = 25;

const STATE_KEY = 'plaud_admin_blocks';
/** Ledger entries older than this are dropped; the meeting is long gone. */
const PRUNE_AFTER_DAYS = 60;

/**
 * The run lock, and it is not optional — it was found the hard way.
 *
 * The first live run created 52 blocks where 27 were wanted, because the
 * scheduler's calendar-sync pass overlapped a manual apply: both planned
 * against an empty ledger, and the ledger was only written at the END of a run,
 * so neither could see the other. A pass makes ~25 sequential Graph creates and
 * calendar-sync fires every few minutes, so overlap is the normal case, not a
 * rare one.
 *
 * `acquireLock` is deliberately SYNCHRONOUS with no await between reading the
 * key and writing it. Both contenders live in the same Node process
 * (scheduler and route alike) and better-sqlite3 is synchronous, so a sync
 * read-modify-write genuinely cannot interleave — this is a real mutex here,
 * not an optimistic guess. It would NOT be safe across processes.
 */
const LOCK_KEY = 'plaud_admin_blocks_lock';
/** A pass that has held the lock longer than this has died; take it. */
const LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Subjects that never earn a block even with other people on them. Empty by
 * default and deliberately so — this is the escape hatch for a daily standup or
 * a recurring all-hands where the answer is "no write-up", and Nick should fill
 * it from what he actually sees rather than from what we guessed. Comma
 * separated, matched case-insensitively as a substring.
 */
const SKIP_SUBJECTS = String(process.env.PLAUD_ADMIN_SKIP_SUBJECTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isEnabled() {
  return String(process.env.PLAUD_ADMIN_BLOCKS_ENABLED || '').toLowerCase() === 'true';
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Local date string. Never toISOString() — the Pi may run UTC and that rolls the day. */
function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Graph hands back naive local wall-clock strings ("2026-08-18T14:00:00"). */
function toMinutes(dateTime) {
  const time = String(dateTime).split('T')[1];
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesToClock(day, minutes) {
  return `${day}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

function eventDate(event) {
  return String(event.start || '').split('T')[0];
}

// ── The ledger ──────────────────────────────────────────────────────────────

function readLedger() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger) {
  // setState takes a primitive — an object throws "unknown type".
  db.setState(STATE_KEY, JSON.stringify(ledger));
}

/** Sync throughout — see LOCK_KEY. An await in here would defeat the point. */
function acquireLock(holder, now = Date.now()) {
  let held = null;
  try {
    const raw = db.getState(LOCK_KEY);
    held = raw ? JSON.parse(raw) : null;
  } catch { held = null; }

  if (held && Number.isFinite(held.at) && now - held.at < LOCK_TTL_MS) {
    return { ok: false, heldBy: held.holder || 'unknown', ageMs: now - held.at };
  }
  if (held) {
    console.warn(`[PlaudAdmin] Taking a stale lock from ${held.holder} (${Math.round((now - held.at) / 1000)}s old)`);
  }
  db.setState(LOCK_KEY, JSON.stringify({ holder, at: now }));
  return { ok: true };
}

function releaseLock() {
  try { db.setState(LOCK_KEY, ''); } catch { /* a stale lock times out anyway */ }
}

function pruneLedger(ledger, now) {
  const cutoff = dateStr(addDays(now, -PRUNE_AFTER_DAYS));
  const out = {};
  for (const [id, entry] of Object.entries(ledger)) {
    if (!entry || typeof entry !== 'object') continue;
    const day = String(entry.meetingDate || entry.start || '').slice(0, 10);
    if (day && day < cutoff) continue;
    out[id] = entry;
  }
  return out;
}

// ── Qualification ───────────────────────────────────────────────────────────

function isOurBlock(event) {
  return String(event.subject || '').startsWith(SUBJECT_PREFIX);
}

/**
 * Attendees who are not Nick. When the signed-in address is unknown we cannot
 * tell his own entry from anyone else's, so nothing qualifies — the same
 * fail-closed rule as the response status.
 */
function attendeesOther(event, me) {
  if (!me) return [];
  const mine = String(me).toLowerCase();
  return (event.attendees || []).filter(a => {
    const email = String(a?.email || '').toLowerCase();
    return email && email !== mine;
  });
}

function createdOrAccepted(event) {
  if (event.isOrganizer === true) return 'organizer';
  const response = String(event.responseStatus || '').toLowerCase();
  if (response === 'organizer') return 'organizer';
  if (response === 'accepted') return 'accepted';
  return null;
}

/**
 * Why this event gets no block, or null if it does. Returning the reason rather
 * than a boolean is what makes the dry run readable — "18 skipped" says nothing,
 * "11 solo blocks, 4 not accepted, 3 already done" is a review.
 */
/**
 * Is there already a block for this meeting on the calendar?
 *
 * Belt and braces behind the ledger, and it closes a class the lock cannot:
 * a lost or restored agent.db, or a failed ledger write, would otherwise make
 * a pass recreate every block it had already made. Matched on DATE + SUBJECT
 * because that is the duplicate unit — the two competing passes of 17 Aug
 * produced blocks for the same meeting *minutes apart* (11:45 and 11:55),
 * since the second saw the first's blocks as busy and moved along, so an
 * exact-time match would not have caught them.
 *
 * This can only ever cause a SKIP, never a create, so it cannot resurrect a
 * block Nick deleted — that stays the ledger's job.
 */
function hasBlockAlready(event, events) {
  const wanted = `${SUBJECT_PREFIX}${String(event.subject || '(No subject)').trim()}`;
  const day = eventDate(event);
  return events.some(e => eventDate(e) === day && String(e.subject || '') === wanted);
}

function skipReason(event, { me, now, ledger, events = [] }) {
  if (!event || !event.id || !event.start || !event.end) return 'incomplete';
  if (isOurBlock(event)) return 'is-admin-block';
  if (event.isAllDay) return 'all-day';

  const showAs = String(event.showAs || 'busy').toLowerCase();
  if (showAs === 'cancelled') return 'cancelled';
  if (showAs === 'free') return 'marked-free';
  if (showAs === 'oof') return 'out-of-office';

  const end = new Date(String(event.end).replace(' ', 'T'));
  // Never backfill. A meeting that has already finished either got written up or
  // did not, and a block in the past is a notification about nothing.
  if (!(end > now)) return 'already-ended';

  if (ledger[event.id]) return 'already-handled';
  if (hasBlockAlready(event, events)) return 'block-exists';

  if (!createdOrAccepted(event)) {
    return event.isOrganizer === null && !event.responseStatus ? 'response-unknown' : 'not-accepted';
  }

  if (attendeesOther(event, me).length === 0) {
    // Nick's own distinction: this is time he blocked out for work, not a
    // meeting, so there is no Plaud recording to process.
    return me ? 'no-other-attendees' : 'identity-unknown';
  }

  const subject = String(event.subject || '').toLowerCase();
  if (SKIP_SUBJECTS.some(s => subject.includes(s))) return 'subject-excluded';

  return null;
}

// ── Placement ───────────────────────────────────────────────────────────────

/**
 * Busy intervals on `day`, from the events already in hand plus any blocks this
 * run has itself placed. Free and cancelled events do not block; tentative ones
 * do. All-day events deliberately do NOT blanket the day — an all-day "Leave"
 * is caught by the working-day check, and an all-day informational marker
 * should not stop a five minute block.
 */
function busyOn(day, events) {
  return events
    .filter(e => eventDate(e) === day)
    .filter(e => !e.isAllDay)
    .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .map(e => ({ start: toMinutes(e.start), end: toMinutes(e.end) }))
    .filter(b => b.start !== null && b.end !== null)
    .sort((a, b) => a.start - b.start);
}

function firstGap(day, events, fromMinute, duration) {
  const busy = busyOn(day, events);
  const start0 = Math.max(fromMinute, DAY_START_MIN);
  for (let start = start0; start + duration <= DAY_END_MIN; start += STEP_MIN) {
    const end = start + duration;
    if (!busy.some(b => start < b.end && end > b.start)) return { start, end };
  }
  return null;
}

/**
 * Where the block goes: straight after the meeting if that is free, otherwise
 * the first free slot after it — which is what "back to back" means in practice,
 * the block landing after the run rather than inside it. Spills to the next
 * working day only when the rest of today is solid to DAY_END.
 */
function placeBlock(event, events, nowMinutesByDay) {
  const meetingDay = eventDate(event);
  const meetingEnd = toMinutes(event.end);
  if (meetingEnd === null) return null;

  // Never place a block in the past on today's date: a meeting that ran over,
  // or a pass that fires mid-meeting, would otherwise book five minutes ago.
  const floor = Math.max(meetingEnd, nowMinutesByDay[meetingDay] ?? 0);

  const sameDay = firstGap(meetingDay, events, floor, BLOCK_MINUTES);
  if (sameDay) {
    return { date: meetingDay, start: sameDay.start, end: sameDay.end, spilled: false };
  }

  let day = new Date(`${meetingDay}T12:00:00`);
  for (let i = 0; i < MAX_SPILL_DAYS; i++) {
    day = addDays(day, 1);
    if (!workingDays.isWorkingDay(day, events)) continue;
    const d = dateStr(day);
    const gap = firstGap(d, events, DAY_START_MIN, BLOCK_MINUTES);
    if (gap) return { date: d, start: gap.start, end: gap.end, spilled: true };
  }
  return null;
}

function blockFor(event, slot) {
  const title = String(event.subject || '(No subject)').trim();
  return {
    meetingId: event.id,
    meetingSubject: title,
    meetingStart: event.start,
    meetingEnd: event.end,
    meetingDate: eventDate(event),
    date: slot.date,
    start: minutesToClock(slot.date, slot.start),
    end: minutesToClock(slot.date, slot.end),
    spilled: slot.spilled,
    subject: `${SUBJECT_PREFIX}${title}`,
    body: `process and update Plaud meeting for ${title}\n\n${BLOCK_MARKER}`,
  };
}

/** A placed block, shaped like a calendar event so the next placement sees it. */
function reserve(events, block) {
  events.push({
    id: `pending-${block.meetingId}`,
    start: block.start,
    end: block.end,
    subject: block.subject,
    showAs: 'busy',
    isAllDay: false,
  });
}

// ── Plan / apply ────────────────────────────────────────────────────────────

/**
 * Read-only. Works from `events` when the caller already has them (calendar-sync
 * does), otherwise fetches the window itself.
 */
async function plan({ days = WINDOW_DAYS, events = null, now = new Date() } = {}) {
  const microsoft = require('./microsoft');

  let list = events;
  if (!Array.isArray(list)) {
    try {
      list = await microsoft.fetchCalendarEvents(dateStr(now), dateStr(addDays(now, days)));
    } catch (e) {
      return { ok: false, reason: 'fetch_failed', detail: e.message, candidates: [] };
    }
  }
  if (!Array.isArray(list)) return { ok: false, reason: 'no_calendar', candidates: [] };

  let me = null;
  try { me = await microsoft.getSignedInAddress(); } catch {}

  const ledger = readLedger();
  const working = list.slice();
  const candidates = [];
  const skipped = {};
  const unplaced = [];

  const nowMinutesByDay = { [dateStr(now)]: now.getHours() * 60 + now.getMinutes() };

  const ordered = list
    .slice()
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));

  for (const event of ordered) {
    // `working`, not `list` — so a block this pass has already placed also
    // counts, and two occurrences in one batch cannot both slip through.
    const reason = skipReason(event, { me, now, ledger, events: working });
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      continue;
    }
    const slot = placeBlock(event, working, nowMinutesByDay);
    if (!slot) {
      unplaced.push({ meetingId: event.id, subject: event.subject, end: event.end });
      skipped['no-slot'] = (skipped['no-slot'] || 0) + 1;
      continue;
    }
    const block = blockFor(event, slot);
    reserve(working, block);
    candidates.push(block);
  }

  const capped = candidates.length > MAX_CREATE_PER_RUN;
  if (capped) {
    console.warn(
      `[PlaudAdmin] ${candidates.length} blocks proposed, capping at ${MAX_CREATE_PER_RUN}. ` +
      'A pass this large usually means the ledger was lost or the window widened — check before applying.'
    );
  }

  return {
    ok: true,
    enabled: isEnabled(),
    identity: me,
    windowDays: days,
    considered: list.length,
    candidates: capped ? candidates.slice(0, MAX_CREATE_PER_RUN) : candidates,
    proposedTotal: candidates.length,
    capped,
    skipped,
    unplaced,
  };
}

/**
 * Create the blocks. Sequential and fault-isolated: these are real calendar
 * writes, so one Graph failure must not abandon the rest, and nothing is
 * retried. A meeting is written to the ledger ONLY on a successful create, so a
 * failure is picked up by the next pass rather than silently lost.
 */
async function apply({ days = WINDOW_DAYS, events = null, now = new Date(), dryRun = true, holder = 'manual' } = {}) {
  // A dry run reads and writes nothing, so it never contends for the lock.
  if (dryRun) {
    const planned = await plan({ days, events, now });
    return { ...planned, created: 0, dryRun: true };
  }

  const lock = acquireLock(holder);
  if (!lock.ok) {
    // Refusing is the whole point: the pass already running will do this work,
    // and running anyway is exactly how 27 blocks became 52.
    console.log(`[PlaudAdmin] Skipped — a pass is already running (${lock.heldBy}, ${Math.round(lock.ageMs / 1000)}s)`);
    return { ok: true, created: 0, skipped: 'locked', heldBy: lock.heldBy, dryRun: false };
  }

  try {
    const planned = await plan({ days, events, now });
    if (!planned.ok) return { ...planned, created: 0, dryRun: false };

    const microsoft = require('./microsoft');
    let ledger = pruneLedger(readLedger(), now);
    const created = [];
    const failed = [];

    for (const block of planned.candidates) {
      let result;
      try {
        result = await microsoft.createCalendarEvent({
          subject: block.subject,
          start: block.start,
          end: block.end,
          body: block.body,
          attendees: [],
        });
      } catch (e) {
        result = { created: false, reason: e.message };
      }

      if (!result?.created) {
        failed.push({ meetingId: block.meetingId, subject: block.subject, reason: result?.reason || 'unknown' });
        console.warn(`[PlaudAdmin] Create failed for "${block.subject}": ${result?.reason}`);
        continue;
      }

      ledger[block.meetingId] = {
        blockId: result.event?.id || null,
        meetingSubject: block.meetingSubject,
        meetingDate: block.meetingDate,
        start: block.start,
        createdAt: new Date().toISOString(),
      };
      created.push({ ...block, blockId: result.event?.id || null });

      // Written per create, not batched at the end. The event already exists in
      // Nick's calendar the instant Graph answers, so anything that stops the
      // loop after this point — a crash, a restart mid-deploy — must not leave
      // a created block unrecorded and duplicable.
      try {
        writeLedger(ledger);
      } catch (e) {
        console.error('[PlaudAdmin] Ledger write FAILED — this block may be duplicated next pass:', e.message);
      }
    }

    if (created.length) {
      console.log(`[PlaudAdmin] Created ${created.length} admin block(s)${failed.length ? `, ${failed.length} failed` : ''}`);
    }

    return { ...planned, created: created.length, blocks: created, failed, dryRun: false };
  } finally {
    releaseLock();
  }
}

/**
 * The scheduler hook. Takes the events calendar-sync already fetched, so this
 * adds no Graph read to the sync path. Gated, and never allowed to throw into
 * its caller — a calendar sync must not fail because a convenience block did.
 */
async function syncHook(events) {
  if (!isEnabled()) return { ok: true, skipped: 'disabled', created: 0 };
  try {
    return await apply({ events, dryRun: false, holder: 'calendar-sync' });
  } catch (e) {
    console.warn('[PlaudAdmin] Pass failed:', e.message);
    return { ok: false, reason: e.message, created: 0 };
  }
}

/** What the ledger holds, for the route — so "nothing happened" is inspectable. */
function status() {
  const ledger = readLedger();
  const entries = Object.entries(ledger)
    .map(([meetingId, e]) => ({ meetingId, ...e }))
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
  return {
    enabled: isEnabled(),
    handled: entries.length,
    skipSubjects: SKIP_SUBJECTS,
    recent: entries.slice(0, 20),
  };
}

/** Forget a meeting so the next pass reconsiders it. */
function forget(meetingId) {
  const ledger = readLedger();
  if (!ledger[meetingId]) return { ok: false, reason: 'not_in_ledger' };
  delete ledger[meetingId];
  writeLedger(ledger);
  return { ok: true, meetingId };
}

module.exports = {
  plan,
  apply,
  syncHook,
  status,
  forget,
  isEnabled,
  _internals: {
    skipReason,
    placeBlock,
    attendeesOther,
    createdOrAccepted,
    firstGap,
    pruneLedger,
    blockFor,
    hasBlockAlready,
    acquireLock,
    releaseLock,
    LOCK_KEY,
    LOCK_TTL_MS,
    BLOCK_MINUTES,
    SUBJECT_PREFIX,
    BLOCK_MARKER,
    MAX_CREATE_PER_RUN,
    DAY_END_MIN,
    STATE_KEY,
  },
};
