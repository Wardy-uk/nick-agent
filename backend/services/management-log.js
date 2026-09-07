'use strict';

/**
 * Management Actions & Conversations Log — PIP competencies 3 and 4.
 *
 * Competency 3 asks that every management conversation, concern or action is
 * logged within two working days, with an owner and a due date, and followed to
 * resolution. Competency 4 asks for the count of overdue management actions to
 * be baselined at 27 Jul 2026, driven to zero by the 60-day review on
 * 11 Sep 2026, and thereafter held at nothing overdue by more than five
 * working days.
 *
 * Both are measurements, and that is the whole reason this is a table rather
 * than a markdown table in the vault. A hand-maintained grid can say "logged
 * within 2 days" without anything checking; here the gap between when something
 * HAPPENED (entry_date) and when it was WRITTEN DOWN (logged_at) is the
 * measurement, so the claim is evidenced by construction. The vault note
 * remains — it is what Chris reads — but it is rendered FROM this, the same way
 * the task export is a read-only copy of the task store rather than a second
 * source of truth.
 *
 * Split like pi-health and state-of-play: `snapshot()` reads, `assess()`
 * judges. `assess()` is pure and takes a plain array plus an optional
 * non-working-day set, so every compliance number in the report can be pinned
 * in a test without a database, a vault or a network call.
 *
 * "Working days" is deliberately NOT Mon–Fri here. The five-working-day
 * standard is the one Nick is measured against, and a bank holiday inside the
 * window is exactly the case where a naive count reports a breach that is not
 * one. Callers pass the holiday set from services/working-days.js; omitting it
 * degrades to Mon–Fri, which is the documented behaviour of the shared module.
 */

const db = require('../db/database');
const shared = require('../../shared/working-days.cjs');

/** PIP competency 4's baseline date, fixed by the plan itself. */
const BASELINE_DATE = '2026-07-27';
/** The 60-day review the baseline must reach zero by. */
const REVIEW_DATE = '2026-09-11';
/** Competency 3: log within this many working days of the conversation. */
const LOG_WITHIN_WORKING_DAYS = 2;
/** Competency 4, post-review standard: nothing overdue by more than this. */
const OVERDUE_TOLERANCE_WORKING_DAYS = 5;

const TYPES = ['conversation', 'concern', 'action'];
const STATUSES = ['open', 'in-progress', 'blocked', 'done'];

/** Local, never toISOString() — the Pi may run in UTC and would flip a day early. */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Parse YYYY-MM-DD as a LOCAL date. `new Date('2026-08-14')` is parsed as UTC
 * midnight, which on a Pi running UTC-ahead of local is the previous day — the
 * same trap the calendar code documents.
 */
function parseLocal(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * Whole working days from `from` to `to`, counting the days AFTER `from` up to
 * and including `to`. Same day → 0. Pure: `nonWorking` is an optional Set of
 * YYYY-MM-DD, and omitting it is plain Mon–Fri.
 *
 * Note `shared/working-days.cjs` works in Date objects, not date strings — it is
 * the browser-safe half and its callers hold Dates. Converting at this boundary
 * rather than string-comparing is what keeps the holiday lookup honest.
 *
 * Bounded at 2000 iterations so a corrupt date can never spin the event loop —
 * this runs inside a report build, and a hang there is a report that never
 * arrives rather than one that is wrong.
 */
function workingDaysBetween(from, to, nonWorking) {
  if (!from || !to) return null;
  const start = parseLocal(from);
  const end = parseLocal(to);
  if (!start || !end || end <= start) return 0;

  let count = 0;
  let cursor = start;
  for (let i = 0; i < 2000; i += 1) {
    cursor = shared.addDays(cursor, 1);
    if (cursor > end) break;
    if (shared.isWorkingDay(cursor, nonWorking)) count += 1;
  }
  return count;
}

// ── Reads ────────────────────────────────────────────────────────────────────

function list({ status, person, type, since, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (person) { where.push('person = ?'); params.push(person); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (since) { where.push('entry_date >= ?'); params.push(since); }
  const sql = `SELECT * FROM management_log
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY entry_date DESC, id DESC
               LIMIT ?`;
  try { return db.all(sql, [...params, Math.min(Math.max(limit, 1), 2000)]) || []; } catch { return []; }
}

function get(id) {
  try { return db.get('SELECT * FROM management_log WHERE id = ?', [id]); } catch { return null; }
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Log an item. `entryDate` is when it HAPPENED; `logged_at` is stamped now.
 *
 * `loggedAt` may be supplied ONLY when importing a record that already exists
 * somewhere else — a meeting note written on the day is contemporaneous
 * evidence, and stamping the import date would report a two-working-day breach
 * that did not happen. For anything logged THROUGH NEURO it must be omitted: a
 * freely backdatable stamp makes the one measurement competency 3 rests on
 * unfalsifiable. The narrowness is the safeguard — an importer names its source,
 * a person typing into the log does not get the option.
 */
function create(entry = {}) {
  const type = String(entry.type || 'action').toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const summary = String(entry.summary || '').trim();
  if (!summary) throw new Error('summary is required');

  const status = STATUSES.includes(String(entry.status || '').toLowerCase())
    ? String(entry.status).toLowerCase()
    : 'open';

  const now = nowIso();
  // Only an import may claim an earlier log stamp, and only against a named source.
  const loggedAt = entry.loggedAt && entry.source && entry.source !== 'manual'
    ? entry.loggedAt
    : now;
  const res = db.run(
    `INSERT INTO management_log
       (entry_date, logged_at, type, person, summary, action, owner, due_date,
        status, resolved_date, hr_logged, source, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.entryDate || todayLocal(),
      loggedAt,
      type,
      entry.person || null,
      summary,
      entry.action || null,
      entry.owner || null,
      entry.dueDate || null,
      status,
      entry.resolvedDate || null,
      entry.hrLogged === undefined || entry.hrLogged === null ? null : (entry.hrLogged ? 1 : 0),
      entry.source || 'manual',
      entry.notes || null,
      now,
      now,
    ],
  );
  return ensureTask(get(res.lastInsertRowid));
}

const PATCHABLE = {
  entryDate: 'entry_date', type: 'type', person: 'person', summary: 'summary',
  action: 'action', owner: 'owner', dueDate: 'due_date', status: 'status',
  resolvedDate: 'resolved_date', hrLogged: 'hr_logged', source: 'source', notes: 'notes',
};

function update(id, patch = {}) {
  const row = get(id);
  if (!row) return null;

  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(PATCHABLE)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === 'hrLogged') value = value === null || value === undefined ? null : (value ? 1 : 0);
    if (key === 'type' && !TYPES.includes(String(value).toLowerCase())) continue;
    if (key === 'status' && !STATUSES.includes(String(value).toLowerCase())) continue;
    sets.push(`${col} = ?`);
    params.push(value ?? null);
  }

  // Closing an item without a resolved date leaves it uncountable — competency 4
  // measures how long things stayed open, so the date is stamped rather than
  // left to the caller to remember.
  if (patch.status === 'done' && !patch.resolvedDate && !row.resolved_date) {
    sets.push('resolved_date = ?');
    params.push(todayLocal());
  }
  if (!sets.length) return row;

  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  db.run(`UPDATE management_log SET ${sets.join(', ')} WHERE id = ?`, params);
  return get(id);
}

function remove(id) {
  const row = get(id);
  if (!row) return false;
  db.run('DELETE FROM management_log WHERE id = ?', [id]);
  return true;
}

// ── Mirroring into the task store ────────────────────────────────────────────

/**
 * The log is a RECORD; the task store is where work is looked for.
 *
 * Those are different jobs, which is why this is a mirror rather than a merge.
 * The log carries what tasks has no use for — when a conversation happened
 * versus when it was written down, whether it reached People HR, who owns it —
 * and all of that is what competencies 3 and 4 are measured on. But a row that
 * Nick has to ACT on and that lives only here is a row nobody sees: the first
 * seeded batch produced three overdue actions that could not be found in Tasks,
 * Focus, or on the phone, because this table has no presence in any of them.
 *
 * Only Nick's own items mirror. An action owned by Chris is something to track,
 * not something to do, and putting it on Nick's task list makes his own list
 * lie about what is his.
 */
function ownedByNick(row) {
  return /^nick\b/i.test(String(row.owner || '').trim());
}

/** Create the mirrored task, if this row should have one and does not. */
function ensureTask(row) {
  if (!row || row.task_id || !ownedByNick(row) || isClosed(row)) return row;
  try {
    const taskStore = require('./task-store');
    const { id } = taskStore.createTask({
      text: row.summary,
      due_date: row.due_date || null,
      source: 'management-log',
      notes: row.action || null,
    });
    db.run('UPDATE management_log SET task_id = ?, updated_at = ? WHERE id = ?', [id, nowIso(), row.id]);
    return get(row.id);
  } catch (e) {
    // A task-store failure must never lose the log entry — the log is the
    // compliance record and is the half that matters if only one survives.
    console.warn('[ManagementLog] Could not mirror to task store:', e.message);
    return row;
  }
}

/**
 * Pull the two back into agreement.
 *
 * Deliberately pull-based, run at the head of `status()`, rather than a hook on
 * the task store: ticking a task off happens on the phone, in Focus and in
 * three routes, and a hook on each is four places to forget. The same shape as
 * `entities.pruneExcludedEntities()` running at the head of the nightly sweep.
 *
 * Closure travels BOTH ways — closing the log closes the task, and ticking the
 * task closes the log — because "I did that" is said in whichever place Nick
 * happens to be looking.
 */
function reconcileTasks() {
  let changed = 0;
  let taskStore;
  try { taskStore = require('./task-store'); } catch { return 0; }

  for (const row of list({ limit: 2000 })) {
    // Mirror anything new that should have a task.
    if (!row.task_id && !isClosed(row) && ownedByNick(row)) { ensureTask(row); changed += 1; continue; }
    if (!row.task_id) continue;

    let task;
    try { task = taskStore.getTask(row.task_id); } catch { task = null; }

    // The task was deleted out from under the log. Forget it rather than
    // pointing at nothing; the next reconcile makes a fresh one.
    if (!task) {
      db.run('UPDATE management_log SET task_id = NULL WHERE id = ?', [row.id]);
      changed += 1;
      continue;
    }

    const taskClosed = task.status === 'done' || task.status === 'dropped';
    if (taskClosed && !isClosed(row)) {
      update(row.id, { status: 'done', resolvedDate: (task.completed_at || nowIso()).slice(0, 10) });
      changed += 1;
    } else if (isClosed(row) && !taskClosed) {
      try { taskStore.setStatus(row.task_id, 'done'); changed += 1; } catch { /* nothing to do */ }
    }
  }
  return changed;
}

// ── Judgement ────────────────────────────────────────────────────────────────

function isClosed(row) {
  return row.status === 'done' || Boolean(row.resolved_date);
}

/**
 * Was this row overdue as at `asOf`? An item resolved AFTER the as-at date was
 * still open on that date — that distinction is the whole of the competency-4
 * baseline, which is a statement about 27 July and not about today.
 */
function wasOverdueAt(row, asOf) {
  if (!row.due_date || row.due_date >= asOf) return false;
  if (row.resolved_date) return row.resolved_date > asOf;
  return row.status !== 'done';
}

/**
 * Does this row bear on the baseline date at all?
 *
 * ⚠ The competency-4 baseline is the one number in this file that a count
 * cannot produce honestly, and it took until 7 Sep 2026 to notice. The PIP says
 * *"Baseline of [ ] overdue management actions recorded as at 27 July 2026"* —
 * a literal blank, never filled in, and the reference note still carries
 * "Overdue-actions baseline recorded — Not done — agree the number with Chris".
 * The log itself was stood up on 12 Aug, sixteen days AFTER the baseline date,
 * and its earliest due date is 13 Aug. So `rows.filter(wasOverdueAt)` returned
 * **0** — arithmetically correct over the rows present, and a statement about
 * 27 July that nothing measured.
 *
 * That is the wrong direction in a document Nick signs and Chris assesses: it
 * reports an unrecorded PIP deliverable as a met one, and the moment the
 * fabrication is spotted every other number in the report is in question. The
 * rule this file already lives by — an absence is never a zero — applies here
 * hardest.
 *
 * A row bears on the date two ways, and BOTH are needed. It was already on the
 * log then (`logged_at`/`entry_date` on or before it) — or it carries a due
 * date on or before it, which is how a baseline legitimately gets established
 * retrospectively: sitting down after the fact and writing up what was already
 * outstanding. Neither alone is enough; a log made entirely of items due after
 * the baseline date says nothing about that date whichever way you read it.
 */
function bearsOnBaseline(row, asOf) {
  if (row.due_date && row.due_date <= asOf) return true;
  const logged = row.logged_at ? String(row.logged_at).slice(0, 10) : null;
  if (logged && logged <= asOf) return true;
  return Boolean(row.entry_date && row.entry_date <= asOf);
}

/**
 * The competency-4 baseline, which is THREE answers and not one.
 *
 * `agreed` — a number Nick and Chris settled between them. It outranks the
 * count, because it is the thing the PIP actually asks for; the measurement is
 * a reconstruction of it at best.
 * `measured` — the log held rows covering the baseline date, so counting them
 * is a real answer (including a real zero).
 * `unrecorded` — nothing in the log existed on that date. `count` is **null**,
 * never 0, and the reason is carried so the report can say which.
 */
function assessBaseline(rows, baselineDate, nonWorking, agreed = null) {
  const covering = rows.filter(r => bearsOnBaseline(r, baselineDate));
  const baselineRows = rows.filter(r => wasOverdueAt(r, baselineDate));
  const items = baselineRows.map(r => ({
    id: r.id,
    summary: r.summary,
    dueDate: r.due_date,
    workingDaysOverdueAtBaseline: workingDaysBetween(r.due_date, baselineDate, nonWorking),
    status: isClosed(r) ? 'closed' : r.status,
    resolvedDate: r.resolved_date || null,
  }));

  const base = {
    date: baselineDate,
    target: 0,
    targetDate: REVIEW_DATE,
    items,
    // The measurement that actually matters between now and 11 Sep. It counts
    // the rows the log CAN see, whatever the baseline source, so it stays a
    // real figure even while the baseline itself is unrecorded.
    stillOpen: baselineRows.filter(r => !isClosed(r)).length,
    rowsCoveringDate: covering.length,
  };

  if (Number.isFinite(agreed)) {
    return { ...base, known: true, source: 'agreed', count: agreed, reason: null };
  }
  if (!covering.length) {
    return {
      ...base,
      known: false,
      source: 'unrecorded',
      count: null,
      reason: `Nothing on the management log bears on ${baselineDate} — every entry was made after it and every due date falls after it, so the log cannot say what was overdue that day. The PIP leaves the figure blank and it has not been agreed with Chris.`,
    };
  }
  return { ...base, known: true, source: 'measured', count: baselineRows.length, reason: null };
}

/**
 * Turn rows into the compliance picture. PURE — no DB, no clock beyond what is
 * passed in. `nonWorking` is an optional Set of YYYY-MM-DD non-working days.
 */
function assess(rows = [], { today = todayLocal(), baselineDate = BASELINE_DATE, nonWorking, agreedBaseline = null } = {}) {
  const overdue = [];
  const lateLogged = [];
  const missingOwner = [];
  const missingDue = [];
  const hrGap = [];
  const hrUnknown = [];

  for (const row of rows) {
    // Overdue now, with the working-day figure the five-day standard is stated in.
    if (!isClosed(row) && row.due_date && row.due_date < today) {
      overdue.push({
        id: row.id,
        summary: row.summary,
        person: row.person,
        owner: row.owner,
        dueDate: row.due_date,
        status: row.status,
        workingDaysOverdue: workingDaysBetween(row.due_date, today, nonWorking),
      });
    }

    // Competency 3: the gap between happening and being written down.
    const loggedDate = String(row.logged_at || '').slice(0, 10);
    if (row.entry_date && loggedDate) {
      const gap = workingDaysBetween(row.entry_date, loggedDate, nonWorking);
      if (gap !== null && gap > LOG_WITHIN_WORKING_DAYS) {
        lateLogged.push({ id: row.id, summary: row.summary, entryDate: row.entry_date, loggedDate, workingDays: gap });
      }
    }

    // Competency 3 also requires an owner and a due date on every item — an
    // open item with neither cannot be followed to resolution, so it is a gap
    // in the log itself rather than a late action.
    if (!isClosed(row)) {
      if (!row.owner) missingOwner.push({ id: row.id, summary: row.summary });
      if (!row.due_date) missingDue.push({ id: row.id, summary: row.summary });
    }

    // Chris spot-checks People HR, so a conversation or concern that never
    // reached it is a real finding. But NOT ASKED is a third state, and folding
    // it in put three unmeasured accusations in a report going to the person
    // who does the spot-checking. Only a confirmed 0 is a gap; NULL is a
    // question for Nick, never a claim to Chris.
    if (row.type === 'conversation' || row.type === 'concern') {
      const entry = { id: row.id, summary: row.summary, person: row.person, entryDate: row.entry_date };
      if (row.hr_logged === 0) hrGap.push(entry);
      else if (row.hr_logged === null || row.hr_logged === undefined) hrUnknown.push(entry);
    }
  }

  overdue.sort((a, b) => (b.workingDaysOverdue || 0) - (a.workingDaysOverdue || 0));

  const breaches = overdue.filter(o => (o.workingDaysOverdue || 0) > OVERDUE_TOLERANCE_WORKING_DAYS);
  return {
    today,
    // Derived, never stored — except the agreed figure, which is a decision
    // rather than a measurement and has nowhere else to live.
    baseline: assessBaseline(rows, baselineDate, nonWorking, agreedBaseline),
    overdue,
    overdueCount: overdue.length,
    // The post-review standard, reported now so the trend is visible before it
    // becomes the thing being judged.
    breachesFiveDay: breaches,
    lateLogged,
    missingOwner,
    missingDue,
    hrGap,
    // Not a finding. Nick answers these in the panel; they never reach Chris
    // as a gap, because nothing measured them.
    hrUnknown,
    totals: {
      rows: rows.length,
      open: rows.filter(r => !isClosed(r)).length,
      closed: rows.filter(isClosed).length,
    },
  };
}

/** Where the agreed figure lives. KV, not a column — one number, not a row. */
const AGREED_BASELINE_KEY = 'management_log_agreed_baseline';

/**
 * The baseline Nick and Chris agreed, or null.
 *
 * ⚠ `null` and `0` are different answers and must stay so: nil overdue on
 * 27 July is a claim somebody made, and no figure is the deliverable still
 * being outstanding. Anything unusable reads as unrecorded rather than as zero.
 */
function getAgreedBaseline() {
  const raw = db.getState(AGREED_BASELINE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Number.isFinite(v?.count) || v.count < 0) return null;
    return { count: Math.round(v.count), agreedOn: v.agreedOn || null, note: v.note || '' };
  } catch { return null; }
}

/** Record it, or pass null to clear it back to unrecorded. */
function setAgreedBaseline(entry) {
  if (entry === null) { db.setState(AGREED_BASELINE_KEY, ''); return null; }
  const count = Number(entry?.count);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error('A baseline needs a whole number of overdue actions — omitting it is not the same as zero.');
  }
  const next = {
    count: Math.round(count),
    agreedOn: entry.agreedOn || todayLocal(),
    note: entry.note || '',
  };
  db.setState(AGREED_BASELINE_KEY, JSON.stringify(next));
  return next;
}

/** Read + judge in one call, with the real bank-holiday set applied. */
function status(opts = {}) {
  // Bring the mirror into agreement before judging, so a task ticked off on the
  // phone is not still reported here as an overdue management action.
  try { reconcileTasks(); } catch (e) { console.warn('[ManagementLog] reconcile failed:', e.message); }
  const rows = list({ limit: 2000 });
  let nonWorking;
  try { nonWorking = require('./working-days').holidaySet(); } catch { nonWorking = undefined; }
  const agreed = getAgreedBaseline();
  const out = assess(rows, { ...opts, nonWorking, agreedBaseline: agreed ? agreed.count : null });
  if (agreed) {
    out.baseline.agreedOn = agreed.agreedOn;
    out.baseline.note = agreed.note;
  }
  return { ...out, rows };
}

module.exports = {
  create, update, remove, list, get,
  assess, status, workingDaysBetween, assessBaseline,
  getAgreedBaseline, setAgreedBaseline,
  reconcileTasks, ensureTask, ownedByNick,
  BASELINE_DATE, REVIEW_DATE, LOG_WITHIN_WORKING_DAYS, OVERDUE_TOLERANCE_WORKING_DAYS,
  TYPES, STATUSES,
};
