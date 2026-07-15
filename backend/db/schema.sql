CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_conv_id
  ON conversations(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jira_tickets_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL UNIQUE,
  summary TEXT,
  status TEXT,
  priority TEXT,
  assignee TEXT,
  sla_remaining_minutes REAL,
  sla_name TEXT,
  at_risk INTEGER DEFAULT 0,
  raw_json TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jira_at_risk
  ON jira_tickets_cache(at_risk);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  decision_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  nag_count INTEGER DEFAULT 0,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'normal',
  due_date TEXT,
  source TEXT,
  ms_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS calendar_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  subject TEXT,
  start_time TEXT,
  end_time TEXT,
  is_all_day INTEGER DEFAULT 0,
  location TEXT,
  organizer TEXT,
  show_as TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nudges_active ON nudges(active, date_key);
CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);
CREATE INDEX IF NOT EXISTS idx_todos_ms_id ON todos(ms_id);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_cache(start_time);

CREATE TABLE IF NOT EXISTS import_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL UNIQUE,
  type TEXT,
  destination TEXT,
  confidence TEXT,
  reason TEXT,
  backend TEXT,
  classified_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_import_cls_path ON import_classifications(relative_path);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  hour INTEGER,
  day_of_week INTEGER,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(date_key, event_type);

CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL UNIQUE,
  subject TEXT,
  from_name TEXT,
  from_email TEXT,
  urgency TEXT,
  category TEXT,
  summary TEXT,
  reason TEXT,
  received TEXT,
  is_read INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  dismissed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_dismissed ON inbox_items(dismissed);
CREATE INDEX IF NOT EXISTS idx_inbox_email_id ON inbox_items(email_id);

CREATE TABLE IF NOT EXISTS vault_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  chunk_text TEXT,
  file_modified TEXT,
  embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(relative_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_path ON vault_embeddings(relative_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON vault_embeddings(content_hash);

-- Entity extraction — people, tasks, decisions extracted from notes
CREATE TABLE IF NOT EXISTS extracted_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  context TEXT,
  extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_path ON extracted_entities(source_path);
CREATE INDEX IF NOT EXISTS idx_entities_type ON extracted_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_value ON extracted_entities(entity_value);

-- Backlinks — tracks which notes mention which entities/notes
CREATE TABLE IF NOT EXISTS note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  target_path TEXT,
  target_entity TEXT,
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_links_source ON note_links(source_path);
CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_entity ON note_links(target_entity);

-- Do Next — high-signal tasks identified in standups, chat sessions, or manually
CREATE TABLE IF NOT EXISTS do_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_do_next_done ON do_next(done, due_date);

-- NOVA flagged tickets ("Nick, look at this") — mirror of NOVA's risk scorer,
-- pushed in via POST /api/nova-signals. NOVA is source of truth; each push
-- replaces the whole active set, so resolved/reviewed tickets drop off.
CREATE TABLE IF NOT EXISTS nova_flags (
  ticket_key TEXT PRIMARY KEY,
  risk_score INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  why TEXT,
  summary TEXT,
  assignee TEXT,
  ticket_status TEXT,
  reasons TEXT,
  flagged_at DATETIME,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_summary (
  date_key TEXT PRIMARY KEY,
  standup_done INTEGER DEFAULT 0,
  standup_hour INTEGER,
  standup_snooze_count INTEGER DEFAULT 0,
  todo_snooze_count INTEGER DEFAULT 0,
  eod_done INTEGER DEFAULT 0,
  captures_count INTEGER DEFAULT 0,
  chat_count INTEGER DEFAULT 0,
  chat_topics TEXT,
  tabs_opened TEXT,
  summary_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SARA Action Suggestions (Phase 5A)
CREATE TABLE IF NOT EXISTS sara_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  focus_item_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sara_actions_status ON sara_actions(status);

-- Location visit history (Phase 5)
CREATE TABLE IF NOT EXISTS location_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  place_name TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  arrival TEXT NOT NULL,
  departure TEXT,
  duration_minutes INTEGER DEFAULT 0,
  source TEXT DEFAULT 'owntracks',
  place_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_location_visits_date ON location_visits(date_key);
CREATE INDEX IF NOT EXISTS idx_location_visits_place ON location_visits(place_name);

-- MoSCoW task prioritisation (Phase 6A)
CREATE TABLE IF NOT EXISTS task_moscow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT UNIQUE NOT NULL,
  moscow TEXT NOT NULL CHECK(moscow IN ('must', 'should', 'could', 'wont')),
  task_text TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_moscow_key ON task_moscow(task_key);
CREATE INDEX IF NOT EXISTS idx_task_moscow_priority ON task_moscow(moscow);
