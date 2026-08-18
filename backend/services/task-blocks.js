'use strict';

/**
 * Task blocks — a NEURO task pushed into the O365 calendar, and the write-up
 * that decides when it is actually finished (18 Aug 2026).
 *
 * Two halves, and the second is the point.
 *
 * **Pushing the task out.** `tasks` already knows how long a thing takes
 * (`estimate_minutes`, #87) and `calendar_cache` already knows where the diary
 * is empty. Nothing joined them, so "block an hour for this" was a manual copy
 * between two systems NEURO owns both ends of. `schedule()` creates the event
 * on Nick's own calendar with NO attendees, which is why it can run on a plain
 * confirm rather than through the queued/approve gate that `schedule_focus_block`
 * uses in chat: a solo block emails nobody, so there is nothing to un-send.
 *
 * **Deciding when it is done.** Yesterday's rule, from `meeting-notes-source`:
 * *a meeting in the diary does not mean Nick attended it* — the Plaud note is
 * what proves both that he was there and that the meeting was processed. A time
 * block has the identical hole and no recording to close it, because nobody
 * Plauds a solo work block. So the evidence is an outcome note Nick writes, and
 * until one lands the task **holds at `awaiting-writeup` rather than going
 * done** (Nick's call, 18 Aug). That hold is enforced in `task-store.updateTask`,
 * the single writer, so it cannot be walked around by the SARA completion
 * funnel, the MCP tool, the chat tool or the route.
 *
 * Three refusals carry the design:
 *
 * 1. **An empty stub does not release the task.** NEURO writes the note, so a
 *    detector that only checks the file EXISTS would create the evidence for its
 *    own test and mark the work done with nothing in it — the feature failing in
 *    the exact silent way it exists to prevent. `isOutcomeWritten()` strips the
 *    template it wrote and requires real prose underneath.
 *
 * 2. **The hold is always escapable, and the escape is recorded.** Plans change,
 *    blocks get abandoned, some work genuinely has no outcome worth writing up.
 *    A hold with no way out would wedge a task in Nick's list forever, and the
 *    first time that happened he would stop using the feature. `release()` takes
 *    a REASON and stores it — a `released` block is a decision on the record,
 *    deliberately distinct from a `complete` one that earned its note.
 *
 * 3. **Nothing rescans the calendar.** Idempotency is the unique (task, day,
 *    start) index plus the block rows, never a sweep of Outlook — deleting the
 *    block in Outlook is a decision, and a scan would recreate it forever with
 *    no way to refuse. That is `plaud-admin-blocks`'s ledger lesson, unchanged.
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/database');
const timeFit = require('./time-fit');
const { readFrontmatter } = require('./meeting-notes-source');

// Where the outcome notes live. A folder of their own, mirroring `Meetings/` —
// the same shape of record for the same reason, and separately walkable so the
// release check is a cheap local read rather than a scan of the whole vault.
const OUTCOMES_DIR = 'Tasks/Outcomes';

// Everything between these is template NEURO wrote. Stripped before deciding
// whether anything is there. A marker rather than "strip blockquotes", because
// Nick quoting something in his own write-up must still count as written.
const STUB_OPEN = '<!-- neuro:task-outcome-stub -->';
const STUB_CLOSE = '<!-- /neuro:task-outcome-stub -->';

// The checklist of what a batch held. Fenced SEPARATELY from the stub because
// the two have opposite lifetimes: the stub's instructions are scaffolding Nick
// may delete, while the checklist is the record of what the window contained and
// should survive into the finished note.
//
// ⚠ It must still be stripped before measuring, and this is the trap worth
// naming: the checklist is real text, so an unfenced one would read as prose and
// release every batch the moment it was created — the empty-stub bug back again,
// wearing a different hat. Ticking boxes is not a summary either, so a fully
// ticked list still does not clear the bar.
const LIST_OPEN = '<!-- neuro:task-outcome-list -->';
const LIST_CLOSE = '<!-- /neuro:task-outcome-list -->';

const FENCES = [[STUB_OPEN, STUB_CLOSE], [LIST_OPEN, LIST_CLOSE]];

/**
 * How much prose counts as a write-up.
 *
 * Not measured — there is no corpus of task outcomes to measure against yet,
 * this being the thing that creates one. Picked to sit above the failure it
 * guards: "done", "yes", "n/a" and a stray heading are all under it, while one
 * honest sentence clears it comfortably. Erring low on purpose — the job here is
 * to catch an EMPTY stub, not to grade Nick's writing, and a threshold that
 * rejects a genuine two-line summary would be a worse bug than one that lets a
 * terse one through.
 */
const MIN_OUTCOME_CHARS = 25;

// The working day a block may be placed in. Deliberately NOT one-to-one-booking's
// AM/PM windows — those exist to keep 1-2-1s out of Nick's mornings and away from
// lunch, which is a rule about meetings with other people in them. Focused work
// has no such constraint and the 10:00-12:00 / 14:00-16:30 pair would refuse most
// of the day for no reason.
const DAY_START_MIN = 9 * 60;         // 09:00
const DAY_END_MIN = 17 * 60 + 30;     // 17:30

// Don't offer a slot that starts in the next few minutes — by the time Nick has
// read the suggestion and confirmed it, it has already started.
const LEAD_MINUTES = 10;

// How far ahead to look before giving up. Beyond a fortnight, "there is no room"
// is a more useful answer than a slot Nick will never keep.
const SEARCH_DAYS = 14;

function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
function toMin(hhmmStr) {
  const m = String(hhmmStr || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── The outcome note ─────────────────────────────────────────────────────────

/**
 * Is there a real write-up in this note, or is it still the stub NEURO wrote?
 *
 * PURE — takes the raw file text and nothing else, so the rule that decides
 * whether a task is finished pins without a vault, a DB or a clock. Same split
 * as `pi-health.assess()` and `cadenceState()`.
 */
function isOutcomeWritten(raw) {
  if (raw == null) return { written: false, chars: 0, reason: 'no note' };

  // CRLF first. The vault is authored on Windows and `\r` is a JS line
  // terminator, so an anchored regex silently fails on every line of it —
  // meeting-notes-source and one-to-one-detect both learned this the hard way.
  let text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  text = text.replace(/^---\n[\s\S]*?\n---/, ' ');                 // frontmatter
  // Everything NEURO wrote and fenced. Split rather than regex so an unclosed
  // fence drops the remainder instead of matching nothing and letting the whole
  // template through — failing towards "not written" is the safe direction.
  for (const [open, close] of FENCES) {
    text = text.split(open).map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf(close);
      return end === -1 ? '' : part.slice(end + close.length);
    }).join(' ');
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');                     // any other comment
  text = text.replace(/^#{1,6}[^\n]*$/gm, ' ');                     // headings are scaffolding
  text = text.replace(/^\s*[-*+]\s*(\[[ xX]\])?\s*$/gm, ' ');       // an empty bullet is not content
  text = text.replace(/\s+/g, ' ').trim();

  const chars = text.length;
  return {
    written: chars >= MIN_OUTCOME_CHARS,
    chars,
    reason: chars === 0 ? 'stub is empty'
      : chars < MIN_OUTCOME_CHARS ? `only ${chars} characters written`
      : null,
  };
}

/**
 * How long the block should be, and how sure we are of it.
 *
 * Precedence: what Nick asked for → the sum of the tasks' estimates → the
 * assumption. An explicit choice is never second-guessed and never snapped: the
 * block is a real window in a real diary, and a 45-minute request that silently
 * became an hour would be the feature quietly disagreeing with him. The BUCKETS
 * are for the estimate written back onto the task, not for the window.
 *
 * `assumed` is true only when nothing knew — an explicit request and a real sum
 * are both answers, and only a guess should be labelled as one.
 */
function resolveWindow(tasks, requestedMinutes) {
  if (Number.isFinite(requestedMinutes) && requestedMinutes > 0) {
    return { minutes: Math.round(requestedMinutes), assumed: false, basis: 'requested' };
  }
  const estimates = tasks.map(t => t.estimate_minutes);
  if (estimates.length && estimates.every(e => e != null)) {
    return { minutes: estimates.reduce((a, b) => a + b, 0), assumed: false, basis: 'estimates' };
  }
  // Partly estimated still counts as not knowing: filling the gaps with the
  // assumption and presenting the total as a sum would launder a guess into a
  // measurement, which is the one thing #87 rules out.
  const minutes = estimates.reduce((sum, e) => sum + (e == null ? timeFit.ASSUMED_MINUTES : e), 0)
    || timeFit.ASSUMED_MINUTES;
  return { minutes, assumed: true, basis: 'assumed' };
}

/**
 * The checklist of what the window holds, with the boxes reflecting what has
 * actually been ticked.
 *
 * The box carries a real meaning — it IS the tick — so it is written from
 * `awaiting` rather than always empty. A checklist that stays blank while the
 * card shows three ticked is two screens disagreeing about the same fact, and
 * the one Nick is typing into is the one that looks wrong.
 *
 * Each line carries its task id in a comment. Obsidian renders HTML comments
 * invisibly, so it costs nothing on screen and makes reading the boxes back
 * exact — matching on the text alone breaks the moment a line is reworded, and
 * failing to match would silently drop a tick.
 */
function renderChecklist(tasks) {
  return [
    LIST_OPEN,
    ...tasks.map(t => `- [${t.awaiting ? 'x' : ' '}] ${t.text} <!--t:${t.id}-->`),
    LIST_CLOSE,
  ];
}

/**
 * Read the boxes back out of a note.
 *
 * Returns a Map of task id → ticked. Only lines carrying an id comment are
 * trusted; a line Nick has reworded past recognition is left alone rather than
 * guessed at, because a wrong guess here completes the wrong task.
 */
function parseChecklist(raw) {
  const ticks = new Map();
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const start = text.indexOf(LIST_OPEN);
  if (start === -1) return ticks;
  const end = text.indexOf(LIST_CLOSE, start);
  const body = end === -1 ? text.slice(start) : text.slice(start, end);

  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*+]\s*\[([ xX])\][\s\S]*?<!--\s*t:(\d+)\s*-->/);
    if (!m) continue;
    ticks.set(Number(m[2]), m[1].toLowerCase() === 'x');
  }
  return ticks;
}

/**
 * Rewrite just the checklist region of an existing note, leaving every other
 * line exactly as Nick left it.
 *
 * Surgical rather than a re-render of the whole file, following vault-hygiene:
 * the note may already hold his write-up, and regenerating it wholesale to fix
 * some checkboxes would throw that away.
 */
function syncChecklistInNote(raw, tasks) {
  const text = String(raw || '');
  const start = text.indexOf(LIST_OPEN);
  if (start === -1) return text;
  const end = text.indexOf(LIST_CLOSE, start);
  if (end === -1) return text;
  return text.slice(0, start) + renderChecklist(tasks).join('\n') + text.slice(end + LIST_CLOSE.length);
}

/** Filesystem-safe, readable, and short enough not to hit Windows path limits. */
function slugify(text) {
  return String(text || 'task')
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[\s.]+$/, '') || 'task';
}

/**
 * Vault-relative path for a block's outcome note. Pure.
 *
 * One note per BLOCK, so a batch is named for the sitting rather than for
 * whichever task happened to be first — naming it after one of four would make
 * the other three look like an afterthought in the folder listing.
 */
function outcomeNotePath(tasks, dateKey, startTime = null) {
  const [year, month] = String(dateKey).split('-');
  const list = Array.isArray(tasks) ? tasks : [tasks];
  const name = list.length === 1
    ? slugify(list[0].text)
    // The time disambiguates two batches on one day, where the task names cannot.
    : `Focus block ${String(startTime || '').replace(':', '')} (${list.length} tasks)`;
  return `${OUTCOMES_DIR}/${year}/${month}/${dateKey} ${name}.md`;
}

/**
 * The stub. Says plainly that the tasks are being held and what closes the hold —
 * a note that does not explain why it exists is one Nick finds three weeks later
 * and deletes.
 *
 * A batch gets a checklist of what was in the window. That list is the actual
 * value of the note for a batch: three weeks later "what did I get through in
 * that half hour" is the question, and the individual task names are the answer.
 */
function renderStub(tasks, block) {
  const list = Array.isArray(tasks) ? tasks : [tasks];
  const many = list.length > 1;
  const title = many
    ? `Focus block — ${list.length} tasks`
    : list[0].text;

  return [
    '---',
    'type: task-outcome',
    // A LIST always, even for one, so the reader and `findOutcomeByTaskIds`
    // never need two shapes. `task_id` stays for a single task because that is
    // what the first notes were written with.
    `task_ids: [${list.map(t => t.id).join(', ')}]`,
    ...(many ? [] : [`task_id: ${list[0].id}`]),
    `date: ${block.date_key}`,
    `block: ${block.date_key}T${block.start_time}`,
    `minutes: ${block.minutes}`,
    '---',
    '',
    `# ${title}`,
    '',
    STUB_OPEN,
    `> Blocked ${block.start_time}–${block.end_time} on ${block.date_key}.`,
    many
      ? '> These tasks stay open in NEURO until there is a real summary below —'
      : '> This task stays open in NEURO until there is a real summary below —',
    '> a couple of lines on what came of it is enough. Nothing to write up?',
    '> Release it from the task list and say why.',
    STUB_CLOSE,
    '',
    // Inside the fence would be wrong: the checklist is a record of what the
    // window held, and it must survive into the finished note rather than being
    // stripped as template.
    ...(many
      ? ['## In this block', ...renderChecklist(list), '']
      : []),
    '## What came of it',
    '',
    '',
    '## What is next',
    '',
    '',
  ].join('\n');
}

function vaultRoot() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

/**
 * Read a block's outcome note.
 *
 * The stored path is the fast path. The fallback is a scan of `Tasks/Outcomes/`
 * for the task id in frontmatter, because Obsidian renames and moves files and
 * the record must survive that — the same reason meeting-notes-source keys on
 * the recording rather than the path.
 *
 * Returns `{ raw, foundPath, error }`. An unreadable VAULT is an error, never an
 * absent note: "Nick has not written it up" and "the vault is not mounted" are
 * different facts and only one of them should hold a task open.
 */
function readOutcomeNote(block) {
  const root = vaultRoot();
  if (!root) return { raw: null, foundPath: null, error: 'OBSIDIAN_VAULT_PATH not set' };
  if (!fs.existsSync(root)) return { raw: null, foundPath: null, error: 'vault path not readable' };

  const direct = path.join(root, block.note_path);
  try {
    if (fs.existsSync(direct)) {
      return { raw: fs.readFileSync(direct, 'utf8'), foundPath: block.note_path, error: null };
    }
  } catch (e) {
    return { raw: null, foundPath: null, error: e.message };
  }

  // Moved or renamed — find it by the ids it carries.
  const taskIds = db.listTaskBlockItems(block.id).map(i => i.task_id);
  const found = findOutcomeByTaskIds(root, taskIds, block.date_key);
  if (found) return { raw: found.raw, foundPath: found.relPath, error: null };
  return { raw: null, foundPath: null, error: null };
}

/** Does this note's frontmatter claim any of these task ids? */
function noteClaimsTask(fm, taskIds) {
  if (!fm) return false;
  const wanted = taskIds.map(String);
  // `task_ids: [58, 61]` — parseFrontmatter hands back the raw string, so the
  // numbers are pulled out rather than parsed as YAML.
  const listed = String(fm.task_ids || '').match(/\d+/g) || [];
  if (listed.some(id => wanted.includes(id))) return true;
  return fm.task_id != null && wanted.includes(String(fm.task_id));
}

function findOutcomeByTaskIds(root, taskIds, dateKey) {
  const base = path.join(root, OUTCOMES_DIR);
  if (!fs.existsSync(base)) return null;

  const walk = (dir, depth) => {
    if (depth > 4) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const fm = readFrontmatter(raw);
      if (!noteClaimsTask(fm, taskIds)) continue;
      // A task can sit in several blocks; match the one this note was written
      // for when the note says, and accept it otherwise (an older note carrying
      // no block date is still that block's write-up).
      if (fm.date && dateKey && String(fm.date).slice(0, 10) !== dateKey) continue;
      return { raw, relPath: path.relative(root, full).replace(/\\/g, '/') };
    }
    return null;
  };

  return walk(base, 0);
}

/** Write the stub. Never overwrites — a note Nick has already touched is his. */
function writeStub(task, block) {
  const root = vaultRoot();
  if (!root) return { written: false, reason: 'OBSIDIAN_VAULT_PATH not set' };

  const full = path.join(root, block.note_path);
  try {
    if (fs.existsSync(full)) return { written: false, reason: 'note already exists' };
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, renderStub(task, block), 'utf8');
    return { written: true, reason: null };
  } catch (e) {
    return { written: false, reason: e.message };
  }
}

// ── Finding a slot ───────────────────────────────────────────────────────────

/**
 * First slot of `minutes` that fits.
 *
 * PURE given its inputs: `events` are calendar_cache rows already mapped to
 * time-fit's shape, `nonWorking` is a Set of YYYY-MM-DD from working-days. No
 * DB, no network, no clock beyond the `now` it is handed — so the placement
 * rules pin without a diary.
 *
 * Returns `{ date, startTime, endTime }` or `{ reason }`. Deliberately returns a
 * REASON rather than null: "your next fortnight is solid" and "I could not read
 * the diary" are different answers and the caller has to be able to say which.
 */
function findSlot({ minutes, events = [], now = new Date(), nonWorking = null } = {}) {
  const need = minutes + timeFit.BUFFER_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) return { reason: 'no duration' };

  const shared = require('../../shared/working-days.cjs');
  const byDay = new Map();
  for (const ev of events || []) {
    if (!ev || ev.isAllDay) continue;
    // Cancelled and free-marked events are not walls, tentative ones are — the
    // same call time-fit makes, so the two cannot disagree about the diary.
    if (ev.showAs === 'cancelled' || ev.showAs === 'free') continue;
    const start = timeFit.minutesIntoDay(ev.start);
    const end = timeFit.minutesIntoDay(ev.end);
    if (start == null || end == null) continue;
    const day = String(ev.date || String(ev.start).split('T')[0]);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push([start, end]);
  }

  let sawWorkingDay = false;
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = shared.addDays(now, i);
    const dateKey = shared.toDateStr(day);
    if (!shared.isWorkingDay(day, nonWorking)) continue;
    sawWorkingDay = true;

    // Today starts from now (plus enough lead to actually confirm it), rounded
    // up to the next five minutes so the block lands on a readable time.
    let cursor = DAY_START_MIN;
    if (i === 0) {
      const nowMin = now.getHours() * 60 + now.getMinutes() + LEAD_MINUTES;
      cursor = Math.max(cursor, Math.ceil(nowMin / 5) * 5);
    }

    const busy = (byDay.get(dateKey) || []).sort((a, b) => a[0] - b[0]);
    for (const [start, end] of busy) {
      if (start - cursor >= need) break;
      cursor = Math.max(cursor, end);
    }
    if (cursor + need <= DAY_END_MIN) {
      return { date: dateKey, startTime: hhmm(cursor), endTime: hhmm(cursor + minutes) };
    }
  }

  return {
    reason: sawWorkingDay
      ? `no ${minutes}-minute gap in the next ${SEARCH_DAYS} days`
      : 'no working day in the search window',
  };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Resolve and validate the tasks going into a block.
 *
 * Refuses the whole thing rather than silently dropping one: a batch that
 * quietly blocked three of the four Nick picked would leave the fourth open with
 * no sign it was ever meant to be in there.
 */
function resolveTasks(taskIds) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [taskIds])
    .map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return { error: 'at least one task is required' };

  const tasks = [];
  for (const id of ids) {
    const task = db.getTaskRow(id);
    if (!task) return { error: `No task #${id}` };
    if (task.status === 'done' || task.status === 'dropped') {
      return { error: `Task #${id} is ${task.status}` };
    }
    tasks.push(task);
  }
  return { tasks };
}

/**
 * What WOULD be created. Reads the diary, creates nothing — the same two-step as
 * `event-parser` and `one-to-one-booking.propose()`, so the slot can be seen and
 * changed before an event exists.
 *
 * `minutes` is the window Nick asked for. `taskIds` may be one or many.
 */
function plan(taskIds, { date = null, startTime = null, minutes = null, now = new Date() } = {}) {
  const resolved = resolveTasks(taskIds);
  if (resolved.error) return { ok: false, error: resolved.error };
  const tasks = resolved.tasks;

  const window = resolveWindow(tasks, minutes);
  const estimated = tasks.reduce((sum, t) => sum + (t.estimate_minutes || 0), 0);
  const unestimated = tasks.filter(t => t.estimate_minutes == null).length;

  const shape = (slot, chosen, extra = {}) => ({
    ok: true,
    tasks: tasks.map(t => ({
      id: t.id,
      text: t.text,
      estimateMinutes: t.estimate_minutes,
      // Stated per task, not just in aggregate — the row Nick has to fix is the
      // one without a number on it.
      assumed: t.estimate_minutes == null,
    })),
    slot,
    minutes: window.minutes,
    minutesAssumed: window.assumed,
    minutesBasis: window.basis,
    assumedMinutes: window.assumed ? timeFit.ASSUMED_MINUTES : null,
    // What the window holds versus how long it is. Nick chooses the window, so
    // this is reported rather than enforced — a deliberately roomy block is a
    // normal thing to want.
    estimatedMinutes: estimated,
    unestimatedTasks: unestimated,
    overpacked: estimated > window.minutes,
    chosen,
    notePath: outcomeNotePath(tasks, slot.date, slot.startTime),
    ...extra,
  });

  // An explicit slot is Nick's decision and is not second-guessed against the
  // diary — he can see his own calendar, and refusing a deliberate choice is how
  // a scheduling tool becomes something you fight.
  if (date && startTime) {
    const start = toMin(startTime);
    if (start == null) return { ok: false, error: 'startTime must be HH:MM' };
    return shape({ date, startTime, endTime: hhmm(start + window.minutes) }, 'explicit');
  }

  const events = readCalendar(now);
  const workingDays = require('./working-days');
  const slot = findSlot({
    minutes: window.minutes,
    events: events.rows,
    now,
    nonWorking: workingDays.holidaySet(),
  });
  if (slot.reason) {
    return { ok: false, error: slot.reason, calendarKnown: events.known };
  }

  // "I can't see the diary" must stay distinct from "you're free" — #87's rule,
  // and here it decides whether the proposed slot is worth anything at all.
  return shape(slot, 'proposed', { calendarKnown: events.known });
}

/**
 * The diary as far as slot-finding is concerned: Graph's cached events PLUS the
 * blocks NEURO has already placed itself.
 *
 * That second half is not belt-and-braces, it is load-bearing. `calendar_cache`
 * only refreshes on a calendar sync, so a block created a minute ago is not in
 * it — and if Graph refused the event, it never will be. Without this, blocking
 * two tasks in a row proposes the SAME slot twice and the second one is rejected
 * as a duplicate. That is `one-to-one-booking.planAll()`'s lesson word for word:
 * proposing individually hands everyone the same free gap.
 *
 * `released` and `dropped` blocks free their slot again — both are decisions
 * that the time is no longer spoken for.
 */
function readCalendar(now = new Date()) {
  const shared = require('../../shared/working-days.cjs');
  const from = shared.toDateStr(now);
  const to = shared.toDateStr(shared.addDays(now, SEARCH_DAYS));

  let known = true;
  let rows = [];
  try {
    rows = db.getCalendarEvents(`${from}T00:00:00`, `${to}T23:59:59`).map(row => ({
      date: String(row.start_time || '').split('T')[0],
      start: row.start_time,
      end: row.end_time,
      subject: row.subject,
      isAllDay: Boolean(row.is_all_day),
      showAs: row.show_as || 'busy',
    }));
  } catch {
    known = false;
  }

  try {
    for (const block of db.listTaskBlockRows({ statuses: ['scheduled', 'awaiting-writeup', 'complete'] })) {
      if (block.date_key < from || block.date_key > to) continue;
      rows.push({
        date: block.date_key,
        start: `${block.date_key}T${block.start_time}:00`,
        end: `${block.date_key}T${block.end_time}:00`,
        subject: 'NEURO focus block',
        isAllDay: false,
        showAs: 'busy',
      });
    }
  } catch (e) {
    console.warn('[TaskBlocks] Could not read existing blocks for slot search:', e.message);
  }

  return { known, rows };
}

/**
 * Create the block: the Graph event, the outcome stub, and the row that ties
 * them to the task.
 *
 * ORDER MATTERS. The row is written FIRST, before the Graph create, because the
 * unique (task, day, start) index is the only thing standing between a
 * double-click and two identical events in Nick's calendar — and by the time
 * Graph has answered, the duplicate has already been created. A row with a null
 * event_id is recoverable; a duplicate invite is not.
 */
async function schedule(taskIds, {
  date = null, startTime = null, minutes = null, saveEstimates = true, now = new Date(),
} = {}) {
  const draft = plan(taskIds, { date, startTime, minutes, now });
  if (!draft.ok) return draft;

  const resolved = resolveTasks(taskIds);
  const tasks = resolved.tasks;
  const { slot, minutesAssumed } = draft;
  const windowMinutes = draft.minutes;
  const notePath = draft.notePath;

  let blockId;
  try {
    blockId = db.createTaskBlockRow({
      date_key: slot.date,
      start_time: slot.startTime,
      end_time: slot.endTime,
      minutes: windowMinutes,
      minutes_assumed: minutesAssumed ? 1 : 0,
      note_path: notePath,
      status: 'scheduled',
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      return { ok: false, error: `Something is already blocked at ${slot.startTime} on ${slot.date}`, duplicate: true };
    }
    throw e;
  }

  // Membership, and the estimate write-back. Splitting the window evenly across
  // un-estimated tasks would invent a number per task; instead each keeps what
  // it had, and only a SINGLE-task block learns its duration from the window —
  // there, the window IS the judgement about that task.
  const taskStore = require('./task-store');
  for (const task of tasks) {
    const allotted = tasks.length === 1 ? windowMinutes : (task.estimate_minutes ?? null);
    db.addTaskBlockItem(blockId, task.id, allotted);
    // Writing it back is what closes the estimate gap: 0 of 154 open tasks
    // carried one, because nothing ever asked at a moment Nick was already
    // thinking about duration. Snapped to the coarse buckets on the way in
    // (task-store does that), while the block keeps the exact window.
    if (saveEstimates && allotted != null && task.estimate_minutes == null) {
      try { taskStore.updateTask(task.id, { estimateMinutes: allotted }); }
      catch (e) { console.warn(`[TaskBlocks] Could not save estimate for #${task.id}: ${e.message}`); }
    }
  }

  const block = db.getTaskBlockRow(blockId);
  const stub = writeStub(tasks, block);

  const microsoft = require('./microsoft');
  const result = await microsoft.createCalendarEvent({
    subject: (tasks.length === 1
      ? `Focus: ${tasks[0].text}`
      : `Focus: ${tasks.length} tasks`).slice(0, 200),
    start: `${slot.date}T${slot.startTime}:00`,
    end: `${slot.date}T${slot.endTime}:00`,
    // No attendees, by design. This is Nick's own time — nothing leaves the
    // building, which is what lets this create on a confirm instead of going
    // through the approve gate outbound actions need.
    attendees: [],
    body: [
      ...tasks.map(t => `• ${t.text}  (NEURO #${t.id})`),
      '',
      'This block is not finished until the outcome note has something in it:',
      `  ${stub.written || stub.reason === 'note already exists' ? notePath : '(stub not written — ' + stub.reason + ')'}`,
      '',
      tasks.length === 1
        ? 'The task stays open in NEURO until then.'
        : 'These tasks stay open in NEURO until then.',
    ].join('\n'),
  });

  if (!result.created) {
    // The block row survives with a null event_id. The stub exists, the tasks
    // are still linked, and Nick can retry — losing the row here would leave an
    // orphaned note in the vault with nothing pointing at it.
    console.warn(`[TaskBlocks] Graph create failed for block #${blockId}: ${result.reason}`);
    return {
      ok: false,
      error: `Blocked in NEURO but Outlook refused it (${result.reason})`,
      blockId,
      notePath,
      graphReason: result.reason,
    };
  }

  db.updateTaskBlockRow(blockId, {
    event_id: result.event.id,
    event_web_link: result.event.webLink || null,
  });

  console.log(`[TaskBlocks] Block #${blockId} (${tasks.length} task(s)) at ${slot.date} ${slot.startTime}-${slot.endTime}`);
  return {
    ok: true,
    blockId,
    tasks: draft.tasks,
    slot,
    minutes: windowMinutes,
    minutesAssumed,
    estimatedMinutes: draft.estimatedMinutes,
    overpacked: draft.overpacked,
    notePath,
    noteWritten: stub.written,
    noteReason: stub.reason,
    event: result.event,
  };
}

// ── The hold ─────────────────────────────────────────────────────────────────

/**
 * Is completing this task held, and by which block?
 *
 * Returns the blocking row, or null. Called by `task-store.updateTask` on the
 * transition to 'done' — the one place every completion path funnels through,
 * which is why the hold cannot be walked around by the SARA funnel, the MCP
 * tool, the chat tool or the route.
 *
 * **A vault that cannot be read does NOT hold the task.** That is deliberate and
 * it is the one place this fails open: a Syncthing hiccup or an unmounted disk
 * would otherwise refuse every completion Nick made, in the single screen he
 * uses to find what he owes. The evidence rule is worth enforcing against
 * forgetfulness; it is not worth enforcing against a mount point.
 */
function checkHold(taskId) {
  let blocks;
  try {
    blocks = db.listTaskBlockRows({ taskId, openOnly: true });
  } catch (e) {
    console.warn('[TaskBlocks] Hold check failed:', e.message);
    return null;
  }
  if (!blocks.length) return null;

  for (const block of blocks) {
    const note = readOutcomeNote(block);
    if (note.error) {
      console.warn(`[TaskBlocks] Vault unreadable, not holding task #${taskId}: ${note.error}`);
      return null;
    }
    const verdict = isOutcomeWritten(note.raw);
    if (verdict.written) return null;   // one written-up block is enough
  }

  // Hold on the most recent one — that is the block Nick just worked.
  return { ...blocks[0], holdReason: isOutcomeWritten(readOutcomeNote(blocks[0]).raw).reason };
}

/**
 * Record that this task's tick was held.
 *
 * Marks the ITEM as well as the block. Per item, because a batch of four
 * routinely finishes three: when the note lands, only the ticked ones complete.
 * Completing the rest would mark work done that nobody did.
 */
function markAwaiting(blockId, taskId = null) {
  try {
    db.updateTaskBlockRow(blockId, { status: 'awaiting-writeup' });
    if (taskId != null) db.setTaskBlockItemAwaiting(blockId, taskId, true);
    writeChecklistToNote(blockId);
  } catch (e) {
    console.warn('[TaskBlocks] Could not mark awaiting:', e.message);
  }
}

/**
 * Push the current ticks into the note on disk.
 *
 * ⚠ This is what stops the checklist going stale, and a stale one is actively
 * dangerous rather than merely untidy: the sweep and the editor both READ those
 * boxes, so a checklist still showing everything unticked would take back every
 * tick made on the card. The file has to be updated at the moment of the tick,
 * not only when the note is next opened.
 *
 * It also means the boxes are right in Obsidian, which is where Nick is most
 * likely to see them.
 *
 * Best-effort and never allowed to throw: the tick itself has already been
 * recorded, and an unreachable vault must not turn that into a failure.
 */
function writeChecklistToNote(blockId) {
  const root = vaultRoot();
  if (!root) return;
  const block = db.getTaskBlockRow(blockId);
  if (!block) return;

  const items = db.listTaskBlockItems(blockId);
  if (items.length < 2) return;   // a single-task note carries no checklist

  const note = readOutcomeNote(block);
  if (note.error || note.raw == null) return;

  const tasks = items.map(i => ({
    id: i.task_id,
    text: i.text,
    awaiting: Boolean(i.awaiting) || i.task_status === 'done',
  }));
  const updated = syncChecklistInNote(note.raw, tasks);
  if (updated === note.raw) return;

  try {
    fs.writeFileSync(path.join(root, note.foundPath || block.note_path), updated, 'utf8');
  } catch (e) {
    console.warn(`[TaskBlocks] Could not update the checklist in the note: ${e.message}`);
  }
}

/**
 * Close a block with no note, on purpose.
 *
 * The escape hatch, and it is not optional — see the header. A reason is
 * REQUIRED: `released` has to stay legible as a decision Nick made rather than
 * degrading into a second, quieter way of saying done. `force` on the task
 * completion that follows is what actually lets it through the hold.
 */
function release(blockId, reason, { completeTask = true } = {}) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };
  const why = String(reason || '').trim();
  if (!why) return { ok: false, error: 'A reason is required to release a block without a write-up' };

  db.updateTaskBlockRow(blockId, { status: 'released', release_reason: why });

  // Same rule as the sweep: only what Nick ticked is completed. Releasing a
  // batch he never ticked closes the BLOCK, not the work.
  const completed = [];
  if (completeTask) {
    const taskStore = require('./task-store');
    for (const item of db.listTaskBlockItems(blockId)) {
      if (!item.awaiting) continue;
      taskStore.updateTask(item.task_id, { status: 'done', force: true });
      completed.push(item.task_id);
    }
  }
  console.log(`[TaskBlocks] Block #${blockId} released: ${why}`);
  return { ok: true, block: db.getTaskBlockRow(blockId), completedTaskIds: completed };
}

/**
 * Write the outcome note for a block, on demand.
 *
 * Normally the stub is written when the block is created, so this is a REPAIR
 * action rather than the usual path: it exists for the case where that write
 * failed — the vault was unreachable, Syncthing had not mounted, the path was
 * refused — and for a note Nick has since deleted. Without it, a block whose
 * stub never landed can never be written up and never completes: the task is
 * held for a note there is nowhere to write.
 *
 * ⚠ **It never overwrites.** `writeStub` refuses when the file exists, and that
 * refusal is the whole safety of this button: a "create note" that clobbered an
 * existing file would destroy the write-up the feature exists to protect, in one
 * click, with no undo. An existing note is reported as such, not replaced.
 */
function createNote(blockId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };

  const items = db.listTaskBlockItems(blockId);
  if (!items.length) return { ok: false, error: 'That block has no tasks in it' };

  // The note is keyed on the tasks in the block NOW, so a stub rewritten after a
  // removal lists what is actually in the window.
  const tasks = items.map(i => ({ id: i.task_id, text: i.text }));
  const stub = writeStub(tasks, block);

  if (!stub.written) {
    const existed = stub.reason === 'note already exists';
    return {
      ok: existed,
      created: false,
      notePath: block.note_path,
      reason: stub.reason,
      error: existed ? null : `Could not write the note — ${stub.reason}`,
    };
  }

  console.log(`[TaskBlocks] Outcome note written on demand for block #${blockId}`);
  return { ok: true, created: true, notePath: block.note_path, reason: null };
}

/**
 * The note as it stands, for editing.
 *
 * A missing note comes back as a freshly rendered stub rather than an error —
 * "create" and "edit" are the same act from where Nick is sitting, and making
 * him press a different button first is a step that exists only because of how
 * this is stored.
 *
 * `hash` is what makes saving safe: the vault is also open in Obsidian and
 * synced by Syncthing, so the copy loaded here can go stale while it sits on
 * screen. Sending it back on save turns a silent last-write-wins into a
 * refusal.
 */
function readNoteForEdit(blockId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };

  const items = db.listTaskBlockItems(blockId);
  if (!items.length) return { ok: false, error: 'That block has no tasks in it' };

  const note = readOutcomeNote(block);
  if (note.error) return { ok: false, error: note.error, vaultError: true };

  // A box is ticked if the task is owed a write-up OR is already done. Keying
  // it on `awaiting` alone leaves a finished task showing unticked, because a
  // task completed while the note already had a write-up never holds and so
  // never gets the flag — the box would then contradict the task list.
  const tasks = items.map(i => ({
    id: i.task_id,
    text: i.text,
    awaiting: Boolean(i.awaiting) || i.task_status === 'done',
  }));
  // Bring the boxes up to date with what has actually been ticked before Nick
  // sees them. The checklist was written when the block was created, so without
  // this it shows every task unticked however many he has ticked off since —
  // which is the card and the note disagreeing about the same fact.
  const raw = note.raw != null ? syncChecklistInNote(note.raw, tasks) : renderStub(tasks, block);
  const verdict = isOutcomeWritten(raw);

  return {
    ok: true,
    notePath: note.foundPath || block.note_path,
    raw,
    exists: note.raw != null,
    hash: contentHash(raw),
    written: verdict.written,
    chars: verdict.chars,
    minChars: MIN_OUTCOME_CHARS,
    tasks: items.map(i => ({ taskId: i.task_id, text: i.text, awaiting: Boolean(i.awaiting) })),
  };
}

function contentHash(text) {
  return require('crypto').createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Save the note, then judge it and release the block if it now says something.
 *
 * Three guards, in order of how badly they would hurt:
 *
 * 1. **`baseHash` mismatch refuses the write.** The same file is open in
 *    Obsidian and delivered by Syncthing, so without this a save from a card
 *    left open since this morning silently destroys whatever was written in
 *    Obsidian since. Refusing and saying so is the only honest option — NEURO
 *    cannot merge prose.
 *
 * 2. **Frontmatter is restored if it was removed.** `task_ids` is the link back
 *    to the block; lose it and a renamed note can never be found again. Repaired
 *    rather than refused, because a person editing prose should not have to
 *    understand why the top of the file matters.
 *
 * 3. The release runs immediately rather than waiting for the sweep. The sweep
 *    stays as the mechanism for notes written in Obsidian; here, Nick is looking
 *    at the screen, and a ten-minute wait to find out whether his words counted
 *    is what would make him stop trusting the rule.
 */
function saveNote(blockId, content, { baseHash = null } = {}) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };
  if (!['scheduled', 'awaiting-writeup'].includes(block.status)) {
    return { ok: false, error: `Block #${blockId} is ${block.status} — it is not waiting on a write-up` };
  }

  const root = vaultRoot();
  if (!root) return { ok: false, error: 'OBSIDIAN_VAULT_PATH not set' };

  const existing = readOutcomeNote(block);
  if (existing.error) return { ok: false, error: existing.error };

  if (baseHash != null && existing.raw != null && contentHash(existing.raw) !== baseHash) {
    return {
      ok: false,
      conflict: true,
      error: 'This note changed in the vault since you opened it — reload before saving so nothing is lost',
    };
  }

  let text = String(content ?? '');
  // Restore the frontmatter if it was edited away. Without `task_ids` the note
  // is unfindable once renamed, and the block would hold forever.
  if (!/^---\n[\s\S]*?\n---/.test(text.replace(/\r\n/g, '\n'))) {
    const items = db.listTaskBlockItems(blockId);
    const head = renderStub(items.map(i => ({ id: i.task_id, text: i.text })), block)
      .match(/^---\n[\s\S]*?\n---\n/)[0];
    text = head + '\n' + text.replace(/^\s+/, '');
  }

  const relPath = existing.foundPath || block.note_path;
  const full = path.join(root, relPath);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  } catch (e) {
    return { ok: false, error: `Could not write the note — ${e.message}` };
  }

  // The boxes in the note are ticks. Reading them back is what makes the
  // checklist mean something rather than being decoration — ticking a box while
  // writing the summary is the natural gesture, and it would be lost otherwise.
  // Only lines carrying their task id are trusted, so a reworded line is left
  // alone rather than guessed at.
  const ticks = parseChecklist(text);
  for (const [taskId, ticked] of ticks) {
    try { db.setTaskBlockItemAwaiting(blockId, taskId, ticked); }
    catch (e) { console.warn(`[TaskBlocks] Could not record tick for #${taskId}: ${e.message}`); }
  }
  if (ticks.size) {
    const anyTicked = db.listTaskBlockItems(blockId).some(i => i.awaiting);
    // Keep the block's own state honest with its items, both ways: unticking
    // the last box means nothing is owed, and ticking one means something is.
    if (anyTicked && block.status === 'scheduled') db.updateTaskBlockRow(blockId, { status: 'awaiting-writeup' });
    if (!anyTicked && block.status === 'awaiting-writeup') db.updateTaskBlockRow(blockId, { status: 'scheduled' });
  }

  const verdict = isOutcomeWritten(text);
  const result = {
    ok: true,
    notePath: relPath,
    hash: contentHash(text),
    written: verdict.written,
    chars: verdict.chars,
    minChars: MIN_OUTCOME_CHARS,
    reason: verdict.reason,
    released: false,
    completedTaskIds: [],
    stillOpenTaskIds: [],
  };

  if (!verdict.written) return result;

  // It says something. Same rule as the sweep: only the ticked tasks complete.
  const items = db.listTaskBlockItems(blockId);
  const taskStore = require('./task-store');
  for (const item of items) {
    if (!item.awaiting) {
      // Judged on the task, not the tick: a task can sit in two blocks, and one
      // already finished in the other is not "still open" here.
      if ((db.getTaskRow(item.task_id) || {}).status !== 'done') result.stillOpenTaskIds.push(item.task_id);
      continue;
    }
    try {
      taskStore.updateTask(item.task_id, { status: 'done', force: true });
      result.completedTaskIds.push(item.task_id);
    } catch (e) {
      console.warn(`[TaskBlocks] Could not complete #${item.task_id}: ${e.message}`);
    }
  }
  db.updateTaskBlockRow(blockId, { status: 'complete', note_path: relPath });
  result.released = true;

  console.log(`[TaskBlocks] Block #${blockId} written up in NEURO — ${result.completedTaskIds.length} task(s) completed`);
  return result;
}

/**
 * Take a task back out of a block.
 *
 * The task itself is untouched — it returns to being an ordinary open task. Only
 * its membership goes, along with the hold that came with it: a task no longer
 * in any block has nothing owing a write-up, so it completes normally again.
 *
 * **Removing the last task is refused.** An empty block is a window in the diary
 * for nothing, and a note nobody can write — `drop()` is the honest way to say
 * "this is not happening", and it keeps the decision on the record rather than
 * leaving a husk behind.
 *
 * The Outlook event is corrected afterwards and is **never allowed to fail the
 * removal**: the membership is already gone in NEURO, so reporting failure would
 * say the removal did not happen when it did. What Graph actually did comes back
 * in `eventUpdate` so the caller can say so — the same shape the Microsoft task
 * push uses.
 */
async function removeTask(blockId, taskId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };
  if (!['scheduled', 'awaiting-writeup'].includes(block.status)) {
    return { ok: false, error: `Block #${blockId} is ${block.status} — nothing to remove from` };
  }

  const items = db.listTaskBlockItems(blockId);
  if (!items.some(i => i.task_id === Number(taskId))) {
    return { ok: false, error: `Task #${taskId} is not in this block` };
  }
  if (items.length === 1) {
    return {
      ok: false,
      error: 'That is the only task in the block — drop the block instead',
      lastTask: true,
    };
  }

  db.removeTaskBlockItem(blockId, taskId);
  const remaining = db.listTaskBlockItems(blockId);

  // If nothing ticked is left, the block is back to merely scheduled — it is no
  // longer holding anyone's completion, and leaving it marked otherwise would
  // keep it in the "waiting on you" list for a hold that no longer exists.
  if (block.status === 'awaiting-writeup' && !remaining.some(i => i.awaiting)) {
    db.updateTaskBlockRow(blockId, { status: 'scheduled' });
  }

  let eventUpdate = null;
  if (block.event_id) {
    try {
      const microsoft = require('./microsoft');
      eventUpdate = await microsoft.updateCalendarEvent(block.event_id, {
        subject: (remaining.length === 1
          ? `Focus: ${remaining[0].text}`
          : `Focus: ${remaining.length} tasks`).slice(0, 200),
        body: [
          ...remaining.map(i => `• ${i.text}  (NEURO #${i.task_id})`),
          '',
          'This block is not finished until the outcome note has something in it:',
          `  ${block.note_path}`,
        ].join('\n'),
      });
    } catch (e) {
      eventUpdate = { updated: false, reason: 'error', detail: e.message };
    }
  }

  console.log(`[TaskBlocks] Task #${taskId} removed from block #${blockId} (${remaining.length} left)`);
  return { ok: true, blockId, remaining: remaining.length, eventUpdate };
}

/**
 * Undo a drop.
 *
 * Dropping deletes nothing — the row, the membership, the note and the Outlook
 * event all survive — so putting it back is just the status. It exists because
 * the drop button is one click with a whole block behind it, and a destructive-
 * looking action with no way back is one you learn to avoid using at all.
 *
 * **Only from `dropped`.** A `released` block completed the tasks Nick had
 * ticked, and a `complete` one earned its note; reversing either means deciding
 * to un-finish work, which is a different act and not one to fold into an undo.
 */
function restore(blockId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };
  if (block.status !== 'dropped') {
    return { ok: false, error: `Block #${blockId} is ${block.status}, not dropped — nothing to undo` };
  }

  const items = db.listTaskBlockItems(blockId);
  if (!items.length) return { ok: false, error: 'That block has no tasks in it' };

  // Back to whichever state its members imply, rather than always 'scheduled':
  // a task ticked before the drop is still ticked, and still owed a write-up.
  const status = items.some(i => i.awaiting) ? 'awaiting-writeup' : 'scheduled';
  db.updateTaskBlockRow(blockId, { status });

  console.log(`[TaskBlocks] Block #${blockId} restored to ${status}`);
  return { ok: true, block: db.getTaskBlockRow(blockId), tasks: items.length };
}

/** Abandon a block — the work is not happening in that slot. Deletes nothing. */
function drop(blockId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, error: `No block #${blockId}` };
  db.updateTaskBlockRow(blockId, { status: 'dropped' });
  return { ok: true, block: db.getTaskBlockRow(blockId) };
}

// ── The release pass ─────────────────────────────────────────────────────────

/**
 * Every open block, checked against its note. Anything written up completes.
 *
 * This is what actually closes the loop: Nick writes the note in Obsidian, and
 * nothing in that act touches NEURO. vault-hooks deliberately do not fire for
 * Syncthing-delivered files, which is the same reason `one-to-one-detect` runs
 * on a TTL rather than trusting a hook — so the sweep is the mechanism, not a
 * backstop for one.
 *
 * Returns what it did AND what it could not read. A sweep that reports zero
 * completions because the vault was unreachable is the bug this whole feature
 * exists to stop, so an unreadable vault is a NAMED GAP, never a quiet zero.
 */
function sweep({ now = new Date(), dryRun = false } = {}) {
  const result = { checked: 0, completed: [], stillOpen: 0, gaps: [] };

  let blocks;
  try {
    blocks = db.listTaskBlockRows({ openOnly: true });
  } catch (e) {
    result.gaps.push(`task_blocks unreadable: ${e.message}`);
    return result;
  }

  for (const block of blocks) {
    result.checked++;
    const note = readOutcomeNote(block);
    if (note.error) {
      if (!result.gaps.includes(note.error)) result.gaps.push(note.error);
      continue;
    }

    const verdict = isOutcomeWritten(note.raw);
    if (!verdict.written) { result.stillOpen++; continue; }

    if (dryRun) { result.completed.push({ blockId: block.id, taskId: block.task_id }); continue; }

    try {
      db.updateTaskBlockRow(block.id, {
        status: 'complete',
        // Follow the note if Nick moved it, so the record points at the file
        // that actually holds the write-up.
        note_path: note.foundPath || block.note_path,
      });

      // Boxes ticked in Obsidian count too — that is where this note is most
      // likely to be finished, and a tick made there would otherwise be ignored
      // in favour of a card Nick never opened.
      for (const [taskId, ticked] of parseChecklist(note.raw)) {
        try { db.setTaskBlockItemAwaiting(block.id, taskId, ticked); } catch {}
      }

      // ONLY the tasks Nick actually ticked are completed. The write-up releases
      // the HOLD; it is not a claim that everything in the window got done. A
      // batch of four routinely finishes three, and marking the fourth done
      // because a note exists would put work in the wins ledger that nobody did
      // — the exact failure "a win is detected, not declared" exists to stop.
      const taskStore = require('./task-store');
      const items = db.listTaskBlockItems(block.id);
      const completed = [];
      for (const item of items) {
        if (!item.awaiting) continue;
        taskStore.updateTask(item.task_id, { status: 'done', force: true });
        completed.push(item.task_id);
      }

      result.completed.push({
        blockId: block.id,
        taskIds: completed,
        // The ones left open are reported rather than hidden: "you wrote it up
        // and two are still open" is information, not an error. Judged on the
        // TASK, not on the tick — a task can sit in two blocks, so one finished
        // in the other would otherwise be reported here as still outstanding.
        stillOpenTaskIds: items
          .filter(i => !i.awaiting && (db.getTaskRow(i.task_id) || {}).status !== 'done')
          .map(i => i.task_id),
        notePath: note.foundPath || block.note_path,
      });
    } catch (e) {
      result.gaps.push(`block #${block.id}: ${e.message}`);
    }
  }

  if (result.completed.length || result.gaps.length) {
    console.log(`[TaskBlocks] Sweep: ${result.completed.length} completed, ${result.stillOpen} still open${result.gaps.length ? `, ${result.gaps.length} gap(s)` : ''}`);
  }
  return result;
}

/**
 * Every live block, with the tasks in it.
 *
 * Both halves of the panel come from this one read. `passed` says whether the
 * slot is behind us, which is what separates "waiting on a write-up" from "in
 * your diary later" — the two need different words but not different queries.
 *
 * An upcoming block is included deliberately, where an earlier cut hid it: once
 * tasks are grouped into a window, the grouping is the thing Nick wants to see
 * and work through in the task list. Hiding it until the slot passed meant the
 * batch he had just made vanished from the screen he made it on.
 */
function listOutstanding({ now = new Date(), includeUpcoming = true } = {}) {
  const shared = require('../../shared/working-days.cjs');
  const today = shared.toDateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let blocks;
  try {
    blocks = db.listTaskBlockRows({ openOnly: true });
  } catch (e) {
    return { rows: [], error: e.message };
  }

  const rows = [];
  for (const block of blocks) {
    const passed = block.date_key < today
      || (block.date_key === today && (toMin(block.end_time) ?? 0) <= nowMin);
    if (!passed && !includeUpcoming) continue;

    const items = db.listTaskBlockItems(block.id);
    // A block with nothing in it is not a thing to show. Removing the last task
    // is refused, so this only happens if rows were deleted by hand.
    if (!items.length) continue;

    const note = readOutcomeNote(block);
    rows.push({
      blockId: block.id,
      tasks: items.map(i => ({
        taskId: i.task_id,
        text: i.text,
        // Ticked and waiting on the write-up, versus never ticked — the card has
        // to be able to say which, because only the first will complete.
        awaiting: Boolean(i.awaiting),
        allottedMinutes: i.allotted_minutes,
      })),
      dateKey: block.date_key,
      startTime: block.start_time,
      endTime: block.end_time,
      minutes: block.minutes,
      minutesAssumed: Boolean(block.minutes_assumed),
      notePath: note.foundPath || block.note_path,
      noteExists: note.raw != null,
      status: block.status,
      // Behind us, so it owes a write-up — versus still ahead, which is just the
      // diary. Same rows, different words on the card.
      passed,
      webLink: block.event_web_link || null,
      // Distinguishes "not written up" from "the vault could not be read",
      // rather than presenting the second as the first.
      vaultError: note.error || null,
    });
  }

  return { rows, error: null };
}

module.exports = {
  MIN_OUTCOME_CHARS,
  OUTCOMES_DIR,
  STUB_OPEN,
  STUB_CLOSE,
  DAY_START_MIN,
  DAY_END_MIN,
  SEARCH_DAYS,
  LIST_OPEN,
  LIST_CLOSE,
  isOutcomeWritten,
  outcomeNotePath,
  renderStub,
  renderChecklist,
  parseChecklist,
  syncChecklistInNote,
  resolveWindow,
  slugify,
  findSlot,
  plan,
  schedule,
  checkHold,
  createNote,
  readNoteForEdit,
  saveNote,
  markAwaiting,
  writeChecklistToNote,
  release,
  removeTask,
  restore,
  drop,
  sweep,
  listOutstanding,
  readOutcomeNote,
};
