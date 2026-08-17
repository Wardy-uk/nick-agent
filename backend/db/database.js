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
  } catch (e) {
    console.error('[DB] tasks migration check failed:', e.message);
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

// Jira cache helpers
function upsertTicket(ticket) {
  run(`
    INSERT OR REPLACE INTO jira_tickets_cache
      (ticket_key, summary, status, priority, assignee, sla_remaining_minutes, sla_name, at_risk, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    ticket.ticket_key,
    ticket.summary || null,
    ticket.status || null,
    ticket.priority || null,
    ticket.assignee || null,
    ticket.sla_remaining_minutes != null ? ticket.sla_remaining_minutes : null,
    ticket.sla_name || null,
    ticket.at_risk ? 1 : 0,
    ticket.raw_json || null
  ]);
}

function clearStaleTickets() {
  run('DELETE FROM jira_tickets_cache');
}

function getAllTickets() {
  return all('SELECT * FROM jira_tickets_cache ORDER BY sla_remaining_minutes ASC');
}

function getAtRiskTickets() {
  return all('SELECT * FROM jira_tickets_cache WHERE at_risk = 1 ORDER BY sla_remaining_minutes ASC');
}

function getQueueSummary() {
  const allTickets = getAllTickets();
  const atRisk = allTickets.filter(t => t.at_risk);
  const p1 = allTickets.filter(t => {
    const p = (t.priority || '').toLowerCase();
    return p.includes('highest') || p === 'p1' || p === 'critical';
  });
  return {
    total: allTickets.length,
    at_risk_count: atRisk.length,
    open_p1s: p1.length,
    at_risk_tickets: atRisk,
    tickets: allTickets
  };
}

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
  run(`
    INSERT OR REPLACE INTO calendar_cache
      (event_id, subject, start_time, end_time, is_all_day, location, organizer, show_as, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    event.id, event.subject, event.start, event.end,
    event.isAllDay ? 1 : 0, event.location, event.organizer, event.showAs
  ]);
}

function clearCalendarCache() {
  run('DELETE FROM calendar_cache');
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

// Inbox item helpers
function upsertInboxItem(item) {
  run(`
    INSERT OR REPLACE INTO inbox_items
      (email_id, subject, from_name, from_email, urgency, category, summary, reason, received, is_read, has_attachments, dismissed, dismissed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT dismissed FROM inbox_items WHERE email_id = ?), 0), (SELECT dismissed_at FROM inbox_items WHERE email_id = ?), COALESCE((SELECT created_at FROM inbox_items WHERE email_id = ?), CURRENT_TIMESTAMP))
  `, [
    item.emailId, item.subject, item.from, item.fromEmail,
    item.urgency, item.category, item.summary, item.reason,
    item.received, item.isRead ? 1 : 0, item.hasAttachments ? 1 : 0,
    item.emailId, item.emailId, item.emailId
  ]);
}

// Every email we have already triaged, dismissed or not. The inbox scanner
// uses this to avoid paying to re-analyse the same unread mail every 10
// minutes — 32 unread emails were being re-triaged 6 times an hour.
function getTriagedEmailIds() {
  return all('SELECT email_id FROM inbox_items').map(r => r.email_id);
}

function getActiveInboxItems() {
  return all(
    'SELECT * FROM inbox_items WHERE dismissed = 0 ORDER BY CASE urgency WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 WHEN \'low\' THEN 2 END, created_at DESC'
  );
}

function dismissInboxItem(emailId) {
  run("UPDATE inbox_items SET dismissed = 1, dismissed_at = datetime('now') WHERE email_id = ?", [emailId]);
}

function cleanupOldDismissed(daysOld = 7) {
  run(`DELETE FROM inbox_items WHERE dismissed = 1 AND dismissed_at < datetime('now', '-${daysOld} days')`);
}

function clearStaleInboxItems() {
  // Remove non-dismissed items older than 24 hours (they'll be re-scanned if still relevant)
  run("DELETE FROM inbox_items WHERE dismissed = 0 AND created_at < datetime('now', '-1 day')");
}

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

const TASK_FIELDS = [
  'text', 'status', 'moscow', 'moscow_proposed', 'priority', 'due_date', 'source',
  'origin_path', 'origin_line', 'context', 'notes', 'ms_id', 'estimate_minutes',
];

function createTaskRow(task) {
  const info = run(
    `INSERT INTO tasks (text, status, moscow, moscow_proposed, priority, due_date, source,
                        origin_path, origin_line, context, notes, ms_id, estimate_minutes, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.text, task.status || 'open', task.moscow || null,
      task.moscow_proposed ? 1 : 0, task.priority || null,
      task.due_date || null, task.source || 'manual', task.origin_path || null,
      task.origin_line == null ? null : task.origin_line, task.context || null,
      task.notes || null, task.ms_id || null,
      task.estimate_minutes == null ? null : task.estimate_minutes,
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
  upsertTicket,
  clearStaleTickets,
  getAllTickets,
  getAtRiskTickets,
  getQueueSummary,
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
  getCalendarEvents,
  savePushSubscription,
  getAllPushSubscriptions,
  removePushSubscription,
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
  upsertInboxItem,
  getActiveInboxItems,
  getTriagedEmailIds,
  dismissInboxItem,
  cleanupOldDismissed,
  clearStaleInboxItems,
  saveEmbedding,
  getEmbedding,
  getEmbeddingChunkCount,
  getAllEmbeddings,
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
