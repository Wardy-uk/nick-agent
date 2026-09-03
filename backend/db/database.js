const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// NEURO_DB_PATH lets a test or a one-off script run against a scratch database
// instead of the real one. Unset in production, where the path is fixed.
const DB_PATH = process.env.NEURO_DB_PATH || path.join(__dirname, 'agent.db');
const DB_DIR = path.dirname(DB_PATH);

let db = null;

function timestampToken() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quarantineDb(reason = 'corrupt') {
  if (!fs.existsSync(DB_PATH)) return null;
  const target = path.join(DB_DIR, `agent.db.${reason}.${timestampToken()}`);
  fs.renameSync(DB_PATH, target);
  return target;
}

// Kept async: callers await init(). Opening is synchronous now, but changing
// the signature would ripple through server.js and the scripts.
async function init() {
  fs.mkdirSync(DB_DIR, { recursive: true });

  // A zero-byte file is a valid (empty) SQLite database, so it would open
  // silently. Quarantine it instead, matching the previous behaviour.
  if (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size === 0) {
    const moved = quarantineDb('empty');
    console.warn(`[DB] Existing database was empty; moved to ${moved}`);
  }

  try {
    db = new Database(DB_PATH);
    // Touch the file so a malformed header fails here, not on first query
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (e) {
    if (db) { try { db.close(); } catch {} }
    const moved = quarantineDb('malformed');
    console.error(`[DB] Failed to load database (${e.message}); moved to ${moved}`);
    db = new Database(DB_PATH);
  }

  // WAL: readers no longer block on the writer, so external scripts can read
  // while the server runs. NORMAL is the standard durable pairing with WAL.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Run migrations
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Migration: vault_embeddings multi-chunk support
  // If the old table has UNIQUE on relative_path alone, recreate with (relative_path, chunk_index)
  try {
    const columns = db.prepare('PRAGMA table_info(vault_embeddings)').all().map(r => r.name);
    if (!columns.includes('chunk_index')) {
      console.log('[DB] Migrating vault_embeddings for multi-chunk support...');
      db.exec('DROP TABLE IF EXISTS vault_embeddings');
      db.exec(`CREATE TABLE vault_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        chunk_text TEXT,
        file_modified TEXT,
        embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(relative_path, chunk_index)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_path ON vault_embeddings(relative_path)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON vault_embeddings(content_hash)');
      console.log('[DB] vault_embeddings migrated — embeddings will rebuild on next cycle');
    }
  } catch (e) {
    console.error('[DB] Migration check failed:', e.message);
  }

  // Migration: tasks.moscow_proposed (added the day after the tasks table itself)
  try {
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(r => r.name);
    if (taskColumns.length && !taskColumns.includes('moscow_proposed')) {
      db.exec('ALTER TABLE tasks ADD COLUMN moscow_proposed INTEGER NOT NULL DEFAULT 0');
      console.log('[DB] tasks.moscow_proposed added');
    }
    // Migration: tasks.estimate_minutes — how long the thing takes. NULL means
    // "not estimated", never zero, so an un-estimated task is distinguishable
    // from an instant one and the assumption used in its place stays visible.
    if (taskColumns.length && !taskColumns.includes('estimate_minutes')) {
      db.exec('ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER');
      console.log('[DB] tasks.estimate_minutes added');
    }
    // Migration: tasks.ms_source — 'MS Planner' or 'MS ToDo' for a task linked to
    // a Microsoft one, so completing it knows which API to PATCH. NULL is a real
    // answer ("we don't know"), and completeMicrosoftTask handles it by trying
    // Planner then To Do; a guessed hint would send it to the wrong one instead.
    if (taskColumns.length && !taskColumns.includes('ms_source')) {
      db.exec('ALTER TABLE tasks ADD COLUMN ms_source TEXT');
      console.log('[DB] tasks.ms_source added');
    }
    // Migration: tasks.assignee — who a VESTA household task is FOR.
    //
    // NULL is a real answer and the default: "nobody has said whose this is",
    // which is different from assigning it to the person who typed it. The two
    // must stay apart or "unassigned" quietly becomes "mine" and the shared list
    // stops meaning anything.
    //
    // Holds `nick` for the owner or a capture-account USERNAME. Not a foreign
    // key: an account can be revoked, and a task that outlives the person who
    // was given it should keep saying who that was rather than silently
    // becoming unassigned.
    if (taskColumns.length && !taskColumns.includes('assignee')) {
      db.exec('ALTER TABLE tasks ADD COLUMN assignee TEXT');
      console.log('[DB] tasks.assignee added');
    }
    // Migration: tasks.household — is this on the shared VESTA list?
    //
    // ⚠ This REPLACES the old rule, which was `source LIKE 'capture:%'`. That
    // asked where a task was TYPED, and whether the household should see
    // something is a question about INTENT — so a home task Nick added through
    // NEURO could never reach the shared list however obviously it belonged
    // there, and a shared one could never be taken back off it.
    //
    // Defaults 0: fails closed. Nothing of his reaches the household surface
    // unless he says so.
    if (taskColumns.length && !taskColumns.includes('household')) {
      db.exec('ALTER TABLE tasks ADD COLUMN household INTEGER NOT NULL DEFAULT 0');
      // ⚠ NOT optional. Everything captured through VESTA was already on the
      // household list under the old rule, so without this the deploy silently
      // empties her list and the feature looks broken the moment it improves.
      const moved = db.prepare("UPDATE tasks SET household = 1 WHERE source LIKE 'capture:%'").run();
      console.log(`[DB] tasks.household added (${moved.changes} existing VESTA captures carried over)`);
    }
    // Migration: tasks.ms_plan — the Planner board or To Do list a linked
    // Microsoft task sits on, so the card can say which one. Display only; the
    // completion push reads ms_source, not this. NULL means "we don't know",
    // which is what a card must show rather than naming the wrong board.
    if (taskColumns.length && !taskColumns.includes('ms_plan')) {
      db.exec('ALTER TABLE tasks ADD COLUMN ms_plan TEXT');
      console.log('[DB] tasks.ms_plan added');
    }
    // Migration: tasks.criticality — how urgent the system that sent this task
    // said it was, in that system's own words. PROVENANCE ONLY, and NEURO never
    // re-derives it: the whole point is that a task which arrived without being
    // asked for can answer who claimed what. NULL is the normal case — nothing
    // Nick creates himself carries one — and null must never be read as "low".
    if (taskColumns.length && !taskColumns.includes('criticality')) {
      db.exec('ALTER TABLE tasks ADD COLUMN criticality TEXT');
      console.log('[DB] tasks.criticality added');
    }
    // Migration: tasks.domain — 'work' or 'personal'. NEURO was built entirely
    // around work, so every row that exists when this runs IS work; that is
    // Nick's own statement, which makes the DEFAULT a fact rather than a guess
    // and means no separate backfill pass is needed — ADD COLUMN with a default
    // stamps every existing row in one statement.
    //
    // ⚠ No CHECK constraint here, unlike schema.sql. SQLite cannot add one via
    // ALTER TABLE, and the alternative is a table rebuild — a destructive
    // migration on a live 447MB DB, to buy a guard that shared/task-domain.cjs
    // already applies on the way in. A fresh DB gets the constraint from the
    // schema; an existing one gets the same protection one layer up.
    if (taskColumns.length && !taskColumns.includes('domain')) {
      db.exec("ALTER TABLE tasks ADD COLUMN domain TEXT NOT NULL DEFAULT 'work'");
      const n = get('SELECT COUNT(*) AS n FROM tasks')?.n || 0;
      console.log(`[DB] tasks.domain added — ${n} existing task(s) stamped 'work'`);
    }

    // Migration: tasks.origin — 'commitment' (somebody else is waiting on it) or
    // 'improvement' (Nick's own idea). See shared/task-origin.cjs.
    //
    // ⚠ NO DEFAULT, unlike `domain` one block up, and the difference is the
    // point: there is no value that is true of every existing row. Every task in
    // the store arrived from a work source, so stamping 'work' was a fact; who
    // WANTED each of these 110 tasks is not recorded anywhere, so stamping
    // either value would be inventing an answer — and the answer is counted in a
    // report that goes to the manager assessing Nick's PIP. Existing rows read
    // NULL ("not classified"), which the report names as its own bucket rather
    // than folding into either.
    //
    // The proposals are a separate, explicit pass: backend/scripts/backfill-task-origin.js.
    if (taskColumns.length && !taskColumns.includes('origin')) {
      db.exec('ALTER TABLE tasks ADD COLUMN origin TEXT');
      const n = get('SELECT COUNT(*) AS n FROM tasks')?.n || 0;
      console.log(`[DB] tasks.origin added — ${n} existing task(s) left unclassified`);
    }
    if (taskColumns.length && !taskColumns.includes('origin_proposed')) {
      db.exec('ALTER TABLE tasks ADD COLUMN origin_proposed INTEGER NOT NULL DEFAULT 0');
      console.log('[DB] tasks.origin_proposed added');
    }
  } catch (e) {
    console.error('[DB] tasks migration check failed:', e.message);
  }

  // Migration: calendar_cache.attendees_other — does this event have other
  // people in it? Graph is asked for `attendees` and the cache dropped them on
  // write, so nothing reading the cache could tell a 1-2-1 from a solo focus
  // block. No backfill is needed: calendar-sync is replace-by-window, so the
  // next sync rewrites every row with the column populated. Existing rows read
  // NULL ("we could not tell") until then, which is the honest interim answer.
  try {
    const calColumns = db.prepare('PRAGMA table_info(calendar_cache)').all().map(r => r.name);
    if (calColumns.length && !calColumns.includes('attendees_other')) {
      db.exec('ALTER TABLE calendar_cache ADD COLUMN attendees_other INTEGER');
      console.log('[DB] calendar_cache.attendees_other added');
    }
    // Migration: calendar_cache.source — which calendar a row came from.
    //
    // ⚠ Every existing row IS a Graph row (Graph was the only writer), so the
    // default stamps them correctly in one statement. That matters more than
    // usual here: the column decides what a sync may DELETE, and a row with no
    // source would be deleted by nothing and live for ever.
    if (calColumns.length && !calColumns.includes('source')) {
      db.exec("ALTER TABLE calendar_cache ADD COLUMN source TEXT NOT NULL DEFAULT 'graph'");
      console.log('[DB] calendar_cache.source added — existing rows stamped graph');
    }
    // ⚠ OUTSIDE the guard above, and NOT in schema.sql. Two reasons, and both
    // have teeth:
    //
    //  1. schema.sql is executed by an unguarded db.exec() BEFORE this block,
    //     and `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
    //     already exists — so on the live database the `source` column does not
    //     exist at that point. An index naming it there throws, db.init() throws
    //     with it, and the backend does not start. The first version of this had
    //     exactly that bug; it passed every test because tests build a FRESH
    //     database, where the column arrives with CREATE TABLE and the migration
    //     path is never exercised at all.
    //  2. It has to be unconditional, because on a fresh database the branch
    //     above does not fire — the column is already there — and an index
    //     created only inside it would never exist on a new install.
    //
    // CREATE INDEX IF NOT EXISTS is idempotent, so running it every boot is free.
    db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_source ON calendar_cache(source, start_time)');
  } catch (e) {
    console.error('[DB] calendar_cache migration check failed:', e.message);
  }

  // Migration: task_blocks gains many-tasks-per-block (18 Aug 2026).
  //
  // The first shape keyed a block on one task_id. Batching several short tasks
  // into one window makes the BLOCK the unit and the membership a separate
  // table, so the old column has to go.
  //
  // **Guarded on the table being EMPTY, and refuses loudly otherwise.** The
  // shipped shape has no home for the rows a populated table would hold — the
  // migration cannot be written honestly — so a drop is only safe on the day it
  // is, which is the day the feature shipped with zero rows. If this ever finds
  // data it must not destroy it; it says so and leaves the table alone, and the
  // new code will fail visibly rather than silently losing a block.
  try {
    const blockCols = db.prepare('PRAGMA table_info(task_blocks)').all().map(r => r.name);
    if (blockCols.includes('task_id')) {
      const rows = db.prepare('SELECT COUNT(*) AS n FROM task_blocks').get().n;
      if (rows === 0) {
        db.exec('DROP TABLE task_blocks');
        // Re-run the schema so the new definition (and its indexes) land. Every
        // statement in it is CREATE ... IF NOT EXISTS, so this is idempotent.
        db.exec(schema);
        console.log('[DB] task_blocks migrated to many-tasks-per-block');
      } else {
        console.error(`[DB] task_blocks holds ${rows} row(s) in the OLD single-task shape and was NOT migrated — task blocks will not work until this is resolved by hand`);
      }
    }
  } catch (e) {
    console.error('[DB] task_blocks migration check failed:', e.message);
  }

  // Migration: health_samples.source_uuid (#40 — Apple Health transport).
  //
  // UNIQUE(metric, recorded_at) already made a re-post idempotent, and it stays
  // the primary guard. This adds the sample's own HealthKit UUID as a second,
  // stricter one, because the phone re-sends overlapping windows constantly:
  // iOS decides when a background sync runs, so "send everything since X" is the
  // only workable contract and the same reading arrives many times.
  //
  // The unique index is PARTIAL (WHERE source_uuid IS NOT NULL) — every row
  // written before this migration, and anything arriving without a UUID, must
  // still be allowed to coexist. A plain UNIQUE would treat all those NULLs as
  // one value on some engines and reject the second row.
  try {
    const healthColumns = db.prepare('PRAGMA table_info(health_samples)').all().map(r => r.name);
    if (healthColumns.length && !healthColumns.includes('source_uuid')) {
      db.exec('ALTER TABLE health_samples ADD COLUMN source_uuid TEXT');
      console.log('[DB] health_samples.source_uuid added');
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_health_samples_uuid
             ON health_samples(source_uuid) WHERE source_uuid IS NOT NULL`);
  } catch (e) {
    console.error('[DB] health_samples migration check failed:', e.message);
  }

  // management_log.task_id — added after the table shipped, so CREATE TABLE IF
  // NOT EXISTS will not put it on an existing DB.
  try {
    const cols = db.prepare('PRAGMA table_info(management_log)').all().map(r => r.name);
    if (cols.length && !cols.includes('task_id')) {
      db.exec('ALTER TABLE management_log ADD COLUMN task_id INTEGER');
      console.log('[DB] management_log.task_id added');
    }
    // hr_logged was NOT NULL DEFAULT 0, which made "never asked" identical to
    // "confirmed missing" — and that difference is the whole point of the
    // column, because the finding built on it goes to the person who does the
    // People HR spot-checks.
    //
    // SQLite cannot drop NOT NULL in place, so this is the standard rebuild.
    // It is worth doing properly rather than working around: leaving the
    // constraint and reinterpreting 0 in `assess()` would mean a genuine
    // "confirmed not logged" could never be recorded at all.
    const hrCol = db.prepare('PRAGMA table_info(management_log)').all().find(c => c.name === 'hr_logged');
    if (hrCol && hrCol.notnull === 1) {
      const before = db.prepare('SELECT COUNT(*) c FROM management_log').get()?.c || 0;
      db.exec('BEGIN');
      try {
        db.exec(`
          CREATE TABLE management_log_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_date TEXT NOT NULL, logged_at TEXT NOT NULL, type TEXT NOT NULL,
            person TEXT, summary TEXT NOT NULL, action TEXT, owner TEXT, due_date TEXT,
            status TEXT NOT NULL DEFAULT 'open', resolved_date TEXT,
            hr_logged INTEGER, source TEXT, notes TEXT, task_id INTEGER,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          -- Every existing 0 was a DEFAULT, never an answer, so it becomes NULL.
          -- A 1 was set deliberately and is kept.
          INSERT INTO management_log_new
            (id, entry_date, logged_at, type, person, summary, action, owner, due_date,
             status, resolved_date, hr_logged, source, notes, task_id, created_at, updated_at)
          SELECT id, entry_date, logged_at, type, person, summary, action, owner, due_date,
                 status, resolved_date, CASE WHEN hr_logged = 1 THEN 1 ELSE NULL END,
                 source, notes, task_id, created_at, updated_at
          FROM management_log;
          DROP TABLE management_log;
          ALTER TABLE management_log_new RENAME TO management_log;
          CREATE INDEX IF NOT EXISTS idx_mgmt_log_due ON management_log(due_date);
          CREATE INDEX IF NOT EXISTS idx_mgmt_log_status ON management_log(status);
          CREATE INDEX IF NOT EXISTS idx_mgmt_log_entry ON management_log(entry_date DESC);
        `);
        const after = db.prepare('SELECT COUNT(*) c FROM management_log').get()?.c || 0;
        if (after !== before) throw new Error(`row count changed ${before} → ${after}`);
        db.exec('COMMIT');
        console.log(`[DB] management_log.hr_logged rebuilt as tri-state (${after} rows preserved)`);
      } catch (e) {
        db.exec('ROLLBACK');
        console.error('[DB] management_log hr_logged rebuild failed, rolled back:', e.message);
      }
    }
  } catch (e) {
    console.error('[DB] management_log migration check failed:', e.message);
  }

  // #107(b) — sara_actions is scanned, not indexed.
  //
  // The only index on a 16,282-row table was `status`, so the scoped reads added
  // in #103 ("has this note already been actioned?", "of this type") came out as
  // SCAN sara_actions, confirmed by EXPLAIN QUERY PLAN. A full nightly sweep is
  // ~813ms across 206 notes today and the cost is rows x notes.
  //
  // Two indexes: `type`, and an EXPRESSION index on the payload's sourcePath —
  // SQLite supports indexing json_extract, and sourcePath is the key those
  // dedupe checks actually filter on. It is the expression that must match the
  // query's exactly, character for character, or the planner ignores the index
  // and the scan comes back silently.
  //
  // Note the growth this was filed against has already stopped: creation went
  // 7,096/day on 14 Aug to 4 and then 1, once persistSuggestions gained its
  // write-side dedupe guard. So this is now ordinary debt rather than the
  // unbounded problem the ticket describes — worth having, not urgent.
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sara_actions_type ON sara_actions(type)');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sara_actions_source_path
             ON sara_actions(json_extract(payload, '$.sourcePath'))`);
  } catch (e) {
    console.error('[DB] sara_actions index migration failed:', e.message);
  }

  console.log('[DB] Initialized');
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call init() first');
  return db;
}

// ── Query helpers ────────────────────────────────────────────────────────────
// Writes commit immediately, so there is no save()/export() step any more.
// Statements are cached because prepare() re-parses SQL on every call.

const stmtCache = new Map();

function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

// better-sqlite3 throws on undefined bindings where sql.js quietly took them.
// Normalise so a missing optional field stays a NULL rather than a 500.
function norm(params) {
  return (params || []).map(p => (p === undefined ? null : p));
}

function all(sql, params) { return stmt(sql).all(norm(params)); }
function get(sql, params) { return stmt(sql).get(norm(params)) || null; }
function run(sql, params) { return stmt(sql).run(norm(params)); }

// Run a SYNCHRONOUS fn as one atomic unit. Previously this collapsed many
// full-database flushes into one; now it is a real transaction, which keeps
// the same all-or-nothing property. Nesting is safe — better-sqlite3 uses
// savepoints. Still not for async work: an await would commit early.
function batchSaves(fn) {
  return getDb().transaction(fn)();
}

// Conversation helpers
function saveMessage(conversationId, role, content) {
  run(
    'INSERT INTO conversations (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, role, content]
  );
}

function getConversationHistory(conversationId, limit = 20) {
  const rows = all(
    `SELECT role, content, created_at FROM conversations
     WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [conversationId, limit]
  );
  return rows.reverse();
}

// ── Jira queue cache: REMOVED 27 Aug 2026 ────────────────────────────────────
//
// The queue feature was deleted on 3 July 2026 (48e6481, "too much noise") — a
// product decision — along with the sync that wrote `jira_tickets_cache`. Three
// later commits then reintroduced READERS of the table it left behind, so for
// seven weeks NEURO quoted the twelve rows frozen there as current fact in
// standups, EOD notes, the daily note, chat and the briefing. Every reader
// guarded on `total > 0`, which is true of stale data.
//
// Gating those readers on freshness stopped the lying; this finishes the
// deletion, because dead-but-readable code is how the bug happened in the first
// place. `upsertTicket`, `clearStaleTickets`, `getAllTickets`,
// `getAtRiskTickets` and `getQueueSummary` are gone with their callers.
//
// ⚠ ESCALATIONS ARE UNAFFECTED and always were. `routes/escalation.js` queries
// Jira live via `/rest/api/3/search/jql` plus NOVA's escalation_log, and never
// touched this cache. SLA-at-risk awareness is what was given up here; if it is
// ever wanted back, build it on that live path rather than resurrecting a cache.
//
// The table itself is left defined and empty in schema.sql — see the note there.

// Decision helpers
function saveDecision(conversationId, decisionText) {
  run('INSERT INTO decisions (conversation_id, decision_text) VALUES (?, ?)', [conversationId, decisionText]);
}

// Agent state helpers
function setState(key, value) {
  run(
    `INSERT OR REPLACE INTO agent_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
    [key, value]
  );
}

function getState(key) {
  const row = get('SELECT value FROM agent_state WHERE key = ?', [key]);
  return row ? row.value : null;
}

// Nudge helpers
function createNudge(type, message, dateKey) {
  run('INSERT INTO nudges (type, message, date_key) VALUES (?, ?, ?)', [type, message, dateKey]);
}

function getActiveNudges() {
  return all('SELECT * FROM nudges WHERE active = 1 ORDER BY created_at DESC');
}

function getActiveNudgeByTypeAndDate(type, dateKey) {
  return get('SELECT * FROM nudges WHERE type = ? AND date_key = ? AND active = 1', [type, dateKey]);
}

function updateNudgeMessage(id, message) {
  run('UPDATE nudges SET message = ? WHERE id = ?', [message, id]);
}

function completeNudge(id) {
  run("UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE id = ?", [id]);
}

function completeNudgeByType(type, dateKey) {
  run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE type = ? AND date_key = ? AND active = 1",
    [type, dateKey]
  );
}

function completeAllNudgesByType(type) {
  run("UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE type = ? AND active = 1", [type]);
}

function incrementNagCount(id) {
  run('UPDATE nudges SET nag_count = nag_count + 1 WHERE id = ?', [id]);
}

// Todo helpers
function createTodo(text, priority, dueDate, source, msId) {
  run(
    'INSERT INTO todos (text, priority, due_date, source, ms_id) VALUES (?, ?, ?, ?, ?)',
    [text, priority || 'normal', dueDate || null, source || null, msId || null]
  );
}

function clearMsTodos() {
  run("DELETE FROM todos WHERE source LIKE 'MS %'");
}

function getActiveTodos() {
  return all(
    "SELECT * FROM todos WHERE done = 0 ORDER BY due_date ASC NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END, created_at ASC"
  );
}

function getAllTodos() {
  return all('SELECT * FROM todos ORDER BY done ASC, created_at DESC');
}

function completeTodo(id) {
  run("UPDATE todos SET done = 1, completed_at = datetime('now') WHERE id = ?", [id]);
}

function deleteTodo(id) {
  run('DELETE FROM todos WHERE id = ?', [id]);
}

// Calendar cache helpers
function upsertCalendarEvent(event) {
  // attendees_other is deliberately three-valued. `event.attendeesOther` is
  // true/false when the caller could judge it and undefined when it could not,
  // and coercing that unknown to 0 would tell every reader "solo block" about a
  // meeting we simply could not see the attendees of.
  const attendeesOther = typeof event.attendeesOther === 'boolean'
    ? (event.attendeesOther ? 1 : 0)
    : null;
  run(`
    INSERT OR REPLACE INTO calendar_cache
      (event_id, subject, start_time, end_time, is_all_day, location, organizer, show_as, attendees_other, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    event.id, event.subject, event.start, event.end,
    event.isAllDay ? 1 : 0, event.location, event.organizer, event.showAs,
    attendeesOther,
    // Which calendar this came from. Defaulted rather than left to the caller,
    // because the value decides what a sync is allowed to DELETE — see below.
    event.source || 'graph'
  ]);
}

/**
 * Empty the cache for ONE source.
 *
 * ⚠ `source` is required, and the argument is not optional by accident. This
 * used to be `DELETE FROM calendar_cache` — the whole table — which was correct
 * while Graph was the only writer, and becomes silent data loss the moment a
 * second calendar exists: calendar-sync runs every few minutes, so every Apple
 * event would be deleted within minutes of arriving, and the diary would simply
 * look like the work one again with nothing reporting a problem.
 *
 * Throwing on a missing source is deliberate. A default of 'graph' would make
 * the dangerous call the easy one to write.
 */
function clearCalendarCache(source) {
  if (!source) throw new Error('clearCalendarCache requires a source — see the comment above');
  run('DELETE FROM calendar_cache WHERE source = ?', [source]);
}

/** Clear one source inside a window, for a push-based sync that sends a range. */
function clearCalendarWindow(source, fromIso, toIso) {
  if (!source) throw new Error('clearCalendarWindow requires a source');
  run(
    'DELETE FROM calendar_cache WHERE source = ? AND start_time >= ? AND start_time <= ?',
    [source, fromIso, toIso]
  );
}

function getCalendarEvents(startDate, endDate) {
  return all(
    'SELECT * FROM calendar_cache WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC',
    [startDate, endDate]
  );
}

// Push subscription helpers
function savePushSubscription(subscription) {
  run(`
    INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?)
  `, [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
}

function getAllPushSubscriptions() {
  return all('SELECT * FROM push_subscriptions');
}

function removePushSubscription(endpoint) {
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

// ── Push delivery log ────────────────────────────────────────────────────────
// Bounded on write. Volume is ~5/day, so this is cheap, but an append-only
// table with no retention is how the email triage blob quietly became a 668KB
// pile — the same mistake one step later.
const PUSH_LOG_RETAIN_DAYS = 90;

function logPushOutcome({ type, title, outcome, reason, sentCount, failedCount }) {
  run(
    `INSERT INTO push_log (type, title, outcome, reason, sent_count, failed_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [type || null, title, outcome, reason || null, sentCount || 0, failedCount || 0]
  );
  run(
    `DELETE FROM push_log WHERE created_at < datetime('now', ?)`,
    [`-${PUSH_LOG_RETAIN_DAYS} days`]
  );
}

function getPushLog(limit = 50) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 50;
  return all('SELECT * FROM push_log ORDER BY id DESC LIMIT ?', [n]);
}

// ── Attention records ────────────────────────────────────────────────────────
// Contract: docs/attention-contract.md. These are thin — every judgement about
// what a state MEANS lives in services/attention-lifecycle.js, which is pure and
// pins without a database (the pi-health.assess() split).

// The states a generated item may re-match against. Terminal states are absent
// on purpose: a resolved, expired or dismissed record must NOT be revived by the
// same dedupe_key turning up again, or yesterday's dismissal silences today's
// standup and a daily recurrence can never open a fresh record.
const ATTENTION_OPEN_STATES = ['active', 'acknowledged', 'deferred'];

/** The open record for a dedupe_key, or null. Newest wins if several exist. */
function getOpenAttentionRecord(dedupeKey) {
  const marks = ATTENTION_OPEN_STATES.map(() => '?').join(', ');
  return get(
    `SELECT * FROM attention_records
      WHERE dedupe_key = ? AND state IN (${marks})
      ORDER BY first_seen_at DESC LIMIT 1`,
    [dedupeKey, ...ATTENTION_OPEN_STATES]
  ) || null;
}

function getAttentionRecord(id) {
  return get('SELECT * FROM attention_records WHERE id = ?', [id]) || null;
}

/** Every record not in a terminal state, newest evidence first. */
function getOpenAttentionRecords() {
  const marks = ATTENTION_OPEN_STATES.map(() => '?').join(', ');
  return all(
    `SELECT * FROM attention_records WHERE state IN (${marks})
      ORDER BY last_seen_at DESC`,
    ATTENTION_OPEN_STATES
  );
}

function insertAttentionRecord(r) {
  run(
    `INSERT INTO attention_records
       (id, dedupe_key, type, state, title, say, reason, tab, urgency, tier, score,
        domain, operational, confidence, evidence, actions, meta,
        first_seen_at, last_seen_at, state_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id, r.dedupeKey, r.type, r.state, r.title || null, r.say || null,
      r.reason || null, r.tab || null, r.urgency || null,
      r.tier ?? null, r.score ?? null, r.domain || null, r.operational ? 1 : 0,
      JSON.stringify(r.confidence || null), JSON.stringify(r.evidence || []),
      JSON.stringify(r.actions || []), JSON.stringify(r.meta || null),
      r.firstSeenAt, r.lastSeenAt, r.stateChangedAt,
    ]
  );
  return getAttentionRecord(r.id);
}

/**
 * Refresh the volatile half of a record from a fresh sighting.
 *
 * ⚠ Deliberately does NOT touch state, defer_until, notified_at or
 * notify_signature. A re-sighting is evidence that the thing still exists; it is
 * not Nick changing his mind, and letting the generator overwrite a deferral
 * would make "snooze" mean "snooze until the next poll" — which, at a 60-second
 * ambient refresh, is no snooze at all.
 */
function touchAttentionRecord(id, r) {
  run(
    `UPDATE attention_records
        SET last_seen_at = ?, title = ?, say = ?, reason = ?, tab = ?,
            urgency = ?, tier = ?, score = ?, domain = ?,
            confidence = ?, evidence = ?, actions = ?, meta = ?
      WHERE id = ?`,
    [
      r.lastSeenAt, r.title || null, r.say || null, r.reason || null, r.tab || null,
      r.urgency || null, r.tier ?? null, r.score ?? null, r.domain || null,
      JSON.stringify(r.confidence || null), JSON.stringify(r.evidence || []),
      JSON.stringify(r.actions || []), JSON.stringify(r.meta || null), id,
    ]
  );
  return getAttentionRecord(id);
}

function setAttentionState(id, state, at, opts = {}) {
  run(
    `UPDATE attention_records
        SET state = ?, state_changed_at = ?, defer_until = ?, defer_reason = ?, resolution = ?
      WHERE id = ?`,
    [state, at, opts.deferUntil || null, opts.deferReason || null, opts.resolution || null, id]
  );
  return getAttentionRecord(id);
}

function markAttentionSurfaced(id, at) {
  run('UPDATE attention_records SET surfaced_at = ? WHERE id = ? AND surfaced_at IS NULL', [at, id]);
}

function markAttentionNotified(id, at, signature) {
  run('UPDATE attention_records SET notified_at = ?, notify_signature = ? WHERE id = ?', [at, signature, id]);
}

/** Records whose defer window has passed — they return to active on their own. */
function getExpiredDeferrals(nowIso) {
  return all(
    "SELECT * FROM attention_records WHERE state = 'deferred' AND defer_until IS NOT NULL AND defer_until <= ?",
    [nowIso]
  );
}

// Bounded on write, like push_log — an append-only history with no retention is
// how the email triage blob became a 668KB pile.
const ATTENTION_EVENT_RETAIN_DAYS = 90;

function logAttentionEvent(recordId, event, at, detail) {
  run(
    'INSERT INTO attention_events (record_id, at, event, detail) VALUES (?, ?, ?, ?)',
    [recordId, at, event, detail || null]
  );
  run('DELETE FROM attention_events WHERE at < ?', [
    new Date(Date.now() - ATTENTION_EVENT_RETAIN_DAYS * 864e5).toISOString(),
  ]);
}

/** The history Nick reads: what was surfaced, when, and why. */
function getAttentionHistory(limit = 50) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 50;
  return all(
    `SELECT e.*, r.type, r.title, r.dedupe_key, r.state AS current_state
       FROM attention_events e
       JOIN attention_records r ON r.id = e.record_id
      ORDER BY e.at DESC, e.id DESC LIMIT ?`,
    [n]
  );
}

/** Outcome counts since an ISO timestamp, plus the suppression reasons behind them. */
function getPushStats(sinceIso) {
  const since = sinceIso || new Date(Date.now() - 7 * 864e5).toISOString();
  return {
    since,
    outcomes: all(
      `SELECT outcome, COUNT(*) AS count FROM push_log
        WHERE created_at >= ? GROUP BY outcome ORDER BY count DESC`,
      [since]
    ),
    reasons: all(
      `SELECT outcome, reason, COUNT(*) AS count FROM push_log
        WHERE created_at >= ? AND reason IS NOT NULL
        GROUP BY outcome, reason ORDER BY count DESC`,
      [since]
    ),
    byType: all(
      `SELECT type, outcome, COUNT(*) AS count FROM push_log
        WHERE created_at >= ? GROUP BY type, outcome ORDER BY count DESC`,
      [since]
    ),
  };
}

// Import classification helpers
function saveImportClassification(relativePath, cls) {
  run(`
    INSERT OR REPLACE INTO import_classifications
      (relative_path, type, destination, confidence, reason, backend, classified_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `, [relativePath, cls.type, cls.destination, cls.confidence, cls.reason, cls.backend || null]);
}

function getImportClassification(relativePath) {
  return get('SELECT * FROM import_classifications WHERE relative_path = ?', [relativePath]);
}

function getAllImportClassifications() {
  return all('SELECT * FROM import_classifications');
}

function deleteImportClassification(relativePath) {
  run('DELETE FROM import_classifications WHERE relative_path = ?', [relativePath]);
}

function deleteAllImportClassifications() {
  run('DELETE FROM import_classifications');
}

// Activity log helpers
function logActivity(eventType, eventData, dateKey) {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const dk = dateKey || now.toISOString().split('T')[0];
  run(
    `INSERT INTO activity_log (event_type, event_data, hour, day_of_week, date_key)
     VALUES (?, ?, ?, ?, ?)`,
    [eventType, eventData ? JSON.stringify(eventData) : null, hour, dayOfWeek, dk]
  );
}

function getActivityForDate(dateKey) {
  return all('SELECT * FROM activity_log WHERE date_key = ? ORDER BY created_at ASC', [dateKey]);
}

function getActivityForRange(startDate, endDate) {
  return all(
    'SELECT * FROM activity_log WHERE date_key >= ? AND date_key <= ? ORDER BY created_at ASC',
    [startDate, endDate]
  );
}

// Daily summary helpers
function saveDailySummary(dateKey, summary) {
  run(`
    INSERT OR REPLACE INTO daily_summary
      (date_key, standup_done, standup_hour, standup_snooze_count,
       todo_snooze_count, eod_done, captures_count, chat_count,
       chat_topics, tabs_opened, summary_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    dateKey,
    summary.standup_done ? 1 : 0,
    summary.standup_hour || null,
    summary.standup_snooze_count || 0,
    summary.todo_snooze_count || 0,
    summary.eod_done ? 1 : 0,
    summary.captures_count || 0,
    summary.chat_count || 0,
    summary.chat_topics ? JSON.stringify(summary.chat_topics) : null,
    summary.tabs_opened ? JSON.stringify(summary.tabs_opened) : null,
    JSON.stringify(summary)
  ]);
}

function getDailySummaries(daysBack = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return all('SELECT * FROM daily_summary WHERE date_key >= ? ORDER BY date_key DESC', [cutoffStr]);
}

function getTodayActivity() {
  const today = new Date().toISOString().split('T')[0];
  return getActivityForDate(today);
}

function getRecentConversations(limit = 5) {
  const rows = all(
    `SELECT conversation_id, MIN(created_at) as started_at, MAX(created_at) as last_at,
            COUNT(*) as message_count
     FROM conversations
     GROUP BY conversation_id
     ORDER BY MAX(created_at) DESC
     LIMIT ?`,
    [limit]
  );
  for (const row of rows) {
    // Get first user message as preview
    const preview = get(
      `SELECT content FROM conversations WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`,
      [row.conversation_id]
    );
    row.preview = preview ? String(preview.content).substring(0, 80) : '';
  }
  return rows;
}

// ── AI cost ledger (26 Aug 2026) ────────────────────────────────────────────
// Deliberately the SAME day boundary as `ai-routing`'s `_todayStr()` (UTC date)
// rather than the local one used elsewhere. The panel shows the ledger's
// "today" next to the budget counter's "today", and two definitions of the day
// would have them disagree for an hour every evening — a discrepancy that
// reads as a bug in the numbers themselves. Duplicated rather than imported
// because ai-routing already requires this module.
function aiLedgerDateKey() {
  return new Date().toISOString().split('T')[0];
}

// One row per cloud call, cost frozen at write time — the same shape NOVA's
// `agent_llm_calls` uses, so the two systems answer "what is this costing" the
// same way. Local dates, never toISOString().
function recordAiCall(call) {
  run(`
    INSERT INTO ai_calls
      (date_key, provider, model, task_type, prompt_tokens, completion_tokens, cost_usd, cost_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    aiLedgerDateKey(),
    call.provider,
    call.model || null,
    call.taskType || null,
    call.promptTokens || 0,
    call.completionTokens || 0,
    // Explicit null, never 0 — an unpriced call is not a free one.
    call.costUsd == null ? null : call.costUsd,
    call.costSource || null,
  ]);
}

function getAiCallsSince(dateKey) {
  return all('SELECT * FROM ai_calls WHERE date_key >= ? ORDER BY id DESC', [dateKey]);
}

function getAiSpendByDay(dateKey) {
  return all(`
    SELECT date_key,
           COUNT(*) AS calls,
           SUM(prompt_tokens + completion_tokens) AS tokens,
           SUM(cost_usd) AS cost_usd,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM ai_calls WHERE date_key >= ?
    GROUP BY date_key ORDER BY date_key DESC
  `, [dateKey]);
}

function getAiSpendBy(column, dateKey) {
  // Caller-supplied column, so it is whitelisted rather than interpolated.
  const col = { task: 'task_type', model: 'model', provider: 'provider' }[column];
  if (!col) throw new Error(`getAiSpendBy: unknown grouping "${column}"`);
  return all(`
    SELECT ${col} AS key,
           COUNT(*) AS calls,
           SUM(prompt_tokens + completion_tokens) AS tokens,
           SUM(cost_usd) AS cost_usd,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM ai_calls WHERE date_key >= ?
    GROUP BY ${col} ORDER BY cost_usd DESC
  `, [dateKey]);
}

// Inbox item helpers RETIRED 26 Aug 2026 with `inbox-scanner.js`.
//
// The `inbox_items` table is left defined but is written by nothing: it was a
// second triage store that nothing reconciled with the one the panel renders,
// and because no frontend ever called its dismiss route it only ever grew. The
// urgent-email push notification counted it — 37 against a panel showing 3.
// Inbox state lives in `agent_state.email_triage`, and `email-triage.js` is the
// only thing that reads or writes it. Do not resurrect these.

// Embedding helpers — multi-chunk: each file can have multiple chunks
function saveEmbedding(relativePath, contentHash, embedding, chunkText, fileModified, chunkIndex = 0) {
  run(`
    INSERT OR REPLACE INTO vault_embeddings
      (relative_path, chunk_index, content_hash, embedding, chunk_text, file_modified, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `, [relativePath, chunkIndex, contentHash, JSON.stringify(embedding), chunkText, fileModified]);
}

function getEmbedding(relativePath) {
  // Returns first chunk (for backwards compat / change detection)
  return get('SELECT * FROM vault_embeddings WHERE relative_path = ? ORDER BY chunk_index ASC LIMIT 1', [relativePath]);
}

function getEmbeddingChunkCount(relativePath) {
  const row = get('SELECT COUNT(*) as count FROM vault_embeddings WHERE relative_path = ?', [relativePath]);
  return row ? row.count : 0;
}

function getAllEmbeddings() {
  return all('SELECT * FROM vault_embeddings');
}

/**
 * One row per indexed NOTE — path, hash, mtime and chunk count, WITHOUT the
 * vectors.
 *
 * ⚠ The coverage report needs exactly this and nothing else. `getAllEmbeddings`
 * loads every embedding blob (thousands of rows of 1024 floats as JSON), which
 * is fine for a scoring pass and absurd for a bookkeeping one — reading the
 * whole index to count it is how a health check becomes the reason the Pi is
 * slow.
 */
function getEmbeddingIndexSummary() {
  return all(`SELECT relative_path,
                     MIN(content_hash) AS content_hash,
                     MIN(file_modified) AS file_modified,
                     COUNT(*) AS chunks
              FROM vault_embeddings
              GROUP BY relative_path`);
}

function deleteEmbedding(relativePath) {
  // Deletes all chunks for this file
  run('DELETE FROM vault_embeddings WHERE relative_path = ?', [relativePath]);
}

// Entity extraction helpers
function saveEntity(sourcePath, entityType, entityValue, context) {
  run(
    `INSERT INTO extracted_entities (source_path, entity_type, entity_value, context) VALUES (?, ?, ?, ?)`,
    [sourcePath, entityType, entityValue, context || null]
  );
}

function getEntitiesForPath(sourcePath) {
  return all('SELECT * FROM extracted_entities WHERE source_path = ? ORDER BY entity_type', [sourcePath]);
}

function getEntitiesByType(entityType, limit = 50) {
  return all('SELECT * FROM extracted_entities WHERE entity_type = ? ORDER BY extracted_at DESC LIMIT ?', [entityType, limit]);
}

function getEntitiesByValue(entityValue) {
  return all('SELECT * FROM extracted_entities WHERE entity_value = ? ORDER BY extracted_at DESC', [entityValue]);
}

function deleteEntitiesForPath(sourcePath) {
  run('DELETE FROM extracted_entities WHERE source_path = ?', [sourcePath]);
}

// Note link / backlink helpers
function saveLink(sourcePath, targetPath, targetEntity, linkType) {
  run(
    `INSERT OR IGNORE INTO note_links (source_path, target_path, target_entity, link_type) VALUES (?, ?, ?, ?)`,
    [sourcePath, targetPath || null, targetEntity || null, linkType]
  );
}

function getLinksFrom(sourcePath) {
  return all('SELECT * FROM note_links WHERE source_path = ?', [sourcePath]);
}

function getLinksTo(targetPath) {
  return all('SELECT * FROM note_links WHERE target_path = ?', [targetPath]);
}

function getBacklinks(entityOrPath) {
  return all(
    'SELECT * FROM note_links WHERE target_path = ? OR target_entity = ? ORDER BY created_at DESC',
    [entityOrPath, entityOrPath]
  );
}

function deleteLinksForPath(sourcePath) {
  run('DELETE FROM note_links WHERE source_path = ?', [sourcePath]);
}

// Do Next helpers
function createDoNext(text, source, sourceRef, priority, dueDate) {
  run(
    `INSERT INTO do_next (text, source, source_ref, priority, due_date) VALUES (?, ?, ?, ?, ?)`,
    [text, source || 'manual', sourceRef || null, priority || 'normal', dueDate || null]
  );
}

function getActiveDoNext() {
  return all(
    `SELECT * FROM do_next WHERE done = 0
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
       due_date ASC NULLS LAST,
       created_at ASC`
  );
}

function getAllDoNext() {
  return all(`SELECT * FROM do_next ORDER BY done ASC, created_at DESC`);
}

function completeDoNext(id) {
  run(`UPDATE do_next SET done = 1, done_at = datetime('now') WHERE id = ?`, [id]);
}

function deleteDoNext(id) {
  run('DELETE FROM do_next WHERE id = ?', [id]);
}

// ── NOVA flags ("Nick, look at this") ──
// NOVA is the source of truth: each sync replaces the entire active set so
// tickets NOVA no longer flags (resolved / reviewed) disappear automatically.
function replaceNovaFlags(flags) {
  const list = flags || [];
  // Transactional: the delete and the refill land together, so a failure
  // mid-loop can't leave the table half-populated.
  batchSaves(() => {
    run('DELETE FROM nova_flags');
    for (const f of list) {
      if (!f || !f.ticket_key) continue;
      run(
        `INSERT INTO nova_flags
           (ticket_key, risk_score, category, why, summary, assignee, ticket_status, reasons, flagged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          f.ticket_key,
          Number(f.risk_score) || 0,
          f.category || null,
          f.why || null,
          f.summary || null,
          f.assignee || null,
          f.ticket_status || null,
          Array.isArray(f.reasons) ? JSON.stringify(f.reasons) : (f.reasons || null),
          f.flagged_at || null,
        ]
      );
    }
  });
  return list.length;
}

function getActiveNovaFlags() {
  return all('SELECT * FROM nova_flags ORDER BY risk_score DESC');
}

// ── Health samples (Apple Health time series) ──

// INSERT OR IGNORE, so re-posting a sample the watch already gave us is a no-op
// rather than a duplicate that would drag the baseline.
function insertHealthSample(metric, value, recordedAt, source) {
  const r = run(
    `INSERT OR IGNORE INTO health_samples (metric, value, recorded_at, source)
     VALUES (?, ?, ?, ?)`,
    [metric, value, recordedAt, source || 'ingest']
  );
  return r.changes > 0;
}

// As above, plus the sample's HealthKit UUID. Two OR IGNOREs are in play: the
// (metric, recorded_at) constraint and the partial unique index on source_uuid,
// so a re-sent reading folds on whichever it trips first. Returns false when it
// folded, which is what lets the ingest response report inserted vs skipped
// honestly rather than counting everything it received as new.
function insertHealthSampleWithUuid(metric, value, recordedAt, source, sourceUuid) {
  const r = run(
    `INSERT OR IGNORE INTO health_samples (metric, value, recorded_at, source, source_uuid)
     VALUES (?, ?, ?, ?, ?)`,
    [metric, value, recordedAt, source || 'ingest', sourceUuid || null]
  );
  return r.changes > 0;
}

function getHealthSamples(metric, sinceIso, limit) {
  return all(
    `SELECT value, recorded_at FROM health_samples
     WHERE metric = ? AND recorded_at >= ?
     ORDER BY recorded_at DESC LIMIT ?`,
    [metric, sinceIso, limit || 5000]
  );
}

function getLatestHealthSample(metric) {
  return get(
    `SELECT value, recorded_at FROM health_samples
     WHERE metric = ? ORDER BY recorded_at DESC LIMIT 1`,
    [metric]
  );
}

// What is actually in the health series, per metric. Powers the MCP tool and
// the ingest status view. Reports first/last seen as well as counts, because
// "we have 4,000 rows" and "nothing has arrived since Tuesday" look identical
// on a count alone — and with iOS deciding when to sync, a stalled feed is the
// expected failure, not a surprising one.
// Every sleep segment in the window, whatever Apple called the stage.
//
// The caller used to enumerate metric names and ask for each one, which is how
// the staged breakdown went missing for 725 of 728 nights: Apple's labels are
// `sleep_asleep_core_hours` / `_asleep_rem_` / `_asleep_deep_`, and the list
// asked for `sleep_core_hours`. A guessed name returns zero rows, not an error.
// Matching on the prefix means a stage nobody anticipated still arrives.
function getSleepSamples(sinceIso, limit) {
  return all(
    `SELECT metric, value, recorded_at FROM health_samples
      WHERE metric LIKE 'sleep\\_%' ESCAPE '\\' AND recorded_at >= ?
      ORDER BY recorded_at DESC LIMIT ?`,
    [sinceIso, limit || 20000]
  );
}

function getHealthMetricSummary(sinceIso) {
  return all(
    `SELECT metric,
            COUNT(*)          AS samples,
            MIN(recorded_at)  AS first_at,
            MAX(recorded_at)  AS last_at
       FROM health_samples
      WHERE (? IS NULL OR recorded_at >= ?)
      GROUP BY metric
      ORDER BY last_at DESC`,
    [sinceIso || null, sinceIso || null]
  );
}

// ── Health daily rollup ──

// Per-day aggregates for the scalar metrics, computed in SQL because the
// alternative is pulling ~1.1M rows into JS to add them up.
//
// AVG and SUM are both returned for every metric and the CALLER picks, rather
// than this deciding: steps want a sum and respiratory rate wants an average,
// and which is which is a fact about the metric, not about SQL. `n` comes back
// too, so a day with one reading is distinguishable from a day with sixty.
// ⚠ Every one of these takes BOTH ends of the window, and that is not tidiness.
// The first cut bounded only the start, which is harmless for the hourly rollup
// (its window ends at now anyway) and silently wrong for a backfill walking
// backwards: each chunk read from its start all the way to the present, and the
// row cap then kept the NEWEST rows, so the oldest chunk's HRV read was
// truncated to the last few months and it overwrote two years of days with
// nulls. Measured when it happened — 744 days written, only 328 with any HRV in
// them. A cap that silently changes the answer instead of refusing is the same
// species as the calendar's $top=50 and the 1,958-key JQL.
function getDailyMetricAggregates(metrics, sinceIso, untilIso) {
  if (!Array.isArray(metrics) || !metrics.length) return [];
  const placeholders = metrics.map(() => '?').join(',');
  return all(
    `SELECT date(recorded_at) AS day,
            metric,
            COUNT(*)   AS n,
            AVG(value) AS avg,
            SUM(value) AS sum,
            MIN(value) AS min,
            MAX(value) AS max
       FROM health_samples
      WHERE metric IN (${placeholders})
        AND recorded_at >= ?
        AND (? IS NULL OR recorded_at <= ?)
      GROUP BY day, metric`,
    [...metrics, sinceIso, untilIso || null, untilIso || null]
  );
}

// Raw samples for one metric across a bounded window. Separate from
// getHealthSamples (which stress-score uses with an open end) rather than
// changing that signature underneath it.
function getHealthSamplesBetween(metric, sinceIso, untilIso, limit) {
  return all(
    `SELECT value, recorded_at FROM health_samples
      WHERE metric = ? AND recorded_at >= ? AND (? IS NULL OR recorded_at <= ?)
      ORDER BY recorded_at DESC LIMIT ?`,
    [metric, sinceIso, untilIso || null, untilIso || null, limit || 20000]
  );
}

function getSleepSamplesBetween(sinceIso, untilIso, limit) {
  return all(
    `SELECT metric, value, recorded_at FROM health_samples
      WHERE metric LIKE 'sleep\\_%' ESCAPE '\\'
        AND recorded_at >= ? AND (? IS NULL OR recorded_at <= ?)
      ORDER BY recorded_at DESC LIMIT ?`,
    [sinceIso, untilIso || null, untilIso || null, limit || 20000]
  );
}

function upsertHealthDay(row) {
  run(
    `INSERT INTO health_daily (
       day, asleep_hours, sleep_source, deep_hours, rem_hours, core_hours,
       awake_hours, sleep_efficiency, hrv_median, hrv_samples, rhr_median,
       steps, active_energy, exercise_minutes, stand_minutes, daylight_minutes,
       respiratory_rate, wrist_temp, spo2, weight_kg, complete, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(day) DO UPDATE SET
       asleep_hours=excluded.asleep_hours, sleep_source=excluded.sleep_source,
       deep_hours=excluded.deep_hours, rem_hours=excluded.rem_hours,
       core_hours=excluded.core_hours, awake_hours=excluded.awake_hours,
       sleep_efficiency=excluded.sleep_efficiency, hrv_median=excluded.hrv_median,
       hrv_samples=excluded.hrv_samples, rhr_median=excluded.rhr_median,
       steps=excluded.steps, active_energy=excluded.active_energy,
       exercise_minutes=excluded.exercise_minutes, stand_minutes=excluded.stand_minutes,
       daylight_minutes=excluded.daylight_minutes, respiratory_rate=excluded.respiratory_rate,
       wrist_temp=excluded.wrist_temp, spo2=excluded.spo2, weight_kg=excluded.weight_kg,
       complete=excluded.complete, computed_at=CURRENT_TIMESTAMP`,
    [
      row.day, row.asleepHours ?? null, row.sleepSource ?? null, row.deepHours ?? null,
      row.remHours ?? null, row.coreHours ?? null, row.awakeHours ?? null,
      row.sleepEfficiency ?? null, row.hrvMedian ?? null, row.hrvSamples ?? null,
      row.rhrMedian ?? null, row.steps ?? null, row.activeEnergy ?? null,
      row.exerciseMinutes ?? null, row.standMinutes ?? null, row.daylightMinutes ?? null,
      row.respiratoryRate ?? null, row.wristTemp ?? null, row.spo2 ?? null,
      row.weightKg ?? null, row.complete ? 1 : 0,
    ]
  );
}

// Newest first. `completeOnly` exists because a baseline built over today's
// half-finished row is a baseline that shifts all morning.
function getHealthDays(days, { completeOnly = false } = {}) {
  return all(
    `SELECT * FROM health_daily
      ${completeOnly ? 'WHERE complete = 1' : ''}
      ORDER BY day DESC LIMIT ?`,
    [days || 30]
  );
}

function getHealthDay(day) {
  return get('SELECT * FROM health_daily WHERE day = ?', [day]);
}

// ── Desktop agent, rolled up per day per machine ──
// One row per (day, host). See services/desktop-daily.js for why nothing is
// merged across hosts and why a thinner row must never overwrite a fuller one.

function upsertDesktopDay(row) {
  run(
    `INSERT INTO desktop_daily (
       day, host, present_minutes, active_minutes, idle_minutes, locked_minutes,
       apps, top_app, top_app_minutes, longest_run_minutes, first_at, last_at,
       sample_count, complete, computed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(day, host) DO UPDATE SET
       present_minutes=excluded.present_minutes, active_minutes=excluded.active_minutes,
       idle_minutes=excluded.idle_minutes, locked_minutes=excluded.locked_minutes,
       apps=excluded.apps, top_app=excluded.top_app,
       top_app_minutes=excluded.top_app_minutes,
       longest_run_minutes=excluded.longest_run_minutes,
       first_at=excluded.first_at, last_at=excluded.last_at,
       sample_count=excluded.sample_count, complete=excluded.complete,
       computed_at=CURRENT_TIMESTAMP`,
    [
      row.day, row.host, row.presentMinutes ?? null, row.activeMinutes ?? null,
      row.idleMinutes ?? null, row.lockedMinutes ?? null, row.apps ?? null,
      row.topApp ?? null, row.topAppMinutes ?? null, row.longestRunMinutes ?? null,
      row.firstAt ?? null, row.lastAt ?? null, row.sampleCount ?? 0,
      row.complete ? 1 : 0,
    ]
  );
}

function getDesktopDay(day, host) {
  return get('SELECT * FROM desktop_daily WHERE day = ? AND host = ?', [day, host]);
}

// Newest first. `days` bounds DISTINCT DAYS, not rows — with two machines
// reporting, a plain LIMIT would return one day's pair and call it two days.
function getDesktopDays(days, { completeOnly = false, host = null } = {}) {
  return all(
    `SELECT * FROM desktop_daily
      WHERE day IN (
        SELECT day FROM desktop_daily
         ${completeOnly ? 'WHERE complete = 1' : ''}
         GROUP BY day ORDER BY day DESC LIMIT ?
      )
      ${completeOnly ? 'AND complete = 1' : ''}
      ${host ? 'AND host = ?' : ''}
      ORDER BY day DESC, host ASC`,
    host ? [days || 30, host] : [days || 30]
  );
}

// ── RescueTime, one row per day ──
// Audited against desktop_daily; see services/rescuetime.js.

function upsertRescueTimeDay(row) {
  run(
    `INSERT INTO rescuetime_daily (day, total_minutes, categories, domains, top_category, complete, fetched_at)
     VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(day) DO UPDATE SET
       total_minutes=excluded.total_minutes, categories=excluded.categories,
       domains=excluded.domains, top_category=excluded.top_category,
       complete=excluded.complete, fetched_at=CURRENT_TIMESTAMP`,
    [
      row.day, row.totalMinutes ?? null, row.categories ?? null, row.domains ?? null,
      row.topCategory ?? null, row.complete ? 1 : 0,
    ]
  );
}

function getRescueTimeDay(day) {
  return get('SELECT * FROM rescuetime_daily WHERE day = ?', [day]);
}

function getRescueTimeDays(days) {
  return all('SELECT * FROM rescuetime_daily ORDER BY day DESC LIMIT ?', [days || 30]);
}

function getDesktopDaysFor(day, host = null) {
  return all(
    `SELECT * FROM desktop_daily WHERE day = ? ${host ? 'AND host = ?' : ''} ORDER BY host ASC`,
    host ? [day, host] : [day]
  );
}

// ── Location Visits ──

function saveLocationVisit(dateKey, placeName, lat, lng, arrival, departure, durationMinutes, source, placeId) {
  run(
    `INSERT INTO location_visits (date_key, place_name, lat, lng, arrival, departure, duration_minutes, source, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [dateKey, placeName, lat, lng, arrival, departure || null, durationMinutes, source || 'owntracks', placeId || null]
  );
}

// ── Host metrics (Pi 5, Pi 4, router, broadband) ──

// INSERT OR IGNORE + the UNIQUE constraint make this idempotent, so the
// importer can safely re-read rows it may already have taken.
function insertHostMetrics(rows) {
  if (!rows || !rows.length) return 0;
  let inserted = 0;
  batchSaves(() => {
    for (const r of rows) {
      if (r.value == null || !Number.isFinite(r.value)) continue;
      const info = run(
        'INSERT OR IGNORE INTO host_metrics (source, metric, value, recorded_at) VALUES (?, ?, ?, ?)',
        [r.source, r.metric, r.value, r.recordedAt]
      );
      inserted += info.changes;
    }
  });
  return inserted;
}

function getHostMetrics(source, metric, sinceIso, limit = 500) {
  return all(
    'SELECT value, recorded_at FROM host_metrics WHERE source = ? AND metric = ? AND recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?',
    [source, metric, sinceIso, limit]
  );
}

function getHostMetricLatest(source, metric) {
  return get(
    'SELECT value, recorded_at FROM host_metrics WHERE source = ? AND metric = ? ORDER BY recorded_at DESC LIMIT 1',
    [source, metric]
  );
}

function pruneHostMetrics(days = 90) {
  const info = run('DELETE FROM host_metrics WHERE recorded_at < datetime(\'now\', ?)', ['-' + days + ' days']);
  return info.changes;
}

function getLocationVisits(dateFrom, dateTo, limit = 100) {
  return all(
    'SELECT * FROM location_visits WHERE date_key >= ? AND date_key <= ? ORDER BY date_key DESC, arrival DESC LIMIT ?',
    [dateFrom, dateTo, limit]
  );
}

function getLocationVisitsByPlace(placeName, limit = 50) {
  return all('SELECT * FROM location_visits WHERE place_name = ? ORDER BY date_key DESC LIMIT ?', [placeName, limit]);
}

function getFrequentLocations(daysBack = 30, minVisits = 2) {
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  return all(
    `SELECT place_name, ROUND(AVG(lat), 6) as avg_lat, ROUND(AVG(lng), 6) as avg_lng,
            COUNT(*) as visit_count, SUM(duration_minutes) as total_minutes,
            MAX(date_key) as last_visit
     FROM location_visits
     WHERE date_key >= ? AND place_name IS NOT NULL
     GROUP BY place_name
     HAVING COUNT(*) >= ?
     ORDER BY visit_count DESC`,
    [cutoff, minVisits]
  );
}

// ── MoSCoW Task Prioritisation ──

function _taskKey(filePath, lineNumber, text) {
  // Stable key: path + first 60 chars of text (line numbers shift when file is edited)
  const shortText = (text || '').substring(0, 60).replace(/\s+/g, ' ').trim();
  return `${filePath || 'unknown'}::${shortText}`;
}

function setTaskMoscow(filePath, lineNumber, text, moscow) {
  const key = _taskKey(filePath, lineNumber, text);
  run(
    `INSERT OR REPLACE INTO task_moscow (task_key, moscow, task_text, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [key, moscow, (text || '').substring(0, 200)]
  );
  return key;
}

function getTaskMoscow(filePath, lineNumber, text) {
  const key = _taskKey(filePath, lineNumber, text);
  const row = get('SELECT moscow FROM task_moscow WHERE task_key = ?', [key]);
  return row ? row.moscow : null;
}

function getAllTaskMoscow() {
  return all('SELECT task_key, moscow, task_text, updated_at FROM task_moscow ORDER BY updated_at DESC');
}

function deleteTaskMoscow(filePath, lineNumber, text) {
  const key = _taskKey(filePath, lineNumber, text);
  run('DELETE FROM task_moscow WHERE task_key = ?', [key]);
}

// ── Tasks (NEURO is the source of truth) ──
// Callers should go through services/task-store.js rather than these directly —
// it owns dedupe-key normalisation and re-exports the vault note after a write.

// ⚠ THE THIRD whitelist a task field has to appear in — after createTask's
// input map and createTaskRow's INSERT column list. A field missing from any of
// the three is silently dropped, with no error anywhere, which is how
// estimateMinutes once vanished from POST /api/tasks. Add to all three.
const TASK_FIELDS = [
  'text', 'status', 'moscow', 'moscow_proposed', 'priority', 'due_date', 'source',
  'origin_path', 'origin_line', 'context', 'domain', 'origin', 'origin_proposed',
  'notes', 'ms_id', 'ms_source', 'ms_plan',
  'estimate_minutes', 'assignee', 'household', 'criticality',
];

function createTaskRow(task) {
  const info = run(
    `INSERT INTO tasks (text, status, moscow, moscow_proposed, priority, due_date, source,
                        origin_path, origin_line, context, domain, origin, origin_proposed,
                        notes, ms_id, estimate_minutes,
                        assignee, household, criticality, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.text, task.status || 'open', task.moscow || null,
      task.moscow_proposed ? 1 : 0, task.priority || null,
      task.due_date || null, task.source || 'manual', task.origin_path || null,
      task.origin_line == null ? null : task.origin_line, task.context || null,
      // Never a bare `|| 'work'` here — task-store resolves the domain through
      // shared/task-domain.cjs before it arrives, so an unrecognised value is
      // already a decision rather than a typo reaching the column.
      task.domain || 'work',
      // NULL is "not classified" and is a real answer — never coerced to either
      // value here, because both are decisions with consequences in a report
      // that leaves the building. task-store resolves it on the way in.
      task.origin || null,
      task.origin_proposed ? 1 : 0,
      task.notes || null, task.ms_id || null,
      task.estimate_minutes == null ? null : task.estimate_minutes,
      // NULL is unassigned and is a real answer, not a missing one.
      task.assignee || null,
      task.household ? 1 : 0,
      // What the sending system CLAIMED, verbatim. NEURO never derives it, and
      // NULL — the normal case — means nobody claimed anything, never "low".
      task.criticality || null,
      task.dedupe_key,
    ]
  );
  return info.lastInsertRowid;
}

function getTaskRow(id) {
  return get('SELECT * FROM tasks WHERE id = ?', [id]);
}

function getTaskByDedupeKey(dedupeKey) {
  return get('SELECT * FROM tasks WHERE dedupe_key = ?', [dedupeKey]);
}

// filters: { status: 'open'|'done'|'all', moscow, source, includeDone }
function listTaskRows(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status && filters.status !== 'all') {
    where.push('status = ?');
    params.push(filters.status);
  } else if (!filters.includeDone && filters.status !== 'all') {
    where.push("status IN ('open', 'in-progress')");
  }
  if (filters.moscow) { where.push('moscow = ?'); params.push(filters.moscow); }
  if (filters.source) { where.push('source = ?'); params.push(filters.source); }
  if (filters.sourcePrefix) { where.push('source LIKE ?'); params.push(`${filters.sourcePrefix}%`); }
  // The VESTA household pool. An explicit flag, never a domain or a source
  // pattern: `domain = 'personal'` would sweep in Nick's own private list, and
  // a source prefix answers where a task was typed rather than whether it is
  // meant to be shared.
  if (filters.household) { where.push('household = 1'); }
  // Absent means EVERY domain, not 'work'. A default here would silently hide
  // personal tasks from every existing caller — including the exports and the
  // counts — which is the invisible half of the asymmetry task-domain describes.
  if (filters.domain) { where.push('domain = ?'); params.push(filters.domain); }
  // Absent means EVERY origin, including the unclassified pile — the same rule
  // as `domain` above, and for the same reason: a default here would hide the
  // very rows that most need looking at. `originUnset` asks for those alone.
  if (filters.origin) { where.push('origin = ?'); params.push(filters.origin); }
  if (filters.originUnset) { where.push('origin IS NULL'); }
  const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE moscow WHEN 'must' THEN 0 WHEN 'should' THEN 1 WHEN 'could' THEN 2
                          WHEN 'wont' THEN 3 ELSE 4 END,
              COALESCE(priority, 0) DESC,
              CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date,
              created_at`;
  return all(sql, params);
}

// Only whitelisted columns, so a rogue body can't rewrite dedupe_key or ids.
function updateTaskRow(id, fields) {
  const sets = [];
  const params = [];
  for (const key of TASK_FIELDS) {
    if (!(key in fields)) continue;
    sets.push(`${key} = ?`);
    params.push(fields[key] === '' ? null : fields[key]);
  }
  if ('dedupe_key' in fields) { sets.push('dedupe_key = ?'); params.push(fields.dedupe_key); }
  if (!sets.length) return 0;
  if ('status' in fields) {
    sets.push("completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END");
    params.push(fields.status);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);
  return run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params).changes;
}

function deleteTaskRow(id) {
  return run('DELETE FROM tasks WHERE id = ?', [id]).changes;
}

function countTasks() {
  return get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status IN ('open', 'in-progress') THEN 1 ELSE 0 END), 0) AS open,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status IN ('open', 'in-progress') AND (moscow IS NULL OR moscow_proposed = 1) THEN 1 ELSE 0 END), 0) AS untriaged,
       COALESCE(SUM(CASE WHEN status IN ('open', 'in-progress') AND moscow_proposed = 1 THEN 1 ELSE 0 END), 0) AS proposed
     FROM tasks`
  ) || { total: 0, open: 0, done: 0, untriaged: 0, proposed: 0 };
}

// ── Task blocks ──
// Callers go through services/task-blocks.js. These are the raw rows.

const TASK_BLOCK_FIELDS = [
  'event_id', 'event_web_link', 'date_key', 'start_time', 'end_time',
  'minutes', 'minutes_assumed', 'note_path', 'status', 'release_reason',
];

function createTaskBlockRow(block) {
  const now = new Date().toISOString();
  const info = run(
    `INSERT INTO task_blocks (event_id, event_web_link, date_key, start_time,
                              end_time, minutes, minutes_assumed, note_path, status,
                              created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      block.event_id || null, block.event_web_link || null,
      block.date_key, block.start_time, block.end_time, block.minutes,
      block.minutes_assumed ? 1 : 0, block.note_path, block.status || 'scheduled',
      now, now,
    ]
  );
  return info.lastInsertRowid;
}

function addTaskBlockItem(blockId, taskId, allottedMinutes = null) {
  return run(
    `INSERT OR IGNORE INTO task_block_items (block_id, task_id, allotted_minutes, created_at)
     VALUES (?, ?, ?, ?)`,
    [blockId, taskId, allottedMinutes == null ? null : allottedMinutes, new Date().toISOString()]
  ).changes;
}

function getTaskBlockRow(id) {
  return get('SELECT * FROM task_blocks WHERE id = ?', [id]);
}

/** The tasks in a block, with their text joined on so callers need one read. */
function listTaskBlockItems(blockId) {
  return all(
    `SELECT i.*, t.text, t.status AS task_status
       FROM task_block_items i
       LEFT JOIN tasks t ON t.id = i.task_id
      WHERE i.block_id = ?
      ORDER BY i.id`,
    [blockId]
  );
}

/**
 * Blocks, newest first.
 *
 * `taskId` filters to blocks CONTAINING that task, via the membership table. A
 * task can legitimately sit in several blocks — work that needed two sittings —
 * so this returns a list, never "the block".
 */
function listTaskBlockRows({ taskId = null, statuses = null, openOnly = false } = {}) {
  const where = [];
  const params = [];
  if (taskId != null) {
    where.push('b.id IN (SELECT block_id FROM task_block_items WHERE task_id = ?)');
    params.push(taskId);
  }
  if (openOnly) {
    where.push("b.status IN ('scheduled', 'awaiting-writeup')");
  } else if (statuses && statuses.length) {
    where.push(`b.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  return all(
    `SELECT b.* FROM task_blocks b${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.date_key DESC, b.start_time DESC, b.id DESC`,
    params
  );
}

/** Take a task out of a block. The task row itself is untouched. */
function removeTaskBlockItem(blockId, taskId) {
  return run('DELETE FROM task_block_items WHERE block_id = ? AND task_id = ?', [blockId, taskId]).changes;
}

/** Mark one task's completion as held inside its block. */
function setTaskBlockItemAwaiting(blockId, taskId, awaiting = true) {
  return run(
    'UPDATE task_block_items SET awaiting = ? WHERE block_id = ? AND task_id = ?',
    [awaiting ? 1 : 0, blockId, taskId]
  ).changes;
}

function updateTaskBlockRow(id, fields) {
  const sets = [];
  const params = [];
  for (const key of TASK_BLOCK_FIELDS) {
    if (!(key in fields)) continue;
    sets.push(`${key} = ?`);
    params.push(fields[key] === '' ? null : fields[key]);
  }
  if (!sets.length) return 0;
  // 'complete' and 'released' both END the block; only one of them earned it,
  // but both stop owing a note, so both stamp the same field.
  if ('status' in fields) {
    sets.push("completed_at = CASE WHEN ? IN ('complete', 'released') THEN datetime('now') ELSE NULL END");
    params.push(fields.status);
  }
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  return run(`UPDATE task_blocks SET ${sets.join(', ')} WHERE id = ?`, params).changes;
}

// ── SARA Actions ──

function createSaraAction(type, payload, confidence, reason, focusItemId) {
  // The old driver had to read last_insert_rowid() before saving, because
  // save() closed and reopened the connection. run() now returns it directly.
  const info = run(
    `INSERT INTO sara_actions (type, payload, confidence, reason, focus_item_id)
     VALUES (?, ?, ?, ?, ?)`,
    [type, JSON.stringify(payload), confidence, reason, focusItemId || null]
  );
  return info.lastInsertRowid;
}

function getPendingSaraActions(limit = 10) {
  const rows = all(
    'SELECT * FROM sara_actions WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT ?',
    ['pending', limit]
  );
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

/**
 * Pending actions OF ONE TYPE, bounded.
 *
 * #83 — the todos route asked for 1,000 pending actions of every type and then
 * threw away everything that was not a `capture_todo`. The cap therefore had to
 * absorb the whole queue to be safe, and when the queue passed it the tail
 * vanished with no error: at the 930-action peak a genuine capture_todo could
 * be pushed out by 900 actions the caller was about to discard. Asking for the
 * type means the bound is over the rows actually wanted.
 */
function getPendingSaraActionsByType(type, limit = 100) {
  const rows = all(
    'SELECT * FROM sara_actions WHERE status = ? AND type = ? ORDER BY confidence DESC, created_at DESC LIMIT ?',
    ['pending', type, limit]
  );
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

function countPendingSaraActionsByType(type) {
  const row = get('SELECT COUNT(*) as count FROM sara_actions WHERE status = ? AND type = ?', ['pending', type]);
  return row ? row.count : 0;
}

function getSaraAction(id) {
  const row = get('SELECT * FROM sara_actions WHERE id = ?', [id]);
  if (row) row.payload = JSON.parse(row.payload || '{}');
  return row;
}

/**
 * Rewrite a pending action's payload. Deliberately refuses anything that is not
 * still pending — editing an action after it has executed would rewrite history
 * rather than the thing about to happen.
 */
function updateSaraActionPayload(id, payload) {
  const info = run(
    `UPDATE sara_actions SET payload = ? WHERE id = ? AND status = 'pending'`,
    [JSON.stringify(payload), id]
  );
  return info.changes > 0;
}

function updateSaraActionStatus(id, status) {
  run(`UPDATE sara_actions SET status = ?, resolved_at = datetime('now') WHERE id = ?`, [status, id]);
}

function getRecentSaraActions(limit = 20) {
  const rows = all('SELECT * FROM sara_actions ORDER BY created_at DESC LIMIT ?', [limit]);
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

/**
 * Scoped reads. These exist because callers kept asking "has this note/event
 * been actioned before?" by pulling `getRecentSaraActions(N)` and filtering it
 * — which is a GLOBAL recency window, not a scoped query. The table churns
 * thousands of rows a day (16,281 by 15 Aug), so the newest 500 spanned about
 * 21 hours: last night's actions for a note were already invisible, and the
 * nightly vault scan re-queued every candidate it had queued the night before.
 * 926 pending capture_todos, 442 of them distinct.
 *
 * A LIMIT is a cliff, not a page. If the question is "for this note" or "of
 * this type", ask SQL that question.
 */
function getSaraActionsBySource(sourcePath, type = null) {
  const rows = type
    ? all(`SELECT * FROM sara_actions
             WHERE type = ? AND json_extract(payload, '$.sourcePath') = ?
             ORDER BY created_at DESC`, [type, sourcePath])
    : all(`SELECT * FROM sara_actions
             WHERE json_extract(payload, '$.sourcePath') = ?
             ORDER BY created_at DESC`, [sourcePath]);
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

function getSaraActionsByType(type, limit = 5000) {
  const rows = all(
    'SELECT * FROM sara_actions WHERE type = ? ORDER BY created_at DESC LIMIT ?',
    [type, limit]
  );
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

/** Status tally since an ISO timestamp — counted in SQL, so no window can clip it. */
function countSaraActionsSince(since) {
  const rows = all(
    'SELECT status, COUNT(*) n FROM sara_actions WHERE created_at >= ? GROUP BY status',
    [since]
  );
  const out = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

module.exports = {
  init,
  getDb,
  // Generic query helpers. Exported so a service owning its own table can use
  // them instead of reaching for getDb() and re-preparing statements itself.
  all,
  get,
  run,
  batchSaves,
  saveMessage,
  getConversationHistory,
  getRecentConversations,
  saveDecision,
  setState,
  getState,
  createNudge,
  getActiveNudges,
  getActiveNudgeByTypeAndDate,
  updateNudgeMessage,
  completeNudge,
  completeNudgeByType,
  completeAllNudgesByType,
  incrementNagCount,
  createTodo,
  clearMsTodos,
  getActiveTodos,
  getAllTodos,
  completeTodo,
  deleteTodo,
  upsertCalendarEvent,
  clearCalendarCache,
  clearCalendarWindow,
  getCalendarEvents,
  savePushSubscription,
  getAllPushSubscriptions,
  removePushSubscription,
  logPushOutcome,
  getPushLog,
  getPushStats,
  ATTENTION_OPEN_STATES,
  getAttentionRecord,
  getOpenAttentionRecord,
  getOpenAttentionRecords,
  insertAttentionRecord,
  touchAttentionRecord,
  setAttentionState,
  markAttentionSurfaced,
  markAttentionNotified,
  getExpiredDeferrals,
  logAttentionEvent,
  getAttentionHistory,
  saveImportClassification,
  getImportClassification,
  getAllImportClassifications,
  deleteImportClassification,
  deleteAllImportClassifications,
  logActivity,
  getActivityForDate,
  getActivityForRange,
  saveDailySummary,
  getDailySummaries,
  getTodayActivity,
  recordAiCall,
  getAiCallsSince,
  getAiSpendByDay,
  getAiSpendBy,
  saveEmbedding,
  getEmbedding,
  getEmbeddingChunkCount,
  getAllEmbeddings,
  getEmbeddingIndexSummary,
  deleteEmbedding,
  // Entity extraction
  saveEntity,
  getEntitiesForPath,
  getEntitiesByType,
  getEntitiesByValue,
  deleteEntitiesForPath,
  // Note links / backlinks
  saveLink,
  getLinksFrom,
  getLinksTo,
  getBacklinks,
  deleteLinksForPath,
  // Do Next
  createDoNext,
  getActiveDoNext,
  getAllDoNext,
  completeDoNext,
  deleteDoNext,
  replaceNovaFlags,
  getActiveNovaFlags,
  // Health samples
  insertHealthSample,
  insertHealthSampleWithUuid,
  getHealthMetricSummary,
  getDailyMetricAggregates,
  getHealthSamplesBetween,
  getSleepSamplesBetween,
  upsertHealthDay,
  upsertDesktopDay,
  getDesktopDay,
  getDesktopDays,
  getDesktopDaysFor,
  upsertRescueTimeDay,
  getRescueTimeDay,
  getRescueTimeDays,
  getHealthDays,
  getHealthDay,
  getHealthSamples,
  getSleepSamples,
  getLatestHealthSample,
  // Location visits
  saveLocationVisit,
  insertHostMetrics,
  getHostMetrics,
  getHostMetricLatest,
  pruneHostMetrics,
  getLocationVisits,
  getLocationVisitsByPlace,
  getFrequentLocations,
  // Tasks (source of truth)
  createTaskRow,
  getTaskRow,
  getTaskByDedupeKey,
  listTaskRows,
  updateTaskRow,
  createTaskBlockRow,
  addTaskBlockItem,
  getTaskBlockRow,
  listTaskBlockItems,
  listTaskBlockRows,
  removeTaskBlockItem,
  setTaskBlockItemAwaiting,
  updateTaskBlockRow,
  deleteTaskRow,
  countTasks,
  // MoSCoW (legacy — superseded by tasks.moscow, kept for the importer)
  setTaskMoscow,
  getTaskMoscow,
  getAllTaskMoscow,
  deleteTaskMoscow,
  // SARA Actions
  createSaraAction,
  getPendingSaraActions,
  getPendingSaraActionsByType,
  countPendingSaraActionsByType,
  getSaraAction,
  updateSaraActionStatus,
  updateSaraActionPayload,
  getRecentSaraActions,
  getSaraActionsBySource,
  getSaraActionsByType,
  countSaraActionsSince,
};
