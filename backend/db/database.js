const initSqlJs = require('sql.js');
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

async function init() {
  const SQL = await initSqlJs();

  db = new SQL.Database();
  if (fs.existsSync(DB_PATH)) {
    try {
      const buffer = fs.readFileSync(DB_PATH);
      if (buffer.length === 0) {
        const moved = quarantineDb('empty');
        console.warn(`[DB] Existing database was empty; moved to ${moved}`);
      } else {
        db = new SQL.Database(buffer);
      }
    } catch (e) {
      const moved = quarantineDb('malformed');
      console.error(`[DB] Failed to load database (${e.message}); moved to ${moved}`);
      db = new SQL.Database();
    }
  }

  // Run migrations
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.run(schema);

  // Migration: vault_embeddings multi-chunk support
  // If the old table has UNIQUE on relative_path alone, recreate with (relative_path, chunk_index)
  try {
    const tableInfo = db.exec("PRAGMA table_info(vault_embeddings)");
    const columns = tableInfo.length > 0 ? tableInfo[0].values.map(r => r[1]) : [];
    if (!columns.includes('chunk_index')) {
      console.log('[DB] Migrating vault_embeddings for multi-chunk support...');
      db.run('DROP TABLE IF EXISTS vault_embeddings');
      db.run(`CREATE TABLE vault_embeddings (
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
      db.run('CREATE INDEX IF NOT EXISTS idx_embeddings_path ON vault_embeddings(relative_path)');
      db.run('CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON vault_embeddings(content_hash)');
      console.log('[DB] vault_embeddings migrated — embeddings will rebuild on next cycle');
    }
  } catch (e) {
    console.error('[DB] Migration check failed:', e.message);
  }

  save();
  console.log('[DB] Initialized');
}

// Every write helper calls save(), and save() dumps the WHOLE database (60MB+)
// synchronously. That is fine for one write and ruinous for a loop of them, so
// batchSaves() lets a caller collapse many writes into a single flush.
let saveDepth = 0;
let savePending = false;

function save() {
  if (!db) return;
  if (saveDepth > 0) { savePending = true; return; }
  fs.mkdirSync(DB_DIR, { recursive: true });
  const data = db.export();
  const buffer = Buffer.from(data);
  const tempPath = path.join(DB_DIR, `agent.db.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, DB_PATH);
}

// Run a SYNCHRONOUS fn with save() deferred to one flush at the end. Not for
// async work: an await would let unrelated writes join the deferral window.
function batchSaves(fn) {
  saveDepth += 1;
  try {
    return fn();
  } finally {
    saveDepth -= 1;
    if (saveDepth === 0 && savePending) {
      savePending = false;
      save();
    }
  }
}

function getDb() {
  if (!db) throw new Error('Database not initialized — call init() first');
  return db;
}

// Conversation helpers
function saveMessage(conversationId, role, content) {
  getDb().run(
    'INSERT INTO conversations (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, role, content]
  );
  save();
}

function getConversationHistory(conversationId, limit = 20) {
  const stmt = getDb().prepare(
    `SELECT role, content, created_at FROM conversations
     WHERE conversation_id = ?
     ORDER BY created_at DESC LIMIT ?`
  );
  stmt.bind([conversationId, limit]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.reverse();
}

// Jira cache helpers
function upsertTicket(ticket) {
  getDb().run(`
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
  save();
}

function clearStaleTickets() {
  getDb().run('DELETE FROM jira_tickets_cache');
  save();
}

function getAllTickets() {
  const stmt = getDb().prepare(
    'SELECT * FROM jira_tickets_cache ORDER BY sla_remaining_minutes ASC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getAtRiskTickets() {
  const stmt = getDb().prepare(
    'SELECT * FROM jira_tickets_cache WHERE at_risk = 1 ORDER BY sla_remaining_minutes ASC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getQueueSummary() {
  const all = getAllTickets();
  const atRisk = all.filter(t => t.at_risk);
  const p1 = all.filter(t => {
    const p = (t.priority || '').toLowerCase();
    return p.includes('highest') || p === 'p1' || p === 'critical';
  });
  return {
    total: all.length,
    at_risk_count: atRisk.length,
    open_p1s: p1.length,
    at_risk_tickets: atRisk,
    tickets: all
  };
}

// Decision helpers
function saveDecision(conversationId, decisionText) {
  getDb().run(
    'INSERT INTO decisions (conversation_id, decision_text) VALUES (?, ?)',
    [conversationId, decisionText]
  );
  save();
}

// Agent state helpers
function setState(key, value) {
  getDb().run(
    `INSERT OR REPLACE INTO agent_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))`,
    [key, value]
  );
  save();
}

function getState(key) {
  const stmt = getDb().prepare('SELECT value FROM agent_state WHERE key = ?');
  stmt.bind([key]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject().value;
  }
  stmt.free();
  return result;
}

// Nudge helpers
function createNudge(type, message, dateKey) {
  getDb().run(
    'INSERT INTO nudges (type, message, date_key) VALUES (?, ?, ?)',
    [type, message, dateKey]
  );
  save();
}

function getActiveNudges() {
  const stmt = getDb().prepare(
    'SELECT * FROM nudges WHERE active = 1 ORDER BY created_at DESC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getActiveNudgeByTypeAndDate(type, dateKey) {
  const stmt = getDb().prepare(
    'SELECT * FROM nudges WHERE type = ? AND date_key = ? AND active = 1'
  );
  stmt.bind([type, dateKey]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function completeNudge(id) {
  getDb().run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE id = ?",
    [id]
  );
  save();
}

function completeNudgeByType(type, dateKey) {
  getDb().run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE type = ? AND date_key = ? AND active = 1",
    [type, dateKey]
  );
  save();
}

function completeAllNudgesByType(type) {
  getDb().run(
    "UPDATE nudges SET active = 0, completed_at = datetime('now') WHERE type = ? AND active = 1",
    [type]
  );
  save();
}

function incrementNagCount(id) {
  getDb().run(
    'UPDATE nudges SET nag_count = nag_count + 1 WHERE id = ?',
    [id]
  );
  save();
}

// Todo helpers
function createTodo(text, priority, dueDate, source, msId) {
  getDb().run(
    'INSERT INTO todos (text, priority, due_date, source, ms_id) VALUES (?, ?, ?, ?, ?)',
    [text, priority || 'normal', dueDate || null, source || null, msId || null]
  );
  save();
}

function clearMsTodos() {
  getDb().run("DELETE FROM todos WHERE source LIKE 'MS %'");
  save();
}

function getActiveTodos() {
  const stmt = getDb().prepare(
    "SELECT * FROM todos WHERE done = 0 ORDER BY due_date ASC NULLS LAST, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END, created_at ASC"
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getAllTodos() {
  const stmt = getDb().prepare(
    'SELECT * FROM todos ORDER BY done ASC, created_at DESC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function completeTodo(id) {
  getDb().run(
    "UPDATE todos SET done = 1, completed_at = datetime('now') WHERE id = ?",
    [id]
  );
  save();
}

function deleteTodo(id) {
  getDb().run('DELETE FROM todos WHERE id = ?', [id]);
  save();
}

// Calendar cache helpers
function upsertCalendarEvent(event) {
  getDb().run(`
    INSERT OR REPLACE INTO calendar_cache
      (event_id, subject, start_time, end_time, is_all_day, location, organizer, show_as, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    event.id, event.subject, event.start, event.end,
    event.isAllDay ? 1 : 0, event.location, event.organizer, event.showAs
  ]);
  save();
}

function clearCalendarCache() {
  getDb().run('DELETE FROM calendar_cache');
  save();
}

function getCalendarEvents(startDate, endDate) {
  const stmt = getDb().prepare(
    'SELECT * FROM calendar_cache WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC'
  );
  stmt.bind([startDate, endDate]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Push subscription helpers
function savePushSubscription(subscription) {
  getDb().run(`
    INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?)
  `, [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
  save();
}

function getAllPushSubscriptions() {
  const stmt = getDb().prepare('SELECT * FROM push_subscriptions');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function removePushSubscription(endpoint) {
  getDb().run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  save();
}

// Import classification helpers
function saveImportClassification(relativePath, cls) {
  getDb().run(`
    INSERT OR REPLACE INTO import_classifications
      (relative_path, type, destination, confidence, reason, backend, classified_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `, [relativePath, cls.type, cls.destination, cls.confidence, cls.reason, cls.backend || null]);
  save();
}

function getImportClassification(relativePath) {
  const stmt = getDb().prepare(
    'SELECT * FROM import_classifications WHERE relative_path = ?'
  );
  stmt.bind([relativePath]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function getAllImportClassifications() {
  const stmt = getDb().prepare('SELECT * FROM import_classifications');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteImportClassification(relativePath) {
  getDb().run('DELETE FROM import_classifications WHERE relative_path = ?', [relativePath]);
  save();
}

function deleteAllImportClassifications() {
  getDb().run('DELETE FROM import_classifications');
  save();
}

// Activity log helpers
function logActivity(eventType, eventData, dateKey) {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const dk = dateKey || now.toISOString().split('T')[0];
  getDb().run(
    `INSERT INTO activity_log (event_type, event_data, hour, day_of_week, date_key)
     VALUES (?, ?, ?, ?, ?)`,
    [eventType, eventData ? JSON.stringify(eventData) : null, hour, dayOfWeek, dk]
  );
  save();
}

function getActivityForDate(dateKey) {
  const stmt = getDb().prepare(
    'SELECT * FROM activity_log WHERE date_key = ? ORDER BY created_at ASC'
  );
  stmt.bind([dateKey]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getActivityForRange(startDate, endDate) {
  const stmt = getDb().prepare(
    'SELECT * FROM activity_log WHERE date_key >= ? AND date_key <= ? ORDER BY created_at ASC'
  );
  stmt.bind([startDate, endDate]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Daily summary helpers
function saveDailySummary(dateKey, summary) {
  getDb().run(`
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
  save();
}

function getDailySummaries(daysBack = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const stmt = getDb().prepare(
    'SELECT * FROM daily_summary WHERE date_key >= ? ORDER BY date_key DESC'
  );
  stmt.bind([cutoffStr]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getTodayActivity() {
  const today = new Date().toISOString().split('T')[0];
  return getActivityForDate(today);
}

function getRecentConversations(limit = 5) {
  const stmt = getDb().prepare(
    `SELECT conversation_id, MIN(created_at) as started_at, MAX(created_at) as last_at,
            COUNT(*) as message_count
     FROM conversations
     GROUP BY conversation_id
     ORDER BY MAX(created_at) DESC
     LIMIT ?`
  );
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    // Get first user message as preview
    const previewStmt = getDb().prepare(
      `SELECT content FROM conversations WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`
    );
    previewStmt.bind([row.conversation_id]);
    row.preview = previewStmt.step() ? previewStmt.getAsObject().content.substring(0, 80) : '';
    previewStmt.free();
    rows.push(row);
  }
  stmt.free();
  return rows;
}

// Inbox item helpers
function upsertInboxItem(item) {
  getDb().run(`
    INSERT OR REPLACE INTO inbox_items
      (email_id, subject, from_name, from_email, urgency, category, summary, reason, received, is_read, has_attachments, dismissed, dismissed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT dismissed FROM inbox_items WHERE email_id = ?), 0), (SELECT dismissed_at FROM inbox_items WHERE email_id = ?), COALESCE((SELECT created_at FROM inbox_items WHERE email_id = ?), CURRENT_TIMESTAMP))
  `, [
    item.emailId, item.subject, item.from, item.fromEmail,
    item.urgency, item.category, item.summary, item.reason,
    item.received, item.isRead ? 1 : 0, item.hasAttachments ? 1 : 0,
    item.emailId, item.emailId, item.emailId
  ]);
  save();
}

function getActiveInboxItems() {
  const stmt = getDb().prepare(
    'SELECT * FROM inbox_items WHERE dismissed = 0 ORDER BY CASE urgency WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 WHEN \'low\' THEN 2 END, created_at DESC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dismissInboxItem(emailId) {
  getDb().run(
    "UPDATE inbox_items SET dismissed = 1, dismissed_at = datetime('now') WHERE email_id = ?",
    [emailId]
  );
  save();
}

function cleanupOldDismissed(daysOld = 7) {
  getDb().run(
    `DELETE FROM inbox_items WHERE dismissed = 1 AND dismissed_at < datetime('now', '-${daysOld} days')`
  );
  save();
}

function clearStaleInboxItems() {
  // Remove non-dismissed items older than 24 hours (they'll be re-scanned if still relevant)
  getDb().run(
    "DELETE FROM inbox_items WHERE dismissed = 0 AND created_at < datetime('now', '-1 day')"
  );
  save();
}

// Embedding helpers — multi-chunk: each file can have multiple chunks
function saveEmbedding(relativePath, contentHash, embedding, chunkText, fileModified, chunkIndex = 0) {
  getDb().run(`
    INSERT OR REPLACE INTO vault_embeddings
      (relative_path, chunk_index, content_hash, embedding, chunk_text, file_modified, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `, [relativePath, chunkIndex, contentHash, JSON.stringify(embedding), chunkText, fileModified]);
  save();
}

function getEmbedding(relativePath) {
  // Returns first chunk (for backwards compat / change detection)
  const stmt = getDb().prepare('SELECT * FROM vault_embeddings WHERE relative_path = ? ORDER BY chunk_index ASC LIMIT 1');
  stmt.bind([relativePath]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

function getEmbeddingChunkCount(relativePath) {
  const stmt = getDb().prepare('SELECT COUNT(*) as count FROM vault_embeddings WHERE relative_path = ?');
  stmt.bind([relativePath]);
  let count = 0;
  if (stmt.step()) count = stmt.getAsObject().count;
  stmt.free();
  return count;
}

function getAllEmbeddings() {
  const stmt = getDb().prepare('SELECT * FROM vault_embeddings');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteEmbedding(relativePath) {
  // Deletes all chunks for this file
  getDb().run('DELETE FROM vault_embeddings WHERE relative_path = ?', [relativePath]);
  save();
}

// Entity extraction helpers
function saveEntity(sourcePath, entityType, entityValue, context) {
  getDb().run(
    `INSERT INTO extracted_entities (source_path, entity_type, entity_value, context) VALUES (?, ?, ?, ?)`,
    [sourcePath, entityType, entityValue, context || null]
  );
  save();
}

function getEntitiesForPath(sourcePath) {
  const stmt = getDb().prepare('SELECT * FROM extracted_entities WHERE source_path = ? ORDER BY entity_type');
  stmt.bind([sourcePath]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getEntitiesByType(entityType, limit = 50) {
  const stmt = getDb().prepare('SELECT * FROM extracted_entities WHERE entity_type = ? ORDER BY extracted_at DESC LIMIT ?');
  stmt.bind([entityType, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getEntitiesByValue(entityValue) {
  const stmt = getDb().prepare('SELECT * FROM extracted_entities WHERE entity_value = ? ORDER BY extracted_at DESC');
  stmt.bind([entityValue]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteEntitiesForPath(sourcePath) {
  getDb().run('DELETE FROM extracted_entities WHERE source_path = ?', [sourcePath]);
  save();
}

// Note link / backlink helpers
function saveLink(sourcePath, targetPath, targetEntity, linkType) {
  getDb().run(
    `INSERT OR IGNORE INTO note_links (source_path, target_path, target_entity, link_type) VALUES (?, ?, ?, ?)`,
    [sourcePath, targetPath || null, targetEntity || null, linkType]
  );
  save();
}

function getLinksFrom(sourcePath) {
  const stmt = getDb().prepare('SELECT * FROM note_links WHERE source_path = ?');
  stmt.bind([sourcePath]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getLinksTo(targetPath) {
  const stmt = getDb().prepare('SELECT * FROM note_links WHERE target_path = ?');
  stmt.bind([targetPath]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getBacklinks(entityOrPath) {
  const stmt = getDb().prepare(
    'SELECT * FROM note_links WHERE target_path = ? OR target_entity = ? ORDER BY created_at DESC'
  );
  stmt.bind([entityOrPath, entityOrPath]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteLinksForPath(sourcePath) {
  getDb().run('DELETE FROM note_links WHERE source_path = ?', [sourcePath]);
  save();
}

// Do Next helpers
function createDoNext(text, source, sourceRef, priority, dueDate) {
  getDb().run(
    `INSERT INTO do_next (text, source, source_ref, priority, due_date) VALUES (?, ?, ?, ?, ?)`,
    [text, source || 'manual', sourceRef || null, priority || 'normal', dueDate || null]
  );
  save();
}

function getActiveDoNext() {
  const stmt = getDb().prepare(
    `SELECT * FROM do_next WHERE done = 0
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
       due_date ASC NULLS LAST,
       created_at ASC`
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getAllDoNext() {
  const stmt = getDb().prepare(
    `SELECT * FROM do_next ORDER BY done ASC, created_at DESC`
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function completeDoNext(id) {
  getDb().run(
    `UPDATE do_next SET done = 1, done_at = datetime('now') WHERE id = ?`,
    [id]
  );
  save();
}

function deleteDoNext(id) {
  getDb().run('DELETE FROM do_next WHERE id = ?', [id]);
  save();
}

// ── NOVA flags ("Nick, look at this") ──
// NOVA is the source of truth: each sync replaces the entire active set so
// tickets NOVA no longer flags (resolved / reviewed) disappear automatically.
function replaceNovaFlags(flags) {
  const d = getDb();
  d.run('DELETE FROM nova_flags');
  const stmt = d.prepare(
    `INSERT INTO nova_flags
       (ticket_key, risk_score, category, why, summary, assignee, ticket_status, reasons, flagged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of flags || []) {
    if (!f || !f.ticket_key) continue;
    stmt.run([
      f.ticket_key,
      Number(f.risk_score) || 0,
      f.category || null,
      f.why || null,
      f.summary || null,
      f.assignee || null,
      f.ticket_status || null,
      Array.isArray(f.reasons) ? JSON.stringify(f.reasons) : (f.reasons || null),
      f.flagged_at || null,
    ]);
  }
  stmt.free();
  save();
  return (flags || []).length;
}

function getActiveNovaFlags() {
  const stmt = getDb().prepare('SELECT * FROM nova_flags ORDER BY risk_score DESC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Location Visits ──

function saveLocationVisit(dateKey, placeName, lat, lng, arrival, departure, durationMinutes, source, placeId) {
  getDb().run(
    `INSERT INTO location_visits (date_key, place_name, lat, lng, arrival, departure, duration_minutes, source, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [dateKey, placeName, lat, lng, arrival, departure || null, durationMinutes, source || 'owntracks', placeId || null]
  );
  save();
}

function getLocationVisits(dateFrom, dateTo, limit = 100) {
  const stmt = getDb().prepare(
    'SELECT * FROM location_visits WHERE date_key >= ? AND date_key <= ? ORDER BY date_key DESC, arrival DESC LIMIT ?'
  );
  stmt.bind([dateFrom, dateTo, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getLocationVisitsByPlace(placeName, limit = 50) {
  const stmt = getDb().prepare(
    'SELECT * FROM location_visits WHERE place_name = ? ORDER BY date_key DESC LIMIT ?'
  );
  stmt.bind([placeName, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getFrequentLocations(daysBack = 30, minVisits = 2) {
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const stmt = getDb().prepare(
    `SELECT place_name, ROUND(AVG(lat), 6) as avg_lat, ROUND(AVG(lng), 6) as avg_lng,
            COUNT(*) as visit_count, SUM(duration_minutes) as total_minutes,
            MAX(date_key) as last_visit
     FROM location_visits
     WHERE date_key >= ? AND place_name IS NOT NULL
     GROUP BY place_name
     HAVING COUNT(*) >= ?
     ORDER BY visit_count DESC`
  );
  stmt.bind([cutoff, minVisits]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── MoSCoW Task Prioritisation ──

function _taskKey(filePath, lineNumber, text) {
  // Stable key: path + first 60 chars of text (line numbers shift when file is edited)
  const shortText = (text || '').substring(0, 60).replace(/\s+/g, ' ').trim();
  return `${filePath || 'unknown'}::${shortText}`;
}

function setTaskMoscow(filePath, lineNumber, text, moscow) {
  const key = _taskKey(filePath, lineNumber, text);
  getDb().run(
    `INSERT OR REPLACE INTO task_moscow (task_key, moscow, task_text, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [key, moscow, (text || '').substring(0, 200)]
  );
  return key;
}

function getTaskMoscow(filePath, lineNumber, text) {
  const key = _taskKey(filePath, lineNumber, text);
  const stmt = getDb().prepare('SELECT moscow FROM task_moscow WHERE task_key = ?');
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row.moscow;
  }
  stmt.free();
  return null;
}

function getAllTaskMoscow() {
  const stmt = getDb().prepare('SELECT task_key, moscow, task_text, updated_at FROM task_moscow ORDER BY updated_at DESC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function deleteTaskMoscow(filePath, lineNumber, text) {
  const key = _taskKey(filePath, lineNumber, text);
  getDb().run('DELETE FROM task_moscow WHERE task_key = ?', [key]);
}

// ── SARA Actions ──

function createSaraAction(type, payload, confidence, reason, focusItemId) {
  getDb().run(
    `INSERT INTO sara_actions (type, payload, confidence, reason, focus_item_id)
     VALUES (?, ?, ?, ?, ?)`,
    [type, JSON.stringify(payload), confidence, reason, focusItemId || null]
  );
  // Read the id BEFORE save(): save() calls db.export(), which closes and
  // reopens the sql.js connection, and last_insert_rowid() then returns 0.
  const stmt = getDb().prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  save();
  return row.id;
}

function getPendingSaraActions(limit = 10) {
  const stmt = getDb().prepare(
    'SELECT * FROM sara_actions WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT ?'
  );
  stmt.bind(['pending', limit]);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.payload = JSON.parse(row.payload || '{}');
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function getSaraAction(id) {
  const stmt = getDb().prepare('SELECT * FROM sara_actions WHERE id = ?');
  stmt.bind([id]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
    row.payload = JSON.parse(row.payload || '{}');
  }
  stmt.free();
  return row;
}

function updateSaraActionStatus(id, status) {
  getDb().run(
    `UPDATE sara_actions SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
    [status, id]
  );
  save();
}

function getRecentSaraActions(limit = 20) {
  const stmt = getDb().prepare(
    'SELECT * FROM sara_actions ORDER BY created_at DESC LIMIT ?'
  );
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.payload = JSON.parse(row.payload || '{}');
    rows.push(row);
  }
  stmt.free();
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
