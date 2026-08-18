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
  // The stub NEURO wrote. Non-greedy and global: a note may carry more than one
  // if Nick pasted a second block's template in.
  text = text.split(STUB_OPEN).map((part, i) => (
    i === 0 ? part : part.slice(part.indexOf(STUB_CLOSE) + STUB_CLOSE.length)
  )).join(' ');
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

/** Vault-relative path for a task's outcome note. Pure. */
function outcomeNotePath(task, dateKey) {
  const [year, month] = String(dateKey).split('-');
  return `${OUTCOMES_DIR}/${year}/${month}/${dateKey} ${slugify(task.text)}.md`;
}

/**
 * The stub. Says plainly that the task is being held and what closes the hold —
 * a note that does not explain why it exists is one Nick finds three weeks later
 * and deletes.
 */
function renderStub(task, block) {
  return [
    '---',
    'type: task-outcome',
    `task_id: ${task.id}`,
    `task: "${String(task.text).replace(/"/g, "'")}"`,
    `date: ${block.date_key}`,
    `block: ${block.date_key}T${block.start_time}`,
    `minutes: ${block.minutes}`,
    '---',
    '',
    `# ${task.text}`,
    '',
    STUB_OPEN,
    `> Blocked ${block.start_time}–${block.end_time} on ${block.date_key}.`,
    '> This task stays open in NEURO until there is a real summary below —',
    '> a couple of lines on what came of it is enough. Nothing to write up?',
    '> Release it from the task list and say why.',
    STUB_CLOSE,
    '',
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

  // Moved or renamed — find it by id.
  const found = findOutcomeByTaskId(root, block.task_id, block.date_key);
  if (found) return { raw: found.raw, foundPath: found.relPath, error: null };
  return { raw: null, foundPath: null, error: null };
}

function findOutcomeByTaskId(root, taskId, dateKey) {
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
      if (!fm || String(fm.task_id) !== String(taskId)) continue;
      // A task can have several blocks; match the one this note was written for
      // when the note says, and accept it otherwise (an older note carrying no
      // block date is still that task's write-up).
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

function blockMinutes(task) {
  const estimate = task.estimate_minutes;
  return estimate == null
    ? { minutes: timeFit.ASSUMED_MINUTES, assumed: true }
    : { minutes: estimate, assumed: false };
}

/**
 * What WOULD be created. Reads the diary, creates nothing — the same two-step as
 * `event-parser` and `one-to-one-booking.propose()`, so the slot can be seen and
 * changed before an event exists.
 */
function plan(taskId, { date = null, startTime = null, now = new Date() } = {}) {
  const task = db.getTaskRow(taskId);
  if (!task) return { ok: false, error: `No task #${taskId}` };
  if (task.status === 'done' || task.status === 'dropped') {
    return { ok: false, error: `Task #${taskId} is ${task.status}` };
  }

  const { minutes, assumed } = blockMinutes(task);

  // An explicit slot is Nick's decision and is not second-guessed against the
  // diary — he can see his own calendar, and refusing a deliberate choice is how
  // a scheduling tool becomes something you fight.
  if (date && startTime) {
    const start = toMin(startTime);
    if (start == null) return { ok: false, error: 'startTime must be HH:MM' };
    return {
      ok: true,
      task: { id: task.id, text: task.text },
      slot: { date, startTime, endTime: hhmm(start + minutes) },
      minutes,
      minutesAssumed: assumed,
      assumedMinutes: assumed ? timeFit.ASSUMED_MINUTES : null,
      chosen: 'explicit',
      notePath: outcomeNotePath(task, date),
    };
  }

  const events = readCalendar(now);
  const workingDays = require('./working-days');
  const slot = findSlot({
    minutes,
    events: events.rows,
    now,
    nonWorking: workingDays.holidaySet(),
  });
  if (slot.reason) {
    return { ok: false, error: slot.reason, calendarKnown: events.known };
  }

  return {
    ok: true,
    task: { id: task.id, text: task.text },
    slot,
    minutes,
    minutesAssumed: assumed,
    assumedMinutes: assumed ? timeFit.ASSUMED_MINUTES : null,
    chosen: 'proposed',
    // "I can't see the diary" must stay distinct from "you're free" — #87's rule,
    // and here it decides whether the proposed slot is worth anything at all.
    calendarKnown: events.known,
    notePath: outcomeNotePath(task, slot.date),
  };
}

/** calendar_cache over the search window, in the shape findSlot/time-fit read. */
function readCalendar(now = new Date()) {
  const shared = require('../../shared/working-days.cjs');
  const from = shared.toDateStr(now);
  const to = shared.toDateStr(shared.addDays(now, SEARCH_DAYS));
  try {
    const rows = db.getCalendarEvents(`${from}T00:00:00`, `${to}T23:59:59`);
    return {
      known: true,
      rows: rows.map(row => ({
        date: String(row.start_time || '').split('T')[0],
        start: row.start_time,
        end: row.end_time,
        subject: row.subject,
        isAllDay: Boolean(row.is_all_day),
        showAs: row.show_as || 'busy',
      })),
    };
  } catch {
    return { known: false, rows: [] };
  }
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
async function schedule(taskId, { date = null, startTime = null, now = new Date() } = {}) {
  const draft = plan(taskId, { date, startTime, now });
  if (!draft.ok) return draft;

  const task = db.getTaskRow(taskId);
  const { slot, minutes, minutesAssumed } = draft;
  const notePath = draft.notePath;

  let blockId;
  try {
    blockId = db.createTaskBlockRow({
      task_id: task.id,
      date_key: slot.date,
      start_time: slot.startTime,
      end_time: slot.endTime,
      minutes,
      minutes_assumed: minutesAssumed ? 1 : 0,
      note_path: notePath,
      status: 'scheduled',
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      return { ok: false, error: `That task is already blocked at ${slot.startTime} on ${slot.date}`, duplicate: true };
    }
    throw e;
  }

  const block = db.getTaskBlockRow(blockId);
  const stub = writeStub(task, block);

  const microsoft = require('./microsoft');
  const result = await microsoft.createCalendarEvent({
    subject: `Focus: ${task.text}`.slice(0, 200),
    start: `${slot.date}T${slot.startTime}:00`,
    end: `${slot.date}T${slot.endTime}:00`,
    // No attendees, by design. This is Nick's own time — nothing leaves the
    // building, which is what lets this create on a confirm instead of going
    // through the approve gate outbound actions need.
    attendees: [],
    body: [
      `NEURO task #${task.id}.`,
      '',
      'This block is not finished until the outcome note has something in it:',
      `  ${stub.written || stub.reason === 'note already exists' ? notePath : '(stub not written — ' + stub.reason + ')'}`,
      '',
      'The task stays open in NEURO until then.',
    ].join('\n'),
  });

  if (!result.created) {
    // The block row survives with a null event_id. The stub exists, the task is
    // still linked, and Nick can retry — losing the row here would leave an
    // orphaned note in the vault with nothing pointing at it.
    console.warn(`[TaskBlocks] Graph create failed for task #${task.id}: ${result.reason}`);
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

  console.log(`[TaskBlocks] Task #${task.id} blocked ${slot.date} ${slot.startTime}-${slot.endTime}`);
  return {
    ok: true,
    blockId,
    task: { id: task.id, text: task.text },
    slot,
    minutes,
    minutesAssumed,
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

/** Mark the block as owing a write-up. Called when a held completion is refused. */
function markAwaiting(blockId) {
  try {
    db.updateTaskBlockRow(blockId, { status: 'awaiting-writeup' });
  } catch (e) {
    console.warn('[TaskBlocks] Could not mark awaiting:', e.message);
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

  let task = null;
  if (completeTask) {
    const taskStore = require('./task-store');
    task = taskStore.updateTask(block.task_id, { status: 'done', force: true });
  }
  console.log(`[TaskBlocks] Block #${blockId} released: ${why}`);
  return { ok: true, block: db.getTaskBlockRow(blockId), task };
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
      const taskStore = require('./task-store');
      taskStore.updateTask(block.task_id, { status: 'done', force: true });
      result.completed.push({
        blockId: block.id,
        taskId: block.task_id,
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
 * Blocks that owe a write-up, with the task text and the note to write in.
 *
 * `scheduled` blocks whose slot is still in the future are excluded — a block at
 * 3pm is not outstanding at 9am, and listing it would turn the panel into a
 * second, worse calendar.
 */
function listOutstanding({ now = new Date() } = {}) {
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
    if (block.status === 'scheduled' && !passed) continue;

    const task = db.getTaskRow(block.task_id);
    if (!task) continue;

    const note = readOutcomeNote(block);
    rows.push({
      blockId: block.id,
      taskId: block.task_id,
      text: task.text,
      dateKey: block.date_key,
      startTime: block.start_time,
      endTime: block.end_time,
      minutes: block.minutes,
      minutesAssumed: Boolean(block.minutes_assumed),
      notePath: note.foundPath || block.note_path,
      noteExists: note.raw != null,
      status: block.status,
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
  isOutcomeWritten,
  outcomeNotePath,
  renderStub,
  slugify,
  findSlot,
  plan,
  schedule,
  checkHold,
  markAwaiting,
  release,
  drop,
  sweep,
  listOutstanding,
  readOutcomeNote,
};
