const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'agent.db');
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

// ── Location Visits ──

function saveLocationVisit(dateKey, placeName, lat, lng, arrival, departure, durationMinutes, source, placeId) {
  run(
    `INSERT INTO location_visits (date_key, place_name, lat, lng, arrival, departure, duration_minutes, source, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [dateKey, placeName, lat, lng, arrival, departure || null, durationMinutes, source || 'owntracks', placeId || null]
  );
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

function getSaraAction(id) {
  const row = get('SELECT * FROM sara_actions WHERE id = ?', [id]);
  if (row) row.payload = JSON.parse(row.payload || '{}');
  return row;
}

function updateSaraActionStatus(id, status) {
  run(`UPDATE sara_actions SET status = ?, resolved_at = datetime('now') WHERE id = ?`, [status, id]);
}

function getRecentSaraActions(limit = 20) {
  const rows = all('SELECT * FROM sara_actions ORDER BY created_at DESC LIMIT ?', [limit]);
  for (const row of rows) row.payload = JSON.parse(row.payload || '{}');
  return rows;
}

module.exports = {
  init,
  getDb,
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
  // Location visits
  saveLocationVisit,
  getLocationVisits,
  getLocationVisitsByPlace,
  getFrequentLocations,
  // MoSCoW
  setTaskMoscow,
  getTaskMoscow,
  getAllTaskMoscow,
  deleteTaskMoscow,
  // SARA Actions
  createSaraAction,
  getPendingSaraActions,
  getSaraAction,
  updateSaraActionStatus,
  getRecentSaraActions,
};
