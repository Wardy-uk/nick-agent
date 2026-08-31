'use strict';

/**
 * Task store — NEURO is the source of truth for tasks (13 Aug 2026).
 *
 * Everything that used to append a checkbox to `Tasks/Master Todo.md` writes here
 * instead. The vault gets a regenerated read-only export note (task-export.js), so
 * tasks stay readable in Obsidian and on the phone when the Pi is down — but the
 * file is a copy, not a store. Nothing reads tasks back out of it.
 *
 * The one hard rule: one row per task. dedupe_key is the normalised text, and it is
 * UNIQUE in the schema, so re-running the importer or draining the same capture line
 * twice updates rather than duplicates.
 */

const db = require('../db/database');
const todoIntelligence = require('./todo-intelligence');
const { domainOrDefault, normaliseDomain } = require('../../shared/task-domain.cjs');

const VALID_MOSCOW = ['must', 'should', 'could', 'wont'];
const VALID_STATUS = ['open', 'in-progress', 'done', 'dropped'];

/**
 * Normalise task text down to something stable enough to match the same action
 * written three different ways (worksheet row, vault checkbox, capture line).
 * Deliberately aggressive: markdown, wikilinks, dates, tags and punctuation all go.
 */
function normalizeText(text) {
  return String(text || '')
    .replace(/<!--.*?-->/g, '')
    // Master Todo annotates lines with their provenance in <sub>…</sub>. The triage
    // worksheets carry the same task without it, so it has to go before matching.
    .replace(/<(sub|small)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, '$2')   // [[path|Name]] → Name
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // [text](url) → text
    // Italic parenthetical refs — *(Outcome 2 — ref 2.2)*. The vault parser strips
    // these from task text but the worksheets keep them, so drop them either side.
    .replace(/\*\([^)]*\)\*/g, ' ')
    .replace(/(?:due::)?\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[📅🕑🔴🟡🟢⏸✅]/gu, ' ')
    .replace(/#[\w-]+/g, ' ')
    .replace(/[*_`~>]/g, ' ')
    .replace(/[—–]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function dedupeKey(text) {
  const norm = normalizeText(text);
  // Long tails differ more often than they matter (a trailing clause, a reworded
  // aside), so key on the first 80 normalised chars.
  return norm.slice(0, 80) || norm;
}

/** Numeric 1-3 priority → the high/normal/low string the rest of NEURO speaks. */
function legacyPriority(row) {
  if (row.priority === 3) return 'high';
  if (row.priority === 2) return 'normal';
  if (row.priority === 1) return 'low';
  if (row.moscow === 'must') return 'high';
  if (row.moscow === 'should') return 'normal';
  if (row.moscow) return 'low';
  return 'normal';
}

/**
 * Map a DB row onto the shape every existing consumer expects from
 * parseVaultTodos() — same keys, plus `task_id` to mark it as DB-owned.
 * moscow/context go into `meta` as well, because todo-intelligence.decorateTask()
 * only preserves an explicit classification when it arrives there.
 */
function toTodoShape(row) {
  return {
    task_id: row.id,
    text: row.text,
    status: row.status === 'done' ? 'done' : row.status === 'in-progress' ? 'in-progress' : 'open',
    priority: legacyPriority(row),
    taskPriority: row.priority || null,
    due_date: row.due_date || null,
    source: 'NEURO',
    taskSource: row.source,
    ms_id: row.ms_id || null,
    // Carried so a linked task's card can still say which Microsoft board the
    // work is on. The Microsoft mirror line is suppressed once a pair is linked,
    // so without these the provenance disappears at exactly the moment Nick
    // confirmed it. Null throughout for a task NEURO alone owns.
    msSource: row.ms_source || null,
    msPlan: row.ms_plan || null,
    mustdo: row.moscow === 'must',
    moscow: row.moscow || null,
    moscowProposed: Boolean(row.moscow_proposed),
    estimateMinutes: row.estimate_minutes == null ? null : row.estimate_minutes,
    context: row.context || null,
    // Work or personal. Defaulted rather than passed through raw, so a row
    // written before the column existed reads as 'work' everywhere instead of
    // arriving as undefined and being treated as "no domain" by one consumer
    // and as personal by another.
    domain: domainOrDefault(row.domain),
    notes: row.notes || null,
    filePath: null,
    lineNumber: null,
    originPath: row.origin_path || null,
    originLine: row.origin_line == null ? null : row.origin_line,
    createdAt: (row.created_at || '').split(' ')[0] || null,
    updatedAt: row.updated_at || null,
    meta: {
      moscow: row.moscow || undefined,
      context: row.context || undefined,
      created: (row.created_at || '').split(' ')[0] || undefined,
      sourcePath: row.origin_path || undefined,
    },
  };
}

// ── Export scheduling ────────────────────────────────────────────────────────
// Writes go through the DB immediately; the vault note is regenerated shortly
// after so a burst of edits produces one file write, not twenty.

// Bumped on every write. vault-cache keys its todo cache on mtimes, which a DB write
// does not change — without this, an edited task keeps showing its old MoSCoW until a
// vault file happens to be touched.
let revision = 0;

function getRevision() {
  return revision;
}

let exportTimer = null;

function scheduleExport(delayMs = 3000) {
  revision++;
  if (exportTimer) return;
  exportTimer = setTimeout(() => {
    exportTimer = null;
    try {
      require('./task-export').writeExport();
    } catch (e) {
      console.error('[Tasks] Export after write failed:', e.message);
    }
  }, delayMs);
  if (exportTimer.unref) exportTimer.unref();
}

// ── Reads ────────────────────────────────────────────────────────────────────

function listTasks(filters = {}) {
  return db.listTaskRows(filters);
}

/** Active tasks in the legacy todo shape — what the vault parser merges in. */
function activeTodos() {
  return db.listTaskRows({ status: 'all', includeDone: false })
    .filter(r => r.status === 'open' || r.status === 'in-progress')
    .map(toTodoShape);
}

function doneTodos(limit = 200) {
  return db.listTaskRows({ status: 'done' }).slice(0, limit).map(toTodoShape);
}

function getTask(id) {
  const row = db.getTaskRow(id);
  return row || null;
}

function counts() {
  return db.countTasks();
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a task, or fold into the existing one when the text already exists.
 * Returns { id, created, task }.
 */
/**
 * The open task that most likely says the same thing as `text`, or null.
 *
 * `dedupeKey` above is the only thing that has ever answered "do I already have
 * this?", and it is the first 80 characters of normalised text: it catches a
 * re-import of identical wording and nothing else. Measured on the live list on
 * 31 Aug 2026, that left ELEVEN duplicate pairs standing among 201 open tasks —
 * one commitment captured out of two wordings of the same meeting, four of them
 * scoring 1.000 on the fuzzy matcher.
 *
 * Deliberately a REPORT, never a fold. The asymmetry is the one `action-candidates`
 * measured and `task-dedupe` is built on: a missed match leaves a visible, cheap
 * duplicate, while a wrong one silently loses a commitment in the place Nick goes
 * to find out what he owes. So this changes no behaviour on its own — a caller
 * gets told, and a person decides.
 *
 * `task-dedupe` is required lazily because it requires this module back; the
 * cycle is real and resolving it at call time is how `action-candidates` handles
 * the same pair.
 */
function findSimilar(text, { excludeId = null, minScore = null } = {}) {
  const query = String(text || '').trim();
  if (!query) return null;
  try {
    const dedupe = require('./task-dedupe');
    // Open AND in-progress. A task Nick has started is the one a second copy most
    // needs to be recognised against, and the one whose duplicate gets worked twice.
    // NOTE the filter, not `includeDone: false`: listTaskRows ignores that flag
    // whenever `status` is 'all', so the flag alone would pull in done and
    // dropped rows and offer finished work as the duplicate of new work.
    const rows = db.listTaskRows({ status: 'all', includeDone: false })
      .filter(r => r.id !== excludeId && (r.status === 'open' || r.status === 'in-progress'));
    if (!rows.length) return null;

    const hit = dedupe.findEquivalent(query, rows.map(r => r.text), {
      minScore: minScore == null ? dedupe.INTERNAL_MIN_SCORE : minScore,
    });
    if (!hit) return null;

    const row = rows[hit.index];
    return {
      id: row.id,
      text: row.text,
      status: row.status,
      due_date: row.due_date || null,
      moscow: row.moscow || null,
      score: hit.score,
      sharedWords: (hit.shared || []).map(w => w.token),
    };
  } catch (e) {
    // Not knowing must never cost the capture. A create that fails because the
    // duplicate CHECK broke is the failure this whole area exists to prevent.
    console.warn('[TaskStore] Similar-task check failed:', e.message);
    return null;
  }
}

function createTask(input = {}) {
  const text = String(input.text || '').trim();
  if (!text) throw new Error('text is required');

  const baseKey = dedupeKey(text);
  if (!baseKey) throw new Error('text has no matchable content');

  const domain = domainOrDefault(input.domain);

  // ── The cross-domain collision ─────────────────────────────────────────────
  //
  // `dedupe_key` is normalised text and UNIQUE across the WHOLE table, so
  // without this a personal task whose first 80 characters match a work one
  // folds into it — and folding is silent by design, so the task simply never
  // appears. "Book the dentist" arriving from the capture page and landing
  // inside a work row is exactly the invisible failure this feature is supposed
  // to remove, reintroduced by an index that predates the question.
  //
  // The key is left ALONE in the ordinary case and suffixed only on an actual
  // clash, rather than prefixing every key with its domain. That matters: six
  // callers outside this module compute `dedupeKey(text)` and look a task up by
  // it (obsidian's mirror suppression, task-import, focus-session), and none of
  // them knows a domain. Prefixing would have broken all of them; suffixing on
  // collision leaves every one of those lookups finding exactly what it found
  // before, and costs nothing on the ~100% of creates that do not clash.
  let key = baseKey;
  let existing = db.getTaskByDedupeKey(key);
  if (existing && existing.domain && existing.domain !== domain) {
    key = `${baseKey} #${domain}`.slice(0, 100);
    existing = db.getTaskByDedupeKey(key);
  }

  if (existing) {
    // A second sighting of the same action is a chance to fill in blanks, never to
    // overwrite a decision Nick has already made.
    const patch = {};
    if (input.due_date && !existing.due_date) patch.due_date = input.due_date;
    if (input.moscow && !existing.moscow) {
      patch.moscow = normMoscow(input.moscow);
      patch.moscow_proposed = input.moscowProposed ? 1 : 0;
    }
    if (input.priority && !existing.priority) patch.priority = normPriority(input.priority);
    if (input.assignee && !existing.assignee) patch.assignee = input.assignee;
    if (input.origin_path && !existing.origin_path) {
      patch.origin_path = input.origin_path;
      patch.origin_line = input.origin_line == null ? null : input.origin_line;
    }
    if (Object.keys(patch).length) { db.updateTaskRow(existing.id, patch); revision++; }
    return { id: existing.id, created: false, task: db.getTaskRow(existing.id) };
  }

  // Asked for, never automatic: it costs a pass over the open list, and the bulk
  // paths (task-import, the capture drain) create in loops and have nobody to
  // tell. Opt-in keeps the cost where a person is actually going to read it.
  const similar = input.checkSimilar ? findSimilar(text) : null;

  const context = input.context || todoIntelligence.triageTodo({
    text,
    sourcePath: input.origin_path || null,
    dueDate: input.due_date || null,
  }).context;

  const id = db.createTaskRow({
    text,
    status: VALID_STATUS.includes(input.status) ? input.status : 'open',
    moscow: normMoscow(input.moscow),
    moscow_proposed: input.moscowProposed ? 1 : 0,
    priority: normPriority(input.priority),
    due_date: input.due_date || null,
    source: input.source || 'manual',
    origin_path: input.origin_path || null,
    origin_line: input.origin_line == null ? null : input.origin_line,
    context,
    domain,
    notes: input.notes || null,
    // VESTA household assignment. NULL is unassigned and is a real answer.
    assignee: input.assignee || null,
    ms_id: input.ms_id || null,
    estimate_minutes: normEstimate(
      input.estimateMinutes ?? input.estimate_minutes,
      { exact: input.estimateExact === true },
    ),
    dedupe_key: key,
  });

  revision++;
  if (input.skipExport !== true) scheduleExport();
  return { id, created: true, task: db.getTaskRow(id), similar };
}

function normMoscow(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().replace(/[^a-z']/g, '');
  if (v === 'wont' || v === "won't") return 'wont';
  return VALID_MOSCOW.includes(v) ? v : null;
}

/**
 * How long it takes, in minutes.
 *
 * Snapped to coarse buckets on purpose. Asking an ADHD brain to predict "37
 * minutes" is asking for a number it does not have and cannot check; asking
 * "quick / half an hour / a couple of hours" is a judgement anyone can make in
 * one second, which is the only kind that will actually get filled in. The
 * buckets are also honest about the precision the data supports.
 *
 * Anything unrecognised returns null — NOT ESTIMATED — rather than a guess.
 *
 * ⚠ The top bucket used to be 240 and anything above it was CLAMPED to 240, so
 * a task Nick knew was a two-day job was recorded as four hours, silently, and
 * then offered up by time-fit and the day planner as something that fits in an
 * afternoon. A ceiling that quietly rewrites the answer is worse than no
 * estimate at all. Above the top bucket the value now rounds UP to the whole
 * hour instead — the same direction the buckets round, and never downwards.
 *
 * `exact` is the escape hatch for a number Nick TYPED. The buckets exist
 * because nobody has "37 minutes" to give; someone who has gone and entered it
 * does, and snapping it is the planner disagreeing with him about his own work
 * (task-blocks' rule for a requested window, one level down).
 */
const ESTIMATE_BUCKETS = [5, 15, 30, 60, 120, 240, 360, 480];
// A working week. Past this it is a project, not a task, and a number that big
// is far likelier to be a typo than an estimate.
const MAX_ESTIMATE_MINUTES = 2400;

function normEstimate(value, { exact = false } = {}) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_ESTIMATE_MINUTES) return null;
  if (exact) return Math.ceil(n);
  // Snap up: a task that takes "about 20 minutes" should not be offered for a
  // 15-minute gap. Rounding the wrong way here is how a system that promises
  // "this fits" stops being trusted.
  const bucket = ESTIMATE_BUCKETS.find(b => n <= b);
  return bucket == null ? Math.ceil(n / 60) * 60 : bucket;
}

/** Accepts 1-3, "1".."3", or the legacy high/normal/low strings. */
function normPriority(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n;
  const v = String(value).toLowerCase();
  if (v === 'high') return 3;
  if (v === 'normal') return 2;
  if (v === 'low') return 1;
  return null;
}

function updateTask(id, fields = {}) {
  const row = db.getTaskRow(id);
  if (!row) return null;

  const patch = {};
  if ('text' in fields) {
    const text = String(fields.text || '').trim();
    if (!text) throw new Error('text cannot be empty');
    patch.text = text;
    // The same domain-suffix rule as createTask, or renaming a personal task
    // onto a work task's wording would be refused outright — which reads to
    // Nick as "NEURO won't let me write that", with no clue that the clash is
    // with a task in a different part of his life that he cannot even see here.
    const domain = normaliseDomain(fields.domain) || domainOrDefault(row.domain);
    let key = dedupeKey(text);
    let clash = db.getTaskByDedupeKey(key);
    if (clash && clash.id !== id && clash.domain && clash.domain !== domain) {
      key = `${key} #${domain}`.slice(0, 100);
      clash = db.getTaskByDedupeKey(key);
    }
    if (clash && clash.id !== id) throw new Error(`Another task already has that text (#${clash.id})`);
    patch.dedupe_key = key;
  }
  if ('moscow' in fields) {
    patch.moscow = normMoscow(fields.moscow);
    // Setting it by hand IS the decision — the proposal flag comes off.
    patch.moscow_proposed = 0;
  }
  if ('priority' in fields) patch.priority = normPriority(fields.priority);
  if ('domain' in fields) {
    // Reclassifying is a DECISION, so an unrecognised value is refused rather
    // than quietly defaulting to 'work' — a silent default here would mean a
    // typo in a client moved a personal task into the work lane and said it
    // had worked. domainOrDefault is for arrival, not for reassignment.
    const next = normaliseDomain(fields.domain);
    if (!next) throw new Error(`domain must be 'work' or 'personal'`);
    patch.domain = next;
  }
  if ('estimateMinutes' in fields || 'estimate_minutes' in fields) {
    // `estimateExact` says the number was typed, not picked off a preset — see
    // normEstimate. A preset still snaps.
    patch.estimate_minutes = normEstimate(
      fields.estimateMinutes ?? fields.estimate_minutes,
      { exact: fields.estimateExact === true },
    );
  }
  if ('due_date' in fields) patch.due_date = fields.due_date || null;
  if ('notes' in fields) patch.notes = fields.notes || null;
  if ('context' in fields) patch.context = fields.context || null;
  if ('status' in fields) {
    if (!VALID_STATUS.includes(fields.status)) throw new Error(`status must be one of ${VALID_STATUS.join(', ')}`);
    patch.status = fields.status;
  }

  // A task blocked into the calendar is not finished until it has been written
  // up (18 Aug 2026). The hold lives HERE rather than in the route because this
  // is the only writer — the SARA completion funnel, the MCP tool, the chat tool
  // and every route all arrive through this function, and a check in any one of
  // them would be a check the other three walk straight past.
  //
  // Held means held at 'in-progress', not refused: the tick was a real statement
  // about the work and throwing it away would make Nick tick twice. Only the
  // 'done' claim waits for its evidence. 'dropped' is never held — abandoning
  // something is not a claim that needs proving.
  let held = null;
  if (patch.status === 'done' && row.status !== 'done' && fields.force !== true) {
    const taskBlocks = require('./task-blocks');
    const blocker = taskBlocks.checkHold(id);
    if (blocker) {
      // The task id matters: the block records WHICH of its tasks were ticked,
      // so a batch completes only those when the write-up lands.
      taskBlocks.markAwaiting(blocker.id, id);
      patch.status = 'in-progress';
      held = {
        blockId: blocker.id,
        notePath: blocker.note_path,
        dateKey: blocker.date_key,
        startTime: blocker.start_time,
        reason: blocker.holdReason || 'no write-up yet',
      };
    }
  }

  db.updateTaskRow(id, patch);

  // Finishing something is the one event the activity log never recorded, which
  // left "what did I actually get done today" unanswerable from the data. Logged
  // on the transition only, so re-saving a done task doesn't inflate the count.
  if (patch.status === 'done' && row.status !== 'done') {
    try {
      db.logActivity('task_done', {
        taskId: id,
        text: row.text,
        moscow: row.moscow || null,
        source: row.source || null,
        ageDays: row.created_at
          ? Math.floor((Date.now() - new Date(row.created_at.replace(' ', 'T')).getTime()) / 86400000)
          : null,
      });
    } catch {}
  }

  scheduleExport();

  const updated = db.getTaskRow(id);
  // `held` rides on the returned row rather than changing the return shape:
  // every existing caller reads columns off it and is unaffected, while the ones
  // that need to SAY the tick was held can. A silent hold would be the worst of
  // both — the task quietly stays open and Nick is never told why.
  if (updated && held) updated.held = held;
  return updated;
}

function setStatus(id, status) {
  return updateTask(id, { status });
}

function deleteTask(id) {
  const changed = db.deleteTaskRow(id);
  if (changed) scheduleExport();
  return changed > 0;
}

module.exports = {
  activeTodos,
  counts,
  createTask,
  findSimilar,
  dedupeKey,
  deleteTask,
  doneTodos,
  getRevision,
  getTask,
  legacyPriority,
  listTasks,
  normalizeText,
  normEstimate,
  normMoscow,
  normPriority,
  scheduleExport,
  setStatus,
  toTodoShape,
  updateTask,
};
