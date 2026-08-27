'use strict';

/**
 * The half-day planner — the thing that puts the work in the diary without
 * being asked.
 *
 * WHY THIS EXISTS. `task-blocks` has been able to block time since 18 Aug and
 * has been used exactly once, for a ten-task test block closed five minutes in.
 * Grep it for `webpush`: no matches. Its only scheduled hook is `sweep()`, which
 * asks "has the outcome note been written yet?" — a detector, not a driver. So
 * the feature could see whether Nick had done the work and could never tell him
 * to start it, and creating a block cost six deliberate steps on a desktop
 * screen he had to remember existed. Nick's own words on finding it again:
 * "I forgot we had that."
 *
 * Vantage's README states the constraint this is built against: his difficulty
 * is INITIATION, not knowledge, and "anything that raises awareness without
 * lowering the barrier is the wrong shape". A planner that proposes and waits
 * raises awareness. One that has already put the blocks in the diary lowers the
 * barrier. That is the whole design.
 *
 * THE HALF-DAY HORIZON is Nick's call (27 Aug): plan the morning at 07:15, plan
 * the afternoon at lunch. It is better than planning a whole day at dawn,
 * because his diary moves under him — an afternoon planned at 07:15 is planned
 * against a calendar that no longer exists by 13:00.
 *
 * Split like `pi-health.assess()` / `state-of-play`: `planWindow()` is PURE and
 * holds every judgement worth pinning; `run()` does the I/O and the writing.
 */

const db = require('../db/database');
const taskBlocks = require('./task-blocks');
const timeFit = require('./time-fit');

// ── Windows ──────────────────────────────────────────────────────────────────

// The two halves. AFTERNOON starts at 13:00 rather than 12:00 so the planner
// never books over the middle of lunch; task-blocks' own 09:00-17:30 bounds
// still apply underneath.
const MORNING = { key: 'morning', label: 'this morning', startMin: 9 * 60, endMin: 13 * 60 };
const AFTERNOON = { key: 'afternoon', label: 'this afternoon', startMin: 13 * 60, endMin: 17 * 60 + 30 };
const WINDOWS = { morning: MORNING, afternoon: AFTERNOON };

// Don't propose a block that starts before Nick could plausibly act on it.
const LEAD_MINUTES = 15;

// A window shorter than this is not worth blocking — it is the gap between two
// meetings, not a place to do a job.
const MIN_BLOCK_MINUTES = 20;

// The most any one auto-created block may run. Beyond this it stops being a
// focus block and becomes "the afternoon", which is not a commitment anyone
// keeps. Longer stretches are split into separate blocks with separate tasks.
const MAX_BLOCK_MINUTES = 90;

// How many blocks a half-day may have. Three is already an ambitious morning,
// and a planner that fills every gap leaves no room for the day to happen.
const MAX_BLOCKS_PER_HALF = 2;

// Tasks per block. The single block ever created by hand held TEN tasks in a
// thirty-minute window; that is the failure this cap exists to prevent, because
// a block that cannot possibly be finished teaches Nick that blocks do not work.
const MAX_TASKS_PER_BLOCK = 3;

// ── The estimate multiplier ──────────────────────────────────────────────────

// Nick's estimates are not merely imprecise, they are BIASED, and in one
// direction. The only two real focus sessions NEURO has recorded both overran:
// 30 planned / 44 actual (1.47x) and 30 planned / 111 actual (3.7x). Nothing
// consumed that until now — `time-fit` still assumes a flat 30 minutes, so
// every block it sized was sized against a number already known to be wrong.
//
// Applied to the ASSUMED duration only, never to a figure Nick typed. An
// explicit estimate is a statement; silently inflating it is the planner
// disagreeing with him in his own calendar.
const DEFAULT_MULTIPLIER = 2.5;

// Below this many samples the multiplier is not measured, it is inherited — and
// the difference is reported rather than hidden.
const MIN_SAMPLES_FOR_LEARNED = 5;

/**
 * What Nick's planned-vs-actual ratio actually is, from every finished focus
 * session and completed block. PURE — takes the samples, resolves no clock.
 *
 * Uses the MEDIAN, not the mean: with a handful of samples one 3.7x runaway
 * would drag a mean far enough to make every block absurd, and the point is a
 * usable default rather than a defensive one.
 */
function estimateMultiplier(samples = []) {
  const ratios = samples
    .filter(s => s && s.planned > 0 && s.actual > 0)
    .map(s => s.actual / s.planned)
    .sort((a, b) => a - b);

  if (ratios.length < MIN_SAMPLES_FOR_LEARNED) {
    return {
      multiplier: DEFAULT_MULTIPLIER,
      samples: ratios.length,
      learned: false,
      // Said out loud wherever it is used. A number presented as measured when
      // it is inherited is the same lie as a zero presented as a reading.
      basis: ratios.length
        ? `${ratios.length} sample(s) so far — too few to learn from, using the ${DEFAULT_MULTIPLIER}x default`
        : `no finished sessions yet — using the ${DEFAULT_MULTIPLIER}x default`,
    };
  }

  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  // Clamped: below 1 the planner would start SHRINKING blocks, which cannot be
  // right for someone who has never once finished early, and above 4 a routine
  // job eats the whole morning.
  const multiplier = Math.min(4, Math.max(1, Number(median.toFixed(2))));
  return {
    multiplier,
    samples: ratios.length,
    learned: true,
    basis: `median of ${ratios.length} finished sessions`,
  };
}

// ── The pure planner ─────────────────────────────────────────────────────────

/**
 * Fit ranked tasks into the free gaps of one half-day. Creates nothing, reads
 * nothing — every input is passed in, so the packing rules pin without a DB, a
 * calendar or a clock.
 *
 * `busy` is [{startMin, endMin}] already filtered to this date.
 * `tasks` is in the order they should be attempted — `rankTasks` order, NOT
 * re-sorted by duration, because sorting by duration quietly turns this into the
 * quick-wins list that already exists elsewhere.
 */
function planWindow({
  window,
  tasks = [],
  busy = [],
  nowMin = 0,
  isToday = true,
  multiplier = DEFAULT_MULTIPLIER,
} = {}) {
  const gaps = freeGaps({ window, busy, nowMin, isToday });
  const blocks = [];
  const queue = [...tasks];
  let overflowed = 0;

  for (const gap of gaps) {
    if (blocks.length >= MAX_BLOCKS_PER_HALF) break;
    if (!queue.length) break;

    const capacity = Math.min(gap.endMin - gap.startMin, MAX_BLOCK_MINUTES);
    if (capacity < MIN_BLOCK_MINUTES) continue;

    const picked = [];
    let used = 0;
    while (queue.length && picked.length < MAX_TASKS_PER_BLOCK) {
      const task = queue[0];
      const need = sizeOf(task, multiplier);
      // The first task goes in even if it does not fit, and the block is capped
      // at the gap rather than the task being skipped — a job too big for any
      // gap would otherwise never be scheduled at all, which is precisely the
      // kind of work that has been sitting open for months.
      if (picked.length && used + need > capacity) break;
      picked.push({ ...task, sizedMinutes: need });
      used += need;
      queue.shift();
    }

    if (!picked.length) continue;

    const minutes = Math.max(MIN_BLOCK_MINUTES, Math.min(capacity, used));
    blocks.push({
      startMin: gap.startMin,
      endMin: gap.startMin + minutes,
      minutes,
      tasks: picked,
      // Reported, never refused — the same call task-blocks makes. A block that
      // is tight is Nick's business; a block that pretends to be roomy is not.
      overpacked: used > minutes,
      // True when nothing in here carried a real estimate, so the card can say
      // the duration is a guess rather than presenting it as a measurement.
      assumed: picked.every(t => t.estimateMinutes == null),
    });
  }

  overflowed = queue.length;

  return {
    window: window.key,
    blocks,
    // What did NOT get planned, and why. A planner reporting only what it did
    // is how work quietly stops being scheduled.
    overflowed,
    gapsFound: gaps.length,
    reason: blocks.length ? null : noRoomReason({ gaps, tasks }),
  };
}

/** How long to allow for one task. Explicit estimates are never inflated. */
function sizeOf(task, multiplier) {
  if (task.estimateMinutes != null) return task.estimateMinutes;
  return Math.round((timeFit.ASSUMED_MINUTES * multiplier) / 5) * 5;
}

/** Free stretches inside the window, honouring the buffer between meetings. */
function freeGaps({ window, busy, nowMin, isToday }) {
  let cursor = window.startMin;
  if (isToday) cursor = Math.max(cursor, Math.ceil((nowMin + LEAD_MINUTES) / 5) * 5);

  const walls = [...busy]
    .filter(b => b && Number.isFinite(b.startMin) && Number.isFinite(b.endMin))
    .sort((a, b) => a.startMin - b.startMin);

  const gaps = [];
  for (const wall of walls) {
    if (wall.endMin <= cursor) { continue; }
    if (wall.startMin > cursor) {
      const end = Math.min(wall.startMin - timeFit.BUFFER_MINUTES, window.endMin);
      if (end - cursor >= MIN_BLOCK_MINUTES) gaps.push({ startMin: cursor, endMin: end });
    }
    cursor = Math.max(cursor, wall.endMin + timeFit.BUFFER_MINUTES);
    if (cursor >= window.endMin) break;
  }
  if (window.endMin - cursor >= MIN_BLOCK_MINUTES) {
    gaps.push({ startMin: cursor, endMin: window.endMin });
  }
  return gaps;
}

function noRoomReason({ gaps, tasks }) {
  if (!tasks.length) return 'nothing open to schedule';
  if (!gaps.length) return 'no free gap in this half of the day';
  return `no gap long enough — the longest is ${Math.max(...gaps.map(g => g.endMin - g.startMin))} minutes`;
}

// ── The run lock ─────────────────────────────────────────────────────────────
//
// NOT optional, and the reason is on the record. When `plaud-admin-blocks` was
// armed, a manual apply overlapped the scheduled pass, both planned against an
// empty ledger, and 27 wanted blocks became 52 real events in Nick's calendar.
// This planner has the identical shape: a cron at 07:15 and 12:30, plus a route
// Nick can hit himself.
//
// Deliberately SYNCHRONOUS with no `await` between reading the key and writing
// it — both contenders are in one Node process and better-sqlite3 is
// synchronous, so that read-modify-write genuinely cannot interleave. It is a
// real mutex here and would NOT be safe across processes.

const LOCK_KEY = 'day_planner_lock';
const LOCK_STALE_MS = 5 * 60 * 1000;

function acquireLock(now) {
  const raw = db.getState(LOCK_KEY);
  if (raw) {
    try {
      const held = JSON.parse(raw);
      if (now.getTime() - new Date(held.at).getTime() < LOCK_STALE_MS) return false;
    } catch { /* a corrupt lock is a stale lock */ }
  }
  db.setState(LOCK_KEY, JSON.stringify({ at: now.toISOString() }));
  return true;
}

function releaseLock() {
  try { db.setState(LOCK_KEY, ''); } catch { /* never fail a run on the lock */ }
}

// ── The ledger ───────────────────────────────────────────────────────────────
//
// One entry per half-day actually planned. A ledger rather than a calendar scan,
// for the reason plaud-admin-blocks learned: deleting a block is a DECISION, and
// a scan recreates it for ever with no way to refuse.

const LEDGER_KEY = 'day_planner_ledger';

function ledger() {
  try { return JSON.parse(db.getState(LEDGER_KEY) || '{}'); } catch { return {}; }
}

function alreadyPlanned(dateKey, windowKey) {
  return Boolean(ledger()[`${dateKey}:${windowKey}`]);
}

/** Stamped per successful half-day, never batched at the end of a multi-step run. */
function stampPlanned(dateKey, windowKey, blockIds) {
  const all = ledger();
  all[`${dateKey}:${windowKey}`] = { at: new Date().toISOString(), blockIds };
  // Bounded — this is a KV blob read on every run.
  const keys = Object.keys(all).sort();
  while (keys.length > 60) delete all[keys.shift()];
  db.setState(LEDGER_KEY, JSON.stringify(all));
}

function forget(dateKey, windowKey) {
  const all = ledger();
  delete all[`${dateKey}:${windowKey}`];
  db.setState(LEDGER_KEY, JSON.stringify(all));
  return true;
}

// ── Gathering (impure) ───────────────────────────────────────────────────────

/**
 * Everything the planner needs, with whether each source ANSWERED.
 *
 * `calendarKnown: false` is not `busy: []`. "I could not read the diary" and
 * "the diary is empty" are different facts, and conflating them here would book
 * focus time over a meeting — the one failure that would end this feature on
 * its first day.
 */
function gather(now = new Date()) {
  const shared = require('../../shared/working-days.cjs');
  const dateKey = shared.toDateStr(now);
  const gaps = [];

  let tasks = [];
  try {
    const taskStore = require('./task-store');
    const { rankTasks } = require('./task-scoring');
    // ⚠ `activeTodos()` returns the LEGACY todo shape, not task rows: the id is
    // `task_id` and the estimate is `estimateMinutes`. Reading `id` /
    // `estimate_minutes` here filtered all 148 open tasks out and the planner
    // reported "nothing open to schedule" against a full backlog — which looks
    // exactly like a quiet day rather than a bug. A file-backed line (Microsoft,
    // a daily note) has a null task_id and genuinely cannot be blocked, so the
    // filter itself is right; it was reading the wrong key.
    tasks = rankTasks(taskStore.activeTodos(), dateKey)
      .map(toPlannerTask)
      .filter(Boolean);
  } catch (e) {
    gaps.push(`tasks unreadable: ${e.message}`);
  }

  let busy = [];
  let calendarKnown = true;
  try {
    for (const row of db.getCalendarEvents(`${dateKey}T00:00:00`, `${dateKey}T23:59:59`)) {
      if (row.is_all_day) continue;
      const showAs = row.show_as || 'busy';
      if (showAs === 'cancelled' || showAs === 'free') continue;
      const startMin = timeFit.minutesIntoDay(row.start_time);
      const endMin = timeFit.minutesIntoDay(row.end_time);
      if (startMin == null || endMin == null) continue;
      busy.push({ startMin, endMin });
    }
  } catch (e) {
    calendarKnown = false;
    gaps.push(`calendar unreadable: ${e.message}`);
  }

  // NEURO's own blocks must count as walls. `calendar_cache` only refreshes on a
  // calendar sync, so a block created ten minutes ago is not in it — without
  // this, planning the afternoon proposes a slot the morning run already took.
  // one-to-one-booking.planAll() learned exactly this.
  try {
    for (const block of db.listTaskBlockRows({ statuses: ['scheduled', 'awaiting-writeup', 'complete'] })) {
      if (block.date_key !== dateKey) continue;
      const startMin = timeFit.minutesIntoDay(`${block.date_key}T${block.start_time}:00`);
      const endMin = timeFit.minutesIntoDay(`${block.date_key}T${block.end_time}:00`);
      if (startMin != null && endMin != null) busy.push({ startMin, endMin });
    }
  } catch (e) {
    gaps.push(`existing blocks unreadable: ${e.message}`);
  }

  return { dateKey, tasks, busy, calendarKnown, gaps, samples: durationSamples() };
}

/**
 * One entry from `task-store.activeTodos()` into what the planner packs, or
 * null if it cannot be blocked. PURE, and exported, because getting it wrong is
 * SILENT.
 *
 * ⚠ `activeTodos()` returns the LEGACY todo shape, not a task row: the id is
 * `task_id` and the estimate is `estimateMinutes`. The first cut of this read
 * `id` and `estimate_minutes`, which filtered all 148 open tasks out — and the
 * planner then reported "nothing open to schedule" against a full backlog,
 * which reads as a quiet day rather than a bug. Nothing threw and nothing
 * logged; only a dry run against the live server showed it.
 *
 * Dropping a null `task_id` is correct and stays: a file-backed line (a
 * Microsoft task, a daily-note checkbox) is owned elsewhere and task-blocks
 * cannot schedule it.
 */
function toPlannerTask(todo) {
  if (!todo || !Number.isInteger(todo.task_id)) return null;
  return {
    id: todo.task_id,
    text: todo.text,
    estimateMinutes: todo.estimateMinutes ?? null,
  };
}

/** Planned-vs-actual pairs from every finished focus session and closed block. */
function durationSamples() {
  const out = [];
  try {
    const history = JSON.parse(db.getState('focus_session_history') || '[]');
    for (const s of history) {
      if (s?.plannedMinutes > 0 && s?.actualMinutes > 0) {
        out.push({ planned: s.plannedMinutes, actual: s.actualMinutes });
      }
    }
  } catch { /* no history is not an error */ }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

// ⚠ DEFAULT OFF. This writes real events into a real calendar on a timer. It is
// armed with one env var once Nick has seen a dry run he agrees with — arming a
// scheduled calendar-writer unattended is how 52 duplicate blocks happened.
const ENABLED = process.env.DAY_PLANNER_ENABLED === 'true';

/**
 * Plan one half of today and, if applying, create the blocks.
 *
 * `apply` defaults FALSE, so calling this looks and creates nothing — the same
 * two-step as event-parser, one-to-one-booking and task-blocks itself.
 */
async function run(windowKey, { now = new Date(), apply = false, force = false } = {}) {
  const window = WINDOWS[windowKey];
  if (!window) return { ok: false, error: `unknown window "${windowKey}"` };

  const shared = require('../../shared/working-days.cjs');
  const dateKey = shared.toDateStr(now);

  if (!shared.isWorkingDay(now, nonWorkingSet())) {
    return { ok: true, skipped: 'not a working day', dateKey, window: windowKey, blocks: [] };
  }

  // Nick's own booked leave. This writes real events into a real calendar on a
  // timer, so a day off must stop it — filling a holiday with focus blocks is
  // the most visible way this feature could embarrass itself.
  //
  // Checked ONLY when it can be checked: `known:false` carries on and plans as
  // before, the same fail-open call the nudge path makes. Silently planning
  // nothing because the bridge was down would look exactly like a quiet day.
  try {
    const availability = require('./team-availability');
    const mine = availability.selfAbsenceOn(dateKey, availability.snapshot(now));
    if (mine.off) {
      return {
        ok: true,
        skipped: `on leave — ${mine.detail || mine.status.replace(/_/g, ' ')}`,
        dateKey, window: windowKey, blocks: [],
      };
    }
  } catch (e) {
    console.warn('[DayPlanner] Could not check leave, planning anyway:', e.message);
  }

  const input = gather(now);
  const mult = estimateMultiplier(input.samples);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Refuse to plan blind. A planner that cannot see the diary and books anyway
  // is worse than no planner.
  if (!input.calendarKnown) {
    return { ok: false, error: 'calendar could not be read — refusing to plan blind', gaps: input.gaps };
  }

  const draft = planWindow({
    window,
    tasks: input.tasks,
    busy: input.busy,
    nowMin,
    isToday: true,
    multiplier: mult.multiplier,
  });

  const result = {
    ok: true,
    dateKey,
    window: windowKey,
    label: window.label,
    multiplier: mult,
    gaps: input.gaps,
    applied: false,
    ...draft,
  };

  if (!apply) return result;
  if (!ENABLED && !force) return { ...result, skipped: 'DAY_PLANNER_ENABLED is not true' };
  if (!force && alreadyPlanned(dateKey, windowKey)) {
    return { ...result, skipped: 'already planned this half-day' };
  }
  if (!draft.blocks.length) return result;

  if (!acquireLock(now)) {
    return { ...result, skipped: 'another planner run is in progress' };
  }

  const created = [];
  const failed = [];
  try {
    for (const block of draft.blocks) {
      try {
        const res = await taskBlocks.schedule(block.tasks.map(t => t.id), {
          date: dateKey,
          startTime: hhmm(block.startMin),
          minutes: block.minutes,
          // NOT written back as the task's estimate. This window was sized by
          // multiplying an assumption; storing it would launder a guess into a
          // measurement, which is the one thing #87 rules out. The real number
          // comes from the end-of-block prompt, where the answer is known.
          saveEstimates: false,
          now,
        });
        if (res.ok) {
          created.push({ blockId: res.blockId ?? null, startTime: hhmm(block.startMin), tasks: block.tasks });
          // Stamped per successful create, never batched at the end — a crash
          // mid-run would otherwise duplicate everything on the next pass.
          stampPlanned(dateKey, windowKey, created.map(c => c.blockId));
        } else {
          failed.push({ startTime: hhmm(block.startMin), error: res.error });
        }
      } catch (e) {
        // Fault-isolated: these are real calendar writes and one failure must
        // not abandon the rest.
        failed.push({ startTime: hhmm(block.startMin), error: e.message });
      }
    }
  } finally {
    releaseLock();
  }

  if (created.length) await announce(window, created, mult);

  return { ...result, applied: true, created, failed };
}

/**
 * Bank holidays, or null. Null means plain Mon-Fri, which is the documented
 * behaviour of `isWorkingDay` with no set — deliberately NOT fail-open in the
 * dangerous direction, because the failure this guards is booking focus time on
 * Christmas Day, and `working-days` already falls back through cache to a
 * compiled-in floor rather than to "every weekday works".
 */
function nonWorkingSet() {
  try { return require('./working-days').holidaySet(); }
  catch { return null; }
}

/**
 * Tell him. This is the half `task-blocks` never had, and the reason it was
 * never used: a block nobody is told about is a calendar entry, not a driver.
 */
async function announce(window, created, mult) {
  try {
    const webpush = require('./webpush');
    const lines = created.map(c => {
      const names = c.tasks.map(t => t.text).join('; ');
      return `${c.startTime} — ${names}`;
    });
    const caveat = mult.learned ? '' : ` (durations are a ${mult.multiplier}x guess for now)`;
    await webpush.sendToAll(
      `Planned ${window.label}`,
      `${lines.join('\n')}${caveat}`,
      { type: 'day_plan', tab: 'todos' }
    );
  } catch (e) {
    // A failed notification must never fail the plan — the blocks are already
    // in the diary and reporting failure would say they were not.
    console.warn('[DayPlanner] Could not announce the plan:', e.message);
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

module.exports = {
  MORNING,
  AFTERNOON,
  WINDOWS,
  ENABLED,
  run,
  gather,
  toPlannerTask,
  durationSamples,
  MAX_BLOCKS_PER_HALF,
  MAX_TASKS_PER_BLOCK,
  MAX_BLOCK_MINUTES,
  MIN_BLOCK_MINUTES,
  DEFAULT_MULTIPLIER,
  // pure, and the half worth pinning
  planWindow,
  estimateMultiplier,
  freeGaps,
  sizeOf,
  // state
  alreadyPlanned,
  stampPlanned,
  forget,
  ledger,
  _acquireLock: acquireLock,
  _releaseLock: releaseLock,
};
